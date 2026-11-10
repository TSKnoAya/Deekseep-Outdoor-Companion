// 会话映射审计：多个 QQ key 指同一 DSH session 时必须全部重建，不能继续串上下文。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dedupeSessionMappings, findDuplicateSessionIds } from '../src/session-map.js';

const dup = findDuplicateSessionIds({
  'group:1': 's1',
  'group:2': 's1',
  'private:3': 's2',
});
assert.equal(dup.get('s1').length, 2);
assert.equal(dup.has('s2'), false);

const out = dedupeSessionMappings({
  'group:1': 's1',
  'group:2': 's1',
  'private:3': 's2',
  'group:4': 's3',
});
assert.deepEqual(out.removed.sort(), ['group:1', 'group:2']);
assert.deepEqual(out.mappings, { 'private:3': 's2', 'group:4': 's3' });
assert.equal(out.duplicates.length, 1);

const clean = dedupeSessionMappings({ 'group:1': 'a', 'group:2': 'b' });
assert.equal(clean.removed.length, 0);

const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
assert.ok(bridge.includes('dedupeSessionMappings(state.sessions)'), 'bridge 启动必须审计重复会话');
assert.ok(bridge.includes('session-map-duplicate'), '重复会话必须写 gate event');
console.log('✅ 会话映射审计通过');
