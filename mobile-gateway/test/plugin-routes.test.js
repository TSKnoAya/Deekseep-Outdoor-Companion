/**
 * 插件宿主路由的契约测试。
 *
 * 抓的是这次真机踩到的 bug：DSH 的 webServer 按**路径**建路由，同一路径注册两次
 * （GET 一次、PUT 一次）时只剩一个方法，于是设置页点「开启」拿到 405「方法不对」。
 * 所以这里用「同 path 后注册覆盖前注册」的假 ctx 来锁住：每个路径必须只注册一次。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const registered = []; // { path, handler }
const routes = new Map(); // 模拟 DSH：同 path 后注册覆盖前注册

const ctx = {
  webServer: {
    register({ path: p, handler }) {
      registered.push({ path: p, handler });
      routes.set(p, handler);
      return () => routes.delete(p);
    },
  },
  effect() {},
};

const mod = await import(
  pathToFileURL(path.join(HERE, '..', 'dsh-plugin', 'lib', 'index.js')).href
);
mod.apply(ctx);

// ── 假网关：只实现本文件用到的 /admin/persona ──────────────────────────────

const personaState = { enabled: true, selectedId: null };
const gatewayCalls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = String(init.method ?? 'GET').toUpperCase();
  gatewayCalls.push({ path: u.pathname, method, body: init.body ?? null });
  if (u.pathname === '/admin/persona') {
    if (method === 'PUT') {
      const body = JSON.parse(init.body ?? '{}');
      if ('enabled' in body) personaState.enabled = body.enabled;
      if ('characterId' in body) personaState.selectedId = body.characterId;
    }
    return jsonResponse({
      ok: true,
      available: true,
      enabled: personaState.enabled,
      selectedId: personaState.selectedId,
      followingDesktop: !personaState.selectedId,
      character: '大肥鱼',
      characters: [{ id: 'char-1', name: '大肥鱼' }],
    });
  }
  return jsonResponse({ ok: true });
};

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

after(() => {
  globalThis.fetch = realFetch;
});

function fakeReq(method, body, remote = '127.0.0.1') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
}

function call(pathname, method = 'GET', body, remote) {
  const handler = routes.get(pathname);
  assert.ok(handler, `路径没注册：${pathname}`);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(text) {
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = { raw: text };
        }
        resolve({ status: res.statusCode, body: parsed });
      },
    };
    Promise.resolve(handler(fakeReq(method, body, remote), res)).catch(reject);
  });
}

const API = '/dsh-mobile-gateway/api';

test('同一个路径只注册一次（GET/PUT 不再互相覆盖）', () => {
  const counts = new Map();
  for (const r of registered) counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
  for (const [p, n] of counts) {
    assert.equal(n, 1, `${p} 被注册了 ${n} 次，DSH 同路径只保留一个方法`);
  }
  assert.equal(counts.get(`${API}/persona`), 1);
  assert.equal(counts.get(`${API}/acp-model`), 1);
});

test('GET /persona 走 GET，PUT /persona 走 PUT（不再 405）', async () => {
  personaState.selectedId = null;
  const got = await call(`${API}/persona`);
  assert.equal(got.status, 200);
  assert.equal(got.body.ok, true);
  assert.equal(gatewayCalls.at(-1).method, 'GET');

  const put = await call(`${API}/persona`, 'PUT', { characterId: 'char-1' });
  assert.equal(put.status, 200);
  assert.equal(put.body.ok, true);
  assert.equal(put.body.selectedId, 'char-1');
  assert.equal(gatewayCalls.at(-1).method, 'PUT');
  assert.deepEqual(JSON.parse(gatewayCalls.at(-1).body), { characterId: 'char-1' });
});

test('PUT /persona 只传 enabled 仍然可用（旧调用兼容）', async () => {
  const put = await call(`${API}/persona`, 'PUT', { enabled: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.enabled, false);
});

test('PUT /persona 两个字段都不给：400 + hint', async () => {
  const put = await call(`${API}/persona`, 'PUT', {});
  assert.equal(put.status, 400);
  assert.equal(put.body.code, 'request.invalid');
  assert.match(put.body.hint, /characterId/);
});

test('没注册的方法回 405，但不影响同路径的其它方法', async () => {
  const del = await call(`${API}/persona`, 'DELETE');
  assert.equal(del.status, 405);
  assert.equal(del.body.error, '方法不对');

  const ok = await call(`${API}/persona`);
  assert.equal(ok.status, 200, 'DELETE 之后 GET 仍要可用');
});

test('非本机来源一律 403', async () => {
  const res = await call(`${API}/persona`, 'GET', undefined, '10.0.0.9');
  assert.equal(res.status, 403);
});
