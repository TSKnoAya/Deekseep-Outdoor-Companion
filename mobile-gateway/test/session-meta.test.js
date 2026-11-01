import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractMeta, oneLine, cleanUserText, createSessionMeta } from '../src/session-meta.js';

// ── 从事件流里挑标题 ────────────────────────────────────────────────────

test('优先用 session/title，没有就用第一条用户消息', () => {
  const raw = [
    '{"type":"session","data":{"id":"s1"}}',
    '{"type":"user/message","data":{"content":"帮我看看这个报错"}}',
    '{"type":"session/title","data":{"title":"排查构建失败"}}',
  ].join('\n');
  const { title, firstUser } = extractMeta(raw);
  assert.equal(title, '排查构建失败');
  assert.equal(firstUser, '帮我看看这个报错');
});

test('用户消息是块数组时也能拼出文字', () => {
  const raw = '{"type":"user/message","data":{"content":[{"type":"text","text":"你"},{"type":"text","text":"好"}]}}';
  assert.equal(extractMeta(raw).firstUser, '你好');
});

test('坏行/非 JSON 行不影响其它行', () => {
  const raw = 'not json\n{"type":"user/message","data":{"text":"第二行可用"}}\n{坏的';
  assert.equal(extractMeta(raw).firstUser, '第二行可用');
});

// ── 压成一行 ─────────────────────────────────────────────────────────────

test('标题去掉换行并截断', () => {
  assert.equal(oneLine('第一行\n\n第二行'), '第一行 第二行');
  assert.equal(oneLine('啊'.repeat(60)).length, 43); // 42 + 省略号
});

test('标题去掉我们自己注入的前言', () => {
  assert.equal(oneLine('【你是下面这个角色，请一直保持它。】哪条鱼？'), '哪条鱼？');
});

test('空标题返回空串，不返回 null', () => {
  assert.equal(oneLine(null), '');
  assert.equal(oneLine('   '), '');
});

// ── 目录定位与缓存（假 fs，不碰真实磁盘） ────────────────────────────────

function fakeFs(tree, stats) {
  return {
    readdirSync: (p) =>
      // 只支持两层的简化实现：sessions/<workspace>
      tree[p].map((n) => ({ name: n, isDirectory: () => true })),
    existsSync: (p) => Object.prototype.hasOwnProperty.call(tree, p),
    statSync: (p) => ({ mtimeMs: stats[p]?.mtimeMs ?? 0, size: stats[p]?.size ?? 0 }),
    readFileSync: () => Buffer.from('raw'),
  };
}

test('在 sessions/*/session-<id>/ 里找到文件，给出时间与标题', () => {
  const root = path.join('X:/dsh', 'sessions');
  const ws = path.join(root, '--C-xx--');
  const file = path.join(ws, 'session-abc', 'session.v4.jsonl.zstd');
  const tree = { [root]: ['--C-xx--'], [ws]: ['session-abc'], [file]: true };
  const meta = createSessionMeta({
    dshHome: 'X:/dsh',
    fsLike: fakeFs(tree, { [file]: { mtimeMs: 1793_000_000_000, size: 100 } }),
    zlibLike: { zstdDecompressSync: () => Buffer.from('{"type":"user/message","data":{"text":"你好"}}') },
  });
  const [out] = meta.enrich([{ sessionId: 'abc', cwd: 'C:/x' }]);
  assert.equal(out.updatedAt, 1793000000000);
  assert.equal(out.title, '你好');
  assert.equal(out.cwd, 'C:/x', '原有字段要保留');
});

test('找不到文件时只缺字段，不抛错', () => {
  const meta = createSessionMeta({
    dshHome: 'X:/dsh',
    fsLike: fakeFs({ [path.join('X:/dsh', 'sessions')]: [] }, {}),
  });
  const [out] = meta.enrich([{ sessionId: 'nope' }]);
  assert.equal(out.title, null);
  assert.equal(out.updatedAt, null);
});

test('没有 DSH_HOME 时不炸，原样返回', () => {
  const meta = createSessionMeta({ fsLike: fakeFs({}, {}) });
  assert.deepEqual(meta.enrich([{ sessionId: 'a' }]), [{ sessionId: 'a', title: null, updatedAt: null }]);
});

test('超过体积上限就跳过解压（宁可没标题，也别卡住）', () => {
  const root = path.join('X:/dsh', 'sessions');
  const ws = path.join(root, 'w');
  const file = path.join(ws, 'session-big', 'session.v4.jsonl.zstd');
  let called = 0;
  const meta = createSessionMeta({
    dshHome: 'X:/dsh',
    fsLike: fakeFs({ [root]: ['w'], [ws]: ['session-big'], [file]: true }, { [file]: { mtimeMs: 1, size: 99 * 1024 * 1024 } }),
    zlibLike: { zstdDecompressSync: () => { called += 1; return Buffer.from(''); } },
  });
  const [out] = meta.enrich([{ sessionId: 'big' }]);
  assert.equal(called, 0);
  assert.equal(out.title, null);
  assert.equal(out.updatedAt, 1);
});

