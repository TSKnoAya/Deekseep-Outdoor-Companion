// 账单生成：token ledger + 遥测 → 角色/会话 Markdown。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attributeLedgerRows, buildBillingReport, parseTelemetry, parseTokenLedger,
  renderCharacterBill, renderConversationBill, renderIndex,
} from '../src/billing-report.js';

const T = 1793416000000;
const ledger = [
  { k: 'turn', t: T, sid: 's1', key: 'group:1', turn: 1, step: 1, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 1000, cacheHit: 100000, cacheWrite: 0, output: 100 } },
  { k: 'turn', t: T + 10000, sid: 's1', key: 'group:1', turn: 1, step: 2, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 0, cacheHit: 50000, cacheWrite: 0, output: 50 } },
  { k: 'turn', t: T + 20000, sid: 's2', key: 'private:2', turn: 2, step: 1, retry: 0, model: 'deepseek-flash', b: { cacheMiss: 500, cacheHit: 20000, cacheWrite: 0, output: 30 } },
].map((x) => JSON.stringify(x)).join('\n');

const telemetry = [
  { v: 1, ts: T, kind: 'wake', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', reason: 'groupMessage', promptChars: 1000, layers: {} },
  { v: 1, ts: T + 100, kind: 'turn_start', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', turn: 1 },
  { v: 1, ts: T + 200, kind: 'model_call', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', turn: 1, step: 1, retry: 0, phase: 'message', model: 'deepseek-flash', usage: { cacheMiss: 1000, cacheHit: 100000, cacheWrite: 0, output: 100 } },
  { v: 1, ts: T + 300, kind: 'tool_call', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', turn: 1, callId: 'c1', tool: 'mcp__snowluma__qq_send_message' },
  { v: 1, ts: T + 400, kind: 'tool_result', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', turn: 1, callId: 'c1', tool: 'mcp__snowluma__qq_send_message', ok: true, resultChars: 50 },
  { v: 1, ts: T + 20000, kind: 'wake', wakeId: 'w2', key: 'private:2', sessionId: 's2', characterId: 'char-a', reason: 'private', promptChars: 800, layers: {} },
];

const parsedLedger = parseTokenLedger(ledger);
assert.equal(parsedLedger.length, 3);
assert.ok(parsedLedger.every((r) => r.cost > 0));

const parsed = parseTelemetry(telemetry);
assert.equal(parsed.wakes.length, 2);
assert.equal(parsed.models.length, 1);
assert.equal(parsed.tools.length, 2);

const attributed = attributeLedgerRows(parsedLedger, parsed, { currentCharacterId: 'char-a', characterCount: 1 });
assert.ok(attributed.every((r) => r.characterId === 'char-a'));
assert.ok(attributed.every((r) => r.characterId === 'char-a'));
assert.ok(attributed.some((r) => r.attribution === 'telemetry'));
assert.ok(attributed.some((r) => r.attribution === 'single-character'));

const report = buildBillingReport({
  ledgerText: ledger,
  telemetryRecords: telemetry,
  currentCharacterId: 'char-a',
  currentCharacterName: '角色甲',
  characterCount: 1,
});
assert.equal(report.conversations.length, 2);
assert.ok(report.conversations.some((c) => c.key === 'group:1' && c.agg.calls === 2));
assert.ok(report.conversations.some((c) => c.key === 'private:2' && c.agg.calls === 1));
assert.equal(report.characters.length, 1);
assert.equal(report.characters[0].id, 'char-a');
assert.ok(report.characters[0].agg.cost > 0);

const group = report.conversations.find((c) => c.key === 'group:1');
const groupMd = renderConversationBill({ key: group.key, agg: group.agg, turns: group.turns, telemetry: report.telemetry });
assert.ok(groupMd.includes('# Token 账单 — group:1'));
assert.ok(groupMd.includes('qq_send_message'));
assert.ok(groupMd.includes('首次发送延迟'));

const charMd = renderCharacterBill({
  characterId: 'char-a', name: '角色甲', agg: report.characters[0].agg, turns: report.characters[0].turns,
  telemetry: report.telemetry, conversationRows: report.characters[0].conversations,
  attribution: 'single-character', includeUnattributed: true,
});
assert.ok(charMd.includes('# Token 账单 — 角色「角色甲」'));
assert.ok(charMd.includes('会话排行'));

const idx = renderIndex({
  conversations: report.conversations.map((c) => ({ key: c.key, file: c.file, cost: c.agg.cost, calls: c.agg.calls })),
  characters: [{ id: 'char-a', name: '角色甲', cost: report.characters[0].agg.cost, calls: report.characters[0].agg.calls }],
});
assert.ok(idx.includes('characters/char-a/summary.md'));
assert.ok(idx.includes('conversations/group_1.md'));

// 多角色且无遥测归因 → 不能猜，必须“未归因”。
const unknown = buildBillingReport({
  ledgerText: ledger, telemetryRecords: [], currentCharacterId: 'char-a', characterCount: 2,
});
assert.ok(unknown.characters.some((c) => c.id === ''), '多角色无遥测时必须保留未归因');

console.log('✅ 账单生成通过');
