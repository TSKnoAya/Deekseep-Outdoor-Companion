/**
 * 「桌面 DSH 传输」：让手机会话和桌面 DSH 是**同一条**会话题。
 *
 * 为什么需要它（实测结论，见 case §31）：
 * - ACP 建的会话 DSH 不认领（`session/resume` 失败），用 ACP id 去 `session/create`
 *   只会另建一条或产生 `<uuid>` / `session-<uuid>` 两份副本；
 * - DSH 自己用 RPC 建的会话，侧栏立刻可见。
 * 所以当桌面 DSH 在跑时，网关改为直接走 DSH 的 Web RPC：建会话 / 发消息 / 收事件 / 答审批，
 * 与 QQ 桥接（src/bridge.js）用的是同一套协议。
 *
 * 接口刻意做成和 AcpClient 同形，server.js 不需要知道背后是谁。
 * 桌面 DSH 不可用时由 main.js 退回 ACP。
 */

import { createTurnCollector, NodeApiClient, unwrap } from '../../src/dsh-client.js';
import { discoverDshBaseUrl } from '../../src/dsh-port.js';
import fs from 'node:fs';
import path from 'node:path';
import { CODES, fail } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

function normalizePath(p) {
  return String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** cwd → DSH 工作区 id（找不到返回 null）。 */
function workspaceIdForCwd(dshHome, cwd) {
  if (!dshHome || !cwd) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dshHome, 'storages', 'workspace.json'), 'utf8'));
    const want = normalizePath(cwd);
    for (const [id, w] of Object.entries(doc?.tables?.workspaces ?? {})) {
      if (normalizePath(w?.path) === want) return id;
    }
  } catch {
    /* 读不到就按 cwd 建 */
  }
  return null;
}

export class DesktopClient {
  constructor(options = {}) {
    this.dshHome = options.dshHome;
    this.log = options.log || (() => {});
    this.api = null;
    this.baseUrl = null;
    this.initialized = false;
    this.serverInfo = { name: 'desktop-dsh', version: 'rpc' };
    /** 正在等待 turn/end 的会话：sessionId → {collector, resolve, reject, timer} */
    this.turns = new Map();
    /** 已 follow 的会话（重连要重放） */
    this.followed = new Set();
    /** rpcId → resolve(optionId)，用于审批回执 */
    this.pendingPerm = new Map();
    this.onPermissionRequest = null;
    this.destroyed = false;
    this.seq = 0;
  }

  async connect() {
    const base = await discoverDshBaseUrl();
    if (!base) {
      throw fail(CODES.ACP_NOT_RUNNING, '没有找到正在运行的桌面 DSH', {
        hint: '打开 DeepSeek Harness 桌面端后重试；或改用 ACP 传输。',
      });
    }
    this.baseUrl = base;
    this.api = new NodeApiClient(base, 20_000, {});
    // 探活：session/list 能回就说明鉴权/协议都对
    await this.api.callUnary('session/list', {});
    this.initialized = true;
    this._pump();
    this.log(`桌面 DSH 传输已连接：${base}`);
    return this;
  }

  destroy() {
    this.destroyed = true;
    try {
      this.api?.invalidateAuth?.();
    } catch {
      /* ignore */
    }
  }

  // ── AcpClient 同形接口 ────────────────────────────────────────────────

  async listSessions() {
    const value = unwrap(await this.api.callUnary('session/list', {}), 'session/list');
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.map((s) => ({ sessionId: String(s.sessionId), cwd: s.cwd ?? '' }));
  }

  async newSession({ cwd }) {
    const workspaceId = workspaceIdForCwd(this.dshHome, cwd);
    const payload = workspaceId ? { workspaceId } : cwd ? { cwd } : {};
    const value = unwrap(await this.api.callUnary('session/create', payload), 'session/create');
    const sessionId = String(value?.sessionId ?? '');
    if (!sessionId) throw fail(CODES.INTERNAL, '桌面 DSH 没有返回 sessionId', {});
    this._follow(sessionId);
    return { sessionId, cwd };
  }

  async resumeSession(sessionId) {
    this._follow(sessionId);
    return { sessionId };
  }

