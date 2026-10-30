/**
 * ACP 客户端：JSON-RPC 2.0 over stdio，外加 ACP 特有的一层语义。
 *
 * 为什么不用现成 SDK：ACP 的 SDK 是给「编辑器里跑 AI」设计的，我们要的是
 * 「手机发消息」。真正需要的东西只有六件事——握手、建会话、列会话、发 prompt、
 * 收增量、回答审批。自己写 300 行比引入一个会跟着上游漂移的依赖更可控，
 * 也让协议变化时能一眼看到改哪。
 *
 * 协议要点（均来自对 DSH 0.2.1-rc.5 的实测与源码阅读）：
 * 1. 帧就是一行一个 JSON，没有 Content-Length 头。
 * 2. 客户端发 request 带 `id`，服务端回 `{id, result}` 或 `{id, error}`。
 * 3. 服务端会**主动**发 request（`session/request_permission`），必须回；
 *    不回 = 那一轮挂到超时。
 * 4. 服务端发 notification（`session/update`）不带 `id`，不需要回。
 * 5. 一个会话同时只能有一个 prompt 在飞（源码：`a prompt is already in flight`）。
 */

import { CODES, fail } from './errors.js';

/** 初始化时声明的能力。fs 全关：手机端不需要 ACP 读写本地文件。 */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
};

export class AcpClient {
  /**
   * @param {object} options
   * @param {object} options.transport - transport.js 产出的对象
   * @param {(msg:string, data?:any)=>void} [options.log]
   * @param {number} [options.requestTimeoutMs] - 普通请求超时；prompt 不走这个
   * @param {number} [options.handshakeTimeoutMs]
   */
  constructor(options) {
    this.transport = options.transport;
    this.log = options.log || (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 45_000;

    this.nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function, timer:any}>} */
    this.pending = new Map();
    /** @type {(update:any)=>void} */
    this.onSessionUpdate = () => {};
    /** @type {(req:any)=>Promise<any>} */
    this.onPermissionRequest = null;
    /** @type {(info:any)=>void} */
    this.onExit = () => {};

    this.initialized = false;
    this.serverInfo = null;
    this.sessionCapabilities = {};
    /** 每个会话的当前轮状态：{ busy, turnId, chunks, startedAt } */
    this.turns = new Map();
    this.closed = false;

