/**
 * 角色人格 API 回归（不启真桥接/真 B站）：
 *   · POST /characters create / load / snapshot / restore / update；
 *   · load 切换 epoch，记忆路径跟着切换，旧角色文件不被新角色写入；
 *   · 回档后 epoch +1（旧在途任务失效）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-character-api-'));
const tempDsh = fs.mkdtempSync(path.join(os.tmpdir(), 'surfcore-character-api-dsh-'));
fs.mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempRoot, 'roles'), { recursive: true });
fs.mkdirSync(path.join(tempDsh, 'surfcore'), { recursive: true });
fs.writeFileSync(path.join(tempRoot, 'src', 'bridge.js'), '// fixture bridge placeholder\n');
fs.writeFileSync(path.join(tempRoot, 'roles', '角色.md'), '# 角色卡：默认\n\n测试用。\n');
fs.writeFileSync(path.join(tempRoot, 'config.json'), JSON.stringify({ ownerQQ: '10001', allow: { private: ['10001'], groups: [] } }, null, 2));

process.env.SURFCORE_ROOT = tempRoot;
process.env.DSH_HOME = tempDsh;
process.env.USERPROFILE = tempDsh;
process.env.SURFCORE_SKIP_AUTOSTART = '1';
process.env.SURFCORE_DISABLE_MEMORY_TIMER = '1';
process.env.SURFCORE_DISABLE_CHARACTER_MIGRATION = '1';
process.env.SURFCORE_DISABLE_PLATFORM_RESTART = '1';

const { apply } = await import('../lib/index.js');
const store = await import('../../../src/character-persona.js');

const routes = [];
const ctx = {
  webServer: { register(route) { routes.push(route); return () => {}; } },
  get(name) { return name === 'connection' ? { requestRejection: () => false } : null; },
  effect(fn) { fn(); return () => {}; },
  sessionController: {
    inspect: async () => ({ events: [] }),
    create: async () => ({}),
    prompt: async () => ({ accepted: true }),
    cancel: async () => ({ accepted: true }),
  },
  settings: null,
};
apply(ctx);

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
    end(body = '') { this.body += body; },
  };
}
function fakeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:58750', ...(body ? { 'content-type': 'application/json' } : {}) };
  if (body) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  }
  return req;
}
async function invoke(method, p, body) {
  const route = routes.find((r) => r.path === '/dsh-surfcore/api');
  const res = fakeRes();
  await route.handler(fakeReq(method, `/dsh-surfcore/api${p}`, body), res);
  return { status: res.statusCode, data: JSON.parse(res.body || '{}') };
}

const persona = (name) => `# 角色卡：${name}\n\n${name} 的人格卡。\n`;
const card = (text) => ({
  version: 1,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  meta: { inboxSeen: [], sourceSeen: [], firstOwnerAt: '' },
  alerts: { level: 0, acknowledgedLevel: 0, lastNotified: {} },
  stats: {},
  records: [{
    id: `m_${text}`, source: 'manual', sourceId: '', platform: 'qq', scope: 'qq', kind: 'manual',
    text, title: text, detail: '', speaker: '主人', isOwner: true, isPrivate: true, direct: true,
    tags: ['owner'], importance: 80, clarity: 'vivid', createdAt: '2026-10-23T00:00:00.000Z',
    lastSeenAt: '2026-10-23T00:00:00.000Z', recallCount: 0, pinned: false, anchor: false,
  }],
});

try {
  const createdA = await invoke('POST', '/characters', { action: 'create', name: '角色甲', personaText: persona('甲'), memoryCard: card('甲的记忆') });
  assert.equal(createdA.status, 200, JSON.stringify(createdA.data));
  const createdB = await invoke('POST', '/characters', { action: 'create', name: '角色乙', personaText: persona('乙'), memoryCard: card('乙的记忆') });
  assert.equal(createdB.status, 200, JSON.stringify(createdB.data));
  assert.notEqual(createdA.data.character.id, createdB.data.character.id);

  const loadedA = await invoke('POST', '/characters', { action: 'load', id: createdA.data.character.id });
  assert.equal(loadedA.status, 200, JSON.stringify(loadedA.data));
  assert.equal(loadedA.data.current.id, createdA.data.character.id);
  assert.equal(loadedA.data.current.epoch, 1);
  const loadedB = await invoke('POST', '/characters', { action: 'load', id: createdB.data.character.id });
  assert.equal(loadedB.status, 200, JSON.stringify(loadedB.data));
  assert.equal(loadedB.data.current.epoch, 2);

  const pathsA = store.characterPaths(createdA.data.character.id);
  const pathsB = store.characterPaths(createdB.data.character.id);
  fs.writeFileSync(pathsB.memoryPromptQq, 'B 的注入块');
  assert.equal(fs.readFileSync(store.activeMemoryPaths().promptQq, 'utf8'), 'B 的注入块');
  assert.notEqual(store.activeMemoryPaths().dir, pathsA.memoryDir);

  const detailA = await invoke('GET', `/characters?id=${createdA.data.character.id}`);
  assert.equal(detailA.status, 200);
  assert.match(detailA.data.persona, /甲 的人格卡/);

  // 人格卡分层 API：核心保留 persona.md，日常/场景写入独立文件；保存后能被快照/回档带上。
  const personaGet = await invoke('GET', '/persona');
  assert.equal(personaGet.status, 200, JSON.stringify(personaGet.data));
  assert.ok(personaGet.data.layers?.core?.path?.endsWith('persona.md'));
  assert.ok(personaGet.data.layers?.daily?.path?.endsWith('persona.daily.md'));
  for (const scene of ['qq-group', 'qq-private', 'bili', 'pet']) {
    assert.ok(personaGet.data.layers?.scenes?.[scene]?.path?.endsWith(`${scene}.md`), `缺少场景路径 ${scene}`);
  }
  for (const [layer, scene, text] of [
    ['daily', '', '日常：最近在忙人格分层。'],
    ['scene', 'qq-group', 'QQ 群聊：先看气氛再开口。'],
    ['scene', 'qq-private', 'QQ 私聊：对主人更直接。'],
    ['scene', 'bili', 'B站：不主动带 QQ 群号。'],
    ['scene', 'pet', '桌宠：更放松。'],
  ]) {
    const savedLayer = await invoke('POST', '/persona', { layer, scene, text });
    assert.equal(savedLayer.status, 200, JSON.stringify(savedLayer.data));
  }
  assert.match(fs.readFileSync(pathsB.personaDaily, 'utf8'), /人格分层/);
  assert.match(fs.readFileSync(pathsB.personaScenes['qq-private'], 'utf8'), /更直接/);
  const unknownScene = await invoke('POST', '/persona', { layer: 'scene', scene: 'nope', text: 'x' });
  assert.equal(unknownScene.status, 400);
  assert.equal(unknownScene.data.code, 'PERSONA_SCENE_UNKNOWN');
  assert.ok(unknownScene.data.hint, '未知场景必须给下一步');

  const snap = await invoke('POST', '/characters', { action: 'snapshot', id: createdB.data.character.id, label: '测试' });
  assert.equal(snap.status, 200, JSON.stringify(snap.data));
  const slot = snap.data.slot;
  assert.ok(slot.startsWith('manual-测试-'));

  const updated = await invoke('POST', '/characters', { action: 'update', id: createdB.data.character.id, personaText: '# 角色卡：乙\n\n被改坏的人格。' });
  assert.equal(updated.status, 200, JSON.stringify(updated.data));
  assert.match(fs.readFileSync(pathsB.persona, 'utf8'), /被改坏/);

  const restored = await invoke('POST', '/characters', { action: 'restore', id: createdB.data.character.id, slot });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.match(fs.readFileSync(pathsB.persona, 'utf8'), /乙 的人格卡/);
  assert.match(fs.readFileSync(pathsB.personaDaily, 'utf8'), /人格分层/, '回档必须恢复人格日常层');
  assert.ok(store.readCurrentCharacter().epoch > 2, '回档后 epoch 必须递增');

  const list = await invoke('GET', '/characters');
  assert.equal(list.status, 200);
  assert.equal(list.data.characters.length, 2);
  assert.equal(list.data.current.id, createdB.data.character.id);

  // 新建时直接加载（切换）也走同一套。
  const createdC = await invoke('POST', '/characters', { action: 'create', name: '角色丙', personaText: persona('丙'), load: true });
  assert.equal(createdC.status, 200, JSON.stringify(createdC.data));
  assert.equal(store.readCurrentCharacter().name, '角色丙');

  // 删除非当前角色：只归档目录、从索引移除；当前角色不能删。
  const currentDelete = await invoke('POST', '/characters', { action: 'delete', id: store.readCurrentCharacter().id });
  assert.equal(currentDelete.status, 400, '当前角色必须拒绝删除');
  const deleted = await invoke('POST', '/characters', { action: 'delete', id: createdA.data.character.id });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  const listAfterDelete = await invoke('GET', '/characters');
  assert.equal(listAfterDelete.data.characters.some((item) => item.id === createdA.data.character.id), false);
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tempDsh, { recursive: true, force: true }); } catch {}
}

console.log('character API tests OK');
process.exit(0);
