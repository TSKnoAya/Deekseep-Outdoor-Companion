import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFishInjector } from '../src/fish-inject.js';

/** 造一个可控的注入器：记忆内容与签名都由测试决定。 */
function mk(options = {}) {
  let sig = 'a';
  const logs = [];
  const inj = createFishInjector({
    dshHome: 'X:/dsh',
    log: (m) => logs.push(m),
    buildContext: () => ({ ok: true, name: '傲娇助手', text: '【你是下面这个角色】', personaChars: 10, memoryChars: 20 }),
    signature: () => sig,
    maxInjections: 3,
    ...options,
  });
  return { inj, logs, setSig: (v) => { sig = v; } };
}

test('第一轮注入，第二轮不重复注入', () => {
  const { inj } = mk();
  const first = inj.prepare('s1');
  assert.equal(first.reason, 'first');
  assert.match(first.prefix, /你是下面这个角色/);
  inj.commit('s1', first);

  const second = inj.prepare('s1');
  assert.equal(second.prefix, null, '同一会话第二轮不该再拼一遍');
  assert.equal(second.reason, 'already');
});

test('不同会话各自算第一轮', () => {
  const { inj } = mk();
  inj.commit('s1', inj.prepare('s1'));
  assert.equal(inj.prepare('s2').reason, 'first');
});

test('记忆变了会再注入一次，并说明「之前那份作废」', () => {
  const { inj, setSig } = mk();
  inj.commit('s1', inj.prepare('s1'));
  setSig('b');
  const again = inj.prepare('s1');
  assert.equal(again.reason, 'memory-changed');
  assert.match(again.prefix, /最新记忆/);
});

test('注入次数有上限，聊很久也不会把窗口塞满', () => {
  const { inj, setSig } = mk();
  inj.commit('s1', inj.prepare('s1')); // 1
  setSig('b');
  inj.commit('s1', inj.prepare('s1')); // 2
  setSig('c');
  inj.commit('s1', inj.prepare('s1')); // 3 = max
  setSig('d');
  const over = inj.prepare('s1');
  assert.equal(over.prefix, null);
  assert.equal(over.reason, 'capped');
});

test('失败的那一轮不记账（重试时还会注入）', () => {
  const { inj } = mk();
  inj.prepare('s1'); // 不 commit，模拟这轮失败
  assert.equal(inj.prepare('s1').reason, 'first');
});

test('关掉开关就完全不注入，也不读文件', () => {
  let reads = 0;
  const { inj } = mk({
    buildContext: () => { reads += 1; return { ok: false, reason: 'boom' }; },
  });
  inj.setEnabled(false);
  const r = inj.prepare('s1');
  assert.equal(r.reason, 'disabled');
  assert.equal(r.prefix, null);
  assert.equal(reads, 0, '关掉后不该再去读角色文件');
});

test('没有角色/没装 SurfCore 时安静降级，不报错', () => {
  const { inj } = mk({ buildContext: () => ({ ok: false, reason: 'no-character' }) });
  const r = inj.prepare('s1');
  assert.equal(r.prefix, null);
  assert.equal(r.reason, 'no-character');
  assert.equal(inj.status().available, false);
  assert.equal(inj.status().character, null);
});

test('status 能看出角色、字数与会话注入次数（设置页要用）', () => {
  const { inj } = mk();
  inj.commit('s1', inj.prepare('s1'));
  const st = inj.status();
  assert.equal(st.enabled, true);
  assert.equal(st.character, '傲娇助手');
  assert.equal(st.memoryChars, 20);
  assert.deepEqual(st.sessions, [{ sessionId: 's1', injections: 1 }]);
});

test('forget 之后该会话重新算第一轮', () => {
  const { inj } = mk();
  inj.commit('s1', inj.prepare('s1'));
  inj.forget('s1');
  assert.equal(inj.prepare('s1').reason, 'first');
});

test('开关落盘：setEnabled 会回调 onToggle（否则重启又回到默认开）', () => {
  const calls = [];
  const inj = createFishInjector({
    dshHome: 'X:/dsh',
    onToggle: (v) => calls.push(v),
    buildContext: () => ({ ok: true, name: '鱼', text: 'x' }),
    signature: () => 'a',
  });
  inj.setEnabled(false);
  inj.setEnabled(true);
  assert.deepEqual(calls, [false, true]);
});

test('persist:false 时只改内存，不写配置', () => {
  const calls = [];
  const inj = createFishInjector({
    dshHome: 'X:/dsh',
    onToggle: (v) => calls.push(v),
    buildContext: () => ({ ok: true, name: '鱼', text: 'x' }),
    signature: () => 'a',
  });
  inj.setEnabled(false, { persist: false });
  assert.deepEqual(calls, []);
  assert.equal(inj.isEnabled(), false);
});
