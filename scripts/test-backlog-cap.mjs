// Phase 3：启动补唤醒必须限量，且默认从 5 降到 3；防止重启后一次叫醒太多冷会话。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bridge = fs.readFileSync(path.resolve('src/bridge.js'), 'utf8');
assert.ok(bridge.includes('backlogMaxSessions: 3'), '默认 backlogMaxSessions 必须是 3');
assert.ok(bridge.includes('backlogMaxSessions'), 'backlog 上限必须可配置');
assert.ok(!bridge.includes('all.sort((a, b) => b.unread - a.unread).slice(0, 5)'), '旧的硬编码 5 必须移除');
assert.ok(bridge.includes('const cap = Math.max(1, Math.min(20, Number(cfg.socialV2?.wake?.backlogMaxSessions) || 3));'), 'cap 必须限制在 1~20');

const client = fs.readFileSync(path.resolve('plugins/surfcore/lib/client.js'), 'utf8');
assert.ok(client.includes('socialV2.wake.backlogMaxSessions'), '设置页必须有 backlog 上限入口');

console.log('✅ backlog 上限通过');
