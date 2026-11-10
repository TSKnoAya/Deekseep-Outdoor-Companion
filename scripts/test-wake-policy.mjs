// 唤醒硬直接策略：只有真正点名才绕过每日配额；普通“你…吗”不绕过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasStrictDirectUnread, isHardDirectWakeReason } from '../src/wake-policy.js';

assert.equal(isHardDirectWakeReason('atMention'), true);
assert.equal(isHardDirectWakeReason('nameMention'), true);
assert.equal(isHardDirectWakeReason('poke'), true);
assert.equal(isHardDirectWakeReason('private'), true);
assert.equal(isHardDirectWakeReason('admin'), true);
assert.equal(isHardDirectWakeReason('question'), false, 'question 不再享受 direct 绕过');
assert.equal(isHardDirectWakeReason('keyword:大肥鱼'), false, 'keyword 不绕过每日配额');
assert.equal(isHardDirectWakeReason('backlog'), false);

assert.equal(hasStrictDirectUnread([{ text: '你觉得呢？' }], { selfNickname: '小咪' }), false);
assert.equal(hasStrictDirectUnread([{ text: '小咪你觉得呢？' }], { selfNickname: '小咪' }), false);
assert.equal(hasStrictDirectUnread([{ text: '@小咪 在吗' }], { selfNickname: '小咪' }), true);
assert.equal(hasStrictDirectUnread([{ isOwner: true, text: '在吗' }], { selfNickname: '小咪' }), false);
assert.equal(hasStrictDirectUnread([{ isOwner: true, text: '在吗' }], { selfNickname: '小咪', includeOwner: true }), true);
assert.equal(hasStrictDirectUnread([{ quoteTargetIsSelf: true, text: '这个呢' }], { selfNickname: '小咪' }), true);
assert.equal(hasStrictDirectUnread([{ isSelf: true, text: '小咪' }], { selfNickname: '小咪' }), false);

const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
assert.ok(bridge.includes('hasStrictDirectUnread(st.unread'), 'bridge 必须用严格 direct unread');
assert.ok(bridge.includes('function isSmallGroupDirectWake'), '小群必须保留积极 direct');
assert.ok(bridge.includes('groupProfileNow.large'), '大群必须走严格 direct');

console.log('✅ 唤醒 direct 策略通过');
