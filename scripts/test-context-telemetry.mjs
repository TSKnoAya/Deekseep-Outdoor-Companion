// Phase 0A 遥测：只读事件折叠、模型调用去重、工具结果大小、报告聚合。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContextTelemetry } from '../src/context-telemetry.js';
import { summarize } from './context-telemetry-report.mjs';
import fsRoot from 'node:fs';
import pathRoot from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-telemetry-'));
const file = path.join(dir, 'telemetry.jsonl');
const telemetry = createContextTelemetry({ file, source: 'plugin', now: () => 1700000000000 });

const session = { id: 's1', header: { agentPreset: 'qq-chat-v2' } };
const BODY = 'M'.repeat(320);
telemetry.wake({ wakeId: 'w1', key: 'group:1', sessionId: 's1', reason: 'groupMessage', promptChars: 12000 });
telemetry.ingestEvent(session, { type: 'turn/start', data: { turn: 1 } });
// 流式 attempt 先到，最终 message 后到；报告必须只算一次。
telemetry.ingestEvent(session, {
  type: 'assistant/attempt',
  data: { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 40 } },
});
telemetry.ingestEvent(session, {
  type: 'assistant/message',
  data: { turn: 1, step: 1, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50 } },
});
telemetry.ingestEvent(session, { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'qq_get_unread_messages' } });
telemetry.ingestEvent(session, {
  type: 'tool/result',
  data: {
    turn: 1,
    message: {
      source: { callId: 'c1' },
      content: [{ text: BODY }],
      isError: false,
    },
  },
});
telemetry.ingestEvent(session, {
  type: 'tool/call',
  data: { turn: 1, callId: 'c2', name: 'qq_get_group_members' },
});
telemetry.ingestEvent(session, {
  type: 'tool/result',
  data: {
    turn: 1,
    message: { source: { callId: 'c2' }, content: [{ text: 'x', isError: true }], isError: true },
  },
});
telemetry.ingestEvent(session, { type: 'turn/end', data: { turn: 1 } });

const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.ok(lines.some((x) => x.kind === 'wake' && x.promptChars === 12000));
assert.ok(lines.some((x) => x.kind === 'model_call' && x.phase === 'message'));
assert.ok(lines.some((x) => x.kind === 'tool_result' && x.resultChars === 320));
assert.ok(lines.some((x) => x.kind === 'tool_result' && x.ok === false));
assert.ok(!fs.readFileSync(file, 'utf8').includes('M'.repeat(320)), '遥测不得记录消息正文');

const report = summarize(lines);
assert.equal(report.wakes, 1);
assert.equal(report.totals.modelCalls, 1, 'attempt + message 必须去重成一次');
assert.equal(report.totals.inputTokens, 1000);
assert.equal(report.totals.outputTokens, 50);
assert.equal(report.totals.toolCalls, 2);
assert.equal(report.totals.toolResults, 2);
assert.equal(report.totals.toolResultChars, 321);
assert.ok(report.wakeReasons.some((x) => x.reason === 'groupMessage'));
assert.ok(report.tools.some((x) => x.tools.some((t) => t.tool === 'qq_get_group_members' && t.errors === 1)));

// 写入失败不能抛到调用方。
const bad = createContextTelemetry({ file: path.join(dir, 'no-such-dir', 'x.jsonl'), source: 'bridge', log: () => {} });
try { bad.wake({ wakeId: 'x' }); } catch (error) { assert.fail(`遥测写入不能抛：${error.message}`); }

// 接线：插件必须观察所有 session/event；bridge 必须在投递 wake 时记录 prompt。
const pluginSource = fsRoot.readFileSync(pathRoot.resolve('plugins/surfcore/lib/index.js'), 'utf8');
const bridgeSource = fsRoot.readFileSync(pathRoot.resolve('src/bridge.js'), 'utf8');
assert.ok(pluginSource.includes('createContextTelemetry'), '插件没有创建遥测器');
assert.ok(pluginSource.includes('contextTelemetry.ingestEvent'), '插件没有观察 session/event');
assert.ok(bridgeSource.includes('contextTelemetry.wake'), 'bridge 没有记录唤醒');
assert.ok(bridgeSource.includes('lastWakePromptMeta'), 'bridge 没有记录 prompt 分段');

fs.rmSync(dir, { recursive: true, force: true });
console.log('✅ 上下文遥测通过');
