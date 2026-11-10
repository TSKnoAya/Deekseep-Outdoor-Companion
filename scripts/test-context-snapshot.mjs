// 一次读取快照：合并 unread/recent/social/activeMembers；截断必须如实标记。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildContextSnapshot, DEFAULT_SNAPSHOT_CAPS } from '../src/context-snapshot.js';

const st = {
  lastWakeReason: 'question',
  lastAiReplyAt: 1000,
  wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true } },
  unread: [
    { seq: 1, sender: 'A', text: 'x'.repeat(300), time: 1 },
    { seq: 2, sender: 'B', text: 'hello', time: 2, media: [{ type: 'image' }] },
    { seq: 3, sender: 'C', text: 'latest', time: 3, quoteTargetIsSelf: true },
  ],
  recentMessages: [
    { seq: 1, sender: 'A', text: 'old', time: 1 },
    { seq: 2, sender: 'B', text: 'hello', time: 2 },
    { seq: 3, sender: 'B', text: 'latest', time: 3 },
    { seq: 4, isSelf: true, text: 'me', time: 4 },
  ],
};
const snap = buildContextSnapshot({ key: 'group:1', st, caps: { unread: 3, recent: 2, textChars: 50 }, now: 9999 });
assert.equal(snap.ok, true);
assert.equal(snap.caps.unread, 3);
assert.equal(snap.unread.total, 3);
assert.equal(snap.unread.truncated, false);
assert.equal(snap.unread.items.length, 3);
assert.equal(snap.unread.items[0].text.length, 50);
assert.equal(snap.unread.items[0].textTruncated, true);
assert.ok(snap.refs.some((r) => r.seq === 1), '截断消息必须有 detail ref');
assert.equal(snap.recent.items.length, 2);
assert.equal(snap.recent.items.some((m) => m.isSelf), true);
assert.equal(snap.activeMembers[0].name, 'B');
assert.equal(snap.social.lastWakeReason, 'question');

const after = buildContextSnapshot({ key: 'group:1', st, caps: { unread: 10 }, afterSeq: 1, now: 1 });
assert.equal(after.unread.total, 2);
assert.equal(after.unread.items[0].seq, 2);

const only = buildContextSnapshot({ key: 'group:1', st, include: ['social'], now: 1 });
assert.ok(only.social && !only.unread && !only.recent);

const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.resolve('src/mcp-snowluma-safe.js'), 'utf8');
assert.ok(bridge.includes('/api/socialV2/snapshot'), 'bridge 必须有快照端点');
assert.ok(mcp.includes("'qq_get_context_snapshot'"), 'MCP 必须注册快照工具');
assert.ok(mcp.includes('TOOL_PROFILE') && mcp.includes('PROFILE_HIDDEN'), '必须支持工具面 profile');
assert.ok(fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8').includes('工具面模式'), '设置页必须能切工具面');
console.log('✅ 上下文快照通过');
