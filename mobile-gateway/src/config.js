/**
 * 网关配置与设置。全部落在 `state/mobile-gateway/`（在 .gitignore 覆盖范围内）。
 *
 * 两条原则：
 * 1. **设置必须现读**。surfcore 的 voice-packs 踩过一次：配置在启动时读进内存，
 *    用户在设置页改完「看起来没生效」，直到重启才对。这里每次取都读内存里的
 *    单一对象（由文件加载一次、写回时同时更新），改动立即生效。
 * 2. **坏文件不能让服务起不来**。JSON 坏了就隔离后从默认值开始，
 *    而不是 throw（对齐 AGENTS.md「单个坏数据不能让服务起不来」）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail } from './errors.js';

/** 网关默认设置。新增字段都要有默认值，否则老用户的设置文件会缺字段。 */
export const DEFAULT_SETTINGS = {
  /** ASR 后端：gateway-sherpa | device-native */
  asrBackend: 'gateway-sherpa',
  /** TTS 后端：volcengine | none */
  ttsBackend: 'volcengine',
  /** 播报档位：all | short | headset-only | off */
  announceMode: 'short',
  /** 短回答阈值（字） */
  shortLimit: 80,
  /** ACP 一轮的审批超时（毫秒） */
  approvalTimeoutMs: 300_000,
  /** 火山引擎（只存结构，值是用户自己填的） */
  volcengine: {
    appId: '',
    accessToken: '',
    resource: 'seed-icl-2.0',
    speaker: '',
  },
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 设置存储。
 * @param {object} options
 * @param {string} options.file - settings.json 路径
 * @param {(msg:string)=>void} [options.log]
 */
export function createSettingsStore({ file, log = () => {} }) {
  let current = structuredClone(DEFAULT_SETTINGS);
  let saveTimer = null;

  function load() {
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      current = deepMerge(DEFAULT_SETTINGS, doc?.settings ?? doc ?? {});
      log(`设置已加载：${file}`);
    } catch (e) {
      if (e?.code === 'ENOENT') {
        log('设置文件不存在，使用默认值');
        return;
      }
      log(`设置文件损坏（${e?.message}），已隔离并回到默认值`);
      try {
        fs.renameSync(file, `${file}.broken-${Date.now()}`);
      } catch {
        /* 隔离失败也不能让启动挂掉 */
      }
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: current }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** 合并写盘（节流：App 改一个开关不值得立刻落盘）。 */
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        save();
      } catch (e) {
        log(`设置写盘失败：${e?.message ?? e}`);
      }
    }, 250);
    saveTimer.unref?.();
  }

  load();

  return {
    /** 当前设置的**副本**（防止调用方改了对象却以为已保存）。 */
    get() {
      return structuredClone(current);
    },
    /**
     * 合并更新。会校验枚举值——让 App 传进来一个拼错的档位时立刻失败，
     * 而不是悄悄存下来、之后行为诡异。
     */
    set(patch = {}) {
      const next = deepMerge(current, patch);
      if (next.asrBackend !== undefined && !['gateway-sherpa', 'device-native'].includes(next.asrBackend)) {
        throw fail(CODES.BAD_REQUEST, `未知的转写后端：${next.asrBackend}`, {
          details: { allowed: ['gateway-sherpa', 'device-native'] },
        });
      }
      if (next.announceMode !== undefined && !['all', 'short', 'headset-only', 'off'].includes(next.announceMode)) {
        throw fail(CODES.BAD_REQUEST, `未知的播报档位：${next.announceMode}`, {
          details: { allowed: ['all', 'short', 'headset-only', 'off'] },
        });
      }
      const limit = Number(next.shortLimit);
      if (!Number.isFinite(limit) || limit < 10 || limit > 2000) {
        throw fail(CODES.BAD_REQUEST, `短回答阈值要在 10~2000 之间（收到 ${next.shortLimit}）`, {});
      }
      next.shortLimit = Math.round(limit);
      current = next;
      scheduleSave();
      return structuredClone(current);
    },
    /** 立刻落盘（进程退出前用）。 */
    flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      save();
    },
  };
}

/**
 * 网关运行配置。和「设置」分开：这些是启动参数，改了要重启。
 *
 * @param {object} [overrides] - 便于测试注入
 */
export function resolveConfig(overrides = {}) {
  const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.cwd(), '.dsh');
  const stateDir = overrides.stateDir || path.join(home, 'mobile-gateway');
  return {
    /** 监听地址。默认回环；要让手机连必须显式改（并且有设备令牌） */
    listen: overrides.listen || process.env.DSH_MOBILE_LISTEN || '127.0.0.1:8788',
    stateDir,
    devicesFile: overrides.devicesFile || path.join(stateDir, 'devices.json'),
    settingsFile: overrides.settingsFile || path.join(stateDir, 'settings.json'),
    modelsDir: overrides.modelsDir || path.join(stateDir, 'models'),
    /** DSH 可执行文件与 ACP 启动器 */
    dshExe: overrides.dshExe || process.env.DSH_EXE ||
      'D:\\deepseek\\DeepSeek Harness.exe',
    dshCli: overrides.dshCli || process.env.DSH_ACP_CLI ||
      'D:\\deepseek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    dshHome: overrides.dshHome ?? process.env.DSH_HOME ?? null,
    /** 新建会话时用的工作目录 */
    defaultCwd: overrides.defaultCwd || process.cwd(),
    /** sherpa 原生模块 */
    sherpaNative: overrides.sherpaNative || process.env.DSH_SHERPA_NATIVE ||
      'D:\\deepseek\\resources\\app.asar.unpacked\\dsh\\node_modules\\sherpa-onnx-win-x64\\sherpa-onnx.node',
    version: overrides.version || '0.1.0',
  };
}

/**
 * 解析 `host:port`。要处理 `[::1]:8788` 这种 IPv6 写法——
 * 直接 `split(':')` 会把 `[::1]` 切成空串，是个典型的死分支（surfcore 踩过，PITFALLS #72）。
 */
export function parseListen(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw fail(CODES.BAD_REQUEST, '监听地址是空的', {});
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) throw fail(CODES.BAD_REQUEST, `监听地址要写成 host:port（收到 ${raw}）`, {});
  const host = raw.slice(0, idx).replace(/^\[|\]$/g, '');
  const port = Number(raw.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw fail(CODES.BAD_REQUEST, `端口不合法：${raw.slice(idx + 1)}`, {});
  }
  return { host, port };
}
