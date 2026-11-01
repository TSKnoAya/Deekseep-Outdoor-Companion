/**
 * HTTP 端点集成测试：真起一个 http server（监听 0 端口），用真实 fetch 打。
 *
 * 为什么值得：这些端点里最容易出的错不是"功能没写"，而是
 *  ① 鉴权漏了一个端点（安全洞）；
 *  ② 失败返回了 200（前端以为成功，用户看到空白）；
 *  ③ SSE 断了不清理（内存泄漏，跑一夜就卡）。
 * 这三类只有真发请求才抓得到。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGatewayServer } from '../src/server.js';
import { DeviceStore } from '../src/devices.js';
import { SessionHub, ApprovalRegistry } from '../src/hub.js';
import { BackendRegistry } from '../src/voice/registry.js';
import { createDeviceAsr } from '../src/voice/asr-device.js';
import { createSettingsStore } from '../src/config.js';
import { fail, CODES } from '../src/errors.js';
import { parsePairPayload } from '../src/pair-qr.js';

let server;
let baseUrl;
let store;
let hub;
let approvals;
let settings;
let asr;
let tts;
let fakeAcp;
let acpConnected = true;
/** DSH 的归档状态是只读的；测试里用 Set 模拟 workspace.json 里的 archivedSessionIds */
const fakeDshArchive = {
  ids: new Set(),
  has(id) {
    return this.ids.has(String(id));
  },
  list() {
    return [...this.ids];
  },
};
/** 角色上下文（「把鱼带到手机」）的假实现：只关心 /admin/persona 的读写契约。 */
const fakeFish = {
  enabled: true,
  selectedId: null,
  status() {
    return {
      enabled: this.enabled,
      available: true,
      reason: null,
      character: this.selectedId === 'char-2' ? '大肥鱼' : '傲娇助手',
      characterId: this.selectedId || 'char-1',
      selectedId: this.selectedId,
      followingDesktop: !this.selectedId,
      selectionMissing: false,
      characters: [
        { id: 'char-1', name: '傲娇助手', updatedAt: '2026-10-30T00:00:00.000Z' },
        { id: 'char-2', name: '大肥鱼', updatedAt: '2026-10-31T00:00:00.000Z' },
      ],
      personaChars: 10,
      memoryChars: 20,
      truncated: false,
      maxInjections: 4,
      lastReason: null,
      sessions: [],
    };
  },
  setEnabled(v) {
    this.enabled = Boolean(v);
  },
  setCharacter(id) {
    this.selectedId = id;
  },
  // 消息路径会调这三个：stub 必须照真实契约实现，否则发消息会 500（第一次就踩了）
  prepare() {
    return { prefix: null, reason: 'disabled' };
  },
  commit() {},
  forget() {},
};
/** 让配对相关用例能切换「有局域网地址 / 只有回环」两种情况。 */
let adminAddresses = {
  loopbackOnly: false,
  list: [{ ip: '192.168.1.247', url: 'http://192.168.1.247:8788', tailscale: false }],
};

