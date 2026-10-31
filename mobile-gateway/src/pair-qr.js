/**
 * 扫码配对：把「网关地址 + 6 位配对码」编码成一条二维码。
 *
 * 为什么载荷里同时带地址和码：手动配对的痛点是两处抄写（地址在设置页、码在另一个位置），
 * 抄错任一处都只报「连不上」。二维码里一次带全，扫到就能直接配对。
 *
 * 载荷格式（版本化，以后改格式不破坏老 App）：
 *   dshmobile://pair?v=1&u=<URL 编码后的网关地址>&c=<6 位配对码>
 *
 * 二维码矩阵由 src/vendor/qrcode-generator.cjs 生成（MIT，单文件、无依赖）。
 * 文件保留 .cjs 后缀：本包是 "type": "module"，改成 .js 会被当 ESM，
 * 而该库是 UMD，在 ESM 下不会导出任何东西。
 *
 * 不要在网关里画 PNG/SVG：渲染交给调用方，网关只出 `{size, rows}` 这种纯数据，
 * 方便测试，也不受 DSH 页面 CSP 限制。
 */

import qrcode from './vendor/qrcode-generator.cjs';

export const PAIR_SCHEME = 'dshmobile';
export const PAIR_HOST = 'pair';
export const PAIR_PAYLOAD_VERSION = '1';
/** M 级纠错：37×37 模块，容错约 15%，手机对着屏幕扫足够稳。 */
export const PAIR_QR_ECC = 'M';

/**
 * 拼二维码载荷。地址必须是 http/https —— 手机端拿到后会直接拿去请求，
 * 不允许 `javascript:` / `file:` 这类别的东西混进来。
 */
export function buildPairPayload({ url, code }) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error(`网关地址必须是 http/https：${target}`);
  const digits = String(code ?? '').trim();
  if (!/^\d{6}$/.test(digits)) throw new Error(`配对码必须是 6 位数字：${digits}`);
  const q = new URLSearchParams({ v: PAIR_PAYLOAD_VERSION, u: target, c: digits });
  return `${PAIR_SCHEME}://${PAIR_HOST}?${q.toString()}`;
}

/**
 * 解析扫描结果。
 *
 * 兼容两种内容：
 *  - 本程序生成的 `dshmobile://pair?...` → `{url, code}`；
 *  - 只有地址的普通 http(s) 链接 → `{url, code: null}`（App 填地址、让用户补 6 位码）。
 * 其它内容一律 null，调用方要明确告诉用户「这不是配对二维码」。
 */
export function parsePairPayload(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!u.hostname) return null;
      return { url: raw, code: null };
    } catch {
      return null;
    }
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== `${PAIR_SCHEME}:` || u.host !== PAIR_HOST) return null;
  const url = String(u.searchParams.get('u') ?? '').trim();
  const code = String(u.searchParams.get('c') ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return null;
  if (!/^\d{6}$/.test(code)) return null;
  return { url, code };
}

/**
 * 生成二维码矩阵。
 * @returns {{size:number, rows:string[]}} rows 是 '0'/'1' 字符串，索引 [y][x]；不含静区。
 */
export function qrMatrix(text) {
  const content = String(text ?? '');
  if (!content) throw new Error('二维码内容为空');
  const qr = qrcode(0, PAIR_QR_ECC);
  try {
    qr.addData(content);
    qr.make();
  } catch (e) {
    // 容量溢出等：宁可报错，也不要生成一个扫不出来的码
    throw new Error(`二维码内容过长或无法编码：${e?.message ?? e}`);
  }
  const size = qr.getModuleCount();
  const rows = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) row += qr.isDark(y, x) ? '1' : '0';
    rows.push(row);
  }
  return { size, rows };
}

/** 一个地址 + 配对码 → 载荷与矩阵（服务端 /admin/pair 用）。 */
export function makePairQr({ url, code }) {
  const payload = buildPairPayload({ url, code });
  return { payload, qr: qrMatrix(payload) };
}
