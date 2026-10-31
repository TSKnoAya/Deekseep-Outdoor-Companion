/**
 * 「把鱼带到手机」——把 SurfCore 的角色人格 + 记忆卡拼成每轮的前言。
 *
 * 为什么复用 `memory-card-prompt-qq.md` 而不是自己拼：
 * 那份是 SurfCore 已经渲染好的注入块（最近记得的 / 重要锚点 / 遗忘规则都在里面）。
 * 自己另写一份等于养第二条鱼——同一个角色在 QQ 和手机上会说话不一样，
 * 养鱼的人对这个极其敏感。**同一条鱼，同一个记忆块。**
 *
 * 为什么不读 memory-card.json 自己渲染：
 * 那是结构化数据（84KB），渲染逻辑有衰减/模糊/容量策略，重复实现必然漂移。
 * 读现成的 prompt 块，等于复用 SurfCore 的渲染结果。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 读 SurfCore 的当前角色指针。 */
export function readCurrentCharacter(surfDir, fsLike = fs) {
  const file = path.join(surfDir, 'characters', 'current.json');
  try {
    const doc = JSON.parse(fsLike.readFileSync(file, 'utf8'));
    if (!doc?.id) return null;
    return { id: String(doc.id), name: String(doc.name ?? doc.id), dir: doc.dir ? String(doc.dir) : null };
  } catch {
    return null;
  }
}

/**
 * 本机有哪些角色。
 *
 * 优先读 SurfCore 自己维护的 `characters/index.json`（带名称与更新时间）；
 * 没有 index 时退回扫目录（每个角色目录里一定有 `character.json`）。
 * 读不到任何东西时返回空数组——**列出角色失败不该让注入跟着失败**。
 */
export function listCharacters(surfDir, fsLike = fs) {
  const base = path.join(surfDir, 'characters');
  const out = [];
  try {
    const doc = JSON.parse(fsLike.readFileSync(path.join(base, 'index.json'), 'utf8'));
    if (Array.isArray(doc?.characters)) {
      for (const c of doc.characters) {
        if (!c?.id) continue;
        out.push(normalizeCharacter(c));
      }
    }
  } catch {
    /* index 缺失/损坏：下面扫目录 */
  }
  if (out.length === 0 && typeof fsLike.readdirSync === 'function') {
    try {
      for (const name of fsLike.readdirSync(base)) {
        const dir = path.join(base, String(name));
        try {
          const meta = JSON.parse(fsLike.readFileSync(path.join(dir, 'character.json'), 'utf8'));
          if (meta?.id) out.push(normalizeCharacter({ ...meta, dir }));
        } catch {
          /* 不是角色目录 */
        }
      }
    } catch {
      /* 没有 characters 目录 */
    }
  }
  // 最近更新过的排前面；没有时间的排后面
  return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

function normalizeCharacter(c) {
  return {
    id: String(c.id),
    name: String(c.name ?? c.personaMeta?.name ?? c.id),
    updatedAt: c.updatedAt ? String(c.updatedAt) : null,
    dir: c.dir ? String(c.dir) : null,
  };
}

function readText(file, fsLike) {
  try {
    return String(fsLike.readFileSync(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * 定位某个角色当前该读的那几个文件（不读内容，只算路径）。
 *
 * 单独拆出来是给「要不要重新注入」用的：判断依据是**文件的 mtime/size**，
 * 所以必须和 `buildFishContext` 走同一套路径解析，否则会出现
 * "签名变了但内容没变"（或反过来）的错判。
 */
export function resolveFishFiles(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const dshHome = options.dshHome;
  if (!dshHome) return null;

  const surfDir = path.join(dshHome, 'surfcore');
  const want = options.characterId ? String(options.characterId) : null;
  let picked = null;
  if (want) {
    // 手机端指定了角色：只从清单里找，**不**回退到"猜一个目录"——
    // 猜错等于把别的角色的记忆灌进去，比不做更糟。
    picked = listCharacters(surfDir, fsLike).find((c) => c.id === want) ?? null;
  }
  if (!picked) picked = readCurrentCharacter(surfDir, fsLike);
  if (!picked) return null;

  const charDir = picked.dir || path.join(surfDir, 'characters', picked.id);
  const platform = options.platform === 'bili' ? 'bili' : 'qq';
  return {
    id: picked.id,
    name: picked.name,
    // 想用 A、但本机已经没有 A（被删/被改名）→ 退回桌面当前角色，并明确标记
    selectionMissing: Boolean(want && picked.id !== want),
    persona: path.join(charDir, 'persona.md'),
    memoryPrompt: path.join(charDir, 'memory', `memory-card-prompt-${platform}.md`),
    memoryCard: path.join(charDir, 'memory', 'memory-card.md'),
  };
}

/** 一份能标识「记忆/人格有没有变过」的签名；读不到任何文件时返回空串。 */
export function fishSignature(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const files = resolveFishFiles(options);
  if (!files) return '';
  const parts = [];
  for (const p of [files.persona, files.memoryPrompt, files.memoryCard]) {
    try {
      const st = fsLike.statSync(p);
      parts.push(`${p}:${Math.round(st.mtimeMs)}:${st.size}`);
    } catch {
      /* 文件不存在就不参与签名 */
    }
  }
  return parts.join('|');
}

/**
 * 组装注入前言。
 *
 * @param {object} options
 * @param {string} options.dshHome - `~/.dsh`
 * @param {'qq'|'bili'} [options.platform] - 用哪份预渲染块（默认 qq，和主载体一致）
 * @param {number} [options.maxChars] - 记忆块最多取多少字（超了截断，别把 token 吃光）
 * @param {object} [options.fsLike]
 * @returns {{ok:boolean, reason?:string, name?:string, personaChars?:number,
 *            memoryChars?:number, truncated?:boolean, text?:string}}
 */
export function buildFishContext(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const dshHome = options.dshHome;
  if (!dshHome) return { ok: false, reason: 'no-dsh-home' };

  const files = resolveFishFiles(options);
  if (!files) return { ok: false, reason: 'no-character' };
  const cur = { name: files.name };  const persona = readText(files.persona, fsLike);
  let memory = readText(files.memoryPrompt, fsLike);
  // 没有 prompt 块时退一步用可读版（也能用，只是没有"遗忘规则"那几句）
  if (!memory) memory = readText(files.memoryCard, fsLike);

  if (!persona && !memory) return { ok: false, reason: 'empty' };

  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 200 ? Math.round(options.maxChars) : 1200;
  const truncated = memory.length > maxChars;
  if (truncated) memory = `${memory.slice(0, maxChars)}\n（记忆还有更多，但这次只说这么多）`;

  const lines = [
    '【你是下面这个角色，请一直保持它。这是你自己的记忆，不是别人给你的设定。】',
    persona ? `## 角色：${cur.name}\n${persona}` : `## 角色：${cur.name}`,
    memory ? `\n${memory}` : '',
    '\n【当前渠道】手机 App。主人此刻在外面（可能不在家、不在电脑前），',
    '回复要比在群里更像私下说话：可以更短、更随意，不要提"群""大家"这类群聊语境。',
    '不知道的就说不记得，不要编。',
  ];

  return {
    ok: true,
    id: files.id,
    name: cur.name,
    selectionMissing: Boolean(files.selectionMissing),
    personaChars: persona.length,
    memoryChars: memory.length,
    truncated,
    text: lines.filter(Boolean).join('\n').trim(),
  };
}
