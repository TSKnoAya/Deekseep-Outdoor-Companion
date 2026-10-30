/**
 * 轮次队列：保证「同一个会话同时只有一个 prompt」。
 *
 * 为什么必须自己做：ACP 侧遇到并发会直接抛
 * `a prompt is already in flight for this session`（源码原文），
 * 而手机端的用户不会等——他会连点两下发送。
 * 与其让第二下变成一个红错误，不如排队：
 * 第一轮跑完自动接着跑第二轮，用户看到的是「稍后发出」。
 *
 * 同时这个类承担 SSE 的广播中心：一轮里的文本增量、工具调用、审批请求
 * 都要能推给**多个**订阅者（手机可能同时开着两个界面）。
 *
 * 实现用一个显式的 `pump()`：入队后尝试启动，任务结束时再尝试启动。
 * 不要用「递归 setTimeout 首元素」那种写法——它会在清空队列后留下幽灵调用，
 * 且两处同时触发时会并发跑两条（正好是这里最不能出现的 bug）。
 */

import { CODES, fail } from './errors.js';

export class SessionHub {
  /**
   * @param {object} options
   * @param {(msg:string, data?:any)=>void} [options.log]
   * @param {number} [options.queueLimit] - 单会话排队上限，防止手机连点堆爆内存
   */
  constructor(options = {}) {
    this.log = options.log || (() => {});
    this.queueLimit = options.queueLimit ?? 10;
    /** @type {Map<string, {running:boolean, queue:Array<{turnId:string, task:Function}>}>} */
    this.sessions = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** @type {Map<string, {turnId:string, startedAt:number}>} */
    this.current = new Map();
  }

  _state(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { running: false, queue: [] };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  /** 订阅某会话的事件流。返回取消订阅函数。 */
  subscribe(sessionId, listener) {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscriberCount(sessionId) {
    return this.listeners.get(sessionId)?.size ?? 0;
  }

  /** 向所有订阅者广播。单个订阅者抛错不影响其他订阅者。 */
  emit(sessionId, event) {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch (e) {
        this.log(`SSE 订阅者抛错（已隔离）：${e?.message ?? e}`);
      }
    }
  }

  /** 当前状态（给 /v1/health 与 App 顶部「正在思考」用）。 */
  status(sessionId) {
    const s = this.sessions.get(sessionId);
    const turn = this.current.get(sessionId);
    return {
      running: Boolean(s?.running),
      queued: Math.max(0, (s?.queue.length ?? 0) - (s?.running ? 1 : 0)),
      turn: turn ? { turnId: turn.turnId, startedAt: turn.startedAt } : null,
      subscribers: this.subscriberCount(sessionId),
    };
  }

  /**
   * 提交一轮。**立刻返回 turnId**，执行在后台串行进行。
   *
   * @param {string} sessionId
   * @param {(ctx:{turnId:string, emit:(e:any)=>void}) => Promise<any>} task
   * @returns {{turnId:string, queued:number}}
   */
  submit(sessionId, task) {
    const s = this._state(sessionId);
    // 「前面还有几轮」= 正在跑的那一轮 + 已经排队的。
    // 只数 queue.length 会漏掉正在跑的（它在 shift 之后就离开队列了），
    // 于是用户连点两下会看到「排队 0」，以为没排上又点一下（单测抓到的）。
    const queuedAhead = s.queue.length + (s.running ? 1 : 0);
    if (queuedAhead >= this.queueLimit) {
      throw fail(CODES.ACP_PROMPT_BUSY, `这个会话已经排了 ${queuedAhead} 条，先等它们跑完`, {
        hint: '等前面的跑完再发，或者点「停止」清空队列。',
        details: { queued: queuedAhead, limit: this.queueLimit },
      });
    }

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    s.queue.push({ turnId, task });
    this.pump(sessionId);
    return { turnId, queued: queuedAhead };
  }

  /** 队列泵：不忙且有活就取一条跑。任何时刻只会有一个在跑。 */
  pump(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.running) return;
    const job = s.queue.shift();
    if (!job) return;

    s.running = true;
    const startedAt = Date.now();
    this.current.set(sessionId, { turnId: job.turnId, startedAt });
    this.emit(sessionId, { type: 'turn_start', turnId: job.turnId, startedAt });

    const ctx = { turnId: job.turnId, emit: (e) => this.emit(sessionId, { turnId: job.turnId, ...e }) };

    Promise.resolve()
      .then(() => job.task(ctx))
      .then(
        (result) => {
          this.emit(sessionId, {
            type: 'turn_end',
            turnId: job.turnId,
            ok: true,
            result,
            durationMs: Date.now() - startedAt,
          });
        },
        (e) => {
          // 失败也必须推给手机——只写日志等于用户永远在等
          const failure = {
            code: e?.code ?? CODES.ACP_TURN_FAILED,
            error: e?.message ?? String(e),
            hint: e?.hint ?? '重发一次；反复失败看电脑上的网关日志。',
          };
          this.emit(sessionId, {
            type: 'turn_end',
            turnId: job.turnId,
            ok: false,
            failure,
            durationMs: Date.now() - startedAt,
          });
          this.log(`轮次 ${job.turnId} 失败：${failure.code} ${failure.error}`);
        },
      )
      .finally(() => {
        s.running = false;
        this.current.delete(sessionId);
        // 立刻尝试跑下一条（不在回调里递归，避免爆栈）
        setImmediate(() => this.pump(sessionId));
      });
  }

