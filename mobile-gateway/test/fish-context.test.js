/**
 * 「把鱼带到手机」的测试。
 *
 * 这层最容易犯的错不是崩溃，而是**拼出来的前言不对**：
 * 少一段记忆卡片 → 鱼变笨；多写一句"你是助手" → 鱼的性格漂了。
 * 所以这里断言的是内容构成，不只是 ok:true。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildFishContext, fishSignature, listCharacters, readCurrentCharacter, readSurfCoreInfo } from '../src/fish-context.js';

const HOME = 'C:\\Users\\bob\\.dsh';
const SURF = path.join(HOME, 'surfcore');
const CHAR = path.join(SURF, 'characters', 'char-1');
const CHAR2 = path.join(SURF, 'characters', 'char-2');

function fakeFs(files = {}) {
  const map = new Map(Object.entries(files));
  return {
    readFileSync(p) {
      if (!map.has(p)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return map.get(p);
    },
    statSync(p) {
      if (!map.has(p)) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      const text = String(map.get(p));
      return { mtimeMs: 1000 + text.length, size: text.length };
    },
  };
}

const otherFiles = {
  [path.join(SURF, 'characters', 'index.json')]: JSON.stringify({
    version: 1,
    currentId: 'char-1',
    characters: [
      { id: 'char-1', name: '傲娇助手', updatedAt: '2026-10-30T00:00:00.000Z', dir: CHAR },
      { id: 'char-2', name: '大肥鱼', updatedAt: '2026-10-31T00:00:00.000Z', dir: CHAR2 },
    ],
  }),
  [path.join(CHAR2, 'persona.md')]: '# 大肥鱼\n- 性格：懒、贪吃',
  [path.join(CHAR2, 'memory', 'memory-card-prompt-qq.md')]: '【记忆卡】\n- 2026-10-31 主人带我去看海',
};

const baseFiles = {
  [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: '傲娇助手', dir: CHAR }),
  [path.join(CHAR, 'persona.md')]: '# 傲娇助手\n- 性格：傲娇、嘴硬心软',
  [path.join(CHAR, 'memory', 'memory-card-prompt-qq.md')]: '【记忆卡 · 你自己的记忆】\n- 2026-10-30 [清楚] 主人让我别熬夜',
};

test('能读出当前角色', () => {
  const cur = readCurrentCharacter(SURF, fakeFs(baseFiles));
  assert.deepEqual(cur, { id: 'char-1', name: '傲娇助手', dir: CHAR });
});

test('没有 current.json 时返回 null，不抛错', () => {
  assert.equal(readCurrentCharacter(SURF, fakeFs({})), null);
});

test('拼出来的前言同时含人格卡与记忆卡', () => {
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(baseFiles) });
  assert.equal(r.ok, true);
  assert.equal(r.name, '傲娇助手');
  assert.match(r.text, /傲娇、嘴硬心软/);
  assert.match(r.text, /主人让我别熬夜/);
  // 明确告诉模型「这是手机渠道」，避免它说「群里」
  assert.match(r.text, /手机 App/);
  assert.match(r.text, /不要编/);
});

test('优先用 qq 的预渲染块（和主载体一致，避免同一条鱼两张脸）', () => {
  const files = {
    ...baseFiles,
    [path.join(CHAR, 'memory', 'memory-card-prompt-bili.md')]: 'B站专用记忆块',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.match(r.text, /主人让我别熬夜/);
  assert.doesNotMatch(r.text, /B站专用记忆块/);

  // 显式要 bili 时才用另一份
  const r2 = buildFishContext({ dshHome: HOME, platform: 'bili', fsLike: fakeFs(files) });
  assert.match(r2.text, /B站专用记忆块/);
});

test('没有 prompt 块时退回 memory-card.md，不直接失败', () => {
  const files = {
    [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: '傲娇助手', dir: CHAR }),
    [path.join(CHAR, 'persona.md')]: '人格卡',
    [path.join(CHAR, 'memory', 'memory-card.md')]: '可读版记忆',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.equal(r.ok, true);
  assert.match(r.text, /可读版记忆/);
});

test('超长记忆会被截断，并标注截断', () => {
  const long = 'x'.repeat(5000);
  const files = {
    ...baseFiles,
    [path.join(CHAR, 'memory', 'memory-card-prompt-qq.md')]: long,
  };
  const r = buildFishContext({ dshHome: HOME, maxChars: 300, fsLike: fakeFs(files) });
  assert.equal(r.truncated, true);
  assert.ok(r.memoryChars < 400);
  assert.match(r.text, /记忆还有更多/);
});

test('既没人格卡也没记忆时 ok:false，让调用方决定（而不是注入一段空壳）', () => {
  const files = {
    [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({ id: 'char-1', name: 'x', dir: CHAR }),
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(files) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('没配置角色时 ok:false / no-character', () => {
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs({}) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-character');
});

// ── 手机端选鱼（多角色） ────────────────────────────────────────────────

test('能列出本机所有角色，按更新时间倒序', () => {
  const list = listCharacters(SURF, fakeFs(otherFiles));
  assert.deepEqual(list.map((c) => c.id), ['char-2', 'char-1']);
  assert.equal(list[0].name, '大肥鱼');
});

test('index.json 缺失时退回扫目录（以 character.json 为准）', () => {
  const files = {
    [path.join(SURF, 'characters', 'char-1', 'character.json')]: JSON.stringify({ id: 'char-1', name: '傲娇助手' }),
  };
  const fsLike = {
    readFileSync: fakeFs(files).readFileSync,
    readdirSync: () => ['char-1'],
  };
  const list = listCharacters(SURF, fsLike);
  assert.deepEqual(list.map((c) => c.id), ['char-1']);
});

test('指定角色时读它的文件，而不是桌面当前角色', () => {
  const fsLike = fakeFs({ ...baseFiles, ...otherFiles });
  const r = buildFishContext({ dshHome: HOME, characterId: 'char-2', fsLike });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'char-2');
  assert.equal(r.name, '大肥鱼');
  assert.match(r.text, /懒、贪吃/);
  assert.match(r.text, /主人带我去看海/);
  assert.doesNotMatch(r.text, /傲娇、嘴硬心软/);
  assert.equal(r.selectionMissing, false);
});

test('指定的角色不存在时退回桌面当前角色，并明确标记 selectionMissing', () => {
  const fsLike = fakeFs({ ...baseFiles, ...otherFiles });
  const r = buildFishContext({ dshHome: HOME, characterId: 'char-gone', fsLike });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'char-1', '不能拿一个不存在的角色目录去拼');
  assert.equal(r.selectionMissing, true);
});

test('签名随角色变化（切鱼后能触发重新注入）', () => {
  const fsLike = fakeFs({ ...baseFiles, ...otherFiles });
  const a = fishSignature({ dshHome: HOME, characterId: 'char-1', fsLike });
  const b = fishSignature({ dshHome: HOME, characterId: 'char-2', fsLike });
  assert.ok(a.length > 0 && b.length > 0);
  assert.notEqual(a, b);
});

// ── 适配 SurfCore 0.8.8：注入上限跟配置走、能读版本、尊重"关闭记忆卡" ─────────

function surfFiles({ promptChars = 1800, config, version = '0.8.8' } = {}) {
  const files = {
    [path.join(SURF, 'characters', 'current.json')]: JSON.stringify({
      version: 1, id: 'char-1', name: '金花', dir: CHAR,
    }),
    [path.join(CHAR, 'persona.md')]: '# 金花\n- 性格：直爽',
    [path.join(CHAR, 'memory', 'memory-card-prompt-qq.md')]: '记'.repeat(promptChars),
    [path.join(CHAR, 'memory', 'memory-card.md')]: '完整记忆卡'.repeat(50),
  };
  if (config !== undefined) {
    files[path.join(SURF, 'config.json')] = JSON.stringify(config);
  }
  if (version) {
    files[path.join(HOME, 'plugins', 'surfcore', 'package.json')] = JSON.stringify({ version });
  }
  return fakeFs(files);
}

test('注入上限跟 SurfCore 的 injectMaxChars.qq 走（新版块 ~1850 字不能被 1200 截掉）', () => {
  const fsLike = surfFiles({ config: { memoryCard: { injectMaxChars: { qq: 2200 } } } });
  const r = buildFishContext({ dshHome: HOME, fsLike });
  assert.equal(r.ok, true);
  assert.equal(r.maxChars, 2200);
  assert.equal(r.truncated, false);
  assert.equal(r.memoryChars, 1800);
});

test('显式 maxChars 仍然优先于配置', () => {
  const fsLike = surfFiles({ config: { memoryCard: { injectMaxChars: { qq: 2200 } } } });
  const r = buildFishContext({ dshHome: HOME, fsLike, maxChars: 300 });
  assert.equal(r.maxChars, 300);
  assert.equal(r.truncated, true);
  assert.match(r.text, /记忆还有更多/);
});

test('没有 config.json 时退到 2200（0.8.8 的默认值），不是老的 1200', () => {
  const r = buildFishContext({ dshHome: HOME, fsLike: surfFiles() });
  assert.equal(r.maxChars, 2200);
  assert.equal(r.truncated, false);
});

test('能读到已装 SurfCore 的版本号（设置页要显示）', () => {
  const info = readSurfCoreInfo({ dshHome: HOME, fsLike: surfFiles({ version: '0.8.8' }) });
  assert.equal(info.version, '0.8.8');
  assert.equal(info.memoryCardEnabled, true);
});

test('SurfCore 里把记忆卡关了 → 只注入人格，不塞记忆', () => {
  const fsLike = surfFiles({ config: { memoryCard: { enabled: false, injectMaxChars: { qq: 2200 } } } });
  const r = buildFishContext({ dshHome: HOME, fsLike });
  assert.equal(r.ok, true);
  assert.equal(r.memorySkipped, true);
  assert.equal(r.memoryChars, 0);
  assert.match(r.text, /## 角色：金花/);
  assert.doesNotMatch(r.text, /记{10}/, '记忆块不该出现');
});

test('配置里 injectMaxChars 是脏值（0 / 字符串 / 负数）时不被采纳', () => {
  const info = readSurfCoreInfo({
    dshHome: HOME,
    fsLike: surfFiles({ config: { memoryCard: { injectMaxChars: { qq: 0 } } } }),
  });
  assert.equal(info.injectMaxChars.qq, null);
});

// ── 旧布局兼容（没建角色、用 roles/角色卡.md 的老用户） ─────────────────

test('没有角色系统时，读 roles/角色卡.md + 全局 memory 目录', () => {
  const f = {
    [path.join(SURF, 'roles', '角色卡.md')]: '# 老角色\n- 性格：冷淡',
    [path.join(SURF, 'memory', 'memory-card-prompt-qq.md')]: '旧记忆',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(f) });
  assert.equal(r.ok, true);
  assert.equal(r.legacyLayout, true);
  assert.equal(r.name, '老角色');
  assert.match(r.text, /性格：冷淡/);
  assert.match(r.text, /旧记忆/);
});

test('旧布局也认 config.json 里的 persona.file（相对 surfcore 根）', () => {
  const f = {
    [path.join(SURF, 'config.json')]: JSON.stringify({ persona: { file: 'roles/自定义.md' } }),
    [path.join(SURF, 'roles', '自定义.md')]: '# 自定义\n- 性格：随和',
  };
  const r = buildFishContext({ dshHome: HOME, fsLike: fakeFs(f) });
  assert.equal(r.ok, true);
  assert.equal(r.name, '自定义');
});