/** 假 ACP：只实现 server.js 用到的几个方法。 */
function makeFakeAcp() {
  return {
    initialized: true,
    serverInfo: { name: 'fake-acp', version: '9.9.9' },
    onPermissionRequest: null,
    async listSessions() {
      return [
        { sessionId: 'sess-1', cwd: 'C:\\work' },
        { sessionId: 'sess-empty', cwd: 'C:\\work' },
      ];
    },
    async newSession({ cwd }) {
      if (cwd === 'FAIL') throw Object.assign(new Error('目录不存在'), { code: 'internal.error', hint: '换个目录', userFacing: true });
      return { sessionId: 'sess-new', configOptions: [] };
    },
    async prompt({ sessionId, text, onText }) {
      if (text.includes('慢')) {
        // 模拟长回合：分两次吐
        onText('第一段');
        await new Promise((r) => setTimeout(r, 30));
        onText('第二段');
        return { stopReason: 'end_turn', text: '第一段第二段' };
      }
      if (text.includes('失败')) {
        throw Object.assign(new Error('模型报错'), { code: 'acp.turn-failed', hint: '重发一次', userFacing: true });
      }
      if (text.includes('审批')) {
        // 触发一次审批请求，等手机回答
        const outcome = await this.onPermissionRequest({
          rpcId: 555,
          sessionId,
          toolCallId: 'call-x',
          options: [
            { optionId: 'allow-once', kind: 'allow_once' },
            { optionId: 'reject-once', kind: 'reject_once' },
          ],
        });
        return { stopReason: outcome?.outcome ?? 'end_turn', text: `结果:${JSON.stringify(outcome)}` };
      }
      onText(`回复:${text}`);
      return { stopReason: 'end_turn', text: `回复:${text}` };
    },
    async cancel() {},
    async closeSession() {},
    answerPermission(rpcId, optionId) {
      // 记录一下，供断言
      this.lastAnswer = { rpcId, optionId };
    },
  };
}

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshm-http-'));
  store = new DeviceStore({ file: path.join(dir, 'devices.json') });
  hub = new SessionHub({ queueLimit: 3 });
  approvals = new ApprovalRegistry({ timeoutMs: 2000 });
  settings = createSettingsStore({ file: path.join(dir, 'settings.json') });

  asr = new BackendRegistry('asr');
  asr.register(createDeviceAsr());
  tts = new BackendRegistry('tts');
  tts.register({
    id: 'fake-tts',
    label: '假 TTS',
    async probe() {
      return { ok: true };
    },
    async synthesize({ text }) {
      return { audio: Buffer.from(`AUDIO:${text}`, 'utf8'), mime: 'audio/wav' };
    },
  });
  tts.register({
    id: 'broken-tts',
    label: '坏 TTS',
    async probe() {
      return { ok: false, code: 'tts.provider-not-configured', error: '没配', hint: '去配' };
    },
    async synthesize() {
      // 真实后端必须用 fail() 抛结构化错误；这里照做，否则测的就不是真实契约。
      throw fail(CODES.TTS_PROVIDER_NOT_CONFIGURED, '没配', { hint: '去配' });
    },
  });
  settings.set({ ttsBackend: 'fake-tts' });

  fakeAcp = makeFakeAcp();

  server = createGatewayServer({
    devices: store,
    getAcp: () => (acpConnected ? fakeAcp : null),
    hub,
    approvals,
    asr,
    tts,
    settings,
    meta: { version: 'test-1.0.0', dshExe: 'X:\\fake.exe', defaultCwd: 'C:\\work' },
    admin: {
      listen: () => ({ host: '0.0.0.0', port: 8788 }),
      addresses: () => adminAddresses,
    },
    fish: fakeFish,
    dshArchive: fakeDshArchive,
    // 假会话元数据：sess-1 有用户消息（有标题），sess-empty 没有任何消息
    sessionMeta: {
      enrich(list) {
        return list.map((s) => (s.sessionId === 'sess-1'
          ? { ...s, title: '测试会话', updatedAt: 2 }
          : { ...s, title: null, updatedAt: 1 }));
      },
      history() {
        return {
          messages: [
            { role: 'user', text: '历史里的问句' },
            { role: 'assistant', text: '历史里的回答' },
          ],
          truncated: false,
          updatedAt: 2,
        };
      },
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 配一台设备并返回带鉴权的 fetch。 */
async function pairAndAuth(name = '测试机') {
  const { code } = store.issuePairCode();
  const res = await fetch(`${baseUrl}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName: name }),
  });
  const body = await res.json();
  assert.equal(body.ok, true, `配对应成功：${JSON.stringify(body)}`);
  const token = body.token;
  return {
    token,
    api: (pathname, init = {}) =>
      fetch(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      }),
  };
}

test('未鉴权的端点必须 401，且带上 code 与 hint', async () => {
  for (const [method, p] of [
    ['GET', '/v1/sessions'],
    ['GET', '/v1/settings'],
    ['POST', '/v1/sessions'],
    ['GET', '/v1/devices'],
    ['GET', '/v1/sessions/sess-1/stream'],
    ['POST', '/v1/sessions/sess-1/messages'],
    ['POST', '/v1/approvals/apv-1'],
    ['POST', '/v1/asr'],
    ['POST', '/v1/tts'],
  ]) {
    const res = await fetch(`${baseUrl}${p}`, { method, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 401, `${method} ${p} 应该 401`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'auth.unauthorized');
    assert.ok(body.hint.length > 0, `${method} ${p} 的失败必须带下一步提示`);
  }
});

test('/v1/health 不需要鉴权，且能反映 DSH 连接状态', async () => {
  const res = await fetch(`${baseUrl}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dsh.connected, true);
  assert.equal(body.dsh.server.name, 'fake-acp');
});

test('配对成功后列表能查到设备，且不返回令牌哈希', async () => {
  const { api } = await pairAndAuth('红米 K80');
  const res = await api('/v1/devices');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.devices.length >= 1);
  assert.ok(body.devices.every((d) => d.tokenHash === undefined));
  assert.ok(body.devices.some((d) => d.name === '红米 K80'));
});

test('会话列表透传 ACP（空会话默认不出现，和 DSH 一致）', async () => {
  const { api } = await pairAndAuth();
  const body = await (await api('/v1/sessions')).json();
  assert.deepEqual(body.sessions, [
    { sessionId: 'sess-1', cwd: 'C:\\work', title: '测试会话', updatedAt: 2, archived: false },
  ]);
  const all = await (await api('/v1/sessions?includeEmpty=1')).json();
  assert.equal(all.sessions.some((s) => s.sessionId === 'sess-empty'), true, 'includeEmpty=1 时才带空会话');
});

test('新建会话失败时，状态码与 code/hint 都要正确', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/sessions', { method: 'POST', body: JSON.stringify({ cwd: 'FAIL' }) });
  assert.notEqual(res.status, 200, '失败不能用 200 返回');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'internal.error');
  assert.equal(body.hint, '换个目录');
});

