// Phase 1A：调用链按 wakeId 归属、bridge/plugin 去重、路径/成功/成本聚合。
import assert from 'node:assert/strict';
import { buildCallChains, dedupeRecords, summarizeChains } from './context-call-chain-report.mjs';

const ts = 1700000000000;
const wake = (id, reason, sessionId = 's1', at = ts) => ({
  v: 1, ts: at, source: 'bridge', kind: 'wake', wakeId: id, sessionId, key: 'group:1', reason, promptChars: 1000,
});
const model = (wakeId, turn, step, at, usage, phase = 'message', sessionId = 's1') => ({
  v: 1, ts: at, source: wakeId ? 'bridge' : 'plugin', kind: 'model_call', wakeId, sessionId, turn, step, retry: 0, phase,
  model: 'deepseek-flash', usage,
});
const tool = (wakeId, callId, name, at, sessionId = 's1') => ({
  v: 1, ts: at, source: wakeId ? 'bridge' : 'plugin', kind: 'tool_call', wakeId, sessionId, turn: 1, callId, tool: name,
});
const result = (wakeId, callId, at, ok = true) => ({
  v: 1, ts: at, source: wakeId ? 'bridge' : 'plugin', kind: 'tool_result', wakeId, sessionId: 's1', turn: 1, callId, tool: 'x', ok, resultChars: 100,
});

const records = [
  wake('w1', 'question', 's1', ts),
  wake('w2', 'atMention', 's1', ts + 10000),
  // bridge + plugin 重复的同一次模型调用；bridge 带 wakeId 应优先。
  model('w1', 1, 1, ts + 100, { cacheMiss: 100, cacheHit: 900, output: 10 }),
  model('', 1, 1, ts + 100, { cacheMiss: 100, cacheHit: 900, output: 10 }),
  tool('w1', 'c1', 'mcp__snowluma__qq_wait_for_messages', ts + 200),
  tool('', 'c1', 'mcp__snowluma__qq_wait_for_messages', ts + 200),
  result('w1', 'c1', ts + 300),
  tool('w1', 'c2', 'mcp__snowluma__qq_send_message', ts + 400),
  result('w1', 'c2', ts + 500),
  model('w2', 2, 1, ts + 10100, { cacheMiss: 200, cacheHit: 800, output: 20 }),
  tool('w2', 'c3', 'mcp__snowluma__qq_close_conversation', ts + 10200),
  result('w2', 'c3', ts + 10300),
];

const cleaned = dedupeRecords(records);
assert.equal(cleaned.filter((r) => r.kind === 'model_call').length, 2, 'bridge/plugin 同调用必须去重');
assert.equal(cleaned.filter((r) => r.kind === 'tool_call').length, 3, '工具调用去重');

const chains = buildCallChains(records);
assert.equal(chains.length, 2);
const first = chains.find((c) => c.wakeId === 'w1');
const second = chains.find((c) => c.wakeId === 'w2');
assert.deepEqual(first.path, ['wait', 'send']);
assert.equal(first.delivered, true);
assert.ok(first.latencyToSendMs > 0);
assert.equal(first.modelCalls, 1);
assert.deepEqual(second.path, ['close']);
assert.equal(second.closed, true);
assert.equal(second.delivered, false);

const report = summarizeChains(chains);
assert.equal(report.wakes, 2);
assert.equal(report.delivered, 1);
assert.ok(report.paths.some((p) => p.path === 'wait → send' && p.count === 1));
assert.ok(report.totalCost > 0);
assert.ok(report.deliveredLatency.p50 > 0, 'delivered latency 必须被统计');
assert.ok(report.avgCostDelivered > 0);

// 旧数据没有 wakeId 时，仍按 session + 最近 wake 兜底。
const legacy = [
  wake('w1', 'question', 's1', ts),
  model('', 1, 1, ts + 100, { cacheMiss: 10, cacheHit: 10, output: 1 }),
];
assert.equal(buildCallChains(legacy).length, 1);

console.log('✅ 调用链报告通过');
