// 限制失败必须带设置路径/当前值/上限，并进入概览错误报告（L1，不弹窗）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
const mcp = fs.readFileSync(path.resolve('src/mcp-snowluma-safe.js'), 'utf8');
assert.ok(bridge.includes('SEND_RATE_LIMIT'), '发送频率必须有结构化 code');
assert.ok(bridge.includes("'socialV2.send.maxSendPerMinute'"), '必须指出具体配置项');
assert.ok(bridge.includes("level: 'L1'"), '限制提醒不能弹 L2/L3，必须 L1');
assert.ok(bridge.includes('reportLimitEvent(key, rateLimit)'), '发送频率失败必须生成错误报告');
assert.ok(bridge.includes('FISH_GUARD_SEND_BLOCK') && bridge.includes('TOKEN_GUARD_SEND_LIMIT'), '鱼群/Token 发送上限也要报告');
assert.ok(mcp.includes("body?.hint ? `；建议：${body.hint}`"), 'MCP 必须把 hint 传给模型');
assert.ok(client.includes('LimitReportCard') && client.includes('知道了（本限制提醒）'), '概览必须有错误报告和本限制提醒');
assert.ok(bridge.includes('60 * 60 * 1000'), '同一限制必须 1 小时才重复报告');
assert.ok(bridge.includes('readLimitMutes') && bridge.includes('/api/socialV2/limit-mute'), '必须支持永久不再显示');
assert.ok(client.includes('永久不再显示'), '概览必须有永久不再显示');
assert.ok(client.includes('去改设置'), '错误报告必须有去改设置入口');
console.log('✅ 限制失败报告通过');