test('发消息立刻返回 202 + turnId（不阻塞等回合结束）', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/sessions/sess-1/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '慢一点' }),
  });
  assert.equal(res.status, 202, '长回合必须立刻返回，否则手机要等十几分钟');
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.turnId.startsWith('turn-'));
});

test('空消息要 400', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/sessions/sess-1/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '   ' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'request.invalid');
});

test('SSE 能收到 hello / turn_start / text / turn_end', async () => {
  const { api } = await pairAndAuth();
  // 先连流，再发消息
  const controller = new AbortController();
  const streamRes = await api('/v1/sessions/sse-1/stream', { signal: controller.signal });
  assert.equal(streamRes.status, 200);
  assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);

  const events = [];
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* 心跳 */
            }
          }
        }
        if (events.some((e) => e.type === 'turn_end')) break;
      }
    } catch {
      /* abort */
    }
  })();

  // 等 hello 到
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(events.some((e) => e.type === 'hello'), '重连时必须先补发当前状态');

  await api('/v1/sessions/sse-1/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '慢一点' }),
  });

  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  controller.abort();

  const types = events.map((e) => e.type);
  assert.ok(types.includes('turn_start'), `应有 turn_start，实际 ${types}`);
  assert.ok(types.includes('text'), `应有 text 增量，实际 ${types}`);
  assert.ok(types.includes('turn_end'), `应有 turn_end，实际 ${types}`);

  const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
  assert.deepEqual(texts, ['第一段', '第二段']);

  const end = events.find((e) => e.type === 'turn_end');
  assert.equal(end.ok, true);
});

test('轮次失败时，turn_end 必须带 ok:false + code + hint（不能静默）', async () => {
  const { api } = await pairAndAuth();
  const controller = new AbortController();
  const res = await api('/v1/sessions/sse-2/stream', { signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
        if (events.some((e) => e.type === 'turn_end')) break;
      }
    } catch {}
  })();

  await new Promise((r) => setTimeout(r, 40));
  await api('/v1/sessions/sse-2/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '失败' }),
  });
  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  controller.abort();

  const end = events.find((e) => e.type === 'turn_end');
  assert.ok(end, '失败也必须推 turn_end');
  assert.equal(end.ok, false);
  assert.equal(end.failure.code, 'acp.turn-failed');
  assert.ok(end.failure.hint.length > 0);
});

