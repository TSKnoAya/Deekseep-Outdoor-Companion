/**
 * ACP 模型读写的测试。
 *
 * 这层是「换模型」的唯一写入口：写错了 DSH 就起不来（YAML 坏了整个 profile 崩）。
 * 所以这里重点钉三件事：① 只动 `- id: acp` 那一段；② 其它条目原样保留；③ 幂等。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findAcpBlock,
  readAcpModel,
  withAcpModel,
  loadAcpModel,
  saveAcpModel,
  profilePath,
} from '../src/acp-model.js';

const SAMPLE = `# Your patch layer for this dsh profile
#
# 一些用户注释

- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: our-free-model
    model: kilo-auto/free

- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-account
    model: deepseek-v4.1-flash

- id: ui-theme
  config:
    preference: dark
`;

test('能定位 - id: acp 那一段', () => {
  const lines = SAMPLE.split('\n');
  const range = findAcpBlock(lines);
  assert.ok(range);
  assert.match(lines[range.start], /^- id: acp/);
  // 段尾应该是下一个顶层条目
  assert.match(lines[range.end], /^- id: ui-theme/);
});

test('读得出当前 provider / model', () => {
  assert.deepEqual(readAcpModel(SAMPLE), { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' });
});

test('没有 acp 段时返回 null', () => {
  assert.equal(readAcpModel('- id: ui-theme\n  config:\n    preference: dark\n'), null);
});

test('替换后只改 acp 段，别的条目一字不动', () => {
  const out = withAcpModel(SAMPLE, { provider: 'our-free-model', model: 'kilo-auto/free' });
  assert.match(out, /agent-default-model[\s\S]*provider: our-free-model\n {4}model: kilo-auto\/free/);
  assert.match(out, /ui-theme[\s\S]*preference: dark/);
  // acp 段变成了新值
  assert.deepEqual(readAcpModel(out), { provider: 'our-free-model', model: 'kilo-auto/free' });
  // 注释保留
  assert.match(out, /# 一些用户注释/);
});

test('文件里没有 acp 段时会追加，且不破坏原有条目', () => {
  const src = '- id: ui-theme\n  config:\n    preference: dark\n';
  const out = withAcpModel(src, { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' });
  assert.deepEqual(readAcpModel(out), { provider: 'deepseek-account', model: 'deepseek-v4.1-flash' });
  assert.match(out, /ui-theme/);
  // 空文件也不会炸
  assert.ok(withAcpModel('', { provider: 'a', model: 'b' }).includes('provider: a'));
});

test('幂等：同样输入跑两次结果一致', () => {
  const once = withAcpModel(SAMPLE, { provider: 'x', model: 'y' });
  const twice = withAcpModel(once, { provider: 'x', model: 'y' });
  assert.equal(once, twice);
});

test('反复替换不会累积重复的 acp 段', () => {
  let text = SAMPLE;
  for (let i = 0; i < 5; i += 1) text = withAcpModel(text, { provider: 'p', model: `m${i}` });
  assert.equal(text.match(/^- id: acp$/gm)?.length, 1);
  assert.deepEqual(readAcpModel(text), { provider: 'p', model: 'm4' });
});

test('路径指向 profiles/acp/cordis.patch.yml', () => {
  assert.match(profilePath('C:\\Users\\x\\.dsh'), /profiles[\\/]acp[\\/]cordis\.patch\.yml$/);
});

/** 造个假 fs。 */
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
    writeFileSync(p, data) {
      map.set(p, data);
    },
    mkdirSync() {},
    get: (p) => map.get(p),
  };
}

test('文件不存在时 load 报 profileExists:false，而不是抛错', () => {
  const r = loadAcpModel('C:\\h', fakeFs({}));
  assert.equal(r.profileExists, false);
  assert.equal(r.current, null);
});

test('save 会先备份再写，且备份内容是原文', () => {
  const file = profilePath('C:\\h');
  const fsLike = fakeFs({ [file]: SAMPLE });
  const r = saveAcpModel('C:\\h', { provider: 'our-free-model', model: 'kilo-auto/free' }, fsLike);
  assert.ok(r.backup);
  assert.equal(fsLike.get(r.backup), SAMPLE);
  assert.deepEqual(readAcpModel(fsLike.get(file)), { provider: 'our-free-model', model: 'kilo-auto/free' });
});

test('save 拒绝空值 / 带空格注入的值', () => {
  const fsLike = fakeFs({});
  assert.throws(() => saveAcpModel('C:\\h', { provider: '', model: 'x' }, fsLike), /都必须给/);
  assert.throws(() => saveAcpModel('C:\\h', { provider: 'a b', model: 'x' }, fsLike), /只允许/);
  assert.throws(() => saveAcpModel('C:\\h', { provider: 'a', model: 'x\ny' }, fsLike), /只允许/);
});