test('解压失败也不影响列表（坏档只丢标题）', () => {
  const root = path.join('X:/dsh', 'sessions');
  const ws = path.join(root, 'w');
  const file = path.join(ws, 'session-bad', 'session.v4.jsonl.zstd');
  const meta = createSessionMeta({
    dshHome: 'X:/dsh',
    fsLike: fakeFs({ [root]: ['w'], [ws]: ['session-bad'], [file]: true }, { [file]: { mtimeMs: 5, size: 10 } }),
    zlibLike: { zstdDecompressSync: () => { throw new Error('corrupt'); } },
  });
  const [out] = meta.enrich([{ sessionId: 'bad' }]);
  assert.equal(out.title, null);
  assert.equal(out.updatedAt, 5);
});

test('ACP 的扁平目录（sessions/<ws>/<id>/）也要认——手机会话就是这种', () => {
  const root = path.join('X:/dsh', 'sessions');
  const ws = path.join(root, '--C-ws--');
  const file = path.join(ws, 'abc-123', 'session.v4.jsonl.zstd');
  const meta = createSessionMeta({
    dshHome: 'X:/dsh',
    fsLike: fakeFs({ [root]: ['--C-ws--'], [ws]: ['abc-123'], [file]: true }, { [file]: { mtimeMs: 7, size: 10 } }),
    zlibLike: { zstdDecompressSync: () => Buffer.from('{"type":"user/message","data":{"text":"手机上说的"}}') },
  });
  const [out] = meta.enrich([{ sessionId: 'abc-123' }]);
  assert.equal(out.updatedAt, 7);
  assert.equal(out.title, '手机上说的');
});

// ── 洗掉注入前言（手机会话的第一条就是前言） ──────────────────────────

test('取分隔符之后的真实用户话', () => {
  const raw = '【你是下面这个角色，请一直保持它。】\n## 角色：傲娇助手\n（记忆卡…）\n\n---\n\n哪条鱼？';
  assert.equal(cleanUserText(raw), '哪条鱼？');
});

test('系统注入的提醒不算用户的话', () => {
  assert.equal(cleanUserText('<system-reminder>\nThe following workspace…'), '');
  assert.equal(cleanUserText('Current runtime context. This snapshot supersedes…'), '');
});

test('只剩前言（被截断）时返回空串，而不是把前言当标题', () => {
  assert.equal(cleanUserText('【你是下面这个角色，请一直'), '');
});

test('被污染的 session/title 会被丢掉，改用清洗后的用户消息', () => {
  const raw = [
    '{"type":"user/message","data":{"content":[{"type":"text","text":"【你是下面这个角色，请一直保持它。】\\n\\n---\\n\\n哪条鱼？"}]}}',
    '{"type":"session/title","data":{"title":"【你是下面这个角色，请一直"}}',
  ].join('\n');
  const { title, firstUser } = extractMeta(raw);
  assert.equal(firstUser, '哪条鱼？');
  assert.equal(title, null, '污染标题应当被丢弃');
});

test('前言很长（分隔符在 400 字之后）也要能取到用户原话', () => {
  // 回归：textOf 曾经 slice(0,400)，导致长前言里的分隔符被截掉，标题永远是前言
  const prefix = '【你是下面这个角色。】' + '设定'.repeat(400);
  const msg = JSON.stringify({
    type: 'user/message',
    data: { content: [{ type: 'text', text: `${prefix}\n\n---\n\n我想问个事儿` }] },
  });
  assert.equal(extractMeta(msg).firstUser, '我想问个事儿');
});

// ── 会话历史 ────────────────────────────────────────────────────────────

test('历史只收用户与助手正文，系统事件跳过，注入前言被剥掉', async () => {
  const { extractHistory } = await import('../src/session-meta.js');
  const raw = [
    '{"type":"session","data":{"id":"s1"}}',
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '【你是下面这个角色】\n设定…\n\n---\n\n你好' }] } }),
    JSON.stringify({ type: 'system/message', data: { text: '系统提醒，不该出现' } }),
    JSON.stringify({ type: 'assistant/message', data: { content: [{ type: 'text', text: '在的' }] } }),
    JSON.stringify({ type: 'user/message', data: { text: '再来一句' } }),
  ].join('\n');
  const { messages, truncated } = extractHistory(raw);
  assert.deepEqual(messages, [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在的' },
    { role: 'user', text: '再来一句' },
  ]);
  assert.equal(truncated, false);
});

test('历史上限只取最后 N 条，并标记 truncated', async () => {
  const { extractHistory } = await import('../src/session-meta.js');
  const raw = [
    '{"type":"user/message","data":{"text":"一"}}',
    '{"type":"assistant/message","data":{"text":"二"}}',
    '{"type":"user/message","data":{"text":"三"}}',
  ].join('\n');
  const r = extractHistory(raw, { limit: 2 });
  assert.deepEqual(r.messages.map((m) => m.text), ['二', '三']);
  assert.equal(r.truncated, true);
});

test('普通用户消息原样保留（不因为以符号开头就被吞）', async () => {
  const { extractHistory } = await import('../src/session-meta.js');
  const raw = JSON.stringify({ type: 'user/message', data: { text: '<div>怎么改这个标签？' } });
  assert.equal(extractHistory(raw).messages[0].text, '<div>怎么改这个标签？');
});