test('并发发两条：第二条排队，不会报错也不会并发执行', async () => {
  const { api } = await pairAndAuth();
  const r1 = await (
    await api('/v1/sessions/q-1/messages', { method: 'POST', body: JSON.stringify({ text: '慢一点' }) })
  ).json();
  const r2 = await (
    await api('/v1/sessions/q-1/messages', { method: 'POST', body: JSON.stringify({ text: '再来' }) })
  ).json();

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true, '第二条应排队而不是报错');
  assert.equal(r2.queued, 1, '第二条应显示前面还有 1 条');

  // 等它们跑完
  await new Promise((r) => setTimeout(r, 200));
});

test('审批：SSE 收到 approval_request，回答后流程继续', async () => {
  const { api } = await pairAndAuth();
  const controller = new AbortController();
  const res = await api('/v1/sessions/apr-1/stream', { signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
        if (events.some((e) => e.type === 'turn_end')) break;
      }
    } catch {}
  })();

  await new Promise((r) => setTimeout(r, 40));
  await api('/v1/sessions/apr-1/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '需要审批' }),
  });

  // 等到 approval_request
  let approvalEvent = null;
  for (let i = 0; i < 100 && !approvalEvent; i++) {
    await new Promise((r) => setTimeout(r, 20));
    approvalEvent = events.find((e) => e.type === 'approval_request');
  }
  assert.ok(approvalEvent, `应收到 approval_request，实际 ${events.map((e) => e.type)}`);
  assert.equal(approvalEvent.approval.toolCallId, 'call-x');
  assert.equal(approvalEvent.approval.options.length, 2);

  // 回答
  const answerRes = await api(`/v1/approvals/${approvalEvent.approval.id}`, {
    method: 'POST',
    body: JSON.stringify({ optionId: 'allow-once' }),
  });
  const answerBody = await answerRes.json();
  assert.equal(answerBody.ok, true);

  await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
  controller.abort();

  const end = events.find((e) => e.type === 'turn_end');
  assert.ok(end, '回答后回合应结束');
  assert.equal(end.ok, true);
  assert.match(end.result.text, /allow-once/, '结果里应体现用户的选择');
});

test('审批：无效 optionId 要 400 并列出可用项', async () => {
  const { api } = await pairAndAuth();
  const controller = new AbortController();
  const res = await api('/v1/sessions/apr-2/stream', { signal: controller.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {}
          }
        }
      }
    } catch {}
  })();

  await new Promise((r) => setTimeout(r, 40));
  await api('/v1/sessions/apr-2/messages', {
    method: 'POST',
    body: JSON.stringify({ text: '需要审批' }),
  });
  let approvalEvent = null;
  for (let i = 0; i < 100 && !approvalEvent; i++) {
    await new Promise((r) => setTimeout(r, 20));
    approvalEvent = events.find((e) => e.type === 'approval_request');
  }
  assert.ok(approvalEvent);

  const bad = await api(`/v1/approvals/${approvalEvent.approval.id}`, {
    method: 'POST',
    body: JSON.stringify({ optionId: 'allow-everything-forever' }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.ok, false);
  assert.equal(badBody.code, 'request.invalid');
  assert.deepEqual(badBody.details.offered.sort(), ['allow-once', 'reject-once']);

  controller.abort();
});

test('审批：回答不存在的审批要 404', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/approvals/apv-does-not-exist', {
    method: 'POST',
    body: JSON.stringify({ optionId: 'allow-once' }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'approval.not-found');
});

test('/v1/announce 按档位给决策', async () => {
  const { api } = await pairAndAuth();
  const off = await (await api('/v1/announce', { method: 'POST', body: JSON.stringify({ text: '你好', mode: 'off' }) })).json();
  assert.equal(off.speak, false);
  assert.equal(off.reason, 'mode-off');

  const short = await (
    await api('/v1/announce', { method: 'POST', body: JSON.stringify({ text: '好的', mode: 'short' }) })
  ).json();
  assert.equal(short.speak, true);
  assert.equal(short.text, '好的');
});

