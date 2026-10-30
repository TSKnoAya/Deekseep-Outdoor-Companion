/**
 * 结构化错误：所有失败都必须能回答「哪里坏了 + 下一步点哪」。
 *
 * 为什么单独一个模块：AGENTS.md §1.7 要求 `ok:false` 必须同时带 `code`（机器读）、
 * `error`（人读）、`hint`（下一步）。如果每个调用点自己拼字符串，必然出现
 * 「有 error 没 hint」「code 拼错」这类漂移——而这类漂移在手机端表现为
 * 「只显示一句看不懂的报错」，用户没法自救。
 *
 * 所以：**错误只能从这里造**，调用点不许自己 new Error 往外抛。
 */

/** 机器可读的错误码。新增时同步 test/errors.test.js 的覆盖清单。 */
export const CODES = {
  // 通用
  BAD_REQUEST: 'request.invalid',
  UNAUTHORIZED: 'auth.unauthorized',
  FORBIDDEN: 'auth.forbidden',
  NOT_FOUND: 'request.not-found',
  TIMEOUT: 'request.timeout',
  INTERNAL: 'internal.error',

  // 配对
  PAIR_CODE_INVALID: 'pair.code-invalid',
  PAIR_CODE_EXPIRED: 'pair.code-expired',
  PAIR_RATE_LIMITED: 'pair.rate-limited',

  // ACP / DSH
  ACP_NOT_RUNNING: 'acp.not-running',
  ACP_SPAWN_FAILED: 'acp.spawn-failed',
  ACP_PROTOCOL_MISMATCH: 'acp.protocol-mismatch',
  ACP_SESSION_NOT_FOUND: 'acp.session-not-found',
  ACP_PROMPT_BUSY: 'acp.prompt-busy',
  ACP_TURN_FAILED: 'acp.turn-failed',

  // 审批
  APPROVAL_NOT_FOUND: 'approval.not-found',
  APPROVAL_EXPIRED: 'approval.expired',

  // 语音
  ASR_NOT_CONFIGURED: 'asr.not-configured',
  ASR_MODEL_MISSING: 'asr.model-missing',
  ASR_FAILED: 'asr.failed',
  TTS_PROVIDER_NOT_CONFIGURED: 'tts.provider-not-configured',
  TTS_FAILED: 'tts.failed',
  AUDIO_INVALID: 'audio.invalid',
  AUDIO_TOO_LARGE: 'audio.too-large',
};

/**
 * 每个码的默认提示。写成「现在该点什么」而不是「发生了什么」。
 * 这里不是日志，是给用户看的一句话。
 */
const DEFAULT_HINTS = {
  [CODES.BAD_REQUEST]: '检查请求参数是不是漏了或格式不对，然后重试。',
  [CODES.UNAUTHORIZED]: '在 App 里重新配对一次（设置 → 重新配对）。',
  [CODES.FORBIDDEN]: '这台设备没有权限做这个操作，换已配对的设备或重新配对。',
  [CODES.NOT_FOUND]: '刷新一下列表，确认目标还在。',
  [CODES.TIMEOUT]: '稍等几秒再试；连续超时说明本机网关或 DSH 卡住了。',
  [CODES.INTERNAL]: '把这条错误发给开发者，并附上网关日志里同一时间的记录。',

  [CODES.PAIR_CODE_INVALID]: '核对电脑上显示的 6 位配对码，重新输入。',
  [CODES.PAIR_CODE_EXPIRED]: '配对码过期了。让电脑端重新生成一个（设置 → 手机配对）。',
  [CODES.PAIR_RATE_LIMITED]: '尝试次数太多。等几分钟再试，或重新生成配对码。',

  [CODES.ACP_NOT_RUNNING]: '在电脑上启动网关（npm start），确认 DSH 已登录。',
  [CODES.ACP_SPAWN_FAILED]: '确认 "D:\\deepseek\\DeepSeek Harness.exe" 还在原路径；路径变了要在配置里改。',
  [CODES.ACP_PROTOCOL_MISMATCH]: 'DSH 升级后协议变了。跑一遍网关自检，或把 DSH 版本降回去。',
  [CODES.ACP_SESSION_NOT_FOUND]: '这个会话已经不在了。回列表新建一个。',
  [CODES.ACP_PROMPT_BUSY]: '这一轮还没结束。等它跑完，或先点「停止」。',
  [CODES.ACP_TURN_FAILED]: '本轮执行失败。重发一次；反复失败看网关日志里的 error 事件。',

  [CODES.APPROVAL_NOT_FOUND]: '这个审批已经处理过或已超时，不用再点。',
  [CODES.APPROVAL_EXPIRED]: '超过时限，DSH 已经按拒绝处理了。重新发消息即可。',

  [CODES.ASR_NOT_CONFIGURED]: '到设置里选一个转写方式：本机网关识别 或 手机本地转写。',
  [CODES.ASR_MODEL_MISSING]: '首次使用要下载识别模型（约 240MB）。到设置里点「下载模型」。',
  [CODES.ASR_FAILED]: '再录一次，尽量靠近麦克风、减少背景音。',
  [CODES.TTS_PROVIDER_NOT_CONFIGURED]: '语音播报后端还没配好。可以先用手机自带的系统语音，或到设置里填火山引擎的 AppID / Access Token。',
  [CODES.TTS_FAILED]: '合成失败。检查网络，或临时切到手机系统语音。',
  [CODES.AUDIO_INVALID]: '录音格式不对（需要 16kHz 单声道 PCM16 WAV）。重新录一次。',
  [CODES.AUDIO_TOO_LARGE]: '录音太长或太大。说短一点再试。',
};

