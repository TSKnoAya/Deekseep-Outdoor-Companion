/**
 * ASR 后端之一：本机网关跑 sherpa-onnx（SenseVoice）。
 *
 * 为什么是这个方案而不是「调 DSH 的语音服务」：
 * DSH 里确实有 `dsh-experimental-speech-to-text`，但它是 **Typert Remote**，
 * 挂在 `dsh-api-gateway` + `dsh-client-connection`（也就是 Web 那一层）上。
 * 本方案走的是 `--profile acp`，那个 profile 根本不挂 gateway；而且 ACP 自己
 * 明确拒绝音频（`dsh-acp/lib/index.js:114`：`audio prompt content is not supported`）。
 * 要走上它，就得绕过 ACP 直接 import DSH 的插件树，等于自己重建一个宿主——
 * 版本一变就崩，不值得（ROADMAP §0「不补屎山」）。
 *
 * 好消息：DSH 打包了 `sherpa-onnx.node`（已实测可 require），
 * 所以网关**直接调它**就能本地转写，不需要 Python、不需要编译器、
 * 不需要 DSH 的插件体系。
 *
 * ── 依赖与模型 ────────────────────────────────────────────────────────────
 * 原生模块：<DSH>/resources/app.asar.unpacked/dsh/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node
 *          已实测 `require` 成功，导出 createOfflineRecognizer / acceptWaveformOffline /
 *          decodeOfflineStream / createOfflineTts 等。
 * 模型：   SenseVoiceSmall ONNX（INT8 约 239MB）+ tokens.txt + Silero VAD。
 *          首次使用时下载，缓存到 state/mobile-gateway/models/。
 *
 * ── 输入契约（与 DSH 的 speech 服务一致）─────────────────────────────────
 * 16kHz / 单声道 / 16-bit PCM WAV。别的格式一律先拒，不要靠模型容错——
 * 采样率不对时 SenseVoice 不报错，只会转出一段乱码，那种失败最难查。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CODES, fail } from '../errors.js';

const DEFAULT_NATIVE =
  'D:\\deepseek\\resources\\app.asar.unpacked\\dsh\\node_modules\\sherpa-onnx-win-x64\\sherpa-onnx.node';

/** 与 DSH speech 服务一致的上限。 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_DURATION_SECONDS = 300;
export const REQUIRED_SAMPLE_RATE = 16000;
export const REQUIRED_CHANNELS = 1;

/**
 * 解析 WAV 头。只接受 PCM16 单声道 16kHz。
 *
 * 为什么自己解而不是用库：只需要读 44 字节的头部，引一个依赖不值得；
 * 而且**校验失败要给出明确的下一步**（「重新录一次」），通用库只会抛
 * 「invalid audio」。
 *
 * @param {Buffer} buf
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, dataStart:number, dataLength:number, durationSeconds:number}}
 */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) {
    throw fail(CODES.AUDIO_INVALID, '音频太短，不是完整的 WAV', {
      hint: '重新录一次；如果录音按钮刚点就松手，可能没录上。',
    });
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw fail(CODES.AUDIO_INVALID, '不是 WAV 文件（缺少 RIFF/WAVE 标识）', {
      hint: 'App 端要用 16kHz 单声道 PCM16 WAV 上传。',
    });
  }

  // 逐块扫描，不要假设 fmt 一定在 12 偏移、data 一定在 36——真实录音器常带 LIST 块
  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, buf.length - body);
      break;
    }
    // 块长度按偶数字节对齐（RIFF 规范）
    offset = body + size + (size % 2);
  }

  if (!fmt) {
    throw fail(CODES.AUDIO_INVALID, 'WAV 里没有 fmt 块', { hint: '重新录一次。' });
  }
  if (fmt.audioFormat !== 1) {
    throw fail(CODES.AUDIO_INVALID, `只支持未压缩 PCM（当前 audioFormat=${fmt.audioFormat}）`, {
      hint: '录音时不要选压缩格式。',
    });
  }
  if (fmt.bitsPerSample !== 16) {
    throw fail(CODES.AUDIO_INVALID, `只支持 16-bit 采样（当前 ${fmt.bitsPerSample}-bit）`, {
      hint: 'App 端按 PCM16 录音。',
    });
  }
  if (fmt.channels !== REQUIRED_CHANNELS) {
    throw fail(CODES.AUDIO_INVALID, `只支持单声道（当前 ${fmt.channels} 声道）`, {
      hint: 'App 端录音要设成单声道。',
    });
  }
  if (fmt.sampleRate !== REQUIRED_SAMPLE_RATE) {
    throw fail(CODES.AUDIO_INVALID, `只支持 16kHz 采样（当前 ${fmt.sampleRate}Hz）`, {
      hint: 'App 端录音采样率设 16000。采样率不对时模型不报错，只会转出乱码。',
    });
  }
  if (dataStart < 0 || dataLength <= 0) {
    throw fail(CODES.AUDIO_INVALID, 'WAV 里没有音频数据', { hint: '重新录一次。' });
  }

  const durationSeconds = dataLength / 2 / fmt.sampleRate;
  if (durationSeconds > MAX_DURATION_SECONDS) {
    throw fail(CODES.AUDIO_TOO_LARGE, `录音太长（${durationSeconds.toFixed(1)} 秒，上限 ${MAX_DURATION_SECONDS} 秒）`, {
      hint: '说短一点，或者分成几段发。',
    });
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    dataStart,
    dataLength,
    durationSeconds,
  };
}