  /**
   * 发一轮。事件流是整段推送的（assistant/message 落到 turn/end 才拿得到完整文本），
   * 所以这里在回合结束时一次性调 `onText`；手机端看到的是「完成后一次性出现」。
   */
  async prompt({ sessionId, text, onText }) {
    if (!this.api) throw fail(CODES.ACP_NOT_RUNNING, '桌面 DSH 未连接', {});
    this._follow(sessionId);

    const collector = createTurnCollector();
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turns.delete(sessionId);
        this.api.callUnary('session/cancel', { sessionId }).catch(() => {});
        reject(fail(CODES.TIMEOUT, '这一轮超过 30 分钟没有结束', { hint: '在电脑上看看是否卡在审批/工具调用。' }));
      }, PROMPT_TIMEOUT_MS);
      this.turns.set(sessionId, { collector, resolve, reject, timer });
    });

    try {
      await this.api.callUnary('session/prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
    } catch (e) {
      const cur = this.turns.get(sessionId);
      if (cur) clearTimeout(cur.timer);
      this.turns.delete(sessionId);
      throw fail(CODES.INTERNAL, `DSH 拒绝发送：${e?.message ?? e}`, {
        hint: '确认桌面 DSH 还在运行、会话没有被归档/删除。',
      });
    }

    const ended = await done;
    const reply = String(ended?.text ?? '');
    if (reply && typeof onText === 'function') onText(reply);
    return { stopReason: ended?.reason?.kind ?? 'end_turn', text: reply };
  }

  async cancel(sessionId) {
    await this.api.callUnary('session/cancel', { sessionId });
  }

  async closeSession(sessionId) {
    this.followed.delete(sessionId);
    try {
      this.api?.events?.forget?.(sessionId);
    } catch {
      /* ignore */
    }
    return { closed: sessionId };
  }

  answerPermission(rpcId, optionId) {
    const resolve = this.pendingPerm.get(rpcId);
    if (!resolve) return;
    this.pendingPerm.delete(rpcId);
    resolve(optionId);
  }

  // ── 事件流 ────────────────────────────────────────────────────────────

  _follow(sessionId) {
    if (!sessionId) return;
    this.followed.add(String(sessionId));
    try {
      this.api?.events?.follow?.(sessionId);
    } catch {
      /* ignore */
    }
  }

  async _pump() {
    while (!this.destroyed) {
      try {
        const stream = this.api.events.mux({}, undefined, () => {
          for (const id of this.followed) {
            try {
              stream.follow(id);
            } catch {
              /* ignore */
            }
          }
        });
        for await (const envelope of stream) {
          if (this.destroyed) break;
          this._onFrame(envelope?.payload ?? envelope);
        }
      } catch (e) {
        if (this.destroyed) break;
        this.log(`桌面事件流断开：${e?.message ?? e}，3 秒后重连`);
      }
      await sleep(3000);
    }
  }

  _onFrame(frame) {
    if (!frame) return;
    if (frame.type === 'session/event' && frame.event) {
      const sessionId = String(frame.sessionId ?? '');
      const turn = this.turns.get(sessionId);
      // 只把本进程等待中的回合喂给 collector：历史快照/别的会话不参与
      if (!turn) return;
      const ended = turn.collector.push(frame.event);
      if (!ended) return;
      clearTimeout(turn.timer);
      this.turns.delete(sessionId);
      turn.resolve(ended);
      return;
    }
    if (frame.type === 'approval/requested') {
      this._handleApproval(frame).catch((e) => this.log(`审批回执失败：${e?.message ?? e}`));
      return;
    }
    if (frame.type === 'question/requested') {
      // 手机端没有问答 UI：直接给空答案，避免回合卡死
      this.api
        .respond({
          clientId: frame.clientId,
          eventId: frame.eventId,
          outcome: { kind: 'result', value: { answers: [] } },
        })
        .catch(() => {});
      return;
    }
    if (frame.type === 'stream/error') {
      this.log(`桌面事件流错误：${JSON.stringify(frame.error ?? {})}`);
    }
  }

  async _handleApproval(frame) {
    const rpcId = String(frame.eventId ?? `approval-${++this.seq}`);
    const request = {
      rpcId,
      sessionId: frame.sessionId,
      toolCallId: frame.toolCallId ?? null,
      toolName: frame.toolName ?? '',
      reason: frame.reason ?? '',
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    };

    let optionId = 'reject-once';
    if (typeof this.onPermissionRequest === 'function') {
      optionId = await new Promise((resolve) => {
        this.pendingPerm.set(rpcId, resolve);
        Promise.resolve(this.onPermissionRequest(request)).catch(() => resolve('reject-once'));
      });
    }
    const value = optionId === 'allow-once' ? 'allowed-once' : 'rejected';
    await this.api.respond({
      clientId: frame.clientId,
      eventId: frame.eventId,
      outcome: { kind: 'result', value },
    });
    this.log(`审批已回执：${request.toolName || rpcId} → ${value}`);
  }
}
