/**
 * 会话元数据：给 `/v1/sessions` 补上「标题 + 最后活动时间」。
 *
 * 为什么需要它：ACP 的 `session/list` 只返回 `{ sessionId, cwd }`，
 * 手机上列出来就是一串 uuid，用户根本认不出哪段是"问我代码那次"。
 *
 * 数据从哪来：DSH 把每个会话压成
 * `~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`，
 * 里面第一条 `user/message` 就是这段对话的开头（最适合当标题），
 * 文件的 mtime 就是最后活动时间。
 *
 * 为什么不复制 DSH 的目录编码规则：那个编码（`C:\Users\…` → `--C-Users-…--`）
 * 是内部实现，改一次我们就全错。直接扫 `sessions/*` 找 `session-<id>` 更稳，
 * 目录数量本来就很少（按工作区分）。
 *
 * 成本控制：
 * - 结果按「路径 + mtime + 大小」缓存，没改过的会话不重复解压；
 * - 超过 `maxBytes` 的会话只给时间不给标题（解压几十 MB 换一个标题不值）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 把「一条用户消息」洗成能当标题的文本。
 *
 * 为什么需要洗：手机走的 ACP 会话里，第一条 user/message 是**我们自己拼的前言**
 * （人格卡 + 记忆卡 + 渠道说明），真正的用户原话被 `\n\n---\n\n` 隔在后面。
 * DSH 会拿这条消息自动生成 `session/title`，于是标题变成
 * 「【你是下面这个角色，请一直」这种鬼东西（实测）。
 *
 * 所以：优先取分隔符之后的部分；没有分隔符但以【…】/`<system-reminder>`/
 * `Current …` 开头的，一律当成"不是人说的话"，返回空串跳过。
 */
export function cleanUserText(raw) {
  // 记忆卡是 CRLF 存的，拼出来的分隔符会变成 \r\n\r\n---\r\n\r\n，必须先归一
  let t = String(raw ?? '').replace(/\r\n/g, '\n');
  const SEP = '\n\n---\n\n';
  const sep = t.lastIndexOf(SEP);
  if (sep >= 0) t = t.slice(sep + SEP.length);
  // 前言里的【…】块（可能不止一个）
  while (/^\s*【[^】]*】/.test(t)) t = t.replace(/^\s*【[^】]*】\s*/, '');
  const head = t.trimStart();
  if (!head) return '';
  // 只剩前言（被截断成「【你是下面这个角色，请一直」）也不能当标题
  if (head.startsWith('【')) return '';
  if (/^<\/?(system-reminder|skill_content|available_skills)\b/i.test(head)) return '';
  if (/^Current (working directory|runtime context|DSH file policy)/i.test(head)) return '';
  // DSH 会把这些**当成 user/message 写进会话日志**，它们不是人说的话（真机踩到：
  // 重启 App 加载历史时，「Time sampled while preparing turn 1…」被渲染成一条消息）
  if (/^Time sampled while preparing turn/i.test(head)) return '';
  if (/^Browser time zone for this request/i.test(head)) return '';
  if (/^Elapsed since the preceding model-visible message/i.test(head)) return '';
  if (/This snapshot supersedes earlier runtime-context snapshots/i.test(head)) return '';
  return head.trim();
}

/** 从解压后的 jsonl 文本里挑标题与首个用户消息。 */
export function extractMeta(raw) {
  let title = null;
  let firstUser = null;
  const lines = String(raw).split('\n');
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === 'session/title' && !title) {
      const t = o.data?.title ?? o.title;
      if (typeof t === 'string' && t.trim()) {
        // DSH 的自动标题取的是第一条消息 —— 被前言污染时宁可不用
        const cleaned = cleanUserText(t);
        title = cleaned || null;
      }
    }
    if (o.type === 'user/message' && !firstUser) {
      const cleaned = cleanUserText(textOf(o));
      if (cleaned) firstUser = cleaned;
    }
    if (title && firstUser) break;
  }
  return { title, firstUser };
}

