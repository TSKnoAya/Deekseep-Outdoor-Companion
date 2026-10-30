/**
 * 播报策略测试。
 *
 * 这组是本项目里最该穷举的：用户不会去点「念一下试试」，
 * 他只在真正被打断、被吵到、或者在会议上突然出声时才发现问题。
 * 所以四条硬规则（代码块不念、长回答只念首句、空内容不念、耳机档）必须钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAnnouncement,
  stripUnreadable,
  firstSentence,
  ANNOUNCE_MODES,
  SHORT_LIMIT,
} from '../src/voice/announce.js';

test('off 档一律不念', () => {
  const r = decideAnnouncement({ text: '你好', mode: 'off' });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'mode-off');
});

test('空的 / 纯空白不念', () => {
  assert.equal(decideAnnouncement({ text: '', mode: 'all' }).speak, false);
  assert.equal(decideAnnouncement({ text: '   \n\t ', mode: 'all' }).speak, false);
  assert.equal(decideAnnouncement({ text: '', mode: 'all' }).reason, 'empty');
});

test('headset-only 档：没耳机不念，有耳机才念', () => {
  const no = decideAnnouncement({ text: '好的', mode: 'headset-only', headsetConnected: false });
  assert.equal(no.speak, false);
  assert.equal(no.reason, 'needs-headset');

  const yes = decideAnnouncement({ text: '好的', mode: 'headset-only', headsetConnected: true });
  assert.equal(yes.speak, true);
  assert.equal(yes.text, '好的');
});

test('短回答整条念', () => {
  const r = decideAnnouncement({ text: '已经处理完了。', mode: 'short' });
  assert.equal(r.speak, true);
  assert.equal(r.text, '已经处理完了。');
  assert.equal(r.reason, 'short-whole');
});

test('长回答只念首句（默认档最重要的一条）', () => {
  const long = '第一步先备份数据库。第二步迁移表结构。第三步再切换流量。'.repeat(5);
  const r = decideAnnouncement({ text: long, mode: 'short' });
  assert.equal(r.speak, true);
  assert.equal(r.text, '第一步先备份数据库。');
  assert.equal(r.reason, 'short-first-sentence');
  // 一定要比原文短很多，否则等于没截
  assert.ok(r.text.length < long.length / 3);
});

test('代码块完全不念（含整条都是代码的情况）', () => {
  const codeOnly = '```js\nconst a = 1;\nconsole.log(a);\n```';
  const r = decideAnnouncement({ text: codeOnly, mode: 'all' });
  assert.equal(r.speak, false);
  assert.equal(r.reason, 'nothing-readable');
});

test('代码块剔除后，剩下的正文照念', () => {
  const mixed = '我改了这段代码：\n```js\nconst a = 1;\n```\n然后运行通过。';
  const r = decideAnnouncement({ text: mixed, mode: 'all' });
  assert.equal(r.speak, true);
  assert.ok(!r.text.includes('const'), '代码内容不能出现在播报文本里');
  assert.ok(r.text.includes('运行通过'));
});

test('文件路径不念', () => {
  const text = '文件在 C:\\Users\\dfer5\\Documents\\report.docx 里面';
  const r = decideAnnouncement({ text, mode: 'all' });
  assert.equal(r.speak, true);
  assert.ok(!r.text.includes('C:\\'), '路径不该被念出来');
});

test('表格不念', () => {
  const text = '| 项目 | 值 |\n|---|---|\n| a | 1 |\n\n结论是通过。';
  const r = decideAnnouncement({ text, mode: 'all' });
  assert.equal(r.speak, true);
  assert.ok(!r.text.includes('|'), '表格分隔符不该被念出来');
  assert.ok(r.text.includes('结论'));
});

test('链接不念', () => {
  const r = decideAnnouncement({ text: '详见 https://example.com/a/b/c 这里', mode: 'all' });
  assert.ok(!r.text.includes('http'));
});

test('纯符号不念', () => {
  const r = decideAnnouncement({ text: '--- === ***', mode: 'all' });
  assert.equal(r.speak, false);
});

test('all 档也做首句截断，不会把三页念完', () => {
  const long = '这是第一句。'.repeat(200);
  const r = decideAnnouncement({ text: long, mode: 'all' });
  assert.equal(r.speak, true);
  assert.equal(r.text, '这是第一句。');
  assert.ok(r.text.length < SHORT_LIMIT * 2);
});

test('stripUnreadable 会压缩多余空白', () => {
  assert.equal(stripUnreadable('你好    \n\n\n  世界'), '你好\n世界');
});

test('firstSentence: 有句号取到句号；没有就按阈值截断', () => {
  assert.equal(firstSentence('第一句。第二句。'), '第一句。');
  assert.equal(firstSentence('第一句！第二句。'), '第一句！');
  assert.equal(firstSentence('短的'), '短的');
  const longNoPunct = '啊'.repeat(200);
  const got = firstSentence(longNoPunct);
  assert.ok(got.length <= SHORT_LIMIT, `截断后应 <= ${SHORT_LIMIT}，实际 ${got.length}`);
});

test('ANNOUNCE_MODES 四档齐全且标了默认档', () => {
  const ids = ANNOUNCE_MODES.map((m) => m.id).sort();
  assert.deepEqual(ids, ['all', 'headset-only', 'off', 'short']);
  assert.equal(ANNOUNCE_MODES.filter((m) => m.default).length, 1);
  assert.equal(ANNOUNCE_MODES.find((m) => m.default).id, 'short');
});

test('每条决策都带 reason，便于排查"为什么没念"', () => {
  const cases = [
    { text: '', mode: 'short' },
    { text: '你好', mode: 'off' },
    { text: '```x```', mode: 'all' },
    { text: '你好', mode: 'headset-only', headsetConnected: false },
  ];
  for (const c of cases) {
    const r = decideAnnouncement(c);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0, JSON.stringify(c));
  }
});
