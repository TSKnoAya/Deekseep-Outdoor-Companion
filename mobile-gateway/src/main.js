#!/usr/bin/env node
/**
 * 网关入口。
 *
 * 启动顺序有讲究：先把 HTTP 服务起来，再连 DSH。
 * 反过来会出现「手机连上了但网关还在启动、所有请求都超时」的体验，
 * 而实际上只是 DSH 冷启动要 2.8 秒。现在手机可以立刻看到 health 里的
 * `dsh.connected=false`，知道在等什么。
 */

import { spawnTransport } from './transport.js';
import { AcpClient } from './acp-client.js';
import { DeviceStore } from './devices.js';
import { SessionHub, ApprovalRegistry } from './hub.js';
import { BackendRegistry } from './voice/registry.js';
import { createSherpaAsr } from './voice/asr-sherpa.js';
import { createDeviceAsr } from './voice/asr-device.js';
import { createVolcengineTts } from './voice/tts-volcengine.js';
import { createGatewayServer } from './server.js';
import { createSettingsStore, resolveConfig, parseListen } from './config.js';
import { CODES, fail } from './errors.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg, data) => {
  const tail = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  console.log(`[${stamp()}] ${msg}${tail}`);
};

const config = resolveConfig();
const settings = createSettingsStore({ file: config.settingsFile, log });
const devices = new DeviceStore({ file: config.devicesFile, log });

// ── 语音后端 ────────────────────────────────────────────────────────────
const asr = new BackendRegistry('asr');
asr.register(
  createSherpaAsr({
    modelDir: config.modelsDir,
    nativePath: config.sherpaNative,
    log,
  }),
);
asr.register(createDeviceAsr());

const tts = new BackendRegistry('tts');
tts.register(
  createVolcengineTts({
    // 现读设置：用户在 App 里填完密钥不用重启网关
    readConfig: () => {
      const s = settings.get();
      return s.volcengine ?? {};
    },
  }),
);

const hub = new SessionHub({ log });
const approvals = new ApprovalRegistry({
  timeoutMs: settings.get().approvalTimeoutMs,
  log,
});

// ── 与 DSH 的连接（自动重连）─────────────────────────────────────────────
let acp = null;
let stopping = false;
let reconnectDelay = 1000;

function connect() {
  if (stopping) return;
  log(`启动 DSH（ACP profile）…`);
  let transport;
  try {
    transport = spawnTransport({
      exe: config.dshExe,
      cli: config.dshCli,
      dshHome: config.dshHome ?? undefined,
      log,
    });
  } catch (e) {
    log(`启动失败：${e.code} ${e.message}`);
    scheduleReconnect(e);
    return;
  }

  const client = new AcpClient({
    transport,
    log,
    onExit: (info) => {
      log(`DSH 进程退出（code=${info.code}）`, info.stderr ? info.stderr.slice(-500) : '');
      if (acp === client) acp = null;
      if (!stopping) scheduleReconnect(info);
    },
  });
  acp = client;

  client
    .initialize()
    .then((result) => {
      reconnectDelay = 1000; // 连上就重置退避
      log(`DSH 已连接：${result?.agentInfo?.name ?? 'unknown'} v${result?.agentInfo?.version ?? '?'}`);
      const caps = Object.keys(result?.agentCapabilities?.sessionCapabilities ?? {});
      log(`会话能力：${caps.join(', ') || '(无)'}`);
    })
    .catch((e) => {
      log(`握手失败：${e.code ?? ''} ${e.message}`);
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
      if (acp === client) acp = null;
      scheduleReconnect(e);
    });
}

function scheduleReconnect(reason) {
  if (stopping) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000); // 指数退避，封顶 30s
  log(`将在 ${Math.round(delay / 1000)} 秒后重连`, reason?.code ?? '');
  setTimeout(connect, delay).unref?.();
}

// ── HTTP ────────────────────────────────────────────────────────────────
const server = createGatewayServer({
  devices,
  getAcp: () => acp,
  hub,
  approvals,
  asr,
  tts,
  settings,
  log,
  meta: {
    version: config.version,
    dshExe: config.dshExe,
    defaultCwd: config.defaultCwd,
  },
  voiceStatus: () => ({
    asrBackend: settings.get().asrBackend,
    ttsBackend: settings.get().ttsBackend,
    announceMode: settings.get().announceMode,
  }),
});

const { host, port } = parseListen(config.listen);
server.listen(port, host, () => {
  const shown = host.includes(':') ? `[${host}]` : host;
  log(`网关已启动：http://${shown}:${port}`);
  log(`状态目录：${config.stateDir}`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    log('⚠️  正在监听非回环地址：手机可以连进来，请确认已生成配对码、且只在可信网络里使用');
  }
  // 没有任何设备时，直接生成一个配对码打出来，省得用户找不到入口
  if (devices.list().length === 0) {
    const issued = devices.issuePairCode();
    log('');
    log(`  首次使用：配对码 ${issued.code}（5 分钟内有效）`);
    log('  在手机 App 里输入这个码即可配对。');
    log('');
  }
  connect();
});

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    log(`端口 ${port} 已被占用。换一个：--listen 127.0.0.1:8790`);
  } else {
    log(`HTTP 服务出错：${e?.message ?? e}`);
  }
  process.exit(1);
});

// ── 优雅退出 ────────────────────────────────────────────────────────────
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，正在退出…`);
  try {
    settings.flush();
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    acp?.destroy();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 300).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => {
  // 未捕获的 Promise 默认会静默——那是最难查的一类问题。这里至少让它可见。
  log(`未处理的 Promise 拒绝：${e?.code ?? ''} ${e?.message ?? e}`);
});
