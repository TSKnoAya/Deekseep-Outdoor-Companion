package com.dsh.mobile.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.dsh.mobile.data.SettingsStore
import com.dsh.mobile.net.GatewayClient
import com.dsh.mobile.net.GatewayException
import com.dsh.mobile.net.SseSubscription
import com.dsh.mobile.net.StreamEvent
import com.dsh.mobile.voice.DeviceSpeechRecognizer
import com.dsh.mobile.voice.HeadsetDetector
import com.dsh.mobile.voice.SpeechException
import com.dsh.mobile.voice.Speaker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * 唯一的界面状态 holder。
 *
 * 为什么把所有状态塞进一个不可变 data class：Compose 的重组靠状态相等性判断，
 * 分成十几个 MutableStateFlow 会让「正在思考 + 有新消息 + 有审批」这种组合状态
 * 出现中间态（界面上闪一下又没有）。单一快照更好推理，也更好测。
 */
class ChatViewModel(app: Application) : AndroidViewModel(app) {

    private val store = SettingsStore(app)
    private val speaker = Speaker(app)
    private val recognizer = DeviceSpeechRecognizer(app)
    private val headset = HeadsetDetector(app)

    private var client: GatewayClient? = null
    private var sse: SseSubscription? = null

    /** 正在自动重建会话（防重入：SSE 可能连发多个失败事件）。 */
    private var recoveringSession = false
    private var speakJob: Job? = null

