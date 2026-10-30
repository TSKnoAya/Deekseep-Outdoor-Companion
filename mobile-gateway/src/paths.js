/**
 * DSH 安装位置的探测。
 *
 * 为什么需要这一层：早期版本把三个路径写死在 `config.js` 里，全是
 * `D:\deepseek\...`——那是**我这台机器**的安装位置。别人装在 C 盘、或者
 * 用默认的 `%LOCALAPPDATA%\Programs\...`，网关直接起不来，报错还只说
 * 「启动 DSH 失败」，用户无从下手。
 *
 * 解析顺序（_后读到的赢_）：
 *   1. `--dsh-dir` 命令行参数
 *   2. 环境变量 `DSH_DIR` / `DSH_INSTALL_DIR`
 *   3. 环境变量 `DSH_EXE` / `DSH_ACP_CLI` / `DSH_SHERPA_NATIVE`（单文件覆盖）
 *   4. `~/.dsh/mobile-gateway/config.json` 里的 `dshInstall`
 *   5. 自动探测（常见安装目录 + 各盘根下的 `deepseek` 目录）
 *
 * 探测结果**不猜**：只有 exe 真的存在才算命中；全部失败就返回候选清单，
 * 让调用方把「我去哪找过」原样打给用户——这比「启动失败」四个字有用得多。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DSH_EXE_NAME = 'DeepSeek Harness.exe';

/** 安装目录 → ACP 启动器路径（Electron 打包后的固定相对结构）。 */
export function cliPathFor(installDir) {
  return path.win32.join(
    installDir,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  );
}

/** 安装目录 → sherpa 原生模块路径（`app.asar.unpacked` 里才是真文件）。 */
export function sherpaPathFor(installDir) {
  return path.win32.join(
    installDir,
    'resources',
    'app.asar.unpacked',
    'dsh',
    'node_modules',
    'sherpa-onnx-win-x64',
    'sherpa-onnx.node',
  );
}

const DRIVES = ['C', 'D', 'E', 'F', 'G', 'H'];

/**
 * 可能装 DSH 的目录清单（顺序即优先级：越靠前越可能是「用户自己选的目录」）。
 * @param {object} [env]
 */
export function candidateDirs(env = process.env) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const norm = String(p).replace(/[\\/]+$/, '');
    if (norm && !out.includes(norm)) out.push(norm);
  };

  // ① 显式指定（最可信）
  push(env.DSH_DIR);
  push(env.DSH_INSTALL_DIR);
  if (env.DSH_EXE) push(path.win32.dirname(env.DSH_EXE));

  // ② 各平台默认安装位置
  const local = env.LOCALAPPDATA;
  const roaming = env.APPDATA;
  const pf = env.PROGRAMFILES;
  const pf86 = env['PROGRAMFILES(X86)'];
  const userProfile = env.USERPROFILE;

  if (local) {
    push(path.win32.join(local, 'Programs', 'DeepSeek Harness'));
    push(path.win32.join(local, 'Programs', 'deepseek-harness'));
    push(path.win32.join(local, 'DeepSeek Harness'));
  }
  if (roaming) push(path.win32.join(roaming, 'DeepSeek Harness'));
  if (pf) push(path.win32.join(pf, 'DeepSeek Harness'));
  if (pf86) push(path.win32.join(pf86, 'DeepSeek Harness'));
  if (userProfile) {
    push(path.win32.join(userProfile, 'AppData', 'Local', 'Programs', 'DeepSeek Harness'));
    push(path.win32.join(userProfile, 'Desktop', 'DeepSeek Harness'));
  }

  // ③ 各盘根下常见的手动目录名（本机就是 D:\deepseek 这种装法）
  for (const d of DRIVES) {
    push(`${d}:\\deepseek`);
    push(`${d}:\\DeepSeek`);
    push(`${d}:\\dsh`);
    push(`${d}:\\DeepSeek Harness`);
  }

  return out;
}

/**
 * 在候选目录里找 `DeepSeek Harness.exe`；找不到就扫一遍各盘根下的目录名
 * （只扫一层，名字含 deepseek 的才进去看，避免把整块盘走一遍）。
 *
 * @param {object} [options]
 * @param {string[]} [options.dirs] - 直接给定候选（测试用）
 * @param {object} [options.env]
 * @param {{existsSync:Function,readdirSync?:Function}} [options.fsLike] - 便于测试注入
 * @returns {{installDir:string,exe:string,cli:string,sherpa:string}|null}
 */
