/**
 * 「把鱼带到手机」的测试。
 *
 * 这层最容易犯的错不是崩溃，而是**拼出来的前言不对**：
 * 少一段记忆卡片 → 鱼变笨；多写一句"你是助手" → 鱼的性格漂了。
 * 所以这里断言的是内容构成，不只是 ok:true。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildFishContext, readCurrentCharacter } from '../src/fish-context.js';

const HOME = 'C:\\Users\\bob\\.dsh';
const SURF = path.join(HOME, 'surfcore');
const CHAR = path.join(SURF, 'characters', 'char-1');

function fakeFs(files = {}) {
  const map = new Map(Object.entries(files));
  return {
    readFileSync(p) {
      if (!map.has(p)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return map.get(p);
    },
  };
}

const baseFiles = {
  [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: '傲娇助手', dir: CHAR }),
  [path.join(CHAR, 'persona.md')]: '# 傲娇助手\n- 性格：傲娇、嘴硬心软',
  [path.join(CHAR, 'memory', 'memory-card-prompt-qq.md')]: '【记忆卡 · 你自己的记忆】\n- 2026-10-30 [清楚] 主人让我别熬夜',
};

test('能读出当前角色', () => {
  const cur = readCurrentCharacter(SURF, fakeFs(baseFiles));
  assert.deepEqual(cur, { id: 'char-1', name: '傲娇助手', dir: CHAR });
});

test('没有 current.json 时返回 null，不抛错', () => {
  assert.equal(readCurrentCharacter(SURF, fakeFs({})), null);
});

test('拼出来的前言同时含人格卡与记忆卡', () => {
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(baseFiles) });
  assert.equal(r.ok, true);
  assert.equal(r.name, '傲娇助手');
  assert.match(r.text, /傲娇、嘴硬心软/);
  assert.match(r.text, /主人让我别熬夜/);
  // 明确告诉模型「这是手机渠道」，避免它说「群里」
  assert.match(r.text, /手机 App/);
  assert.match(r.text, /不要编/);
});

test('优先用 qq 的预渲染块（和主载体一致，避免同一条鱼两张脸）', () => {
  const files = {
    ...baseFiles,
    [path.join(CHAR, 'memory', 'memory-card-prompt-bili.md')]: 'B站专用记忆块',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.match(r.text, /主人让我别熬夜/);
  assert.doesNotMatch(r.text, /B站专用记忆块/);

  // 显式要 bili 时才用另一份
  const r2 = buildFishContext({ dshHome: HOME, platform: 'bili', fsLike: fakeFs(files) });
  assert.match(r2.text, /B站专用记忆块/);
});

test('没有 prompt 块时退回 memory-card.md，不直接失败', () => {
  const files = {
    [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: '傲娇助手', dir: CHAR }),
    [path.join(CHAR, 'persona.md')]: '人格卡',
    [path.join(CHAR, 'memory', 'memory-card.md')]: '可读版记忆',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.equal(r.ok, true);
  assert.match(r.text, /可读版记忆/);
});

test('超长记忆会被截断，并标注截断', () => {
  const long = 'x'.repeat(5000);
  const files = {
    ...baseFiles,
    [path.join(CHAR, 'memory', 'memory-card-prompt-qq.md')]: long,
  };
  const r = buildFishContext({ dshHome: HOME, maxChars: 300, fsLike: fakeFs(files) });
  assert.equal(r.truncated, true);
  assert.ok(r.memoryChars < 400);
  assert.match(r.text, /记忆还有更多/);
});

test('既没人格卡也没记忆时 ok:false，让调用方决定（而不是注入一段空壳）', () => {
  const files = {
    [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: 'x', dir: CHAR }),
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('没配置角色时 ok:false / no-character', () => {
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs({}) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-character');
});