/** 事件里的正文可能在 data.content（数组块）或 data.text。 */
function textOf(o) {
  const d = o.data ?? {};
  const c = d.content ?? d.text ?? '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .join('');
  }
  return '';
}

/**
 * 用户消息的展示文本。
 *
 * 只在「看起来是注入/系统文本」时才用 cleanUserText：
 * 普通用户消息原样保留（避免把以 `<`、`【` 开头的正常文本误删）。
 */
function userMessageText(raw) {
  const t = String(raw ?? '').replace(/\r\n/g, '\n');
  const looksInjected =
    t.includes('\n\n---\n\n') ||
    /^\s*【/.test(t) ||
    /^\s*<\/?(system-reminder|skill_content|available_skills)\b/i.test(t) ||
    /^Current (working directory|runtime context|DSH file policy)/i.test(t) ||
    /^Time sampled while preparing turn/i.test(t) ||
    /^Browser time zone for this request/i.test(t) ||
    /This snapshot supersedes earlier runtime-context snapshots/i.test(t);
  return looksInjected ? cleanUserText(t) : t.trim();
}

/**
 * 助手消息的正文。
 *
 * 结构是 `{ data: { message: { role, content: [{type:'reasoning'|'text'|'tool-call'}] } } }`
 * ——真正的回答只是其中 `type:'text'` 那几块。之前读的是 `data.content`，取不到，
 * 于是**历史里助手的话全丢了**，只剩用户消息（真机就是这样：重启后回复消失）。
 *
 * 只取 text，绝不拼 reasoning：那是模型的思考过程，不该出现在对方的手机里。
 */
function assistantText(o) {
  const msg = o?.data?.message ?? null;
  const content = msg?.content ?? o?.data?.content ?? null;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || b.type === 'output_text'))
      .map((b) => String(b.text ?? ''))
      .join('\n')
      .trim();
  }
  return String(o?.data?.text ?? '').trim();
}

/**
 * 从解压后的 jsonl 里取出对话历史（只保留用户与助手的正文）。
 *
 * @param {string} raw
 * @param {{limit?:number}} [options] - 最多返回最后多少条
 * @returns {{messages:Array<{role:'user'|'assistant',text:string}>, truncated:boolean}}
 */
export function extractHistory(raw, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, Math.round(options.limit))) : 200;
  const out = [];
  for (const line of String(raw).split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === 'user/message') {
      const text = userMessageText(textOf(o));
      if (text) out.push({ role: 'user', text });
    } else if (o.type === 'assistant/message') {
      const text = assistantText(o);
      if (text) out.push({ role: 'assistant', text });
    }
  }
  const truncated = out.length > limit;
  return { messages: truncated ? out.slice(-limit) : out, truncated };
}

/**
 * DSH 的 `session.v4.jsonl.zstd` 是**追加写**的：每写一批就 append 一个 zstd 帧。
 * `zlib.zstdDecompressSync` 只解第一帧（实测：整段只回来 237 个字符），
 * 所以要按帧魔数切开逐帧解，再把文本拼起来。
 *
 * 魔数 `28 B5 2F FD` 理论上可能出现在压缩数据中间；真撞上了那一帧会解压失败，
 * 我们跳过它——丢一帧不影响"第一条用户消息"通常落在第一帧末尾/第二帧开头。
 */
export function decompressAllFrames(buf, zlibLike) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = buf.indexOf(magic);
  while (i >= 0) {
    starts.push(i);
    i = buf.indexOf(magic, i + 4);
  }
  const single = () => zlibLike.zstdDecompressSync(buf);
  if (starts.length <= 1) return single();

  const chunks = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      chunks.push(zlibLike.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8'));
    } catch {
      /* 单帧坏了就跳过，别让整个列表挂掉 */
    }
  }
  return Buffer.from(chunks.join(''), 'utf8');
}

