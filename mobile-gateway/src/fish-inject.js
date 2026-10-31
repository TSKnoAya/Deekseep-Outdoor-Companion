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

import path from 'node:path';
import { buildFishContext, fishSignature, listCharacters } from './fish-context.js';

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
  /** 开关变了要落盘（否则重启网关又回到默认开） */
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
  /** 角色选择变了也要落盘 */
  const onCharacterChange = typeof options.onCharacterChange === 'function' ? options.onCharacterChange : null;

  let enabled = options.enabled !== false;
  /**
   * 手机端固定的角色 id；null = 跟随桌面当前角色（`characters/current.json`）。
   * 为什么默认跟随：大多数时候手机就是"出门时的那条鱼"，用户不该在电脑上切完鱼、
   * 手机上还是旧的。固定只在用户显式选过之后才生效。
   */
  let selectedId = options.characterId ? String(options.characterId) : null;
  /** sessionId → { sig, count, characterId } */
  const state = new Map();
  let lastReason = null;

  const withSelection = (extra = {}) => ({ ...base, characterId: selectedId, ...extra });

  function currentSignature() {
    try {
      return signature(withSelection());
    } catch {
      return '';
    }
  }

  function characterList() {
    try {
      return listCharacters(path.join(options.dshHome, 'surfcore'), options.fsLike);
    } catch {
      return [];
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

      const ctx = buildContext(withSelection());
      if (!ctx?.ok) {
        lastReason = ctx?.reason ?? 'unavailable';
        return { prefix: null, reason: lastReason };
      }

      const sig = currentSignature();
      const prev = state.get(sessionId);
      if (!prev) {
        lastReason = 'first';
        return { prefix: ctx.text, reason: 'first', character: ctx.name, characterId: ctx.id, sig };
      }
      // 换了角色必须重新注入，且**不受次数上限限制**——这是用户的显式动作，
      // 旧前缀里还是上一条鱼的性格和记忆，不说清楚模型会继续演错人。
      if (ctx.id && prev.characterId && ctx.id !== prev.characterId) {
        lastReason = 'character-switched';
        return {
          prefix: `【角色已经换成「${ctx.name}」，之前那个角色的设定和记忆不再适用。】\n${ctx.text}`,
          reason: 'character-switched',
          character: ctx.name,
          characterId: ctx.id,
          sig,
        };
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
          characterId: ctx.id,
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
        characterId: prepared.characterId ?? prev?.characterId ?? null,
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
        ctx = buildContext(withSelection());
      } catch {
        ctx = { ok: false, reason: 'error' };
      }
      return {
        enabled,
        available: Boolean(ctx?.ok),
        reason: ctx?.ok ? null : (ctx?.reason ?? 'unavailable'),
        character: ctx?.ok ? ctx.name : null,
        characterId: ctx?.ok ? (ctx.id ?? null) : null,
        /** null = 跟随桌面当前角色 */
        selectedId,
        followingDesktop: !selectedId,
        /** 选过的角色在本机已经不存在，现在临时用的是桌面当前角色 */
        selectionMissing: Boolean(ctx?.selectionMissing),
        characters: characterList().map((c) => ({ id: c.id, name: c.name, updatedAt: c.updatedAt })),
        personaChars: ctx?.personaChars ?? 0,
        memoryChars: ctx?.memoryChars ?? 0,
        truncated: Boolean(ctx?.truncated),
        maxInjections,
        lastReason,
        sessions: [...state.entries()].map(([id, v]) => ({ sessionId: id, injections: v.count })),
      };
    },

    /**
     * 手机固定用哪条鱼。`null` = 跟随桌面当前角色。
     * 只改内存还不够：重启网关会回到默认，所以默认落盘。
     */
    setCharacter(next, { persist = true } = {}) {
      const id = next === null || next === undefined || next === '' ? null : String(next);
      const changed = id !== selectedId;
      selectedId = id;
      if (changed) log(`手机角色：${id ? `固定为 ${id}` : '跟随桌面当前角色'}`);
      if (persist && changed && onCharacterChange) {
        try {
          onCharacterChange(id);
        } catch {
          /* 写配置失败不该影响本次运行 */
        }
      }
      return selectedId;
    },

    setEnabled(next, { persist = true } = {}) {
      enabled = Boolean(next);
      log(`角色上下文注入：${enabled ? '开' : '关'}`);
      if (persist && onToggle) {
        try {
          onToggle(enabled);
        } catch {
          /* 写配置失败不该影响本次运行 */
        }
      }
      return enabled;
    },
  };
}
