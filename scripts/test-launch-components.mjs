// 一键启动/停止的接线契约：UI 入口、语音分支、结构化失败码必须同时存在。
// 只读源码，不启动任何服务（真正的启动行为由集成环境手测）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'plugins/surfcore/lib/client.js'), 'utf8');

for (const action of ['start-selected', 'stop-selected']) {
  assert.ok(index.includes(action), `后端必须支持 ${action}`);
}
assert.ok(index.includes('NO_COMPONENTS'), '空选择必须返回结构化错误');
assert.ok(index.includes('VOICE_BRIDGE_DOWN'), '语音依赖桥接必须返回可行动错误');
assert.ok(index.includes('PLATFORM_DISABLED'), '平台开关关闭必须返回结构化错误');
assert.ok(index.includes("'QQ（含 SnowLuma）'"), '启动项标签必须包含 SnowLuma');
assert.ok(index.includes("stopSchedulerNow"), '一键停止必须能停 B站生物钟');
assert.ok(index.includes("['voice', 'qq', 'bili', 'pet']"), '停止顺序必须先语音后桥接');

for (const text of ['一键启动 SurfCore', '一键停止（全部）', 'voiceBranch', '语音分支']) {
  assert.ok(client.includes(text), `前端必须有一键启动/停止/语音分支：${text}`);
}
assert.ok(client.includes('launchErr'), '启动失败必须显示在界面上');
assert.ok(client.includes('it.hint'), '失败项必须展示下一步建议');

console.log('✅ 一键启动/停止接线通过');
