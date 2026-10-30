/**
 * TTS 后端：volcengine（火山/豆包语音）——**目前只留接口，等密钥就绪再补实现**。
 *
 * 为什么现在就把参数写死在这里：这些细节是实测确认过的，散落在聊天记录里
 * 一定会丢。写进代码注释，日后接的时候不用重新查一遍。
 *
 * ── 已确认的接入契约（2026-10-30 核对 voxd 源码与官方文档）────────────────
 * 端点：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 * 头：  X-Api-App-Key       = <AppID>
 *       X-Api-Access-Key    = <Access Token>
 *       X-Api-Resource-Id   = seed-icl-2.0   ← 必须是这个，换 seed-tts-2.0 会 403/55000000
 *       X-Api-Request-Id    = 任意唯一串
 * body：{ user: { uid }, req_params: { text, speaker, audio_params: { format:'wav', sample_rate:24000 } } }
 * 返回：多行 JSON，每行 { code, data }，data 是 base64 的 WAV 分片。
 *       **首片 RIFF 的长度字段是 0xFFFFFFFF（流式），必须按 'data' 块自己切 PCM。**
 *       成功码有两种：0 和 20000000（后者 data 为 null，是结束帧）。
 * 音色：speaker 是复刻得到的 ID（例如 S_fxkbW5bj2），不是本地文件。
 *
 * ── 已知的坑（都是实测/源码里踩出来的）───────────────────────────────────
 * 1. 缺少 AppID 或 AccessToken 时，**绝不能用空串去请求**——那会 401 并可能
 *    在日志里留下半截凭据。这里先用 probe() 拦住，报 `tts.provider-not-configured`。
 * 2. `ark-` 开头的方舟 API Key **不能**用于这里。已实测三种认证方式全部失败：
 *    X-Api-Key → 401 45000010 Invalid X-Api-Key
 *    Bearer    → 400 45000000 app key not found in header or query
 *    App-Key   → 401 45000010 load grant: requested grant not found in SaaS storage
 * 3. 计费按字符。调用方必须自己限长（见 MAX_CHARS）。
 */

import { CODES, fail } from '../errors.js';

/** 单次合成的字符上限。火山侧限制 1000，这里留余量。 */
const MAX_CHARS = 1000;

/**
 * @param {object} options
 * @param {() => ({appId?:string, accessToken?:string, resource?:string, speaker?:string})} options.readConfig
 *   - 每次调用时现读，这样改了配置不用重启网关（和 surfcore 里 voice-packs 的教训一致：
 *     配置只在启动时读进内存，改完不重启就"看起来没生效"）
 * @param {typeof fetch} [options.fetchImpl] - 便于测试替换
 */
