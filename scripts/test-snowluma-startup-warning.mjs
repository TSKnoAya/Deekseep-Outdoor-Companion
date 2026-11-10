// SnowLuma 未启动时不能弹“断线”告警；只有本次进程真正连过，断开才告警。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
const index = fs.readFileSync(path.resolve('plugins/surfcore/lib/index.js'), 'utf8');
assert.ok(bridge.includes('everConnected'), 'bridge 必须记录是否连过 SnowLuma');
assert.ok(bridge.includes("if (!snowlumaHealth.everConnected)"), '未连接过时不能发断线告警');
assert.ok(bridge.includes('snowlumaHealth.everConnected = true'), '连接成功必须置 everConnected');
assert.ok(client.includes('snow.everConnected === true'), 'UI 只能在连过之后显示连接异常');
assert.ok(index.includes('everConnected: bridge?.snowluma?.everConnected === true'), 'overview 必须带 everConnected');
console.log('✅ SnowLuma 启动告警抑制通过');