    private val _state = MutableStateFlow(AppState(baseUrl = store.baseUrl, asrBackend = store.asrBackend, announceMode = store.announceMode))
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        if (store.isPaired) {
            connectAndLoad()
        }
    }

    // ── 配对 ──────────────────────────────────────────────────────────────

    fun updateBaseUrl(value: String) {
        _state.update { it.copy(baseUrl = value) }
    }

    fun updatePairCode(value: String) {
        _state.update { it.copy(pairCode = value.filter { c -> c.isDigit() }.take(6)) }
    }

    /**
     * 配对。失败时把 hint 放进 state.banner —— **必须**让用户看到下一步，
     * 不能只 Toast 一句「配对失败」（AGENTS.md §1.7）。
     */
    fun pair() {
        val s = _state.value
        if (s.baseUrl.isBlank()) {
            _state.update { it.copy(banner = Banner("先填网关地址", "在电脑上启动网关，它会打印 http://<IP>:8788；把这个地址填进来。", false)) }
            return
        }
        if (s.pairCode.length != 6) {
            _state.update { it.copy(banner = Banner("配对码是 6 位数字", "看电脑上网关窗口打印的那 6 位数。", false)) }
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            _state.update { it.copy(busy = "pairing") }
            try {
                val normalized = normalizeBaseUrl(s.baseUrl)
                store.baseUrl = normalized
                val c = GatewayClient(normalized, null)
                val result = c.pair(s.pairCode, android.os.Build.MODEL ?: "Android")
                store.token = result.token
                store.deviceId = result.deviceId
                client = c
                _state.update { it.copy(banner = null, busy = null, paired = true, baseUrl = normalized) }
                loadSessionsAndConnect()
            } catch (e: GatewayException) {
                _state.update { it.copy(busy = null, banner = Banner(e.error, e.hint, e.retryable)) }
            } catch (e: Exception) {
                // 之前这里只打 e.message，遇到 message 为 null 的异常就显示「配对失败：null」，
                // 用户完全不知道下一步做什么（实测就被这个问题卡住过一次）。
                _state.update {
                    it.copy(
                        busy = null,
                        banner = Banner(
                            "配对失败：${describeException(e)}",
                            "先点下面的「测试连接」：能连上说明是配对码问题，连不上就是地址/防火墙问题。",
                            true,
                        ),
                    )
                }
            }
        }
    }

    /**
     * 测试连接：打 `/v1/health`（免鉴权），**不需要配对码**。
     *
     * 为什么要有它：用户分不清「连不上网关」和「配对码错了」——两者的补救办法完全不同。
     * 这个按钮把两种情况当场分开。
     */
    fun testConnection() {
        val s = _state.value
        if (s.baseUrl.isBlank()) {
            _state.update {
                it.copy(banner = Banner("先填网关地址", "在电脑上双击 start-gateway.bat，窗口里会打印 http://<IP>:8788。", false))
            }
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            _state.update { it.copy(busy = "testing") }
            val normalized = normalizeBaseUrl(s.baseUrl)
            try {
                val h = GatewayClient(normalized, null).health()
                store.baseUrl = normalized
                _state.update {
                    it.copy(
                        busy = null,
                        baseUrl = normalized,
                        banner = if (h.dshConnected) {
                            Banner(
                                "连上了：网关 v${h.version}",
                                "DSH 已连接（${h.dshName ?: "?"}）。现在把电脑窗口里的 6 位配对码填进上面，点「配对」。",
                                false,
                                ok = true,
                            )
                        } else {
                            Banner(
                                "网关在跑，但 DSH 还没连上",
                                "电脑上那个窗口里应该有「启动 DSH（ACP profile）…」，等几秒会变成「DSH 已连接」。没变就看窗口里的报错。",
                                true,
                            )
                        },
                    )
                }
            } catch (e: GatewayException) {
                _state.update { it.copy(busy = null, banner = Banner(e.error, e.hint, e.retryable)) }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        busy = null,
                        banner = Banner(
                            "测试失败：${describeException(e)}",
                            "在手机浏览器打开 ${normalized}/v1/health —— 出 JSON 说明网络没问题（那就是 App 的问题）；打不开说明网络/防火墙没放行。",
                            true,
                        ),
                    )
                }
            }
        }
    }

    /** 把异常翻成人话：message 可能是 null，那就至少给个类名。 */
    private fun describeException(e: Exception): String {
        val msg = e.message?.takeIf { it.isNotBlank() }
        return msg ?: "${e.javaClass.simpleName}（无错误信息）"
    }

    /** DSH 说「不认识这个会话」——通常是网关重启后会话 id 过期。 */
    private fun isUnknownSession(e: GatewayException): Boolean = isUnknownSessionText("${e.error} ${e.hint}")

    private fun isUnknownSessionText(text: String): Boolean {
        val blob = text.lowercase()
        return blob.contains("unknown session") || blob.contains("会话不存在") || blob.contains("unknown_session")
    }

    /**
     * 会话失效后的自愈：新建一个会话，把刚才那条用户消息重发过去。
     *
     * 为什么不清空 messages：用户刚打的字还在对话流里，清掉等于「我发的消息被吞了」。
     * 返回 true 表示已接管（调用方不要再写错误卡）。
     */
    private fun recoverSession(resend: String?): Boolean {
        if (recoveringSession) return false
        val c = client ?: return false
        recoveringSession = true
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val created = c.createSession(null)
                store.lastSessionId = created.sessionId
                _state.update {
                    it.copy(
                        currentSessionId = created.sessionId,
                        sessions = runCatching { c.listSessions() }.getOrDefault(it.sessions),
                        streamingText = "",
                        approvals = emptyList(),
                        thinking = !resend.isNullOrBlank(),
                        lastTurnFailed = null,
                    )
                }
                reconnectStream(created.sessionId)
                if (!resend.isNullOrBlank()) {
                    runCatching { c.sendMessage(created.sessionId, resend) }
                        .onFailure { err ->
                            _state.update {
                                it.copy(
                                    thinking = false,
                                    messages = it.messages + ChatMessage(
                                        role = Role.Error,
                                        text = "重发失败：${describeException(err as? Exception ?: Exception(err))}",
                                        hint = "看电脑上网关窗口的报错。",
                                    ),
                                )
                            }
                        }
                }
            } catch (e: Exception) {
                _state.update {
                    it.copy(
                        thinking = false,
                        messages = it.messages + ChatMessage(
                            role = Role.Error,
                            text = "会话已失效，自动新建也失败了：${describeException(e)}",
                            hint = "看电脑上网关窗口的报错；也可以点右上角 + 手动新建一个会话。",
                        ),
                    )
                }
            } finally {
                recoveringSession = false
            }
        }
        return true
    }

    fun unpair() {
        sse?.cancel()
        sse = null
        client = null
        store.clearAuth()
        _state.update { it.copy(paired = false, sessions = emptyList(), messages = emptyList(), currentSessionId = null) }
    }

    private fun normalizeBaseUrl(raw: String): String {
        var s = raw.trim()
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s.trimEnd('/')
    }

    private fun connectAndLoad() {
        client = GatewayClient(store.baseUrl, store.token)
        _state.update { it.copy(paired = true) }
        loadSessionsAndConnect()
    }

    private fun loadSessionsAndConnect() {
        val c = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val health = c.health()
                _state.update { it.copy(dshConnected = health.dshConnected, gatewayVersion = health.version, banner = null) }
                if (!health.dshConnected) {
                    _state.update {
                        it.copy(banner = Banner("网关在，但 DSH 没连上", "电脑上确认 DSH 已启动并登录。网关会自动重连，不用管它。", true))
                    }
                }
                val sessions = c.listSessions()
                _state.update { it.copy(sessions = sessions) }
                // 只认「自己上次用过的那个」会话；没有就新建。
                // 不能拿 sessions.first() —— 列表里可能有别的 DSH 进程留下的会话，
                // 当前进程不认识它，一发消息就 "unknown session: ..."（真机踩过）。
                val target = store.lastSessionId?.takeIf { id -> sessions.any { it.sessionId == id } }
                if (target == null) {
                    createSession()
                } else {
                    openSession(target)
                }
            } catch (e: GatewayException) {
                _state.update { it.copy(banner = Banner(e.error, e.hint, e.retryable)) }
            }
        }
    }

    // ── 会话 ──────────────────────────────────────────────────────────────

    fun createSession(cwd: String? = null) {
        val c = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val created = c.createSession(cwd)
                store.lastSessionId = created.sessionId
                _state.update { it.copy(sessions = c.listSessions()) }
                openSession(created.sessionId)
            } catch (e: GatewayException) {
                _state.update { it.copy(banner = Banner(e.error, e.hint, e.retryable)) }
            }
        }
    }

    fun openSession(sessionId: String) {
        sse?.cancel()
        store.lastSessionId = sessionId
        _state.update {
            it.copy(
                currentSessionId = sessionId,
                messages = emptyList(),
                streamingText = "",
                thinking = false,
                approvals = emptyList(),
                banner = null,
            )
        }
        val c = client ?: return
        sse = SseSubscription(
            c,
            sessionId,
            object : SseSubscription.Listener {
                override fun onEvent(event: StreamEvent) = handleEvent(event)
                override fun onClosed(reason: String) {
                    _state.update { st ->
                        if (st.streamLostReason == reason) st
                        else st.copy(streamLostReason = reason)
                    }
                    // 自动重连：网关在 hello 里补发状态，所以重连不会丢「正在思考」
                    viewModelScope.launch {
                        delay(2000)
                        if (store.lastSessionId == sessionId) {
                            _state.update { it.copy(streamLostReason = null) }
                            reconnectStream(sessionId)
                        }
                    }
                }
            },
        ).also { it.start() }
    }

    private fun reconnectStream(sessionId: String) {
        sse?.cancel()
        val c = client ?: return
        sse = SseSubscription(
            c,
            sessionId,
            object : SseSubscription.Listener {
                override fun onEvent(event: StreamEvent) = handleEvent(event)
                override fun onClosed(reason: String) {
                    _state.update { it.copy(streamLostReason = reason) }
                    viewModelScope.launch {
                        delay(4000)
                        if (store.lastSessionId == sessionId) {
                            _state.update { it.copy(streamLostReason = null) }
                            reconnectStream(sessionId)
                        }
                    }
                }
            },
        ).also { it.start() }
    }

    private fun handleEvent(event: StreamEvent) {
        when (event) {
            is StreamEvent.Hello -> _state.update { it.copy(thinking = event.running) }

            is StreamEvent.TurnStart -> _state.update {
                it.copy(thinking = true, streamingText = "", lastTurnFailed = null)
            }

            is StreamEvent.Text -> _state.update { it.copy(streamingText = it.streamingText + event.text) }

            is StreamEvent.ApprovalRequest -> _state.update {
                it.copy(approvals = it.approvals + ApprovalUi(
                    id = event.approvalId,
                    toolCallId = event.toolCallId,
                    options = event.options,
                ))
            }

            is StreamEvent.TurnEnd -> {
                val s = _state.value
                if (event.ok) {
                    val full = event.text?.takeIf { it.isNotBlank() } ?: s.streamingText
                    val message = ChatMessage(role = Role.Assistant, text = full.trim())
                    _state.update {
                        it.copy(
                            messages = if (message.text.isBlank()) it.messages else it.messages + message,
                            streamingText = "",
                            thinking = false,
                            approvals = emptyList(),
                            lastTurnFailed = null,
                        )
                    }
                    if (message.text.isNotBlank()) maybeAnnounce(message.text)
                } else {
                    val errText = event.error ?: "本轮失败"
                    // 关键：这个错误是 SSE 的 turn_end 事件带回来的，**不是** HTTP 异常，
                    // 所以 send() 里的 catch 永远看不到它（第一版就栽在这）。
                    // 会话失效属于「网关重启后的正常现象」，不该甩给用户——自动重建再发一次。
                    if (isUnknownSessionText(errText) && recoverSession(_state.value.messages.lastOrNull { it.role == Role.User }?.text)) {
                        // 已交给 recoverSession 处理，这里不写错误卡
                    } else {
                        _state.update {
                            it.copy(
                                thinking = false,
                                streamingText = "",
                                approvals = emptyList(),
                                // 失败必须留痕在对话流里，不能只闪一下 banner
                                messages = it.messages + ChatMessage(
                                    role = Role.Error,
                                    text = errText,
                                    hint = event.hint,
                                ),
                                lastTurnFailed = event.code,
                            )
                        }
                    }
                }
            }

            StreamEvent.QueueCleared -> _state.update { it.copy(queuedNotice = null) }

            is StreamEvent.Unknown -> Unit
        }
    }

    // ── 发消息 ────────────────────────────────────────────────────────────

    fun send(text: String) {
        val c = client ?: return
        val s = _state.value
        val sessionId = s.currentSessionId ?: run {
            createSession()
            return
        }
        val body = text.trim()
        if (body.isEmpty()) return

        _state.update {
            it.copy(
                messages = it.messages + ChatMessage(role = Role.User, text = body),
                input = "",
                thinking = true,
            )
        }

        viewModelScope.launch(Dispatchers.IO) {
            try {
                val r = c.sendMessage(sessionId, body)
                if (r.queued > 0) {
                    _state.update { it.copy(queuedNotice = "前面还有 ${r.queued} 条在跑，已排队") }
                }
            } catch (e: GatewayException) {
                // 「unknown session」= 这个会话不存在于**当前** DSH 进程里。
                // 典型场景：网关重启过（DSH 是新进程），而 App 还记着旧会话 id，
                // 或者会话列表里混进了别的进程留下的会话。
                // 这种错不该甩给用户，自动新建一个会话再发一次即可。
                if (isUnknownSession(e)) {
                    try {
                        val created = c.createSession(null)
                        store.lastSessionId = created.sessionId
                        _state.update { it.copy(sessions = runCatching { c.listSessions() }.getOrDefault(it.sessions), currentSessionId = created.sessionId, messages = emptyList()) }
                        val r = c.sendMessage(created.sessionId, body)
                        if (r.queued > 0) {
                            _state.update { it.copy(queuedNotice = "前面还有 ${r.queued} 条在跑，已排队") }
                        }
                        openSession(created.sessionId)
                        return@launch
                    } catch (e2: Exception) {
                        _state.update {
                            it.copy(
                                thinking = false,
                                messages = it.messages + ChatMessage(role = Role.Error, text = e2.message ?: "自动新建会话失败", hint = e2.let { err -> if (err is GatewayException) err.hint else "重试一次；仍然失败看电脑上网关窗口的报错。" }),
                            )
                        }
                        return@launch
                    }
                }
                _state.update {
                    it.copy(
                        thinking = false,
                        messages = it.messages + ChatMessage(role = Role.Error, text = e.error, hint = e.hint),
                    )
                }
            }
        }
    }

    fun updateInput(value: String) = _state.update { it.copy(input = value) }

    fun cancelTurn() {
        val c = client ?: return
        val sid = _state.value.currentSessionId ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                c.cancel(sid)
                _state.update { it.copy(thinking = false, queuedNotice = null) }
            } catch (e: GatewayException) {
                _state.update { it.copy(banner = Banner(e.error, e.hint, e.retryable)) }
            }
        }
    }

    // ── 审批 ──────────────────────────────────────────────────────────────

    fun answerApproval(approvalId: String, optionId: String) {
        val c = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                c.answerApproval(approvalId, optionId)
                _state.update { st -> st.copy(approvals = st.approvals.filterNot { it.id == approvalId }) }
            } catch (e: GatewayException) {
                _state.update { st ->
                    st.copy(
                        approvals = st.approvals.filterNot { it.id == approvalId },
                        banner = Banner(e.error, e.hint, e.retryable),
                    )
                }
            }
        }
    }

    // ── 语音输入 ──────────────────────────────────────────────────────────

    fun startVoiceInput() {
        val s = _state.value
        if (s.recording) return

        if (s.asrBackend == "device-native") {
            _state.update { it.copy(recording = true, banner = null) }
            viewModelScope.launch {
                try {
                    val text = recognizer.listen()
                    _state.update { it.copy(recording = false) }
                    send(text)
                } catch (e: SpeechException) {
                    _state.update { it.copy(recording = false, banner = Banner(e.error, e.hint, false)) }
                } catch (e: Exception) {
                    _state.update {
                        it.copy(recording = false, banner = Banner("语音识别失败：${e.message}", "再试一次，或切到「本机网关识别」。", true))
                    }
                }
            }
        } else {
            // 网关识别：需要先录一段 16k 单声道 PCM16 WAV 再上传
            _state.update {
                it.copy(
                    banner = Banner(
                        "本机网关识别还没接录音",
                        "这条路径需要先录 16kHz 单声道 WAV。当前版本请先切到「手机本地转写」，或在电脑上直接发。",
                        false,
                    ),
                )
            }
        }
    }

    // ── 播报 ──────────────────────────────────────────────────────────────

    private fun maybeAnnounce(text: String) {
        val s = _state.value
        if (s.announceMode == "off") return
        if (!s.announceEnabled) return

        val headsetOn = headset.isHeadsetConnected()
        val decision = decideLocally(text, s.announceMode, headsetOn)
        if (!decision.first) return

        speakJob?.cancel()
        speakJob = viewModelScope.launch {
            try {
                speaker.ensureReady()
                speaker.speak(decision.second)
            } catch (e: SpeechException) {
                // 播报失败不能打断对话流——只给一个可关闭的提示
                _state.update { it.copy(banner = Banner("播报失败", e.hint, false)) }
            } catch (e: Exception) {
                _state.update { it.copy(banner = Banner("播报失败", "可以先用文字；反复失败就在设置里关掉播报。", false)) }
            }
        }
    }

    /** 本地版的播报决策（和网关 announce.js 保持同步）。 */
    private fun decideLocally(text: String, mode: String, headsetOn: Boolean): Pair<Boolean, String> {
        val readable = Speaker.stripForSpeech(text)
        if (readable.isBlank()) return false to ""
        if (!readable.any { it.isLetterOrDigit() }) return false to ""
        if (mode == "headset-only" && !headsetOn) return false to ""
        val limit = 80
        return if (mode == "all") {
            true to if (readable.length <= limit) readable else Speaker.firstSentence(readable, limit)
        } else {
            true to if (readable.length <= limit) readable else Speaker.firstSentence(readable, limit)
        }
    }

    fun stopSpeaking() {
        speakJob?.cancel()
        speaker.stop()
    }

    fun toggleAnnounceEnabled() = _state.update { it.copy(announceEnabled = !it.announceEnabled) }

    /**
     * 切换播报档位。**立刻生效**（写本地 + 尝试同步网关）。
     * 网关同步失败不阻塞本地——离线也要能改设置。
     */
    fun setAnnounceMode(mode: String) {
        store.announceMode = mode
        _state.update { it.copy(announceMode = mode) }
        val c = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                c.putSettings(buildJsonObject {
                    put("announceMode", JsonPrimitive(mode))
                })
            } catch (_: Exception) {
                // 本地已生效；网关侧下次连接会以本地为准
            }
        }
    }

    fun setAsrBackend(backend: String) {
        store.asrBackend = backend
        _state.update { it.copy(asrBackend = backend) }
        val c = client ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                c.putSettings(buildJsonObject {
                    put("asrBackend", JsonPrimitive(backend))
                })
            } catch (_: Exception) {
            }
        }
    }

    fun dismissBanner() = _state.update { it.copy(banner = null) }

    fun retryLastThing() {
        val s = _state.value
        _state.update { it.copy(banner = null) }
        if (!s.paired) return
        if (s.currentSessionId == null) loadSessionsAndConnect()
        else reconnectStream(s.currentSessionId!!)
    }

    override fun onCleared() {
        super.onCleared()
        sse?.cancel()
        speakJob?.cancel()
        speaker.shutdown()
    }
}

