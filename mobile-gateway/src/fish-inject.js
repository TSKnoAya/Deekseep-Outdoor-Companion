/**
 * 「把鱼带到手机」的注入调度：决定**这一轮要不要把人格+记忆拼进 prompt**。
 *
 * 为什么不是每轮都拼：
 * ACP 会话会保存历史，第一轮注入的前言会一直留在上下文里。每轮再拼一遍等于
 * 同一段 1KB 的话重复 N 遍——既烧 token，又会让模型把它当成"反复强调的命令"，
 * 说话越来越像在念设定。所以：
 *
 *   第一轮  → 完整注入
 *   记忆变了 → 再注入一次（最多 maxInjections 次，避免用户连聊几十轮把窗口填满）
 *   其余     → 不注入（历史里已经有了）
 *
 * 为什么用文件 mtime/size 当"变了"的判据：
 * SurfCore 每次写入记忆卡都会重写文件，mtime 必变；读内容再比对要多读 100KB
 * 且拿不到"内容没变但被重写"的区别——而那种情况重新注入一次也无害。
 */

import { buildFishContext, fishSignature } from './fish-context.js';

/**
 * @param {object} options
 * @param {string} options.dshHome - `~/.dsh`
 * @param {(msg:string, data?:any)=>void} [options.log]
 * @param {boolean} [options.enabled] - 初始开关
 * @param {number} [options.maxInjections] - 同一会话最多注入几次（含第一次）
 * @param {object} [options.fsLike] - 测试注入
 * @param {Function} [options.buildContext] - 测试注入
 * @param {Function} [options.signature] - 测试注入
 */
export function createFishInjector(options = {}) {
  const log = options.log || (() => {});
  const maxInjections = Number.isFinite(options.maxInjections) && options.maxInjections > 0
    ? Math.round(options.maxInjections)
    : 4;
  const buildContext = options.buildContext ?? buildFishContext;
  const signature = options.signature ?? fishSignature;
  const base = { dshHome: options.dshHome, fsLike: options.fsLike };

  let enabled = options.enabled !== false;
  /** sessionId → { sig, count } */
  const state = new Map();
  let lastReason = null;

  function currentSignature() {
    try {
      return signature(base);
    } catch {
      return '';
    }
  }

  return {
    isEnabled: () => enabled,

    /**
     * 这一轮该拼什么。
     *
     * @returns {{prefix:string|null, reason:string, character?:string}}
     *   prefix 为 null 表示不加任何东西（正常情况，不算错误）。
     */
    prepare(sessionId) {
      if (!enabled) {
        lastReason = 'disabled';
        return { prefix: null, reason: 'disabled' };
      }

      const ctx = buildContext(base);
      if (!ctx?.ok) {
        lastReason = ctx?.reason ?? 'unavailable';
        return { prefix: null, reason: lastReason };
      }

      const sig = currentSignature();
      const prev = state.get(sessionId);
      if (!prev) {
        lastReason = 'first';
        return { prefix: ctx.text, reason: 'first', character: ctx.name, sig };
      }
      if (prev.count >= maxInjections) {
        lastReason = 'capped';
        return { prefix: null, reason: 'capped' };
      }
      if (sig && sig !== prev.sig) {
        lastReason = 'memory-changed';
        return {
          prefix: `【记忆有更新，这是你现在的最新记忆，之前那份作废。】\n${ctx.text}`,
          reason: 'memory-changed',
          character: ctx.name,
          sig,
        };
      }
      lastReason = 'already';
      return { prefix: null, reason: 'already' };
    },

    /** 本轮成功后才记账：失败重试时不该被当成"已经注入过"。 */
    commit(sessionId, prepared) {
      if (!prepared?.prefix) return;
      const prev = state.get(sessionId);
      state.set(sessionId, {
        sig: prepared.sig ?? currentSignature(),
        count: (prev?.count ?? 0) + 1,
      });
      log(`已注入角色上下文（${prepared.reason}）：${prepared.character ?? '?'}`);
    },

    /** 会话关掉就丢掉状态，下次进来重新注入——那是新的一段对话。 */
    forget(sessionId) {
      state.delete(sessionId);
    },

    status() {
      let ctx = null;
      try {
        ctx = buildContext(base);
      } catch {
        ctx = { ok: false, reason: 'error' };
      }
      return {
        enabled,
        available: Boolean(ctx?.ok),
        reason: ctx?.ok ? null : (ctx?.reason ?? 'unavailable'),
        character: ctx?.ok ? ctx.name : null,
        personaChars: ctx?.personaChars ?? 0,
        memoryChars: ctx?.memoryChars ?? 0,
        truncated: Boolean(ctx?.truncated),
        maxInjections,
        lastReason,
        sessions: [...state.entries()].map(([id, v]) => ({ sessionId: id, injections: v.count })),
      };
    },

    setEnabled(next) {
      enabled = Boolean(next);
      log(`角色上下文注入：${enabled ? '开' : '关'}`);
      return enabled;
    },
  };
}