/**
 * 造一个结构化错误。
 * @param {string} code - 必须是 {@link CODES} 里的值。
 * @param {string} error - 人读的一句话，说清「在哪失败」。
 * @param {object} [options]
 * @param {string} [options.hint] - 覆盖默认提示；只有默认不适用时才传。
 * @param {number} [options.status] - HTTP 状态码，默认按 code 推断。
 * @param {object} [options.details] - 附加机器可读信息（不要放密钥）。
 * @returns {Error & { code:string, hint:string, status:number, details?:object }}
 */
export function fail(code, error, options = {}) {
  const hint = String(options.hint ?? DEFAULT_HINTS[code] ?? '重试一次；仍然失败就把这条错误发给开发者。');
  const err = new Error(String(error || code));
  err.code = code;
  err.hint = hint;
  err.status = options.status ?? statusFor(code);
  if (options.details && typeof options.details === 'object') err.details = options.details;
  // 标记：这是「给用户看」的错误，不是内部 bug，上层不用打完整栈
  err.userFacing = true;
  return err;
}

/** 码 → HTTP 状态。默认 500，已知类别给出更准确的值。 */
export function statusFor(code) {
  if (code === CODES.BAD_REQUEST || code === CODES.AUDIO_INVALID || code === CODES.AUDIO_TOO_LARGE) return 400;
  if (code === CODES.UNAUTHORIZED || code === CODES.PAIR_CODE_INVALID || code === CODES.PAIR_CODE_EXPIRED) return 401;
  if (code === CODES.FORBIDDEN || code === CODES.PAIR_RATE_LIMITED) return 403;
  if (code === CODES.NOT_FOUND || code === CODES.ACP_SESSION_NOT_FOUND || code === CODES.APPROVAL_NOT_FOUND) return 404;
  if (code === CODES.TIMEOUT) return 504;
  if (code === CODES.ACP_PROMPT_BUSY || code === CODES.APPROVAL_EXPIRED) return 409;
  if (code === CODES.ASR_NOT_CONFIGURED || code === CODES.TTS_PROVIDER_NOT_CONFIGURED) return 503;
  return 500;
}

/**
 * 把任意异常收敛成 `{ ok:false, code, error, hint }`。
 *
 * 非 {@link fail} 造出来的异常（真正的 bug、第三方库抛的）一律归成 INTERNAL，
 * 但**保留原始 message 到 error 字段**——否则用户只会看到「内部错误」，
 * 而开发者拿不到任何线索。
 */
export function toFailure(err) {
  if (err && err.userFacing && err.code) {
    return {
      ok: false,
      code: err.code,
      error: err.message,
      hint: err.hint,
      ...(err.details ? { details: err.details } : {}),
    };
  }
  return {
    ok: false,
    code: CODES.INTERNAL,
    error: err?.message ? String(err.message) : '未知错误',
    hint: DEFAULT_HINTS[CODES.INTERNAL],
    ...(err?.stack ? { details: { stack: String(err.stack).split('\n').slice(0, 4).join('\n') } } : {}),
  };
}

/** 成功响应。保持和 `toFailure` 对称的形状，前端只用判 `ok`。 */
export function ok(value) {
  return { ok: true, ...value };
}

/**
 * 断言式校验：不满足就抛结构化错误。
 * 用它代替散落的 `if (!x) throw new Error(...)`，保证每个失败都有 code + hint。
 */
export function requireThat(condition, code, error, options) {
  if (!condition) throw fail(code, error, options);
}
