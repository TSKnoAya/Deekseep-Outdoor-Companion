// 群分层：小群/大群判定、手动覆盖、阈值、触发跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_GROUP_POLICY, groupTier, normalizeGroupPolicy, shouldSkipTriggerForTier } from '../src/group-policy.js';

const p = normalizeGroupPolicy({});
assert.equal(p.largeThreshold, 200);
assert.equal(p.activeMessageThreshold, 60);
assert.equal(groupTier({ key: 'group:1', memberCount: 32, activityCount: 8, policy: p }).tier, 'small');
assert.equal(groupTier({ key: 'group:1', memberCount: 861, activityCount: 0, policy: p }).tier, 'large');
assert.equal(groupTier({ key: 'group:1', memberCount: 10, activityCount: 120, policy: p }).tier, 'large');
assert.equal(groupTier({ key: 'group:1', memberCount: 0, activityCount: 0, policy: p }).source, 'default');
assert.equal(groupTier({ key: 'group:1', memberCount: 999, activityCount: 999, policy: { ...p, overrides: { 'group:1': 'small' } } }).tier, 'small');
assert.equal(groupTier({ key: 'group:2', memberCount: 2, activityCount: 0, policy: { ...p, overrides: { 'group:2': 'large' } } }).tier, 'large');
assert.equal(groupTier({ key: 'group:2', memberCount: 2, activityCount: 0, policy: { ...p, enabled: false } }).tier, 'small');

assert.equal(shouldSkipTriggerForTier('question', 'large'), true);
assert.equal(shouldSkipTriggerForTier('keyword:大肥鱼', 'large'), true);
assert.equal(shouldSkipTriggerForTier('probability', 'large'), true);
assert.equal(shouldSkipTriggerForTier('atMention', 'large'), false);
assert.equal(shouldSkipTriggerForTier('nameMention', 'large'), false);
assert.equal(shouldSkipTriggerForTier('question', 'small'), false);

const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
assert.ok(bridge.includes('groupProfile(key, st)'), 'bridge 必须接群画像');
assert.ok(bridge.includes('if (!large && tr.question'), '大群必须跳过普通 question');
assert.ok(bridge.includes('const m = /^group:(\\d+)$/'), '群 key 正则必须能匹配 group:数字');
assert.ok(fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8').includes('选择即保存'), '群覆盖必须选择即保存');
assert.ok(bridge.includes('/api/socialV2/group-policy'), 'bridge 必须有群分层 API');
const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
assert.ok(client.includes('GroupPolicyPanel'), '设置页必须有群分层面板');
assert.ok(client.includes('强制小群') && client.includes('强制大群'), '必须允许手动覆盖');
assert.ok(client.includes('将大大加快您的 Token 消耗速度'), '群分层必须有 token 消耗警示');

console.log('✅ 群分层通过');
