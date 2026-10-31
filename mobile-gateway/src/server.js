/**
 * 网关的 HTTP 服务：把 ACP 会话包装成手机能用的 REST + SSE。
 *
 * 为什么是 REST + SSE 而不是 WebSocket：
 * - 手机端 OkHttp/Retrofit 对 SSE 有一等支持，断线重连语义清晰；
 * - 单向推送场景（服务端→手机）SSE 足够，双向只有「发消息/审批」两个动作，
 *   REST 更简单也更好调试（curl 就能测）；
 * - WebSocket 要多维护一套握手/心跳/重连，而这里并没有双向高频通信的需求。
 *
 * 为什么不用任何框架：Node 内置 http 足够，且零依赖意味着
 * 用户 `npm install` 不用等（甚至完全不用装依赖）。
 */

import http from 'node:http';
import { CODES, fail, toFailure, ok, requireThat } from './errors.js';
import { ANNOUNCE_MODES } from './voice/announce.js';
import { loadAcpModel, saveAcpModel } from './acp-model.js';
import { makePairQr } from './pair-qr.js';

const MAX_JSON_BODY = 4 * 1024 * 1024; // 4MB；音频走专门的 /v1/asr 且单独限长
const MAX_AUDIO_BODY = 24 * 1024 * 1024;

/**
 * 创建一个网关 HTTP 服务（不 listen，由调用方决定端口/地址，便于测试）。
 *
 * @param {object} deps
 * @param {object} deps.devices - DeviceStore
 * @param {object} deps.getAcp - () => AcpClient；未连接时返回 null
 * @param {object} deps.hub - SessionHub
 * @param {object} deps.approvals - ApprovalRegistry
 * @param {object} deps.asr - BackendRegistry
 * @param {object} deps.tts - BackendRegistry
 * @param {object} deps.settings - { get(), set(patch) }
 * @param {(msg:string, data?:any)=>void} [deps.log]
 * @param {object} [deps.meta] - { version, dshHome, dshExe }
 */