export function detectInstall(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const env = options.env ?? process.env;
  const dirs = options.dirs ?? candidateDirs(env);
  const tried = [];

  const hit = (dir) => {
    const exe = path.win32.join(dir, DSH_EXE_NAME);
    tried.push(exe);
    try {
      if (!fsLike.existsSync(exe)) return null;
    } catch {
      return null;
    }
    return { installDir: dir, exe, cli: cliPathFor(dir), sherpa: sherpaPathFor(dir) };
  };

  for (const dir of dirs) {
    const found = hit(dir);
    if (found) return found;
  }

  // 兜底：扫各盘根目录里名字像 deepseek 的文件夹
  if (typeof fsLike.readdirSync === 'function') {
    for (const d of DRIVES) {
      const root = `${d}:\\`;
      let entries = [];
      try {
        entries = fsLike.readdirSync(root, { withFileTypes: true });
      } catch {
        continue; // 盘符不存在/无权限，正常
      }
      for (const e of entries) {
        const name = String(e.name ?? '');
        if (!/deepseek|harness|dsh/i.test(name)) continue;
        if (typeof e.isDirectory === 'function' && !e.isDirectory()) continue;
        const found = hit(path.win32.join(root, name));
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * 这个路径能不能用 `fs.existsSync` 判断存在？
 *
 * **不能的**：`app.asar` 内部的路径。asar 是个归档文件，普通 Node fs 看不进去
 * （只有 Electron 运行时能解析），于是 `existsSync('...app.asar\\...\\cli.js')`
 * 恒为 false——早期版本因此在本机都报「找不到 cli」，实际上完全可用，
 * 直到真正 spawn 才知道对不对。
 *
 * `app.asar.unpacked` 是真实的解包目录，能正常判断。
 */
export function isInsideAsar(p) {
  const s = String(p ?? '');
  if (!s) return false;
  if (/app\.asar\.unpacked/i.test(s)) return false;
  return /[\\/]app\.asar[\\/]/i.test(s) || /\.asar[\\/]/i.test(s);
}

/**
 * 汇总最终使用的 DSH 路径。优先级：单文件环境变量 > 目录（参数/环境/配置/探测）。
 *
 * @param {object} [options]
 * @param {string} [options.dshDir] - `--dsh-dir` 的值
 * @param {string} [options.configDir] - `config.json` 里的 `dshInstall`
 * @param {object} [options.env]
 * @param {object} [options.fsLike]
 * @returns {{installDir:string|null,exe:string|null,cli:string|null,sherpa:string|null,
 *            source:string,missing:string[],warnings:string[],tried:string[]}}
 */
export function resolveDshPaths(options = {}) {
  const env = options.env ?? process.env;
  const fsLike = options.fsLike ?? fs;

  const explicitDir = options.dshDir || env.DSH_DIR || env.DSH_INSTALL_DIR || options.configDir || null;
  let detected = null;

  // 显式给了目录就先信它（哪怕 exe 不存在，也要如实报错，而不是悄悄换成别的）
  if (explicitDir) {
    const dir = String(explicitDir).replace(/[\\/]+$/, '');
    const exe = env.DSH_EXE || path.win32.join(dir, DSH_EXE_NAME);
    detected = { installDir: dir, exe, cli: cliPathFor(dir), sherpa: sherpaPathFor(dir) };
  } else {
    detected = detectInstall({ env, fsLike });
  }

  const base = detected ?? { installDir: null, exe: null, cli: null, sherpa: null };
  const exe = env.DSH_EXE || base.exe;
  const cli = env.DSH_ACP_CLI || base.cli;
  const sherpa = env.DSH_SHERPA_NATIVE || base.sherpa;

  const exists = (p) => {
    if (!p) return false;
    // asar 内部的路径普通 fs 看不进去，不当「缺失」处理（交给 spawn 去证伪）
    if (isInsideAsar(p)) return true;
    try {
      return fsLike.existsSync(p);
    } catch {
      return false;
    }
  };

  const missing = [];
  if (!exists(exe)) missing.push(`exe:${exe ?? '(未找到)'}`);
  if (!exists(cli)) missing.push(`cli:${cli ?? '(未找到)'}`);
  // sherpa 缺失只影响「网关侧语音识别」，不影响收发消息，所以不算致命
  const warnings = [];
  if (!exists(sherpa)) warnings.push(`sherpa:${sherpa ?? '(未找到)'}`);

  let source = 'detect';
  if (env.DSH_EXE || env.DSH_ACP_CLI) source = 'env-file';
  else if (options.dshDir) source = 'arg';
  else if (env.DSH_DIR || env.DSH_INSTALL_DIR) source = 'env-dir';
  else if (options.configDir) source = 'config';
  else if (!detected) source = 'none';

  return {
    installDir: base.installDir ?? (exe ? path.win32.dirname(exe) : null),
    exe,
    cli,
    sherpa,
    source,
    missing,
    warnings,
    tried: detected ? [] : candidateDirs(env),
  };
}

/** 找不到 DSH 时给用户看的话。要说清「找过哪、下一步做什么」。 */
export function notFoundHint(tried = []) {
  const lines = [
    '没找到 DSH（DeepSeek Harness）。网关必须知道它装在哪',
    '  ① 先确认 DSH 已安装并登录过一次',
    '  ② 启动时指定目录：node src/main.js --dsh-dir "你的安装目录"',
    `     安装目录里应直接有 "${DSH_EXE_NAME}"`,
    '  ③ 或写进配置文件：%USERPROFILE%\\.dsh\\mobile-gateway\\config.json',
    '     {"dshInstall": "你的安装目录"}',
  ];
  if (tried.length > 0) {
    lines.push('  找过这些位置（都没命中）：');
    for (const d of tried.slice(0, 8)) lines.push(`    ${d}`);
    if (tried.length > 8) lines.push(`    …还有 ${tried.length - 8} 处`);
  }
  return lines.join('\n');
}
