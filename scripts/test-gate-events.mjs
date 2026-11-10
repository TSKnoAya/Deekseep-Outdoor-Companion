// 闸门事件中心 + 单轮止血纯逻辑（临时目录，不碰真实 state / QQ / DSH）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateEventStore, classifyGateEvent } from '../src/gate-events.js';
import { createTurnGuard } from '../src/turn-guard.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-gate-'));
try {
  const store = createGateEventStore({ dir, log: () => {} });
  const whitelist = store.record({ gate: 'allow', kind: 'security', event: 'not-whitelisted', reason: { code: 'NOT_ALLOWED' } });
  assert.equal(whitelist.level, 'L0', '普通白名单拒绝必须静默');

  const compat = store.record({ gate: 'qq-tool-restrict', kind: 'compat', event: 'context-denied', impactLevel: 'core' });
  assert.equal(compat.level, 'L2', '上下文压缩被拒要警示');

  const budgetActive = store.record({ gate: 'token-budget', kind: 'cost', event: 'budget-exhausted', activeTurn: true });
  assert.equal(budgetActive.level, 'L3', '回合中额度耗尽必须紧急停止');

  const warn = store.record({ gate: 'token-budget', kind: 'cost', event: 'budget-warning' });
  assert.equal(warn.level, 'L1', '80% 是轻提示');

  const leak = store.record({ gate: 'outbound', kind: 'security', event: 'sensitive-outbound', confidence: 'confirmed' });
  assert.equal(leak.level, 'L3');

  const tokenLike = store.record({
    gate: 'test', kind: 'cost', event: 'budget-warning',
    evidence: { token: 'SECRET-TOKEN', nested: { password: 'p' } },
  });
  const raw = fs.readFileSync(store.file, 'utf8');
  assert.ok(!raw.includes('SECRET-TOKEN'), '令牌不能落进事件文件');
  assert.ok(!raw.includes('"password":"p"'), '密码不能落进事件文件');
  assert.ok(tokenLike.evidence.token === '********');

  const listed = store.list({ limit: 20 });
  assert.ok(listed.events.length >= 5);
  assert.ok(listed.counts.L3 >= 2);
  assert.equal(store.list({ level: 'L0' }).events.every((x) => x.level === 'L0'), true);

  store.ack([whitelist.id]);
  assert.equal(store.list({ includeAcked: false }).events.some((x) => x.id === whitelist.id), false);
  store.ack([], true);

  // 分级函数本身：同一闸门因情境升级。
  assert.equal(classifyGateEvent({ kind: 'compat', event: 'tool-denied', repeatCount: 3, activeTurn: true }), 'L3');
  assert.equal(classifyGateEvent({ kind: 'security', event: 'not-whitelisted' }), 'L0');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'bridge-exit' }), 'L2');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'TURN_REPEATED_TOOL_ERROR', action: 'stopped' }), 'L3');
  assert.equal(classifyGateEvent({ kind: 'fault', event: 'TURN_STEPS_EXCEEDED', action: 'stopped' }), 'L3');

  // 单轮止血：步数、重复错误、预算。
  const turn = createTurnGuard({ maxSteps: 2, maxRepeatedErrors: 2 });
  turn.begin('s1', 'group:1');
  assert.equal(turn.noteStep('s1'), null);
  assert.equal(turn.noteStep('s1'), null);
  assert.equal(turn.noteStep('s1')?.code, 'TURN_STEPS_EXCEEDED');
  turn.end('s1');

  turn.begin('s2', 'group:1');
  assert.equal(turn.noteToolError('s2', 'compress', 'fetch failed: ECONNREFUSED'), null);
  const repeated = turn.noteToolError('s2', 'compress', 'fetch failed: ECONNREFUSED');
  assert.equal(repeated?.code, 'TURN_REPEATED_TOOL_ERROR');
  assert.equal(repeated?.evidence?.count, 2);
  turn.end('s2');

  turn.begin('s3');
  assert.equal(turn.noteBudgetExhausted('s3', [{ scope: 'qq' }])?.code, 'TURN_BUDGET_EXHAUSTED');

  // 故障恢复后自动确认：同 dedupeKey 的未处理事件应被 ack 掉（避免"连着还弹 L2"）。
  {
    store.record({ gate: 'snowluma', kind: 'fault', event: 'send-channel-down', level: 'L2', dedupeKey: 'test:down' });
    store.record({ gate: 'snowluma', kind: 'fault', event: 'send-channel-down', level: 'L2', dedupeKey: 'test:down' });
    const before = store.list({ limit: 50, includeAcked: false }).events.filter((e) => e.dedupeKey === 'test:down');
    assert.equal(before.length, 2, '记录两条未确认的断线事件');
    const ids = store.ackByDedupe('test:down');
    assert.equal(ids.length, 2, 'ackByDedupe 返回被确认的 id');
    const after = store.list({ limit: 50, includeAcked: false }).events.filter((e) => e.dedupeKey === 'test:down');
    assert.equal(after.length, 0, '恢复后同 dedupeKey 事件不再出现');
  }

  // 业务拒绝 vs 环境错误：前者不该停轮（2026-10-31 实测 qq_close_conversation 被拒 3 次触发 L3）
  {
    const guard = createTurnGuard({ maxSteps: 99, maxRepeatedErrors: 2 });
    guard.begin('biz');
    const reject = '收尾失败：对方最近一条不是你的消息…建议先 qq_send_message';
    assert.equal(guard.noteToolError('biz', 'qq_close_conversation', reject), null, '业务拒绝不计数');
    assert.equal(guard.noteToolError('biz', 'qq_close_conversation', reject), null, '业务拒绝重复也不停轮');
    const infra = 'fetch failed: ECONNREFUSED';
    assert.equal(guard.noteToolError('biz', 'qq_send_message', infra), null);
    const hit = guard.noteToolError('biz', 'qq_send_message', infra);
    assert.equal(hit?.code, 'TURN_REPEATED_TOOL_ERROR', '环境错误仍按阈值停轮');
    guard.end('biz');
  }

  // 接线契约：桥接必须真的在回合事件里接上 guard，且用 cancel-only 接口。
  const bridgeSource = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
  const dshSource = fs.readFileSync(path.resolve('src/dsh-client.js'), 'utf8');
  assert.match(bridgeSource, /guardTurnEvent\(frame\.sessionId/, 'bridge 必须在 session/event 接 round guard');
  assert.match(bridgeSource, /api\.cancelTurn\(/, '止血必须调用 cancel-only');
  assert.match(dshSource, /async cancelTurn\(/, 'dsh-client 必须提供 cancelTurn');
  // 断线去抖 + 恢复自动确认（2026-10-31：明明连着却弹 L2）
  assert.match(bridgeSource, /downTimer/, 'bridge 必须给 close 加观察窗口');
  assert.match(bridgeSource, /ackByDedupe\('snowluma:send-channel-down'\)/, '重连后必须自动确认断线事件');
  assert.ok(!bridgeSource.includes('自动唤醒已暂停，避免先生成后丢弃'), '断线文案不能声称“已暂停”（暂停由发送失败触发）');

  console.log('✅ 闸门事件中心/单轮止血通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