  /** 清空排队（不打断正在跑的那一轮）。 */
  clearQueue(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { cleared: 0 };
    const cleared = s.queue.length;
    s.queue = [];
    if (cleared) this.emit(sessionId, { type: 'queue_cleared', cleared });
    return { cleared };
  }

  /** 会话关掉时释放订阅者，避免泄漏。 */
  dispose(sessionId) {
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
    this.current.delete(sessionId);
  }
}

/**
 * 审批等待表。
 *
 * 为什么要有自己的 id 而不是直接把 rpcId 给手机：手机可能断线重连，
 * 重连后需要一个稳定的 id 来回答；而 rpcId 是 jsonrpc 内部编号，重启就没了。
 * 这里生成自己的 id，映射到 rpcId + 超时定时器。
 */
export class ApprovalRegistry {
  constructor({ timeoutMs = 300_000, log = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.log = log;
    /** @type {Map<string, any>} */
    this.pending = new Map();
    this.seq = 0;
  }

  /**
   * @param {object} request - AcpClient 传来的 request
   * @param {(outcome:any)=>void} settle - 超时或回答时调用，把结果交回 ACP
   */
  add(request, settle) {
    const id = `apv-${++this.seq}-${Date.now().toString(36)}`;
    const expiresAt = Date.now() + this.timeoutMs;
    const timer = setTimeout(() => {
      this.log(`审批 ${id} 超时，按取消处理`);
      this.pending.delete(id);
      try {
        settle({ outcome: 'cancelled' });
      } catch {
        /* ACP 那边可能已经关了 */
      }
    }, this.timeoutMs);
    timer.unref?.();

    this.pending.set(id, {
      rpcId: request.rpcId,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      options: request.options,
      createdAt: Date.now(),
      timer,
      settle,
    });

    return {
      id,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      options: request.options,
      expiresAt,
    };
  }

  /** 回答一个审批。 */
  answer(id, optionId) {
    const entry = this.pending.get(id);
    if (!entry) {
      throw fail(CODES.APPROVAL_NOT_FOUND, `没有这个待审批请求：${id}`, {});
    }
    // 只接受这个请求真正提供过的选项
    const valid = entry.options.some((o) => o?.optionId === optionId);
    if (!valid && optionId !== 'cancelled') {
      throw fail(CODES.BAD_REQUEST, `无效的审批选项：${optionId}`, {
        details: { offered: entry.options.map((o) => o?.optionId) },
      });
    }

    clearTimeout(entry.timer);
    this.pending.delete(id);
    const outcome =
      optionId === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
    entry.settle(outcome);
    return { id, outcome };
  }

  /** 列出某会话的待审批（重连后拉一遍）。 */
  list(sessionId) {
    return [...this.pending.entries()]
      .filter(([, e]) => !sessionId || e.sessionId === sessionId)
      .map(([id, e]) => ({
        id,
        sessionId: e.sessionId,
        toolCallId: e.toolCallId,
        options: e.options,
        createdAt: e.createdAt,
      }));
  }

  /** 会话关闭时清空，避免留下永远不会被回答的请求。 */
  clearSession(sessionId) {
    for (const [id, e] of this.pending) {
      if (e.sessionId !== sessionId) continue;
      clearTimeout(e.timer);
      this.pending.delete(id);
      try {
        e.settle({ outcome: 'cancelled' });
      } catch {
        /* 忽略 */
      }
    }
  }
}