export function createVolcengineTts(options) {
  const readConfig = options.readConfig;
  const fetchImpl = options.fetchImpl ?? fetch;

  function normalize() {
    const c = readConfig() ?? {};
    return {
      appId: String(c.appId ?? '').trim(),
      accessToken: String(c.accessToken ?? '').trim(),
      resource: String(c.resource ?? 'seed-icl-2.0').trim() || 'seed-icl-2.0',
      speaker: String(c.speaker ?? '').trim(),
    };
  }

  return {
    id: 'volcengine',
    label: '火山引擎（豆包语音 · 复刻音色）',

    /**
     * 只检查配置是否齐全，不发网络请求。
     *
     * 为什么不探活：火山没有轻量的健康检查端点，随便发一次合成就要花钱。
     * 「配置齐全」已经能回答用户真正关心的问题——「我现在能不能用」。
     */
    async probe() {
      const c = normalize();
      const missing = [];
      if (!c.appId) missing.push('AppID');
      if (!c.accessToken) missing.push('Access Token');
      if (!c.speaker) missing.push('音色 ID');
      if (missing.length === 0) return { ok: true };
      return {
        ok: false,
        code: CODES.TTS_PROVIDER_NOT_CONFIGURED,
        error: `火山引擎语音还没配置：缺 ${missing.join(' / ')}`,
        hint:
          '到火山引擎控制台 → 语音技术 → 语音合成大模型 → 声音复刻，开通后拿 AppID 和 Access Token；' +
          '音色 ID 是复刻训练得到的 S_ 开头字符串。填到设置页即可，不用重启。',
      };
    },

    /**
     * 合成。
     *
     * 当前实现：**配置齐全时直接抛「尚未实现」**。这是有意的——
     * 与其返回一段假音频让用户以为通了，不如明确告诉他现在还不能用。
     * 接口形状已经定好，日后只需填 this._call 的实现。
     */
    async synthesize({ text, voice }) {
      const c = normalize();
      const say = String(text ?? '').trim();
      if (!say) throw fail(CODES.BAD_REQUEST, '要合成的内容是空的', {});
      if (say.length > MAX_CHARS) {
        throw fail(CODES.BAD_REQUEST, `文本太长（${say.length} 字），单次最多 ${MAX_CHARS} 字`, {
          hint: '拆成几段分别合成，或者只念前几句。',
        });
      }

      const probe = await this.probe();
      if (!probe.ok) throw fail(probe.code, probe.error, { hint: probe.hint });

      // ── 以下为待实现的真实调用（保留形状，方便日后直接填）──────────────
      // const res = await fetchImpl('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'X-Api-App-Key': c.appId,
      //     'X-Api-Access-Key': c.accessToken,
      //     'X-Api-Resource-Id': c.resource,
      //     'X-Api-Request-Id': `dshm-${Date.now()}`,
      //   },
      //   body: JSON.stringify({
      //     user: { uid: 'dsh-mobile' },
      //     req_params: { text: say, speaker: voice || c.speaker,
      //                   audio_params: { format: 'wav', sample_rate: 24000 } },
      //   }),
      // });
      // const pcm = extractPcm(await res.text());
      // return { audio: wrapWav(pcm, 24000), mime: 'audio/wav' };
      // ────────────────────────────────────────────────────────────────────

      throw fail(
        CODES.TTS_PROVIDER_NOT_CONFIGURED,
        '火山引擎播报后端尚未接入（接口已预留，等密钥到位后补实现）',
        {
          hint:
            '现在可以先用「手机系统语音」播报。等拿到火山引擎的 AppID / Access Token 后，' +
            '后端只需补一段请求代码即可切换，App 端不用改。',
          details: { stage: 'not-implemented', configured: true },
        },
      );
    },
  };
}

/**
 * 从火山的「多行 JSON + base64 分片」响应里抽出纯 PCM。
 *
 * 这段逻辑现在没有被调用（合成还没实现），但它是**最容易写错的一步**，
 * 先写出来并配单测，免得日后接的时候再踩一遍：
 * 首片 WAV 头里的长度字段是 0xFFFFFFFF，直接当 WAV 用会得到噪音或播放失败。
 *
 * @param {string} raw - HTTP 响应体
 * @returns {Buffer} 交错的 16-bit 小端 PCM
 */
export function extractPcm(raw) {
  const chunks = [];
  let lastError = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // 非 JSON 行（可能是心跳/日志）直接跳过
    }
    const code = obj?.code;
    // 0 和 20000000 都是成功；其余视为错误
    if (code !== undefined && code !== null && code !== 0 && code !== 20000000) {
      lastError = { code, message: obj?.message ?? '' };
      continue;
    }
    if (typeof obj?.data === 'string' && obj.data) {
      try {
        chunks.push(Buffer.from(obj.data, 'base64'));
      } catch {
        /* 单片坏掉不影响其他片 */
      }
    }
  }
  const blob = Buffer.concat(chunks);
  if (!blob.length) {
    if (lastError) {
      throw fail(CODES.TTS_FAILED, `火山返回错误 ${lastError.code}：${lastError.message}`, {});
    }
    return Buffer.alloc(0);
  }
  // 跳过流式 WAV 头：找到 'data' 标识，从其后 8 字节开始是 PCM
  const idx = blob.indexOf(Buffer.from('data', 'ascii'));
  const pcm = idx >= 0 ? blob.subarray(idx + 8) : blob.subarray(44);
  // 16-bit 采样，长度必须是偶数
  return pcm.subarray(0, pcm.length - (pcm.length % 2));
}

/** 给裸 PCM 套一个合法的 44 字节 WAV 头（火山的流式头不能用）。 */
export function wrapWav(pcm, sampleRate = 24000, channels = 1) {
  const byteRate = sampleRate * channels * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt 块大小
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