    this.transport.onLine((line) => this._handleLine(line));
    this.transport.onExit((info) => {
      this.closed = true;
      this.onExit(info);
      // 所有挂起的请求立刻失败，避免手机端无限转圈
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(
          fail(CODES.ACP_NOT_RUNNING, 'DSH 进程已退出，请求中断', {
            hint: '在电脑上重启网关；如果反复退出，看网关日志里的 stderr。',
          }),
        );
      }
      this.pending.clear();
    });
  }

  // ── 帧分发 ────────────────────────────────────────────────────────────────
  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // 协议流量之外的杂行（例如某个插件往 stdout 打了日志）
      this.log(`ACP 收到非 JSON 行，已忽略：${line.slice(0, 200)}`);
      return;
    }

    // ① 服务端主动发的 request（要我们回）
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this._handleServerRequest(msg);
      return;
    }

    // ② 服务端 notification（session/update 等）
    if (msg.method) {
      if (msg.method === 'session/update') this.onSessionUpdate(msg.params);
      return;
    }

    // ③ 对我们请求的响应
    if (msg.id !== undefined && msg.id !== null) {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // 已超时/已取消的迟到响应
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          fail(CODES.ACP_TURN_FAILED, `DSH 返回错误：${msg.error.message ?? JSON.stringify(msg.error)}`, {
            details: { acpError: msg.error },
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  _handleServerRequest(msg) {
    if (msg.method === 'session/request_permission') {
      const params = msg.params ?? {};
      const request = {
        // ACP 的权限请求没有独立 id，用 jsonrpc id 作为关联键
        rpcId: msg.id,
        sessionId: params.sessionId,
        toolCallId: params.toolCall?.toolCallId ?? null,
        options: Array.isArray(params.options) ? params.options : [],
      };
      if (!this.onPermissionRequest) {
        // 没人接就明确拒绝，而不是静默挂住
        this._send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { outcome: { outcome: 'cancelled' } },
        });
        this.log('收到审批请求但没有处理器，已按取消处理');
        return;
      }
      Promise.resolve(this.onPermissionRequest(request))
        .then((outcome) => {
          this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
        })
        .catch((e) => {
          this.log(`审批处理器抛错：${e?.message ?? e}`);
          this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
        });
      return;
    }

    // 其他服务端 request 我们都不支持——按 JSON-RPC 规范回 method-not-found，
    // 这样 DSH 那边会立刻失败而不是等超时。
    this._send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `unsupported client method: ${msg.method}` },
    });
  }

  _send(frame) {
    if (this.closed) return false;
    return this.transport.write(JSON.stringify(frame));
  }

  /**
   * 发一个 request 并等响应。
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs] - 传 0 表示不超时（prompt 用）
   */
  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (this.closed) {
      return Promise.reject(
        fail(CODES.ACP_NOT_RUNNING, 'DSH 连接已关闭', { hint: '重启网关后再试。' }),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            fail(CODES.TIMEOUT, `请求 ${method} 超时（${timeoutMs}ms）`, {
              details: { method },
            }),
          );
        }, timeoutMs);
        // 别让超时计时器拖住进程退出
        timer.unref?.();
      }
      this.pending.set(id, { resolve, reject, timer });
      const ok = this._send({ jsonrpc: '2.0', id, method, params });
      if (!ok) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(fail(CODES.ACP_NOT_RUNNING, 'DSH 连接已断开', { hint: '重启网关后再试。' }));
      }
    });
  }

  // ── ACP 语义封装 ──────────────────────────────────────────────────────────

  /** 握手。返回服务端公布的能力；协议版本不符会明确报错。 */
  async initialize() {
    const result = await this.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES },
      this.handshakeTimeoutMs,
    );
    const version = result?.protocolVersion;
    if (version !== 1) {
      throw fail(CODES.ACP_PROTOCOL_MISMATCH, `ACP 协议版本不匹配：期望 1，实际 ${version}`, {
        details: { got: version, expected: 1 },
      });
    }
    this.serverInfo = result.agentInfo ?? null;
    this.sessionCapabilities = result.agentCapabilities?.sessionCapabilities ?? {};
    this.initialized = true;
    return result;
  }

  /** 列会话。DSH 会返回 `[{sessionId, cwd}]`。 */
  async listSessions() {
    const result = await this.request('session/list', {});
    return Array.isArray(result?.sessions) ? result.sessions : [];
  }

  /**
   * 新建会话。
   * @param {object} params
   * @param {string} params.cwd - 工作目录（决定 DSH 在哪个目录里干活）
   * @param {Array} [params.mcpServers]
   */
  async newSession({ cwd, mcpServers = [] }) {
    const result = await this.request('session/new', { cwd, mcpServers });
    if (!result?.sessionId) {
      throw fail(CODES.INTERNAL, 'session/new 没有返回 sessionId', {
        details: { result },
      });
    }
    return {
      sessionId: result.sessionId,
      configOptions: result.configOptions ?? [],
    };
  }

  /** 恢复一个已持久化的会话（跨进程有效）。 */
  async resumeSession(sessionId) {
    const result = await this.request('session/resume', { sessionId });
    return result;
  }

  /**
   * 发一轮 prompt。**会阻塞到本轮结束**。
   *
   * 调用方（网关）必须自己保证「同一会话不并发」——ACP 侧会直接抛
   * `a prompt is already in flight for this session`。
   *
   * @param {object} params
   * @param {string} params.sessionId
   * @param {string} params.text
   * @param {(chunk:string)=>void} [params.onText] - 文本增量回调
   * @returns {Promise<{stopReason:string, text:string}>}
   */
  async prompt({ sessionId, text, onText }) {
    const turn = this.turns.get(sessionId);
    if (turn?.busy) {
      throw fail(CODES.ACP_PROMPT_BUSY, '这一轮还在跑，不能并发再发一条', {
        details: { sessionId, turnId: turn.turnId },
      });
    }

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state = { busy: true, turnId, chunks: [], startedAt: Date.now() };
    this.turns.set(sessionId, state);

    // 本轮内的增量都投给这次调用；onText 负责转成 SSE 推给手机
    const prevUpdate = this.onSessionUpdate;
    this.onSessionUpdate = (params) => {
      prevUpdate?.(params);
      if (params?.sessionId !== sessionId) return;
      const u = params.update ?? params;
      if (u?.sessionUpdate === 'agent_message_chunk') {
        const chunk = extractText(u.content);
        if (chunk) {
          state.chunks.push(chunk);
          try {
            onText?.(chunk);
          } catch (e) {
            this.log(`onText 回调抛错：${e?.message ?? e}`);
          }
        }
      }
    };

    try {
      const result = await this.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: String(text ?? '') }] },
        0, // 不超时：一轮跑十几分钟是正常的
      );
      return {
        turnId,
        stopReason: result?.stopReason ?? 'end_turn',
        text: state.chunks.join(''),
      };
    } finally {
      this.onSessionUpdate = prevUpdate;
      state.busy = false;
      state.endedAt = Date.now();
    }
  }

  /** 取消当前轮。没有进行中的轮就静默成功（ACP 语义）。 */
  async cancel(sessionId) {
    await this.request('session/cancel', { sessionId });
  }

  /** 关闭会话并释放其后代。 */
  async closeSession(sessionId) {
    const result = await this.request('session/close', { sessionId });
    this.turns.delete(sessionId);
    return result;
  }

  /** 回答一个审批请求。 */
  answerPermission(rpcId, optionId) {
    const outcome =
      optionId === 'cancelled'
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: String(optionId) };
    this._send({ jsonrpc: '2.0', id: rpcId, result: { outcome } });
  }

  destroy() {
    this.closed = true;
    this.transport.close();
  }
}

/**
 * 从 ACP content block 里取纯文本。
 * 只认 `text`；`resource_link` / `image` 一律忽略——手机端不需要它们。
 */
export function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
      .join('');
  }
  if (content.type === 'text') return String(content.text ?? '');
  return '';
}
