import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  findNode,
  startGateway,
  stopGateway,
  gatewayStatus,
  _resetForTest,
} from '../dsh-plugin/lib/gateway-process.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-gw-'));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function probe(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitFor(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const FAKE_GATEWAY = `
import http from 'node:http';
const i = process.argv.indexOf('--listen');
const port = Number(process.argv[i + 1].split(':')[1]);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
}).listen(port, '0.0.0.0', () => console.log('fake gateway up on ' + port));
`;

test('findNode：按与 start-gateway.bat 相同的顺序找 node', () => {
  const fromResources = findNode({
    env: {},
    resourcesPath: 'D:/deepseek/resources',
    execPath: 'C:/app/app.exe',
    platform: 'win32',
    exists: (p) => p.includes('primary-runtime'),
  });
  assert.ok(fromResources && fromResources.includes('primary-runtime'));

  const fromLocalAppData = findNode({
    env: { LOCALAPPDATA: 'C:/Users/x/AppData/Local' },
    resourcesPath: null,
    execPath: 'C:/app/app.exe',
    platform: 'win32',
    exists: (p) => p.includes('DeepSeek Harness'),
  });
  assert.equal(
    fromLocalAppData,
    path.win32.join('C:/Users/x/AppData/Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  );

  assert.equal(
    findNode({ env: {}, resourcesPath: null, execPath: 'C:/nodejs/node.exe', platform: 'win32', exists: (p) => p === 'C:/nodejs/node.exe' }),
    'C:/nodejs/node.exe',
  );

  assert.equal(
    findNode({ env: {}, resourcesPath: null, execPath: 'C:/app/DeepSeek Harness.exe', platform: 'win32', exists: () => false }),
    null,
    'Electron 的 exe 不能当 node 用，找不到时要返回 null 交给上层兜底',
  );
});

test('启动 → 健康检查通过 → 重复启动不重复拉起 → 停止', async () => {
  _resetForTest();
  const dir = tempDir();
  const script = path.join(dir, 'fake-gateway.mjs');
  fs.writeFileSync(script, FAKE_GATEWAY);
  const port = await freePort();
  const opts = { port, script, cwd: dir, logFile: path.join(dir, 'gw.log'), node: process.execPath, env: process.env };

  const started = await startGateway(opts);
  assert.equal(started.started, true, JSON.stringify(started));
  assert.ok(started.pid > 0);
  assert.equal(gatewayStatus().managed, true);
  assert.equal(await probe(port), true);

  const again = await startGateway(opts);
  assert.equal(again.already, true);
  assert.equal(again.pid, started.pid);

  assert.equal(await stopGateway(), true);
  assert.equal(await waitFor(async () => !(await probe(port))), true, '停止后端口应释放');
  assert.equal(gatewayStatus().managed, false);
  assert.equal(await stopGateway(), false, '已经停了再停应返回 false');
});

test('启动失败：进程秒退时给出 code + hint + 日志尾部', async () => {
  _resetForTest();
  const dir = tempDir();
  const script = path.join(dir, 'bad-gateway.mjs');
  fs.writeFileSync(script, `console.error('boom: no config'); process.exit(3);`);
  const port = await freePort();
  const logFile = path.join(dir, 'gw.log');

  await assert.rejects(
    () => startGateway({ port, script, cwd: dir, logFile, node: process.execPath, env: process.env }),
    (e) => {
      assert.equal(e.code, 'gateway.start-failed');
      assert.ok(e.hint && e.hint.length > 0);
      assert.match(e.hint, /boom: no config/, '日志尾部要带给用户，不能只说「启动失败」');
      return true;
    },
  );
  assert.equal(gatewayStatus().managed, false);
  assert.ok(gatewayStatus().lastError, '失败原因要能显示在状态卡里');
});