export function createGatewayServer(deps) {
  const log = deps.log || (() => {});
  const meta = deps.meta ?? {};

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const failure = toFailure(e);
      // 状态码必须来自错误本身，不能一律 500：
      // 400/404/503 这些是「用户能自救」的失败，返回 500 会让 App 显示
      // 「服务器内部错误」，用户永远不知道该去改什么（单测抓到的）。
      const status = Number.isInteger(e?.status) ? e.status : 500;
      if (res.headersSent) return tryEnd(res);
      sendJson(res, failure, status);
    });
  });

  // ── 路由 ────────────────────────────────────────────────────────────────

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // 预检：手机端在开发时可能跨域
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    // ① 不需要鉴权的端点
    if (pathname === '/v1/pair' && req.method === 'POST') return handlePair(req, res);
    if (pathname === '/v1/health' && req.method === 'GET') return handleHealth(req, res);
    if (pathname === '/' && req.method === 'GET') return handleRoot(req, res);

    // ①.5 管理接口：**只允许本机回环**。
    // 这些接口能改模型、发配对码，比业务接口危险得多；网关又监听 0.0.0.0，
    // 所以必须按来源 IP 卡死，不能只靠「藏起来」。
    if (pathname.startsWith('/admin/')) {
      if (!isLoopback(req)) {
        return sendJson(res, toFailure(fail(CODES.UNAUTHORIZED, '管理接口只允许本机访问', {})), 403);
      }
      if (pathname === '/admin/status' && req.method === 'GET') return handleAdminStatus(req, res);
      if (pathname === '/admin/pair' && req.method === 'POST') return handleAdminPair(req, res);
      if (pathname === '/admin/reload' && req.method === 'POST') return handleAdminReload(req, res);
      if (pathname === '/admin/acp-model' && req.method === 'GET') return handleAdminGetModel(req, res);
      if (pathname === '/admin/acp-model' && req.method === 'PUT') return handleAdminPutModel(req, res);
      if (pathname === '/admin/persona' && req.method === 'GET') return handleAdminGetPersona(req, res);
      if (pathname === '/admin/persona' && req.method === 'PUT') return handleAdminPutPersona(req, res);
      return sendJson(res, toFailure(fail(CODES.NOT_FOUND, `没有这个管理接口：${pathname}`, {})), 404);
    }

    // ② 其余全部要鉴权
    const device = authenticate(req);
    if (!device) {
      const f = toFailure(
        fail(CODES.UNAUTHORIZED, '设备未配对或令牌无效', {}),
      );
      return sendJson(res, f, 401);
    }
    res.setHeader('X-Device-Id', device.id);

    // ③ 具体路由
    if (pathname === '/v1/sessions' && req.method === 'GET') return handleListSessions(req, res);
    if (pathname === '/v1/sessions' && req.method === 'POST') return handleCreateSession(req, res);

    const streamMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/stream$/);
    if (streamMatch && req.method === 'GET') return handleStream(req, res, decodeURIComponent(streamMatch[1]));

    const promptMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (promptMatch && req.method === 'POST') return handlePrompt(req, res, decodeURIComponent(promptMatch[1]));

    const cancelMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') return handleCancel(req, res, decodeURIComponent(cancelMatch[1]));

    const closeMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/close$/);
    if (closeMatch && req.method === 'POST') return handleCloseSession(req, res, decodeURIComponent(closeMatch[1]));

    if (pathname === '/v1/approvals' && req.method === 'GET') return handleListApprovals(req, res, url);

    const approveMatch = pathname.match(/^\/v1\/approvals\/([^/]+)$/);
    if (approveMatch && req.method === 'POST') return handleAnswerApproval(req, res, decodeURIComponent(approveMatch[1]));

    if (pathname === '/v1/asr' && req.method === 'POST') return handleAsr(req, res);
    if (pathname === '/v1/tts' && req.method === 'POST') return handleTts(req, res);
    if (pathname === '/v1/voice/backends' && req.method === 'GET') return handleVoiceBackends(req, res);
    if (pathname === '/v1/announce' && req.method === 'POST') return handleAnnounce(req, res);

    if (pathname === '/v1/settings' && req.method === 'GET') return handleGetSettings(req, res);
    if (pathname === '/v1/settings' && req.method === 'PUT') return handlePutSettings(req, res);
    if (pathname === '/v1/devices' && req.method === 'GET') return sendJson(res, ok({ devices: deps.devices.list() }));
    if (pathname === '/v1/devices' && req.method === 'POST') return handleIssuePairCode(req, res);

    return sendJson(res, toFailure(fail(CODES.NOT_FOUND, `没有这个接口：${pathname}`, {})), 404);
  }

  // ── 鉴权 ────────────────────────────────────────────────────────────────

  function authenticate(req) {
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    return deps.devices.verify(token);
  }

  // ── 各端点实现 ──────────────────────────────────────────────────────────

  function handleRoot(req, res) {
    sendJson(
      res,
      ok({
        name: 'dsh-mobile-gateway',
        version: meta.version ?? '0.0.0',
        hint: '这是网关。手机 App 用 /v1/* 接口；配对请先在电脑端点「生成配对码」。',
      }),
    );
  }

  // ── 管理接口（仅本机）────────────────────────────────────────────────────
  // 存在的理由：手机端要换模型/看状态/发配对码，但手机 App 不该有这些权限。
  // 调用方是 DSH 的设置页插件（跑在本机），所以按来源 IP 卡回环就够了。

  function isLoopback(req) {
    const ip = String(req.socket?.remoteAddress ?? '');
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  function handleAdminStatus(req, res) {
    const acp = deps.getAcp();
    const listen = deps.admin?.listen?.() ?? null;
    // 手机要填的不是 0.0.0.0（那是"所有网卡"），而是本机的真实 IP。
    // 这里直接把候选地址算好给界面用，免得用户自己拼。
    const addresses = deps.admin?.addresses?.() ?? [];
    sendJson(
      res,
      ok({
        version: meta.version ?? '?',
        listen,
        addresses,
        stateDir: meta.stateDir ?? null,
        dshExe: meta.dshExe ?? null,
        dsh: {
          connected: Boolean(acp?.initialized),
          name: acp?.serverInfo?.name ?? null,
        },
        devices: deps.devices.list().length,
      }),
    );
  }

  /**
   * 生成配对码（给「换手机 / 重装 App」用，不用去重启网关窗口）。
   *
   * 同时带上每个可达地址的二维码：手机扫一次就拿到「地址 + 码」，
   * 省掉在电脑屏幕和手机键盘之间抄两遍（抄错只会报「连不上」，很难查）。
   * 二维码生成失败不拖累手动配对——码照发，另给结构化警告。
   */
  function handleAdminPair(req, res) {
    const pair = deps.devices.issuePairCode();
    const addresses = deps.admin?.addresses?.() ?? { loopbackOnly: true, list: [] };
    const list = Array.isArray(addresses.list) ? addresses.list : [];
    const urls = [];
    let warn = null;
    for (const a of list) {
      try {
        const { payload, qr } = makePairQr({ url: a.url, code: pair.code });
        urls.push({ ...a, payload, qr });
      } catch (e) {
        warn = {
          code: 'pair.qr-failed',
          error: `二维码生成失败：${e?.message ?? e}`,
          hint: '配对码仍然有效：在手机 App 里手动填地址和这 6 位码就行。',
        };
      }
    }
    if (list.length === 0) {
      warn = addresses.loopbackOnly
        ? {
            code: 'pair.loopback-only',
            error: '网关只监听了回环地址（127.0.0.1），手机扫了也连不上。',
            hint: '用 start-gateway.bat 启动（或加 --listen 0.0.0.0:8788）后重新生成；现在仍可手动配对到回环地址。',
          }
        : {
            code: 'pair.no-lan-address',
            error: '没检测到局域网地址，生成不了能用的二维码。',
            hint: '先连上 Wi-Fi 或网线；也可以在手机 App 里手动填本机 IP:8788。',
          };
    }
    sendJson(res, ok({ ...pair, urls, ...(warn ? { warn } : {}) }));
  }

  async function handleAdminReload(req, res) {
    const result = await deps.admin?.reloadAcp?.();
    sendJson(res, ok(result ?? { reloaded: true }));
  }

  /**
   * 角色上下文（「把鱼带到手机」）的开关与状态。
   *
   * 默认开着，但只在**装了 SurfCore 且有当前角色**时才真的生效；
   * 没装的人拿到 `available:false`，不影响任何东西。
   */
  function handleAdminGetPersona(req, res) {
    if (!deps.fish) return sendJson(res, ok({ enabled: false, available: false, reason: 'not-wired' }));
    sendJson(res, ok(deps.fish.status()));
  }

  async function handleAdminPutPersona(req, res) {
    requireThat(Boolean(deps.fish), CODES.BAD_REQUEST, '这个网关版本没接角色上下文', {});
    const body = await readJson(req, MAX_JSON_BODY);
    const hasEnabled = typeof body.enabled === 'boolean';
    const hasCharacter = body.characterId === null || typeof body.characterId === 'string';
    requireThat(hasEnabled || hasCharacter, CODES.BAD_REQUEST, 'enabled 或 characterId 至少要给一个', {
      hint: 'characterId 传角色 id（见 GET 返回的 characters），null 表示跟随桌面当前角色。',
    });
    if (hasEnabled) deps.fish.setEnabled(body.enabled);
    if (hasCharacter) deps.fish.setCharacter(body.characterId === '' ? null : body.characterId);
    sendJson(res, ok(deps.fish.status()));
  }

  function handleAdminGetModel(req, res) {
    const dshHome = deps.admin?.dshHome;
    requireThat(Boolean(dshHome), CODES.BAD_REQUEST, '网关不知道自己属于哪个 DSH_HOME', {});
    sendJson(res, ok(loadAcpModel(dshHome)));
  }

  async function handleAdminPutModel(req, res) {
    const dshHome = deps.admin?.dshHome;
    requireThat(Boolean(dshHome), CODES.BAD_REQUEST, '网关不知道自己属于哪个 DSH_HOME', {});
    const body = await readJson(req, MAX_JSON_BODY);
    const provider = String(body.provider ?? '').trim();
    const model = String(body.model ?? '').trim();
    let saved;
    try {
      saved = saveAcpModel(dshHome, { provider, model });
    } catch (e) {
      if (e?.code === 'bad-request') throw fail(CODES.BAD_REQUEST, e.message, { hint: '格式：deepseek-account / deepseek-v4.1-flash' });
      throw e;
    }
    // 只改文件不生效：DSH 的 profile 是进程启动时读的，必须让 ACP 子进程重开一次
    let reloaded = false;
    let reloadError = null;
    try {
      await deps.admin?.reloadAcp?.();
      reloaded = true;
    } catch (e) {
      reloadError = e?.message ?? String(e);
      log(`改完模型但重载 ACP 失败：${reloadError}`);
    }
    sendJson(res, ok({ ...saved, reloaded, reloadError }));
  }

  function handleHealth(req, res) {
    const acp = deps.getAcp();
    const voice = deps.voiceStatus ? deps.voiceStatus() : {};
    sendJson(
      res,
      ok({
        version: meta.version ?? '0.0.0',
        uptimeMs: Math.round(process.uptime() * 1000),
        dsh: {
          connected: Boolean(acp?.initialized),
          server: acp?.serverInfo ?? null,
          exe: meta.dshExe ?? null,
        },
        devices: deps.devices.list().length,
        voice,
      }),
    );
  }

  async function handlePair(req, res) {
    const body = await readJson(req, MAX_JSON_BODY);
    const result = deps.devices.pair({
      code: body.code,
      deviceName: body.deviceName ?? req.headers['user-agent'] ?? '手机',
    });
    log(`新设备配对成功：${result.deviceId}`);
    sendJson(res, ok(result));
  }

  async function handleListSessions(req, res) {
    const acp = requireAcp();
    const sessions = await acp.listSessions();
    // 补标题与最后活动时间，并按时间倒序：手机上的列表才认得出来
    const enriched = deps.sessionMeta ? deps.sessionMeta.enrich(sessions) : sessions;
    enriched.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sendJson(res, ok({ sessions: enriched }));
  }

  async function handleCreateSession(req, res) {
    const acp = requireAcp();
    const body = await readJson(req, MAX_JSON_BODY);
    const cwd = String(body.cwd ?? meta.defaultCwd ?? process.cwd());
    const created = await acp.newSession({ cwd, mcpServers: body.mcpServers ?? [] });
    log(`新建会话 ${created.sessionId}（cwd=${cwd}）`);
    sendJson(res, ok(created));
  }

  async function handlePrompt(req, res, sessionId) {
    const acp = requireAcp();
    const body = await readJson(req, MAX_JSON_BODY);
    const text = String(body.text ?? '').trim();
    requireThat(text.length > 0, CODES.BAD_REQUEST, '消息内容是空的', {});

    // 「把鱼带到手机」：把角色人格 + 记忆卡拼在这轮消息前面。
    //
    // 注意这段前缀**只发给 DSH**，不会进手机的气泡——手机显示的用户消息是它自己
    // 发出去的那句；SSE 里也只有模型回的字。所以用户不会看到一坨设定文本。
    const prepared = body.noPersona === true ? null : deps.fish?.prepare(sessionId) ?? null;
    const promptText = prepared?.prefix ? `${prepared.prefix}\n\n---\n\n${text}` : text;

    const submitted = deps.hub.submit(sessionId, async (ctx) => {
      // 审批请求要挂到 registry 上，并推给手机。
      //
      // 这里的 Promise 由 ApprovalRegistry 负责兑现：`settle` 就是它的 resolve。
      // 三条路都只会调用一次 settle —— 手机回答、超时取消、会话关闭清理，
      // 所以不需要任何轮询（原先那版用 setInterval 偷看 registry，既浪费又会漏）。
      acp.onPermissionRequest = (request) =>
        new Promise((resolve) => {
          const entry = deps.approvals.add(request, (outcome) => {
            // 把结果回给 ACP；无论来源是用户点击还是超时，都走这一条
            try {
              acp.answerPermission(request.rpcId, outcome.optionId ?? outcome.outcome);
            } catch (e) {
              log(`回传审批结果失败：${e?.message ?? e}`);
            }
            resolve(outcome);
          });
          ctx.emit({ type: 'approval_request', approval: entry });
        });

      const result = await acp.prompt({
        sessionId,
        text: promptText,
        onText: (chunk) => ctx.emit({ type: 'text', text: chunk }),
      });
      // 只有这一轮真的跑完才记账；失败重试时前缀还得再带上
      deps.fish?.commit(sessionId, prepared);
      return { stopReason: result.stopReason, text: result.text };
    });

    sendJson(res, ok({ sessionId, ...submitted }), 202);
  }

  async function handleCancel(req, res, sessionId) {
    const acp = requireAcp();
    await acp.cancel(sessionId);
    const cleared = deps.hub.clearQueue(sessionId);
    sendJson(res, ok({ cancelled: true, ...cleared }));
  }

  async function handleCloseSession(req, res, sessionId) {
    const acp = requireAcp();
    deps.approvals.clearSession(sessionId);
    deps.hub.dispose(sessionId);
    deps.fish?.forget(sessionId);
    await acp.closeSession(sessionId).catch(() => {});
    sendJson(res, ok({ closed: sessionId }));
  }

  /**
   * SSE 流。
   *
   * 关键点：先补发当前状态（`hello`），再接后续增量。
   * 不这样做的话，手机在「任务已开始但还没结束」时重连，会看不到任何东西，
   * 只能等到下一轮——而正式场景里一轮可能跑十分钟。
   */
  function handleStream(req, res, sessionId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(req),
    });

    const send = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* 连接已断，由 close 事件清理 */
      }
    };

    send({ type: 'hello', sessionId, status: deps.hub.status(sessionId) });

    // 重连补发未回答的审批
    for (const a of deps.approvals.list(sessionId)) send({ type: 'approval_request', approval: a });

    const unsubscribe = deps.hub.subscribe(sessionId, send);
    // 心跳：防中间设备掐掉空闲连接
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15_000);
    ping.unref?.();

    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  async function handleListApprovals(req, res, url) {
    sendJson(res, ok({ approvals: deps.approvals.list(url.searchParams.get('sessionId') || null) }));
  }

  async function handleAnswerApproval(req, res, approvalId) {
    const body = await readJson(req, MAX_JSON_BODY);
    const optionId = String(body.optionId ?? '').trim();
    requireThat(optionId.length > 0, CODES.BAD_REQUEST, '缺少 optionId', {
      hint: '传 "allow-once" / "reject-once" / "cancelled" 之一。',
    });
    const result = deps.approvals.answer(approvalId, optionId);
    log(`审批 ${approvalId} → ${optionId}`);
    sendJson(res, ok(result));
  }

  async function handleAsr(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const backendId = url.searchParams.get('backend') || deps.settings.get().asrBackend;
    const backend = deps.asr.require(backendId);
    requireThat(
      backend.gatewayTranscribe !== false,
      CODES.ASR_NOT_CONFIGURED,
      `后端 ${backend.id} 不在网关上做识别`,
      { hint: '「手机本地转写」是在手机上完成的，直接把识别出的文字当普通消息发。' },
    );

    const audio = await readBinary(req, MAX_AUDIO_BODY);
    requireThat(audio.length > 0, CODES.AUDIO_INVALID, '没有收到音频数据', {});
    const result = await backend.transcribe({
      audio,
      mime: String(req.headers['content-type'] ?? 'audio/wav'),
      language: url.searchParams.get('language') || 'auto',
    });
    sendJson(res, ok(result));
  }
  async function handleTts(req, res) {
    const body = await readJson(req, MAX_JSON_BODY);
    const backendId = body.backend || deps.settings.get().ttsBackend;
    const backend = deps.tts.require(backendId);
    const result = await backend.synthesize({ text: body.text, voice: body.voice });
    // 直接返回二进制音频，省掉 base64 膨胀
    res.writeHead(200, {
      'Content-Type': result.mime ?? 'audio/wav',
      'Content-Length': result.audio.length,
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
    });
    res.end(result.audio);
  }

  async function handleVoiceBackends(req, res) {
    const [asr, tts] = await Promise.all([deps.asr.describe(), deps.tts.describe()]);
    sendJson(
      res,
      ok({
        asr: { ...asr, selected: deps.settings.get().asrBackend },
        tts: { ...tts, selected: deps.settings.get().ttsBackend },
        announceModes: ANNOUNCE_MODES,
      }),
    );
  }

  async function handleAnnounce(req, res) {
    const body = await readJson(req, MAX_JSON_BODY);
    const { decideAnnouncement } = await import('./voice/announce.js');
    const decision = decideAnnouncement({
      text: body.text,
      mode: body.mode || deps.settings.get().announceMode,
      headsetConnected: Boolean(body.headsetConnected),
    });
    sendJson(res, ok(decision));
  }

  function handleGetSettings(req, res) {
    sendJson(res, ok({ settings: deps.settings.get(), announceModes: ANNOUNCE_MODES }));
  }

  async function handlePutSettings(req, res) {
    const body = await readJson(req, MAX_JSON_BODY);
    const next = deps.settings.set(body ?? {});
    sendJson(res, ok({ settings: next }));
  }

  async function handleIssuePairCode(req, res) {
    const issued = deps.devices.issuePairCode();
    sendJson(res, ok(issued));
  }

  function requireAcp() {
    const acp = deps.getAcp();
    if (!acp || !acp.initialized) {
      throw fail(CODES.ACP_NOT_RUNNING, 'DSH 还没连上', {
        hint: '在电脑上确认网关已启动、DSH 已登录；网关会自动重连。',
      });
    }
    return acp;
  }

  return server;
}

// ── HTTP 小工具 ────────────────────────────────────────────────────────────

function corsHeaders(req) {
  const origin = String(req.headers.origin ?? '');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function tryEnd(res) {
  try {
    res.end();
  } catch {
    /* 已经关了 */
  }
}

/** 读 JSON 体，带体积上限。超限直接抛结构化错误，不要等它读完。 */
export function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(CODES.AUDIO_TOO_LARGE, `请求体太大（>${Math.round(limit / 1024 / 1024)}MB）`, {}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(fail(CODES.BAD_REQUEST, '请求体不是合法 JSON', {}));
      }
    });
    req.on('error', reject);
  });
}

/** 读二进制体（音频）。 */
export function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(CODES.AUDIO_TOO_LARGE, `音频太大（>${Math.round(limit / 1024 / 1024)}MB）`, {}));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
