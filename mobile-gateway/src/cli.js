/**
 * 命令行参数与局域网地址探测。
 *
 * 为什么单独一层：`main.js` 的启动横幅里原本写着「换一个：--listen 127.0.0.1:8790」，
 * 但代码里根本没解析 argv——**提示了一个不存在的开关**，用户照着敲只会得到
 * `node: bad option`。凡是在文案里出现的命令，必须真的能跑。
 *
 * 只有两个参数，手写解析比拉一个依赖更划算；解析结果由 `test/cli.test.js` 钉住。
 */

import os from 'node:os';

/** 启动参数默认值。 */
export function parseArgs(argv = []) {
  const out = { listen: null, help: false, pair: false, dshDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (a === '--pair') {
      // 配对过设备之后，启动时就不再自动打码了（否则任何人重启一下就能拿到配对码）。
      // 需要一个「我人在电脑前，我要给新设备配对」的显式动作，这就是它。
      out.pair = true;
    } else if (a === '--listen') {
      out.listen = argv[i + 1] ?? '';
      i += 1;
    } else if (a.startsWith('--listen=')) {
      out.listen = a.slice('--listen='.length);
    } else if (a === '--dsh-dir') {
      // 别人电脑上 DSH 装在哪我不知道，探测不到就得让他指一下
      out.dshDir = argv[i + 1] ?? '';
      i += 1;
    } else if (a.startsWith('--dsh-dir=')) {
      out.dshDir = a.slice('--dsh-dir='.length);
    }
    // 其它参数忽略：网关不该因为一个手滑的空格就起不来
  }
  return out;
}

/** `--help` 的正文。命令必须与真实能力一致。 */
export function usage() {
  return [
    'DSH 手机网关',
    '',
    '用法：node src/main.js [选项]',
    '',
    '  --listen host:port   监听地址，默认 127.0.0.1:8788',
    '                       手机要连进来必须用 0.0.0.0:8788（或本机网卡 IP）',
    '  --pair               强制生成一个新的 6 位配对码并打印（换手机/重装 App 时用）',
    '  --dsh-dir <目录>     DSH 安装目录（里面有 "DeepSeek Harness.exe"）。',
    '                       探测不到时用它指定；也可以写进 config.json 的 dshInstall',
    '  -h, --help           显示本帮助',
    '',
    '等价环境变量：DSH_MOBILE_LISTEN / DSH_DIR / DSH_EXE / DSH_ACP_CLI',
    '',
    '示例：',
    '  node src/main.js --listen 0.0.0.0:8788',
    '  node src/main.js --listen 0.0.0.0:8788 --pair',
    '  node src/main.js --dsh-dir "C:\\Program Files\\DeepSeek Harness"',
  ].join('\n');
}

/** 是不是回环地址（手机永远连不到这些）。 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 是不是 Tailscale 的地址（100.64.0.0/10，shared address space）。 */
export function isTailscaleIp(ip) {
  const m = String(ip).match(/^100\.(\d+)\./);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/**
 * 本机可供手机使用的 IPv4 地址。
 * 过滤回环与 169.254（APIPA，说明 DHCP 没拿到地址，写出来只会误导用户）。
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces ?? {})) {
    for (const nic of list ?? []) {
      const family = typeof nic.family === 'string' ? nic.family : `IPv${nic.family}`;
      if (family !== 'IPv4' || nic.internal) continue;
      const ip = String(nic.address ?? '');
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      if (!out.includes(ip)) out.push(ip);
    }
  }
  return out;
}
