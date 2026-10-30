/**
 * 语音后端注册表：ASR 与 TTS 各自可插拔。
 *
 * 为什么要插件化而不是写死：用户明确要求「做一个切换功能」，用来在
 * 「网关调 DSH」和「手机本地转写」之间切；播报档位也要能切。如果每条路
 * 都 if/else 写进主流程，加到第三种后端时必然变成三处硬编码。
 *
 * 所以约定：后端只要实现 `id` / `label` / `probe()` / 自己的主方法，
 * 就能被注册进来；主流程只跟接口说话。
 *
 * **失败一律抛 fail(code, ...)，不许返回 undefined 让上层猜。**
 */

import { CODES, fail } from '../errors.js';

/**
 * 后端基类契约（不强制继承，鸭子类型即可）：
 *
 * ASR：
 *   id, label
 *   async probe() -> { ok, code?, error?, hint? }
 *   async transcribe({ audio: Buffer, mime, language }) -> { text, provider }
 *
 * TTS：
 *   id, label
 *   async probe() -> { ok, code?, error?, hint? }
 *   async synthesize({ text, voice }) -> { audio: Buffer, mime }
 */

/** 简单的注册表：按 id 增删查，重复注册直接报错（静默覆盖会让排查变成噩梦）。 */
export class BackendRegistry {
  /**
   * @param {string} kind - 'asr' | 'tts'，只用于错误文案
   */
  constructor(kind) {
    this.kind = kind;
    /** @type {Map<string, any>} */
    this.backends = new Map();
    this.defaultId = null;
  }

  register(backend) {
    if (!backend?.id) throw new Error(`${this.kind} 后端缺少 id`);
    if (this.backends.has(backend.id)) {
      throw new Error(`${this.kind} 后端 ${backend.id} 重复注册`);
    }
    this.backends.set(backend.id, backend);
    if (!this.defaultId) this.defaultId = backend.id;
    return this;
  }

  has(id) {
    return this.backends.has(id);
  }

  get(id) {
    return this.backends.get(id) ?? null;
  }

  /** 取后端；不存在就抛结构化错误，而不是返回 null 让调用点 NPE。 */
  require(id) {
    const key = id || this.defaultId;
    if (!key) {
      throw fail(
        this.kind === 'asr' ? CODES.ASR_NOT_CONFIGURED : CODES.TTS_PROVIDER_NOT_CONFIGURED,
        `还没有配置任何${this.kind === 'asr' ? '转写' : '播报'}后端`,
        {},
      );
    }
    const backend = this.backends.get(key);
    if (!backend) {
      throw fail(
        this.kind === 'asr' ? CODES.ASR_NOT_CONFIGURED : CODES.TTS_PROVIDER_NOT_CONFIGURED,
        `未知的${this.kind}后端：${key}`,
        { details: { requested: key, available: [...this.backends.keys()] } },
      );
    }
    return backend;
  }

  /** 列出所有后端及其可用性（供 App 设置页渲染选择器）。 */
  async describe() {
    const out = [];
    for (const [id, backend] of this.backends) {
      let probe;
      try {
        probe = await backend.probe();
      } catch (e) {
        probe = { ok: false, code: CODES.INTERNAL, error: e?.message ?? String(e) };
      }
      out.push({
        id,
        label: backend.label ?? id,
        ready: probe?.ok === true,
        ...(probe?.ok === true ? {} : { reason: probe?.code ?? null, message: probe?.error ?? null, hint: probe?.hint ?? null }),
      });
    }
    return { default: this.defaultId, backends: out };
  }
}