/** 把 PCM16 字节转成 sherpa 要的 Float32Array（[-1,1]）。 */
export function pcm16ToFloat32(pcm) {
  const usable = pcm.length - (pcm.length % 2);
  const out = new Float32Array(usable / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * 创建 sherpa ASR 后端。
 *
 * 模型加载是**懒**的：第一次转写时才 require 原生模块 + 建 recognizer。
 * 理由：网关启动就要快（手机连不上会一直重试），而语音可能一整天都用不到。
 *
 * @param {object} options
 * @param {string} options.modelDir - 存放 sensevoice.onnx / tokens.txt 的目录
 * @param {string} [options.nativePath] - sherpa-onnx.node 路径
 * @param {(msg:string)=>void} [options.log]
 * @param {() => Promise<{model:string, tokens:string}>} [options.ensureModel]
 *   - 负责「模型不在就下载」；下载是另一个模块的事，这里只等结果
 */
export function createSherpaAsr(options) {
  const modelDir = options.modelDir;
  const nativePath = options.nativePath || DEFAULT_NATIVE;
  const log = options.log || (() => {});
  const ensureModel = options.ensureModel ?? null;

  let recognizer = null;
  let sherpa = null;
  let loadError = null;

  function locateModelFiles() {
    const modelFile = path.join(modelDir, 'model.int8.onnx');
    const tokensFile = path.join(modelDir, 'tokens.txt');
    return { modelFile, tokensFile };
  }

  function loadRecognizer() {
    if (recognizer) return recognizer;
    if (loadError) throw loadError;

    try {
      if (!fs.existsSync(nativePath)) {
        throw fail(
          CODES.ASR_NOT_CONFIGURED,
          `找不到 sherpa-onnx 原生模块：${nativePath}`,
          {
            hint:
              '这是 DSH 自带的组件。如果 DSH 换了安装位置，需要在网关配置里改 nativePath；' +
              '如果 DSH 升级后不再打包它，改用「手机本地转写」。',
          },
        );
      }
      const { modelFile, tokensFile } = locateModelFiles();
      if (!fs.existsSync(modelFile) || !fs.existsSync(tokensFile)) {
        throw fail(CODES.ASR_MODEL_MISSING, '识别模型还没下载', {
          hint: '到 App 设置 → 语音 → 点「下载识别模型」（约 240MB，只需一次）。',
          details: { modelDir, want: ['model.int8.onnx', 'tokens.txt'] },
        });
      }

      // 用 createRequire 是为了在 ESM 里加载 .node；直接 import 不行
      const require = createRequire(import.meta.url);
      sherpa = require(nativePath);

      recognizer = sherpa.createOfflineRecognizer({
        featConfig: { sampleRate: REQUIRED_SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: modelFile, useInverseTextNormalization: 1 },
          tokens: tokensFile,
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      });
      log(`sherpa 识别器已就绪（${path.basename(modelFile)}）`);
      return recognizer;
    } catch (e) {
      // 缓存失败：避免每次请求都重试一遍昂贵的加载
      loadError = e?.userFacing
        ? e
        : fail(CODES.ASR_FAILED, `加载识别模型失败：${e?.message ?? e}`, {
            hint: '先试「手机本地转写」；仍然不行把这条错误发给开发者。',
          });
      throw loadError;
    }
  }

  return {
    id: 'gateway-sherpa',
    label: '本机网关识别（SenseVoice，音频走电脑）',

    async probe() {
      try {
        if (!fs.existsSync(nativePath)) {
          return {
            ok: false,
            code: CODES.ASR_NOT_CONFIGURED,
            error: `找不到 sherpa-onnx 原生模块`,
            hint: '改用「手机本地转写」，或在配置里指定正确的 nativePath。',
          };
        }
        const { modelFile, tokensFile } = locateModelFiles();
        if (!fs.existsSync(modelFile) || !fs.existsSync(tokensFile)) {
          return {
            ok: false,
            code: CODES.ASR_MODEL_MISSING,
            error: '识别模型还没下载（约 240MB）',
            hint: '点「下载识别模型」；只需一次，之后离线也能用。',
          };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, code: CODES.ASR_FAILED, error: e?.message ?? String(e) };
      }
    },

    /**
     * @param {object} params
     * @param {Buffer} params.audio - 完整 WAV
     * @param {string} [params.language] - 'auto' | 'zh' | 'en' | 'yue' | 'ja' | 'ko'
     * @returns {Promise<{text:string, provider:string, durationSeconds:number}>}
     */
    async transcribe({ audio, language = 'auto' }) {
      if (!Buffer.isBuffer(audio)) {
        throw fail(CODES.AUDIO_INVALID, '音频必须是 Buffer', {});
      }
      if (audio.length > MAX_AUDIO_BYTES) {
        throw fail(CODES.AUDIO_TOO_LARGE, `音频太大（${(audio.length / 1024 / 1024).toFixed(1)}MB，上限 20MB）`, {
          hint: '说短一点再发。',
        });
      }

      const wav = parseWav(audio);
      const rec = loadRecognizer();

      let stream;
      try {
        stream = sherpa.createOfflineStream();
        const pcm = audio.subarray(wav.dataStart, wav.dataStart + wav.dataLength);
        sherpa.acceptWaveformOffline(stream, REQUIRED_SAMPLE_RATE, pcm16ToFloat32(pcm));
        sherpa.decodeOfflineStream(rec, stream);
        const result = sherpa.getOfflineStreamResultAsJson(stream);
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        const text = String(parsed?.text ?? '').trim();
        return { text, provider: 'gateway-sherpa', durationSeconds: wav.durationSeconds };
      } catch (e) {
        throw fail(CODES.ASR_FAILED, `转写失败：${e?.message ?? e}`, {
          hint: '再录一次；反复失败就切到「手机本地转写」。',
        });
      } finally {
        // 流对象是原生资源，必须显式释放，否则长时间运行会泄漏
        try {
          sherpa?.freeOfflineStream?.(stream);
        } catch {
          /* 有的版本没有这个导出，忽略 */
        }
      }
    },

    /** 让 ensureModel 在首次启用时被调用（下载模型）。 */
    async prepare() {
      if (typeof ensureModel === 'function') return ensureModel();
      return { skipped: true };
    },
  };
}