/** 压成一行、去掉换行与多余空白，截断到 max 字。 */
export function oneLine(text, max = 42) {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[【\[][^】\]]*[】\]]\s*/, '') // 去掉注入前缀（前言以【…】开头）
    .trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * @param {object} options
 * @param {string} options.dshHome - `~/.dsh`
 * @param {object} [options.fsLike]
 * @param {object} [options.zlibLike] - 测试注入
 * @param {number} [options.maxBytes] - 超过就跳过解压
 */
export function createSessionMeta(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const zlibLike = options.zlibLike ?? zlib;
  const dshHome = options.dshHome;
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 16 * 1024 * 1024;
  const cache = new Map();

  function sessionsRoot() {
    return dshHome ? path.join(dshHome, 'sessions') : null;
  }

  /**
   * 在 sessions/* 里找这个会话的 zstd 文件。
   *
   * 两种目录命名都得认（实测）：
   * - 桌面端：`sessions/<workspace>/session-<id>/session.v4.jsonl.zstd`
   * - ACP 端（手机走的就是这条）：`sessions/<workspace>/<id>/session.v4.jsonl.zstd`
   * 只认一种的话，手机上列出来会全是 uuid（第一版就是这么错的）。
   */
  function locate(sessionId) {
    const root = sessionsRoot();
    if (!root) return null;
    let workspaces;
    try {
      workspaces = fsLike.readdirSync(root, { withFileTypes: true });
    } catch {
      return null;
    }
    const dirNames = [`session-${sessionId}`, sessionId];
    for (const w of workspaces) {
      if (!w.isDirectory()) continue;
      for (const d of dirNames) {
        const p = path.join(root, w.name, d, 'session.v4.jsonl.zstd');
        try {
          if (fsLike.existsSync(p)) return p;
        } catch {
          /* 没权限就当没有 */
        }
      }
    }
    return null;
  }

  function readMeta(sessionId) {
    const file = locate(sessionId);
    if (!file) return null;
    let st;
    try {
      st = fsLike.statSync(file);
    } catch {
      return null;
    }
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit && hit.sig === sig) return hit.meta;

    const meta = { updatedAt: Math.round(st.mtimeMs), title: null, bytes: st.size };
    if (st.size <= maxBytes && typeof zlibLike.zstdDecompressSync === 'function') {
      try {
        const raw = decompressAllFrames(fsLike.readFileSync(file), zlibLike).toString('utf8');
        const { title, firstUser } = extractMeta(raw);
        meta.title = oneLine(title || firstUser) || null;
      } catch {
        /* 压缩流坏了也不影响列表：退回只显示时间 */
      }
    }
    cache.set(file, { sig, meta });
    return meta;
  }

  return {
    /** 把 ACP 给的会话补上 title / updatedAt；补不到的字段为 null。 */
    enrich(sessions) {
      const list = Array.isArray(sessions) ? sessions : [];
      return list.map((s) => {
        const id = String(s?.sessionId ?? '');
        const extra = id ? readMeta(id) : null;
        return {
          ...s,
          title: extra?.title ?? null,
          updatedAt: extra?.updatedAt ?? null,
        };
      });
    },

    /**
     * 读一段会话的历史消息（手机点进旧会话时用）。
     *
     * 不做缓存：历史会一直增长，按 mtime 缓存等于每次都要重解；而它只在「打开会话」时调用一次。
     * 读不到文件不算错误（可能是刚建的空会话），返回 reason 让调用方决定怎么展示。
     */
    history(sessionId, options = {}) {
      const file = locate(sessionId);
      if (!file) return { messages: [], reason: 'no-file' };
      let st;
      try {
        st = fsLike.statSync(file);
      } catch {
        return { messages: [], reason: 'no-file' };
      }
      const updatedAt = Math.round(st.mtimeMs);
      if (st.size > maxBytes) return { messages: [], reason: 'too-large', updatedAt };
      try {
        const raw = decompressAllFrames(fsLike.readFileSync(file), zlibLike).toString('utf8');
        const { messages, truncated } = extractHistory(raw, options);
        return { messages, truncated, updatedAt };
      } catch {
        return { messages: [], reason: 'unreadable', updatedAt };
      }
    },

    clear: () => cache.clear(),
  };
}