test('/v1/voice/backends 返回后端清单与四档播报', async () => {
  const { api } = await pairAndAuth();
  const body = await (await api('/v1/voice/backends')).json();
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.tts.backends));
  assert.ok(body.tts.backends.some((b) => b.id === 'fake-tts' && b.ready === true));
  assert.ok(body.tts.backends.some((b) => b.id === 'broken-tts' && b.ready === false));
  assert.deepEqual(body.announceModes.map((m) => m.id).sort(), ['all', 'headset-only', 'off', 'short']);
});

test('/v1/tts 成功时返回二进制音频，不是 JSON', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/tts', { method: 'POST', body: JSON.stringify({ text: '你好' }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /audio/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('utf8'), 'AUDIO:你好');
});

test('/v1/tts 后端未配置时返回 503 + code + hint', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/tts', {
    method: 'POST',
    body: JSON.stringify({ text: '你好', backend: 'broken-tts' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'tts.provider-not-configured');
  assert.ok(body.hint.length > 0);
});

test('/v1/asr 用 device-native 后端时明确说明不需要走网关', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/asr?backend=device-native', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: Buffer.from('fake'),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'asr.not-configured');
  assert.match(body.hint, /手机/);
});

test('设置读写：非法档位要 400，合法值立即生效', async () => {
  const { api } = await pairAndAuth();
  const bad = await api('/v1/settings', {
    method: 'PUT',
    body: JSON.stringify({ announceMode: '有时候念吧' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'request.invalid');

  const good = await api('/v1/settings', {
    method: 'PUT',
    body: JSON.stringify({ announceMode: 'headset-only' }),
  });
  const goodBody = await good.json();
  assert.equal(goodBody.ok, true);
  assert.equal(goodBody.settings.announceMode, 'headset-only');

  // 立即生效（不用重启）
  const got = await (await api('/v1/settings')).json();
  assert.equal(got.settings.announceMode, 'headset-only');
});

test('未知路径返回 404 且结构化', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/nope');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'request.not-found');
});

test('DSH 未连接时，会话端点返回 500 且 hint 指向「去启动网关」', async () => {
  const { api } = await pairAndAuth();
  acpConnected = false;
  try {
    const res = await api('/v1/sessions');
    assert.notEqual(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'acp.not-running');
    assert.ok(body.hint.length > 0);
  } finally {
    acpConnected = true;
  }
});

test('请求体不是 JSON 时 400，不发散成 500', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/sessions/sess-1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'request.invalid');
  assert.match(body.message ?? body.error, /JSON/);
});

// ── 扫码配对 ──────────────────────────────────────────────────────────────

test('管理配对码：每个可达地址带一条二维码，载荷能解析回地址与码', async () => {
  adminAddresses = {
    loopbackOnly: false,
    list: [
      { ip: '192.168.1.247', url: 'http://192.168.1.247:8788', tailscale: false },
      { ip: '100.101.102.103', url: 'http://100.101.102.103:8788', tailscale: true },
    ],
  };
  try {
    const res = await fetch(`${baseUrl}/admin/pair`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.code, /^\d{6}$/);
    assert.equal(body.urls.length, 2);
    for (const u of body.urls) {
      assert.deepEqual(parsePairPayload(u.payload), { url: u.url, code: body.code });
      assert.equal(u.qr.size, 37);
      assert.equal(u.qr.rows.length, 37);
      assert.equal(u.qr.rows[0].length, 37);
    }
    assert.equal(body.urls[1].tailscale, true);
    assert.equal(body.warn, undefined);
  } finally {
    adminAddresses = { loopbackOnly: false, list: [{ ip: '192.168.1.247', url: 'http://192.168.1.247:8788', tailscale: false }] };
  }
});

