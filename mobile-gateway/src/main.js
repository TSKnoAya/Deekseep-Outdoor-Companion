#!/usr/bin/env node
/**
 * 网关入口。
 *
 * 启动顺序有讲究：先把 HTTP 服务起来，再连 DSH。
 * 反过来会出现「手机连上了但网关还在启动、所有请求都超时」的体验，
 * 而实际上只是 DSH 冷启动要 2.8 秒。现在手机可以立刻看到 health 里的
 * `dsh.connected=false`，知道在等什么。
 */

import path from 'node:path';
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
  saveStartupConfigPatch,
} from './config.js';
import { resolveDshPaths, notFoundHint } from './paths.js';
import { createFishInjector } from './fish-inject.js';
import { createDshArchive } from './dsh-archive.js';
import { DesktopClient } from './desktop-client.js';
import { createSessionMeta } from './session-meta.js';
import { createOutreachStore } from './outreach.js';
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
let connecting = false;

/**
 * 传输选择：
 * - 默认 auto：桌面 DSH 在跑就走 RPC（手机会话与桌面同源），否则退回 ACP；
 * - `DSH_MOBILE_TRANSPORT=desktop`：只走桌面 RPC（不可用就重试，不退 ACP）；
 * - `DSH_MOBILE_TRANSPORT=acp`：保持旧行为。
 */
async function connect() {
  if (stopping || connecting) return;
  connecting = true;
  try {
    const mode = String(process.env.DSH_MOBILE_TRANSPORT || startupCfg.transport || 'auto').toLowerCase();
    if (mode !== 'acp') {
      try {
        const desktop = new DesktopClient({ dshHome, log });
        await desktop.connect();
        if (stopping) {
          desktop.destroy();
          return;
        }
        acp = desktop;
        reconnectDelay = 1000;
        log('使用桌面 DSH 传输（手机会话与桌面同源）');
        return;
      } catch (e) {
        log(`桌面 DSH 传输不可用：${e?.message ?? e}`);
        if (mode === 'desktop') {
          scheduleReconnect(e);
          return;
        }
        log('退回 ACP 传输');
      }
    }
    connectAcp();
  } finally {
    connecting = false;
  }
}

function connectAcp() {
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
const listening = parseListen(config.listen);
// DSH 的 home：ACS 模型写的是 <home>/profiles/acp，必须和 DSH 子进程看到的一致
const dshHome = config.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.dsh');

/**
 * 重开 ACP 子进程，让新写的 profile 生效。
 * 为什么不重启整个网关：模型只影响 ACP 子进程，重启网关会打断手机端的 SSE 连接。
 */
function reloadAcp() {
  log('重载 ACP：销毁旧子进程并按新配置重连');
  try {
    acp?.destroy();
  } catch {
    /* ignore */
  }
  acp = null;
  reconnectDelay = 1000;
  connect();
  return { reloaded: true };
}

const server = createGatewayServer({
  devices,
  getAcp: () => acp,
  hub,
  approvals,
  asr,
  tts,
  settings,
  log,
  // 主动搭话的补发收件箱：读 SurfCore 的 purpose-outreach.json，把"它在别处说过的话"补到手机
  outreach: createOutreachStore({
    file: path.join(config.stateDir, 'outreach.json'),
    dshHome,
    log,
  }),
  // 会话列表的标题/时间：读 DSH 的 sessions 目录（只读，带 mtime 缓存）
  sessionMeta: createSessionMeta({ dshHome }),
  // 手机侧跟随 DSH 的归档状态（只读 workspace.json，不跨进程写）
  dshArchive: createDshArchive({ file: path.join(dshHome, 'storages', 'workspace.json'), log }),
  // 「把鱼带到手机」：只在装了 SurfCore 且有当前角色时生效；`DSH_MOBILE_PERSONA=0` 可关
  fish: createFishInjector({
    dshHome,
    log,
    // 优先级：环境变量 > config.json 的 personaEnabled > 默认开
    enabled: process.env.DSH_MOBILE_PERSONA !== undefined
      ? process.env.DSH_MOBILE_PERSONA !== '0'
      : startupCfg.personaEnabled !== false,
    // 手机固定的角色（null = 跟随桌面当前角色）；同样支持环境变量覆盖
    characterId: process.env.DSH_MOBILE_PERSONA_CHARACTER !== undefined
      ? (process.env.DSH_MOBILE_PERSONA_CHARACTER || null)
      : (typeof startupCfg.personaCharacterId === 'string' && startupCfg.personaCharacterId
        ? startupCfg.personaCharacterId
        : null),
    // 开关落盘：否则重启网关又回到默认值，用户会以为开关没生效
    onToggle: (v) => saveStartupConfigPatch(baseConfig.configFile, { personaEnabled: v }),
    onCharacterChange: (id) => saveStartupConfigPatch(baseConfig.configFile, { personaCharacterId: id }),
  }),
  meta: {
    version: config.version,
    dshExe: config.dshExe,
    defaultCwd: config.defaultCwd,
    stateDir: config.stateDir,
  },
  admin: {
    dshHome,
    listen: () => listening,
    reloadAcp,
    // 手机端该填的地址：真实 IP + 端口（回环地址对手机没有意义）
    addresses: () => {
      const { host, port } = listening;
      if (isLoopbackHost(host)) {
        return { loopbackOnly: true, list: [] };
      }
      return {
        loopbackOnly: false,
        list: lanAddresses().map((ip) => ({
          ip,
          url: `http://${ip}:${port}`,
          // 100.64.0.0/10 = Tailscale，出门（4G/5G）也能用
          tailscale: isTailscaleIp(ip),
        })),
      };
    },
  },
  voiceStatus: () => ({
    asrBackend: settings.get().asrBackend,
    ttsBackend: settings.get().ttsBackend,
    announceMode: settings.get().announceMode,
  }),
});

const { host, port } = listening;
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
