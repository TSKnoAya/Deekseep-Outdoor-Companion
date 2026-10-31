/**
 * 网关子进程管理（插件宿主侧）。
 *
 * 存在的理由：用户不该为了开一个后台服务去双击 bat / 开命令行。
 * DSH 设置页点一下「启动网关」，这里就用与 start-gateway.bat 相同的参数
 * （`--listen 0.0.0.0:8788 --pair`）把网关拉起来，日志落到
 * `<DSH_HOME>/mobile-gateway/gateway.log`，失败时把日志尾部原样交给前端。
 *
 * 两个容易踩的点：
 * 1. DSH 主进程的 `process.execPath` 是 **Electron 的 exe**，不是 node；
 *    直接 spawn 它会把 argv 当应用参数。优先用 DSH 自带的 node，
 *    真找不到时才用 `ELECTRON_RUN_AS_NODE=1` 兜底。
 * 2. Windows 上 `child.kill()` 只杀网关本身，它 spawn 的 DSH(ACP) 子进程会留下；
 *    所以停止用 `taskkill /T /F` 杀整棵进程树。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, fail } from '../../src/errors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dsh-plugin/lib → mobile-gateway */
const GATEWAY_ROOT = path.resolve(HERE, '../..');
const GATEWAY_SCRIPT = path.join(GATEWAY_ROOT, 'src', 'main.js');

export const DEFAULT_PORT = 8788;

/** 正在被本插件管理的网关进程。 */
let managed = null; // { child, pid, port, log, fd }
let lastError = null;
let starting = null;

export function gatewayStatus() {
  const alive = Boolean(managed && managed.child.exitCode === null);
  return {
    managed: alive,
    pid: alive ? managed.pid : null,
    log: logFile(),
    lastError: alive ? null : lastError,
  };
}

/** 找可用的 node.exe。顺序与 start-gateway.bat 保持一致，避免「bat 能起、按钮不能起」。 */
export function findNode({
  env = process.env,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const bin = platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [];
  if (env.DSH_MOBILE_NODE) candidates.push(env.DSH_MOBILE_NODE);
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', bin));
  }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        env.LOCALAPPDATA,
        'Programs',
        'DeepSeek Harness',
        'resources',
        'runtime',
        'primary-runtime',
        'dependencies',
        'node',
        'bin',
        'node.exe',
      ),
    );
  }
  if (platform === 'win32' && env.ProgramFiles) {
    candidates.push(path.join(env.ProgramFiles, 'nodejs', 'node.exe'));
  }
  if (/(^|[\\/])node(\.exe)?$/i.test(execPath)) candidates.push(execPath);
  for (const p of candidates) {
    try {
      if (p && exists(p)) return p;
    } catch {
      /* 单个候选坏掉不影响其它候选 */
    }
  }
  return null;
}

function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function logFile(env = process.env) {
  return path.join(dshHome(env), 'mobile-gateway', 'gateway.log');
}

function resolveRuntime({ node, env = process.env } = {}) {
  if (node) return { exe: node, electron: false };
  const found = findNode({ env });
  if (found) return { exe: found, electron: false };
  // 没有独立 node：DSH 的 Electron 二进制加这个开关会按 node 运行
  return { exe: process.execPath, electron: Boolean(process.versions?.electron) };
}

function probe(port, timeoutMs = 800) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(file, maxChars = 1200) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > maxChars ? text.slice(-maxChars) : text;
  } catch {
    return '';
  }
}

/**
 * 启动网关。已经活着（不管是本插件还是手动起的）就直接返回，不重复 spawn。
 * @param {object} [opts] - 仅测试用：port / script / cwd / logFile / node / env
 */
export async function startGateway(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  if (managed && managed.child.exitCode === null) {
    return { running: true, already: true, pid: managed.pid, port: managed.port, log: managed.log };
  }
  if (await probe(port)) {
    return { running: true, already: true, pid: null, port, log: opts.logFile ?? logFile(opts.env) };
  }
  if (starting) return starting;
  starting = doStart({ ...opts, port }).finally(() => {
    starting = null;
  });
  return starting;
}

async function doStart({ port, script = GATEWAY_SCRIPT, cwd = GATEWAY_ROOT, logFile: file, node, env = process.env }) {
  if (!fs.existsSync(script)) {
    throw fail(CODES.NOT_FOUND, `找不到网关入口：${script}`, {
      hint: '插件和网关要放在同一个 mobile-gateway 目录里；也可以手动双击 start-gateway.bat。',
    });
  }
  const runtime = resolveRuntime({ node, env });
  const log = file ?? logFile(env);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  fs.writeSync(
    fd,
    `\n=== ${new Date().toISOString()} 从 DSH 设置页启动：${runtime.exe} ${script} --listen 0.0.0.0:${port} --pair\n`,
  );

  const child = spawn(runtime.exe, [script, '--listen', `0.0.0.0:${port}`, '--pair'], {
    cwd,
    env: {
      ...env,
      ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });

  const entry = { child, pid: child.pid, port, log, fd };
  managed = entry;
  lastError = null;

  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  child.once('exit', () => {
    try {
      fs.closeSync(fd);
    } catch {
      /* 已被 stopGateway 收走 */
    }
    if (managed === entry) managed = null;
  });

  // HTTP 起来就算成功（DSH/ACP 是随后异步连的，状态在 ① 卡片里单独显示）
  for (let i = 0; i < 40; i += 1) {
    if (await probe(port)) {
      return { running: true, started: true, pid: child.pid, port, log };
    }
    const result = await Promise.race([exited, sleep(300).then(() => null)]);
    if (result) {
      const reason = result.error
        ? `无法启动进程：${result.error.message}`
        : `进程退出（code=${result.code ?? '-'} signal=${result.signal ?? '-'}）`;
      throw startFailed(entry, reason, log);
    }
  }

  throw startFailed(entry, '启动超时（12 秒内没监听 ' + port + '）', log);
}

/** 启动失败：先把进程/句柄收干净，再抛结构化错误（code + error + hint 都有）。 */
function startFailed(entry, reason, log) {
  if (managed === entry) managed = null;
  try {
    fs.closeSync(entry.fd);
  } catch {
    /* 已关闭 */
  }
  try {
    if (entry.child.exitCode === null) {
      if (process.platform === 'win32' && entry.pid) {
        // 连同它可能已经 spawn 的 DSH/ACP 一起收掉，别留孤儿
        spawn('taskkill', ['/pid', String(entry.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        entry.child.kill();
      }
    }
  } catch {
    /* 已退出 */
  }
  const tailText = tail(log);
  lastError = { error: reason, hint: tailText };
  return fail('gateway.start-failed', `网关没起来：${reason}`, {
    hint: `${tailText ? `日志最后几行：\n${tailText}` : '日志是空的。'}\n日志文件：${log}\n常见原因：8788 被别的程序占用、DSH 安装目录变了、没有可用的 node。`,
  });
}

/** 停止本插件启动的网关（连同它 spawn 的 DSH/ACP 子进程）。 */
export async function stopGateway() {
  const entry = managed;
  if (!entry || entry.child.exitCode !== null) return false;
  managed = null;
  const pid = entry.pid;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('exit', resolve);
      killer.once('error', resolve);
    });
  } else {
    try {
      entry.child.kill('SIGTERM');
    } catch {
      /* 已经退出 */
    }
  }
  return true;
}

/** 仅供测试：清掉模块内状态。 */
export function _resetForTest() {
  managed = null;
  lastError = null;
  starting = null;
}
