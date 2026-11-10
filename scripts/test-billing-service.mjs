// 账单服务：自动写入角色/会话 MD；只读文件，不启动服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBillingService } from '../plugins/surfcore/lib/billing.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-billing-'));
const state = path.join(root, 'surfcore');
const qq = path.join(root, 'repo');
fs.mkdirSync(path.join(state, 'characters'), { recursive: true });
fs.mkdirSync(path.join(qq, 'state'), { recursive: true });
fs.writeFileSync(path.join(state, 'characters', 'index.json'), JSON.stringify({ characters: [{ id: 'char-a', name: '角色甲' }] }));
const T = 1793416000000;
fs.writeFileSync(path.join(qq, 'state', 'token-usage.jsonl'), JSON.stringify({
  k: 'turn', t: T, sid: 's1', key: 'group:1', turn: 1, step: 1, retry: 0, model: 'deepseek-flash',
  b: { cacheMiss: 100, cacheHit: 1000, cacheWrite: 0, output: 10 },
}) + '\n');
fs.writeFileSync(path.join(qq, 'state', 'context-telemetry-bridge.jsonl'), JSON.stringify({
  v: 1, ts: T, kind: 'wake', wakeId: 'w1', key: 'group:1', sessionId: 's1', characterId: 'char-a', reason: 'groupMessage', promptChars: 100, layers: {},
}) + '\n');
fs.writeFileSync(path.join(state, 'context-telemetry-plugin.jsonl'), '');
const service = createBillingService({
  stateDir: state, qqRoot: qq, intervalMs: 0,
  readCurrentCharacter: () => ({ id: 'char-a', name: '角色甲' }),
  log: () => {},
});
const result = service.generate();
assert.equal(result.ok, true, result.error);
assert.ok(fs.existsSync(path.join(state, 'billing', 'index.md')));
assert.ok(fs.existsSync(path.join(state, 'billing', 'characters', 'char-a', 'summary.md')));
assert.ok(fs.existsSync(path.join(state, 'billing', 'conversations', 'group_1.md')));
assert.match(fs.readFileSync(path.join(state, 'billing', 'characters', 'char-a', 'summary.md'), 'utf8'), /角色「角色甲」/);
assert.match(fs.readFileSync(path.join(state, 'billing', 'conversations', 'group_1.md'), 'utf8'), /Token 账单 — group:1/);
fs.rmSync(root, { recursive: true, force: true });
console.log('✅ 账单服务通过');
