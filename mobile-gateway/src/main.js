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
import {
  createSettingsStore,
  resolveConfig,
  parseListen,
  readStartupConfig,
  ensureStartupConfigTemplate,
} from './config.js';
import { resolveDshPaths, notFoundHint } from './paths.js';
import { parseArgs, usage, isLoopbackHost, isTailscaleIp, lanAddresses } from './cli.js';
import { CODES, fail } from './errors.js';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg, data) => {
  const tail = data === undefined ? '' : ` ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  console.log(`[${stamp()}] ${msg}${tail}`);
};

// `--listen` 必须先解析：早期版本的报错文案提到了这个开关，但代码没实现，
// 照抄只会得到 `node: bad option`。现在文案与能力一致。
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (args.listen !== null) {
  try {
    parseListen(args.listen);
  } catch (e) {
    console.error(`监听地址不合法：${e.message}\n`);
    console.error(usage());
    process.exit(1);
  }
}

// ── 三段配置合流：命令行 > 环境变量 > config.json > 自动探测 ──────────────
const baseConfig = resolveConfig();
const startupCfg = readStartupConfig(baseConfig.configFile, log);

// DSH 装在哪不再写死盘符：显式目录 > 单文件环境变量 > config.json > 探测
const resolved = resolveDshPaths({
  dshDir: args.dshDir ?? null,
  configDir: typeof startupCfg.dshInstall === 'string' ? startupCfg.dshInstall : null,
  env: process.env,
});

if (resolved.missing.length > 0) {
  console.error(notFoundHint(resolved.tried ?? []));
  console.error('');
  console.error(`缺少：${resolved.missing.join(' / ')}`);
  process.exit(1);
}

// 首次运行写一份模板，让用户知道「有个文件可以改」（已存在绝不覆盖）
ensureStartupConfigTemplate(baseConfig.configFile, {
  _说明: '启动期配置，改完要重启网关；App 里能改的设置不在这里。路径会自动探测，探测失败才需要填 dshInstall',
  _listen说明: '0.0.0.0 表示允许手机连进来；只想本机用就改成 127.0.0.1:8788',
  dshInstall: resolved.installDir ?? '',
  listen: '0.0.0.0:8788',
});

const listen =
  args.listen ??
  process.env.DSH_MOBILE_LISTEN ??
  (typeof startupCfg.listen === 'string' && startupCfg.listen ? startupCfg.listen : null);

const config = resolveConfig({
  ...(listen ? { listen } : {}),
  dshExe: resolved.exe,
  dshCli: resolved.cli,
  ...(resolved.sherpa ? { sherpaNative: resolved.sherpa } : {}),
  ...(typeof startupCfg.defaultCwd === 'string' && startupCfg.defaultCwd
    ? { defaultCwd: startupCfg.defaultCwd }
    : {}),
});
const settings = createSettingsStore({ file: config.settingsFile, log });
const devices = new DeviceStore({ file: config.devicesFile, log });
log(`DSH 安装目录：${resolved.installDir ?? '(未知)'}（来源：${resolved.source}）`);
if (resolved.warnings.length > 0) {
  log(`提示：${resolved.warnings.join(' / ')} 缺失，只影响网关侧语音识别，收发消息不受影响`);
}

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

  if (isLoopbackHost(host)) {
    // 用户最容易踩的坑：在电脑浏览器里打开 127.0.0.1 一切正常，
    // 手机却永远连不上——回环地址对手机来说指的是手机自己。
    log('⚠️  当前只监听回环地址，手机连不上（127.0.0.1 对手机来说是手机自己）');
    log(`   要让手机连：node src/main.js --listen 0.0.0.0:${port}`);
  } else {
    log('⚠️  正在监听非回环地址：手机可以连进来，请确认已生成配对码、且只在可信网络里使用');
    const lan = lanAddresses();
    if (lan.length > 0) {
      log('   手机端「网关地址」填下面这个：');
      for (const ip of lan) {
        // Tailscale 的地址段是 100.64.0.0/10：出门（4G/5G）也能用，值得单独标出来
        const tag = isTailscaleIp(ip) ? '   ← Tailscale，外出也能用' : '';
        log(`   http://${ip}:${port}${tag}`);
      }
    } else {
      log('   没检测到局域网 IPv4 地址：先连上 Wi-Fi/网线，或用本机网卡 IP 手动拼地址');
    }
  }

  // 没有人配对过时自动打一个码；配对过之后只认显式的 --pair。
  // 不能无条件打：否则任何人能重启网关，就等于能拿到配对码。
  const hasDevices = devices.list().length > 0;
  if (args.pair || !hasDevices) {
    const issued = devices.issuePairCode();
    log('');
    if (args.pair) {
      log(`  配对码 ${issued.code}（5 分钟内有效，已用 --pair 强制重新生成）`);
    } else {
      log(`  首次使用：配对码 ${issued.code}（5 分钟内有效）`);
    }
    log('  在手机 App 里输入这个码即可配对；过期了就 Ctrl+C 后重新启动网关。');
    if (hasDevices) {
      log('  注意：已有设备配对过，这条是给新设备的；旧设备的令牌不受影响。');
    }
    log('');
  } else {
    log('');
    log(`  已配对设备 ${devices.list().length} 台，本次不生成配对码。`);
    log('  要换手机/重装 App：加 --pair 重新启动，会打印一个新码。');
    log('');
  }
  connect();
});

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    log(`端口 ${port} 已被占用。换一个：node src/main.js --listen 0.0.0.0:8790`);
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
