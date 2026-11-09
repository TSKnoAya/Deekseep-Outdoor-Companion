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
 * 旧布局兼容：没有「角色系统」的老用户，人格卡在
 * `config.json → persona.file`、`roles/角色卡.md` 或 `roles/*.md` 里，
 * 记忆卡在 `surfcore/memory/memory-card-prompt-qq.md`。
 *
 * 新版 SurfCore 仍然支持这套（`lib/persona.js` 的优先级 1~3），
 * 所以我们也要认——否则「升级了 SurfCore 但还没建角色」的用户在手机上会完全没注入，
 * 而他在 QQ 上明明是有性格的。
 */
function resolveLegacyPersona(surfDir, fsLike) {
  const exists = (p) => {
    if (!p) return false;
    try {
      return Boolean(fsLike.statSync(p));
    } catch {
      return false;
    }
  };

  // ① config.json 里的 persona.file（绝对路径，或相对 surfcore 根）
  try {
    const cfg = JSON.parse(fsLike.readFileSync(path.join(surfDir, 'config.json'), 'utf8')) ?? {};
    const configured = String(cfg?.persona?.file ?? '').trim();
    if (configured) {
      const abs = path.isAbsolute(configured) ? configured : path.join(surfDir, configured);
      if (exists(abs)) return abs;
    }
  } catch {
    /* 没配置 */
  }

  // ② roles/角色卡.md
  const preferred = path.join(surfDir, 'roles', '角色卡.md');
  if (exists(preferred)) return preferred;

  // ③ roles/ 下第一个 .md（排除 README，和 SurfCore 的规则一致）
  if (typeof fsLike.readdirSync === 'function') {
    try {
      const cards = fsLike
        .readdirSync(path.join(surfDir, 'roles'))
        .filter((n) => String(n).toLowerCase().endsWith('.md'))
        .filter((n) => String(n).toLowerCase() !== 'readme.md')
        .sort();
      if (cards.length) return path.join(surfDir, 'roles', String(cards[0]));
    } catch {
      /* 没有 roles 目录 */
    }
  }
  return null;
}

/** 从人格卡正文里猜个名字（第一行 `# xxx`），猜不到就叫「角色」。 */
function personaName(file, fsLike) {
  const text = readText(file, fsLike);
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 20) : '角色';
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
  const platform = options.platform === 'bili' ? 'bili' : 'qq';
  const want = options.characterId ? String(options.characterId) : null;
  let picked = null;
  if (want) {
    // 手机端指定了角色：只从清单里找，**不**回退到"猜一个目录"——
    // 猜错等于把别的角色的记忆灌进去，比不做更糟。
    picked = listCharacters(surfDir, fsLike).find((c) => c.id === want) ?? null;
  }
  if (!picked) picked = readCurrentCharacter(surfDir, fsLike);

  // 没有角色系统（老用户）→ 走旧布局；两边都没有才算「没装/没建卡」
  if (!picked) {
    const legacyPersona = resolveLegacyPersona(surfDir, fsLike);
    if (!legacyPersona) return null;
    return {
      id: 'legacy',
      name: personaName(legacyPersona, fsLike),
      selectionMissing: Boolean(want),
      legacy: true,
      persona: legacyPersona,
      memoryPrompt: path.join(surfDir, 'memory', `memory-card-prompt-${platform}.md`),
      memoryCard: path.join(surfDir, 'memory', 'memory-card.md'),
    };
  }

  const charDir = picked.dir || path.join(surfDir, 'characters', picked.id);
  return {
    id: picked.id,
    name: picked.name,
    // 想用 A、但本机已经没有 A（被删/被改名）→ 退回桌面当前角色，并明确标记
    selectionMissing: Boolean(want && picked.id !== want),
    legacy: false,
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
 * 读新版 SurfCore（0.8.x）自己的配置与版本号。
 *
 * 为什么要读配置而不是写死上限：
 * 0.8.8 起注入块从 ~450 字涨到 ~1850 字（多了「QQ 与群里的记忆」「正在模糊的事」两节），
 * 而 `memoryCard.injectMaxChars.qq` 是用户在 SurfCore 里调过的**注入上限**（默认 2200）。
 * 我们写死 1200 会把新版块直接截掉三分之一，鱼就"失忆"了。
 *
 * 读不到的字段一律返回 null，由调用方决定默认值——配置损坏不该让注入失败。
 */
export function readSurfCoreInfo(options = {}) {
  const fsLike = options.fsLike ?? fs;
  const dshHome = options.dshHome;
  if (!dshHome) return { version: null, injectMaxChars: {}, memoryCardEnabled: true };

  const surfDir = path.join(dshHome, 'surfcore');
  let config = {};
  try {
    config = JSON.parse(fsLike.readFileSync(path.join(surfDir, 'config.json'), 'utf8')) ?? {};
  } catch {
    /* 没有配置：用默认 */
  }

  let version = null;
  try {
    const pkg = JSON.parse(
      fsLike.readFileSync(path.join(dshHome, 'plugins', 'surfcore', 'package.json'), 'utf8'),
    );
    if (pkg?.version) version = String(pkg.version);
  } catch {
    /* 插件目录不在（比如换过安装位置）：版本号只是展示用 */
  }

  const raw = config?.memoryCard?.injectMaxChars ?? {};
  const toCap = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 200 ? Math.round(n) : null;
  };

  return {
    version,
    injectMaxChars: { qq: toCap(raw.qq), bili: toCap(raw.bili) },
    // SurfCore 里把记忆卡关了，就不该往手机塞记忆（只留人格）
    memoryCardEnabled: config?.memoryCard?.enabled !== false,
  };
}

/**
 * 组装注入前言。
 *
 * @param {object} options
 * @param {string} options.dshHome - `~/.dsh`
 * @param {'qq'|'bili'} [options.platform] - 用哪份预渲染块（默认 qq，和主载体一致）
 * @param {number} [options.maxChars] - 记忆块最多取多少字（不传则跟随 SurfCore 配置）
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
  const cur = { name: files.name };
  const persona = readText(files.persona, fsLike);
  const info = readSurfCoreInfo({ dshHome, fsLike });
  const platform = options.platform === 'bili' ? 'bili' : 'qq';

  let memory = info.memoryCardEnabled ? readText(files.memoryPrompt, fsLike) : '';
  // 没有 prompt 块时退一步用可读版（也能用，只是没有"遗忘规则"那几句）
  const usedFallbackCard = !memory && info.memoryCardEnabled;
  if (usedFallbackCard) memory = readText(files.memoryCard, fsLike);

  if (!persona && !memory) return { ok: false, reason: 'empty' };

  // 上限优先级：显式参数 > SurfCore 配置 > 2200（0.8.8 的默认值）
  const capFromConfig = info.injectMaxChars[platform] ?? null;
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 200
    ? Math.round(options.maxChars)
    : (capFromConfig ?? 2200);
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
    surfcoreVersion: info.version,
    // 旧布局（没建角色、用 roles/角色卡.md）时给界面一个提示，别让人以为读错了角色
    legacyLayout: Boolean(files.legacy),
    maxChars,
    personaChars: persona.length,
    memoryChars: memory.length,
    memorySkipped: !info.memoryCardEnabled,
    truncated,
    text: lines.filter(Boolean).join('\n').trim(),
  };
}
