/**
 * ACP 传输层：把「一行一条 JSON」的 stdio 抽象出来。
 *
 * 为什么要抽这一层：DSH 的 ACP 服务是 stdio JSON-RPC，而本仓库的开发沙箱
 * **禁止 spawn 子进程**（实测 `EPERM`）。如果把 spawn 写死在客户端里，
 * 整个协议逻辑就一行都测不了——而 ACP 的坑（串行 prompt、阻塞回合、
 * 请求/响应按 id 配对、服务端主动发的 request_permission）恰恰只有跑起来
 * 才能验证。所以客户端只依赖本文件的接口：
 *
 *   write(line) / onLine(cb) / onExit(cb) / close()
 *
 * 生产用 {@link spawnTransport}，测试用 {@link memoryTransport}。
 */

import { spawn } from 'node:child_process';
import { fail, CODES } from './errors.js';

/** DSH 桌面端自带的 ACP 启动器路径（与 `runtime/cli/bin/dsh.cmd` 等价）。 */
export const DEFAULT_DSH_EXE = 'D:\\deepseek\\DeepSeek Harness.exe';
export const DEFAULT_DSH_CLI =
  'D:\\deepseek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';

/**
 * 用 DSH 自带的 Electron 运行时跑 ACP profile。
 *
 * 为什么是 `--expose-internals`：dsh.cmd 里就是这么调的，ACP 依赖 Node 内部
 * 模块；去掉会直接启动失败。
 *
 * @param {object} [options]
 * @param {string} [options.exe] - DeepSeek Harness.exe 路径
 * @param {string} [options.cli] - dsh-desktop-host/lib/cli.js 路径
 * @param {string} [options.profile] - 默认 `acp`
 * @param {string} [options.dshHome] - 传给子进程的 DSH_HOME；默认继承
 * @param {(msg:string)=>void} [options.log]
 * @returns {{write:Function,onLine:Function,onExit:Function,close:Function,pid:number|null}}
 */
export function spawnTransport(options = {}) {
  const exe = options.exe || DEFAULT_DSH_EXE;
  const cli = options.cli || DEFAULT_DSH_CLI;
  const profile = options.profile || 'acp';
  const log = options.log || (() => {});

  let child;
  try {
    child = spawn(exe, ['--expose-internals', cli, '--profile', profile], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(options.dshHome ? { DSH_HOME: options.dshHome } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (cause) {
    // 沙箱 EPERM、exe 不存在、被策略拦，都在这里
    throw fail(CODES.ACP_SPAWN_FAILED, `启动 DSH 失败：${cause?.message ?? cause}`, {
      hint: `确认 "${exe}" 存在且可执行；如果是在受限沙箱里跑，需要允许创建子进程。`,
      details: { code: cause?.code ?? null },
    });
  }

  const lineHandlers = [];
  const exitHandlers = [];
  const errChunks = [];
  let buf = '';
  let closed = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    // ACP 是「按行分隔的 JSON」，一行可能跨多个 chunk，也可能一个 chunk 里有多行
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      for (const fn of lineHandlers) {
        try {
          fn(line);
        } catch (e) {
          log(`ACP 行处理器抛错：${e?.message ?? e}`);
        }
      }
    }
  });

  // stderr 是诊断信息，不是协议流量。只留最后 8KB，出错时拼进错误里。
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errChunks.push(chunk);
    if (errChunks.length > 40) errChunks.shift();
  });

  child.on('error', (e) => {
    // spawn 阶段的异步失败（例如 ENOENT）也走这里
    closed = true;
    for (const fn of exitHandlers) fn({ code: null, error: e });
  });

  child.on('exit', (code, signal) => {
    closed = true;
    const stderr = errChunks.join('').slice(-4000);
    for (const fn of exitHandlers) fn({ code, signal, stderr });
  });

  return {
    pid: child.pid ?? null,
    write(line) {
      if (closed || !child.stdin.writable) return false;
      child.stdin.write(String(line).endsWith('\n') ? String(line) : `${line}\n`);
      return true;
    },
    onLine(fn) {
      lineHandlers.push(fn);
    },
    onExit(fn) {
      exitHandlers.push(fn);
    },
    close() {
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* 已经关了，忽略 */
      }
      try {
        child.kill();
      } catch {
        /* 进程可能已经退出 */
      }
    },
  };
}

/**
 * 内存传输：测试用假 DSH。
 *
 * `onServerWrite` 收到客户端写出的每一行，测试里据此模拟服务端行为；
 * `serverPush(line)` 让测试主动往客户端推一行（模拟 `session/update`、
 * `session/request_permission` 这类服务端主动消息）。
 *
 * @param {{onClientWrite?:(line:string)=>void}} [options]
 */
export function memoryTransport(options = {}) {
  const lineHandlers = [];
  const exitHandlers = [];
  const written = [];
  let closed = false;

  const transport = {
    pid: null,
    written,
    write(line) {
      if (closed) return false;
      const text = String(line);
      written.push(text);
      options.onClientWrite?.(text.trim());
      return true;
    },
    onLine(fn) {
      lineHandlers.push(fn);
    },
    onExit(fn) {
      exitHandlers.push(fn);
    },
    close() {
      closed = true;
    },
    /** 测试专用：模拟服务端推送一行。 */
    serverPush(line) {
      for (const fn of lineHandlers) fn(String(line).trim());
    },
    /** 测试专用：模拟子进程退出。 */
    serverExit(info = { code: 0 }) {
      closed = true;
      for (const fn of exitHandlers) fn(info);
    },
    get isClosed() {
      return closed;
    },
  };
  return transport;
}
