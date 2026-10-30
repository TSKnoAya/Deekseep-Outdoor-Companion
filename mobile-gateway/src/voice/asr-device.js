/**
 * ASR 后端之二：手机本地转写（Android `SpeechRecognizer`）。
 *
 * 这一侧网关**什么都不做**——识别在手机里完成，只把文字发上来。
 * 那为什么还要在网关注册一个后端？因为：
 *
 * 1. App 需要知道「现在该用哪条路」。如果网关不表态，App 就得自己判断，
 *    而判断逻辑一旦分散，切换开关和实际行为必然不一致（surfcore 里
 *    voice-packs 的教训：配置在启动时读进内存，改完不重启就"看起来没生效"）。
 * 2. `probe()` 要能回答「这条路现在可用吗」。Android 的离线中文包
 *    没装时 `SpeechRecognizer` 会静默失败，提前告诉用户比失败后猜强。
 * 3. 音频**不需要上传**，这点必须显式建模（`requiresUpload: false`），
 *    否则 App 会白传一遍音频，隐私承诺也就成了空话。
 */

import { CODES, fail } from '../errors.js';

/**
 * 手机本地 ASR 的网关侧代理。
 *
 * 它的 `transcribe()` 不接收音频，只接收**客户端已经识别好的文字**，
 * 所以这里的主要作用是「能力声明 + 校验」。
 */
export function createDeviceAsr() {
  return {
    id: 'device-native',
    label: '手机本地转写（音频不出手机）',
    /** 与 gateway-sherpa 的区别：这条路上传的不是音频，是文字。 */
    requiresUpload: false,
    /** 网关不参与识别，所以不能通过 /v1/asr 调用它。 */
    gatewayTranscribe: false,

    async probe() {
      // 网关无法感知手机端是否装了离线包——如实说明，不要假装知道
      return {
        ok: true,
        note: '识别在手机上完成。如果手机没装中文离线语音包，识别会失败，需要到系统设置里下载。',
      };
    },

    async transcribe() {
      throw fail(
        CODES.ASR_NOT_CONFIGURED,
        '「手机本地转写」不需要调用网关的转写接口',
        {
          hint:
            '这是在手机上完成的识别。App 应该直接调用系统的 SpeechRecognizer，' +
            '把识别出的文字当普通文本消息发上来，不要再走 /v1/asr。',
          details: { requiresUpload: false },
        },
      );
    },
  };
}