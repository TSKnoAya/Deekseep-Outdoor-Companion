/**
 * 「主动搭话」的补发收件箱。
 *
 * 为什么不是"网关自己生成一句开场"：
 * 那只是假装它想你了。真正的主动消息是 **SurfCore 的目的机制**发出来的
 * （QQ / 桌宠 / B 站各自有载体），手机上要做的不是凭空造一句，
 * 而是**把它在别处说过的话补给你看**——否则"带出门"就只是一半。
 *
 * 数据从哪来：
 * - 自动：SurfCore 的 `characters/<id>/purpose-outreach.json` 里
 *   `lastText` + `lastSentAt` 就是"最近一次主动说出去的话"；
 *   每发现一个新的 `lastSentAt`，就入队一条。
 * - 手动：任何东西都可以 `POST /v1/outreach`（本机）塞一条，方便将来接别的载体。
 *
 * 为什么不直接推送：那要 Android 前台服务 + 通知权限（改 APK、耗电、MIUI 还会杀后台）。
 * 所以这里是"打开 App 时补发"，先把内容通路做对，推送留到以后。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_ITEMS = 50;

function readJson(file, fsLike) {
  try {
    return JSON.parse(fsLike.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.file - 收件箱文件（`~/.dsh/mobile-gateway/outreach.json`）
 * @param {string} [options.dshHome]
 * @param {(m:string)=>void} [options.log]
 * @param {object} [options.fsLike]
 */
export function createOutreachStore(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const file = options.file;
  const log = options.log ?? (() => {});
  const dshHome = options.dshHome;

  let state = readJson(file, fsLike) ?? {};
  if (!Array.isArray(state.items)) state.items = [];
  if (!Number.isFinite(state.lastSurfSentAt)) state.lastSurfSentAt = 0;
  let seq = Number.isFinite(state.seq) ? state.seq : state.items.length;

  function save() {
    try {
      fsLike.mkdirSync(path.dirname(file), { recursive: true });
      fsLike.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      log(`收件箱写入失败：${e?.message ?? e}`);
    }
  }

  function append({ text, at, source, character }) {
    const body = String(text ?? '').trim();
    if (!body) return null;
    seq += 1;
    const item = {
      id: `o${seq}`,
      text: body.slice(0, 2000),
      at: Number(at) || Date.now(),
      source: String(source ?? 'unknown'),
      character: character ? String(character) : null,
    };
    state.items.push(item);
    if (state.items.length > MAX_ITEMS) state.items = state.items.slice(-MAX_ITEMS);
    state.seq = seq;
    save();
    return item;
  }

  /**
   * 读 SurfCore 的目的状态，把"新的主动消息"入队。
   *
   * 只认 `lastSentAt` 比上次见过的大，且 `lastText` 非空——
   * 因为那个文件每次 tick 都会重写（drives/nextFireAt 在变），不能看 mtime。
   */
  function syncFromSurfCore() {
    if (!dshHome) return 0;
    const surfDir = path.join(dshHome, 'surfcore', 'characters');
    let charId = null;
    try {
      const cur = readJson(path.join(surfDir, 'current.json'), fsLike);
      charId = cur?.id ? String(cur.id) : null;
    } catch {
      return 0;
    }
    // 没建角色的老布局没有 purpose 文件，直接跳过
    if (!charId) return 0;

    const file2 = path.join(surfDir, charId, 'purpose-outreach.json');
    const doc = readJson(file2, fsLike);
    if (!doc) return 0;

    const sentAt = Number(doc.lastSentAt) || 0;
    const text = String(doc.lastText ?? '').trim();
    if (sentAt <= state.lastSurfSentAt || !text) return 0;

    state.lastSurfSentAt = sentAt;
    const item = append({
      text,
      at: sentAt,
      source: 'surfcore-purpose',
      character: charId,
    });
    if (item) log(`主动消息入队：${item.text.slice(0, 20)}…`);
    save();
    return item ? 1 : 0;
  }

  return {
    /** 未读列表（按时间正序，App 直接按顺序插进对话即可）。 */
    pending() {
      syncFromSurfCore();
      return state.items.map((x) => ({ ...x }));
    },
    append,
    ack(ids) {
      const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
      const before = state.items.length;
      state.items = state.items.filter((x) => !set.has(x.id));
      if (state.items.length !== before) save();
      return { removed: before - state.items.length, remaining: state.items.length };
    },
    sync: syncFromSurfCore,
    status() {
      return { pending: state.items.length, lastSurfSentAt: state.lastSurfSentAt || null };
    },
  };
}
