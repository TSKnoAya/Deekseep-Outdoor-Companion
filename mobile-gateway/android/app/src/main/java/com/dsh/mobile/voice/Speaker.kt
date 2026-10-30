package com.dsh.mobile.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 播报：TTS 后端之二 —— 手机系统语音。
 *
 * 为什么必须有这条：网关那边的火山引擎后端现在**只留了接口**，
 * 密钥没到位时它是不可用的（返回 `tts.provider-not-configured`）。
 * 如果 App 只支持火山，那用户现在就把语音播报用不了——
 * 有个降级的系统 TTS，至少「能出声」，而且完全离线、免费。
 *
 * 两个关键设计：
 * 1. **可打断**：新消息来了必须立刻停掉上一句。TextToSpeech 的 stop() 是异步的，
 *    所以这里用一个「代次」计数，让迟到的 onDone 不影响新一轮状态。
 * 2. **代码块/表格不念**：这条规则在网关侧也有（announce.js），这里再做一次
 *    是因为系统 TTS 不经过网关——比如火山没配好时的纯本地播报路径。
 */
class Speaker(private val context: Context) {

    private var tts: TextToSpeech? = null
    private var ready = false
    private var initError: String? = null
    /** 代次：每次 speak/stop 都 +1，旧回调发现代次不符就直接忽略。 */
    @Volatile private var generation = 0

    suspend fun ensureReady() = suspendCancellableCoroutine<Unit> { cont ->
        if (ready) {
            cont.resume(Unit)
            return@suspendCancellableCoroutine
        }
        if (tts != null && initError != null) {
            cont.resumeWithException(SpeechException("tts.failed", initError!!, "检查系统语音服务是否正常。"))
            return@suspendCancellableCoroutine
        }
        val engine = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ready = true
                initError = null
                if (cont.isActive) cont.resume(Unit)
            } else {
                initError = "系统语音初始化失败（状态码 $status）"
                if (cont.isActive) {
                    cont.resumeWithException(
                        SpeechException(
                            "tts.failed",
                            initError!!,
                            "到「设置 → 系统 → 语言与输入 → 文字转语音」确认有可用引擎并下载中文语音包。",
                        ),
                    )
                }
            }
        }
        tts = engine
    }

    /** 念一句。返回时表示**已经念完**（或被新的一句话打断）。 */
    suspend fun speak(text: String, rate: Float = 1.0f, volume: Float = 1.0f) =
        suspendCancellableCoroutine<Unit> { cont ->
            val engine = tts
            if (engine == null || !ready) {
                cont.resumeWithException(
                    SpeechException("tts.failed", "语音引擎还没准备好", "稍等再试，或重启 App。"),
                )
                return@suspendCancellableCoroutine
            }
            val clean = stripForSpeech(text)
            if (clean.isBlank()) {
                cont.resume(Unit) // 没东西可念，算成功（不是错误）
                return@suspendCancellableCoroutine
            }

            val myGen = ++generation
            val utteranceId = "utt-${UUID.randomUUID()}"

            // 中文优先：手机是中文系统，但保险起见显式设置
            val lang = engine.setLanguage(Locale.SIMPLIFIED_CHINESE)
            engine.setSpeechRate(rate)
            engine.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )

            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(id: String?) {}
                override fun onDone(id: String?) {
                    if (myGen == generation && cont.isActive) cont.resume(Unit)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(id: String?) {
                    if (myGen == generation && cont.isActive) {
                        cont.resumeWithException(
                            SpeechException("tts.failed", "系统语音播放出错", "换个系统语音引擎，或改用网关播报。"),
                        )
                    }
                }

                override fun onError(id: String?, errorCode: Int) {
                    if (myGen == generation && cont.isActive) {
                        cont.resumeWithException(
                            SpeechException("tts.failed", "系统语音播放出错（码 $errorCode）", "换个系统语音引擎。"),
                        )
                    }
                }
            })

            val result = engine.speak(clean, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
            if (result != TextToSpeech.SUCCESS) {
                if (cont.isActive) {
                    cont.resumeWithException(
                        SpeechException(
                            if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                                "tts.language"
                            } else "tts.failed",
                            "没法朗读中文（语种状态 $lang）",
                            "到系统设置里下载中文语音包。",
                        ),
                    )
                }
            }

            cont.invokeOnCancellation {
                generation++ // 让这次的回调失效
                try {
                    engine.stop()
                } catch (_: Exception) {
                }
            }
        }

    /** 立刻停止当前播报（新消息来了就调它）。 */
    fun stop() {
        generation++
        try {
            tts?.stop()
        } catch (_: Exception) {
        }
    }

    fun shutdown() {
        generation++
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {
        }
        tts = null
        ready = false
    }

    /** 播放网关合成好的 wav（火山后端可用时走这条）。 */
    suspend fun playFile(file: File) = suspendCancellableCoroutine<Unit> { cont ->
        val player = MediaPlayer()
        try {
            player.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            player.setDataSource(file.absolutePath)
            player.setOnCompletionListener {
                try {
                    player.release()
                } catch (_: Exception) {
                }
                if (cont.isActive) cont.resume(Unit)
            }
            player.setOnErrorListener { _, what, extra ->
                try {
                    player.release()
                } catch (_: Exception) {
                }
                if (cont.isActive) {
                    cont.resumeWithException(
                        SpeechException("tts.failed", "播放合成音频失败（$what/$extra）", "重试一次。"),
                    )
                }
                true
            }
            player.prepare()
            player.start()
        } catch (e: Exception) {
            try {
                player.release()
            } catch (_: Exception) {
            }
            if (cont.isActive) {
                cont.resumeWithException(
                    SpeechException("tts.failed", "播放失败：${e.message}", "重试一次。"),
                )
            }
        }
        cont.invokeOnCancellation {
            try {
                player.stop()
                player.release()
            } catch (_: Exception) {
            }
        }
    }

    companion object {
        /**
         * 系统 TTS 前的最后一道清洗。
         *
         * 为什么网关已经过滤了这里还要再做：火山后端没配时，播报走的是
         * **纯本地路径**（不进网关），所以过滤规则必须也在本地有一份。
         * 两处规则保持一致（见网关 src/voice/announce.js）。
         */
        fun stripForSpeech(text: String): String {
            var s = text
            s = s.replace(Regex("```[\\s\\S]*?```"), " ")
            s = s.replace(Regex("`[^`\\n]+`"), " ")
            s = s.replace(Regex("^\\s*\\|.*\\|\\s*$", RegexOption.MULTILINE), " ")
            s = s.replace(Regex("https?://\\S+"), " ")
            s = s.replace(Regex("(?:[A-Za-z]:\\\\[^\\s，。；]+|/(?:[\\w.-]+/){2,}[\\w.-]+)"), " ")
            s = s.replace(Regex("^\\s*#{1,6}\\s+", RegexOption.MULTILINE), "")
            s = s.replace(Regex("[ \\t]+"), " ")
            s = s.replace(Regex(" *\\n *"), "\n")
            s = s.replace(Regex("\\n{2,}"), "\n")
            return s.trim()
        }

        /** 取首句（与网关 firstSentence 保持同样的语义）。 */
        fun firstSentence(text: String, limit: Int = 80): String {
            val s = text.trim()
            if (s.isEmpty()) return ""
            val m = Regex("^[\\s\\S]*?[。！？!?]").find(s)
            if (m != null) return m.value.trim()
            if (s.length <= limit) return s
            val head = s.take(limit)
            val cut = maxOf(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf(' '))
            return (if (cut > 20) head.take(cut) else head).trim()
        }
    }
}