test('管理配对码：只监听回环时给结构化警告，二维码为空但码仍可手动配对', async () => {
  adminAddresses = { loopbackOnly: true, list: [] };
  try {
    const body = await (await fetch(`${baseUrl}/admin/pair`, { method: 'POST' })).json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.urls, []);
    assert.equal(body.warn.code, 'pair.loopback-only');
    // 失败路径也要可行动：error 说清在哪失败，hint 说清下一步
    assert.ok(body.warn.error.length > 0);
    assert.match(body.warn.hint, /start-gateway\.bat|--listen/);

    const paired = await (
      await fetch(`${baseUrl}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: body.code, deviceName: '手动配对' }),
      })
    ).json();
    assert.equal(paired.ok, true, JSON.stringify(paired));
  } finally {
    adminAddresses = { loopbackOnly: false, list: [{ ip: '192.168.1.247', url: 'http://192.168.1.247:8788', tailscale: false }] };
  }
});

// ── 手机端选鱼（/admin/persona） ─────────────────────────────────────────

test('角色上下文：GET 给出可选角色与当前来源', async () => {
  fakeFish.selectedId = null;
  const body = await (await fetch(`${baseUrl}/admin/persona`)).json();
  assert.equal(body.ok, true);
  assert.equal(body.followingDesktop, true);
  assert.equal(body.selectedId, null);
  assert.deepEqual(body.characters.map((c) => c.id), ['char-1', 'char-2']);
});

test('角色上下文：PUT characterId 固定角色；null 恢复跟随桌面', async () => {
  const pick = await (
    await fetch(`${baseUrl}/admin/persona`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: 'char-2' }),
    })
  ).json();
  assert.equal(pick.ok, true);
  assert.equal(pick.selectedId, 'char-2');
  assert.equal(pick.followingDesktop, false);
  assert.equal(pick.character, '大肥鱼');

  const back = await (
    await fetch(`${baseUrl}/admin/persona`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: null }),
    })
  ).json();
  assert.equal(back.selectedId, null);
  assert.equal(back.followingDesktop, true);
});

test('角色上下文：两个字段都不给时 400 且 hint 说明怎么传', async () => {
  const res = await fetch(`${baseUrl}/admin/persona`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'request.invalid');
  assert.match(body.hint, /characterId/);
});

test('角色上下文：老的 {enabled:false} 写法仍然可用', async () => {
  const body = await (
    await fetch(`${baseUrl}/admin/persona`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
  ).json();
  assert.equal(body.ok, true);
  assert.equal(body.enabled, false);
  fakeFish.enabled = true; // 别影响其它用例
});

// ── 会话归档：以 DSH 为准（只读 workspace.json） ─────────────────────────

test('DSH 里归档的会话默认不出现在手机列表；includeArchived=1 才带上', async () => {
  const { api } = await pairAndAuth();
  fakeDshArchive.ids.clear();

  const before = await (await api('/v1/sessions')).json();
  assert.ok(before.sessions.some((s) => s.sessionId === 'sess-1'));

  // 模拟用户在 DSH 桌面端点了「归档」
  fakeDshArchive.ids.add('sess-1');

  const hidden = await (await api('/v1/sessions')).json();
  assert.equal(hidden.sessions.some((s) => s.sessionId === 'sess-1'), false, '归档后手机列表里应看不到');

  const all = await (await api('/v1/sessions?includeArchived=1')).json();
  const row = all.sessions.find((s) => s.sessionId === 'sess-1');
  assert.equal(row.archived, true, '显式要全量时应带 archived 标记');

  // 模拟在 DSH 里取消归档
  fakeDshArchive.ids.delete('sess-1');
  const back = await (await api('/v1/sessions')).json();
  assert.ok(back.sessions.some((s) => s.sessionId === 'sess-1'));
});

test('网关不再提供手机侧归档接口（唯一权威是 DSH）', async () => {
  const { api } = await pairAndAuth();
  const res = await api('/v1/sessions/sess-1/archive', { method: 'POST' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'request.not-found');
});

// ── 会话历史 ────────────────────────────────────────────────────────────

test('会话历史：返回已有对话；接口要鉴权', async () => {
  const { api } = await pairAndAuth();
  const body = await (await api('/v1/sessions/sess-1/history?limit=50')).json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(body.truncated, false);

  const anon = await fetch(`${baseUrl}/v1/sessions/sess-1/history`);
  assert.equal(anon.status, 401);
});