// ── 状态模型 ──────────────────────────────────────────────────────────────

data class AppState(
    val baseUrl: String = "",
    val pairCode: String = "",
    val paired: Boolean = false,
    val busy: String? = null,
    val gatewayVersion: String? = null,
    val dshConnected: Boolean = false,
    val sessions: List<com.dsh.mobile.net.SessionInfo> = emptyList(),
    val currentSessionId: String? = null,
    val messages: List<ChatMessage> = emptyList(),
    val streamingText: String = "",
    val thinking: Boolean = false,
    val approvals: List<ApprovalUi> = emptyList(),
    val input: String = "",
    val recording: Boolean = false,
    val banner: Banner? = null,
    val streamLostReason: String? = null,
    val queuedNotice: String? = null,
    val lastTurnFailed: String? = null,
    val asrBackend: String = "gateway-sherpa",
    val announceMode: String = "short",
    val announceEnabled: Boolean = true,
)

data class ChatMessage(
    val role: Role,
    val text: String,
    val hint: String? = null,
)

enum class Role { User, Assistant, Error }

data class ApprovalUi(
    val id: String,
    val toolCallId: String?,
    val options: List<com.dsh.mobile.net.ApprovalOption>,
)

/**
 * 顶部提示条。`retryable` 决定要不要显示「重试」按钮——
 * 配置类错误重试没用，应该引导用户去改设置。
 */
data class Banner(
    val title: String,
    val hint: String,
    val retryable: Boolean,
    /** true 表示「这是一条好消息」（连接测试通过）。用来换配色，不然绿事也标红。 */
    val ok: Boolean = false,
)
