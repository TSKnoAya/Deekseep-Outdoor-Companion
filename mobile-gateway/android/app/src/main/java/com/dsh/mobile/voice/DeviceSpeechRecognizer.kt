package com.dsh.mobile.voice

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.Locale
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 手机本地转写（ASR 后端之二）。
 *
 * 为什么提供这条：用户要在「本机网关识别」和「手机本地转写」之间切。
 * 本地转写的好处是**音频不出手机**，代价是识别质量取决于手机有没有装离线中文包。
 *
 * HyperOS 上的坑（这类问题必须提前告诉用户，否则只会看到「点了没反应」）：
 * 1. 没装中文离线语音包时，SpeechRecognizer 会直接 onError，
 *    错误码是 ERROR_LANGUAGE_NOT_SUPPORTED 或 ERROR_NETWORK。
 * 2. 小米的「语音助手」可能抢占麦克风；如果连续报 ERROR_AUDIO，
 *    要到「设置 → 应用 → DSH → 权限」确认麦克风已允许。
 * 3. 识别服务是系统组件，停用后本方法完全失效——所以设置了 [isAvailable] 供 UI 判断。
 */
class DeviceSpeechRecognizer(private val context: Context) {

    /** 系统是否提供识别服务。红米 K80 自带，但不能假设。 */
    val isAvailable: Boolean
        get() = SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * 录一次并等结果。
     *
     * 用 suspendCancellableCoroutine 而不是回调：调用点（ViewModel）已经是协程，
     * 再套一层回调会让「录音中 → 转写中 → 出文字」的状态管理散落在各处。
     *
     * 注意：SpeechRecognizer **必须在主线程创建和调用**，否则会抛
     * "SpeechRecognizer should be used only from the main thread"。
     */
    suspend fun listen(
        languageTag: String = "zh-CN",
        silenceMs: Int = 1200,
    ): String = suspendCancellableCoroutine { cont ->
        if (!isAvailable) {
            cont.resumeWithException(
                SpeechException(
                    "asr.not-configured",
                    "这台手机没有可用的语音识别服务",
                    "到「设置 → 应用 → 系统应用」确认「语音服务 / 语音助手」没有被停用；" +
                        "或者改用「本机网关识别」。",
                ),
            )
            return@suspendCancellableCoroutine
        }

        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        var settled = false

        fun finish(block: () -> Unit) {
            if (settled) return
            settled = true
            try {
                recognizer.destroy()
            } catch (_: Exception) {
            }
            block()
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}

            override fun onError(error: Int) {
                finish {
                    val (code, msg, hint) = describeError(error)
                    cont.resumeWithException(SpeechException(code, msg, hint))
                }
            }

            override fun onResults(results: Bundle?) {
                val text = results
                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    ?.firstOrNull()
                    ?.trim()
                    .orEmpty()
                finish {
                    if (text.isEmpty()) {
                        cont.resumeWithException(
                            SpeechException("asr.empty", "没听清", "再录一次，靠近麦克风、减少背景音。"),
                        )
                    } else {
                        cont.resume(text)
                    }
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, languageTag)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
            // 优先走离线：这既省流量也保证音频不出手机
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 800L)
        }

        try {
            recognizer.startListening(intent)
        } catch (e: Exception) {
            finish {
                cont.resumeWithException(
                    SpeechException("asr.failed", "启动录音失败：${e.message}", "确认已授予麦克风权限。"),
                )
            }
        }

        cont.invokeOnCancellation {
            try {
                recognizer.cancel()
            } catch (_: Exception) {
            }
            try {
                recognizer.destroy()
            } catch (_: Exception) {
            }
            settled = true
        }
    }

    /** 把系统错误码翻译成「人话 + 下一步」。 */
    private fun describeError(error: Int): Triple<String, String, String> = when (error) {
        SpeechRecognizer.ERROR_AUDIO ->
            Triple("asr.audio", "麦克风被占用或不可用", "关掉其他用麦克风的应用；确认 DSH 有录音权限。")
        SpeechRecognizer.ERROR_CLIENT ->
            Triple("asr.client", "识别服务被中断", "再试一次；反复失败就改用「本机网关识别」。")
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
            Triple("asr.permission", "没有录音权限", "到「设置 → 应用 → DSH → 权限 → 麦克风」允许。")
        SpeechRecognizer.ERROR_NETWORK ->
            Triple("asr.network", "识别需要联网但网络不通", "连上 Wi-Fi；或到系统设置里下载中文离线语音包。")
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
            Triple("asr.network", "识别超时", "检查网络后重试。")
        SpeechRecognizer.ERROR_NO_MATCH ->
            Triple("asr.empty", "没听清你说什么", "再录一次，说慢一点。")
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY ->
            Triple("asr.busy", "识别服务正忙", "等一秒再按；如果一直忙就重启手机上的语音服务。")
        SpeechRecognizer.ERROR_SERVER ->
            Triple("asr.server", "识别服务返回错误", "再试一次。")
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT ->
            Triple("asr.empty", "没检测到说话", "按下去之后尽快说话。")
        12 /* ERROR_LANGUAGE_NOT_SUPPORTED */ ->
            Triple("asr.language", "系统没有中文识别能力", "到「设置 → 系统 → 语言与输入 → 语音识别」下载中文离线包。")
        13 /* ERROR_LANGUAGE_UNAVAILABLE */ ->
            Triple("asr.language", "中文识别包不可用", "下载中文离线语音包，或改用「本机网关识别」。")
        else ->
            Triple("asr.failed", "识别失败（错误码 $error）", "改用「本机网关识别」，或把错误码发给开发者。")
    }
}

class SpeechException(
    val code: String,
    val error: String,
    val hint: String,
) : Exception(error)

/**
 * 耳机检测：决定 headset-only 档要不要出声。
 *
 * 为什么单独一个类而不是在 ViewModel 里判断：
 * 蓝牙耳机的连接状态会变（开车时连上、下车断开），
 * 而播报决策发生在「收到回答的那一刻」，必须读**当时**的状态而不是启动时的。
 */
class HeadsetDetector(private val context: Context) {
    private val audioManager: AudioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    /**
     * 是否连着有线耳机 / 蓝牙耳机 / 免提。
     *
     * 用 `isWiredHeadsetOn || isBluetoothA2dpOn` 这两条是最稳的：
     * 更细的 AudioDeviceCallback 能区分具体设备类型，但对「要不要出声」这个
     * 决策没有帮助，反而增加生命周期管理成本。
     */
    fun isHeadsetConnected(): Boolean = try {
        val am = audioManager
        @Suppress("DEPRECATION")
        val wired = am.isWiredHeadsetOn
        @Suppress("DEPRECATION")
        val bt = am.isBluetoothA2dpOn
        val speaker = am.isSpeakerphoneOn
        wired || bt || speaker
    } catch (e: Exception) {
        false // 查询失败就当没耳机——宁可少念，不要在地铁里突然外放
    }
}
