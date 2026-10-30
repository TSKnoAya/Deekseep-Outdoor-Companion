package com.dsh.mobile.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonArray
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources

/**
 * SSE 订阅：把网关推来的事件流变成回调。
 *
 * 为什么不用 WebSocket：单向推送（服务端→手机）用 SSE 就够，
 * OkHttp 有一等支持，断线重连的语义也简单。手机只在「发消息/答审批」时上行。
 *
 * 三个必须处理好的点：
 * 1. **重连**：手机切后台、锁屏、地铁过隧道都会断。断了要自动重连，
 *    而且网关在 `hello` 里补发当前状态，所以重连不会丢「正在思考」的指示。
 * 2. **心跳**：网关每 15 秒发一行 `: ping`。SSE 的注释行不会进 onEvent，
 *    但能让 TCP 保活，避免运营商 NAT 掐连接。
 * 3. **关闭**：Activity 销毁时必须 cancel，否则 OkHttp 的线程会一直挂着。
 */
class SseSubscription(
    private val client: GatewayClient,
    private val sessionId: String,
    private val listener: Listener,
) {
    interface Listener {
        fun onEvent(event: StreamEvent)
        /** 流断了。带原因，便于 UI 显示「连接中断，正在重连」而不是静默。 */
        fun onClosed(reason: String)
    }

    private var source: EventSource? = null
    @Volatile private var cancelled = false

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    fun start() {
        cancelled = false
        val request = Request.Builder()
            .url("${client.baseUrl.trimEnd('/')}/v1/sessions/$sessionId/stream")
            .apply {
                client.token?.takeIf { it.isNotBlank() }?.let { header("Authorization", "Bearer $it") }
                header("Accept", "text/event-stream")
            }
            .build()

        val factory = EventSources.createFactory(client.sseHttp)
        source = factory.newEventSource(
            request,
            object : EventSourceListener() {
                override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                    if (cancelled) return
                    val obj: JsonObject = try {
                        json.parseToJsonElement(data).jsonObject
                    } catch (e: Exception) {
                        return // 心跳/坏帧，忽略
                    }
                    listener.onEvent(parseEvent(obj))
                }

                override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                    if (cancelled) return
                    val why = when {
                        response?.code == 401 -> "配对已失效（401）"
                        t != null -> "网络中断：${t.message ?: t.javaClass.simpleName}"
                        else -> "连接被关闭"
                    }
                    listener.onClosed(why)
                }

                override fun onClosed(eventSource: EventSource) {
                    if (cancelled) return
                    listener.onClosed("服务端关闭了连接")
                }
            },
        )
    }

    fun cancel() {
        cancelled = true
        source?.cancel()
        source = null
    }

    // ── 事件解析 ──────────────────────────────────────────────────────────

    private fun parseEvent(obj: JsonObject): StreamEvent {
        val type = obj["type"]?.jsonPrimitive?.content ?: "unknown"
        return when (type) {
            "hello" -> StreamEvent.Hello(
                running = obj["status"]?.jsonObject?.get("running")?.jsonPrimitive?.content?.toBoolean() ?: false,
            )

            "turn_start" -> StreamEvent.TurnStart(
                turnId = obj["turnId"]?.jsonPrimitive?.content ?: "",
            )

            "text" -> StreamEvent.Text(obj["text"]?.jsonPrimitive?.content ?: "")

            "approval_request" -> {
                val a = obj["approval"]?.jsonObject
                val options = a?.get("options")?.jsonArray?.mapNotNull { el ->
                    val o = el as? JsonObject ?: return@mapNotNull null
                    ApprovalOption(
                        optionId = o["optionId"]?.jsonPrimitive?.content ?: "",
                        kind = o["kind"]?.jsonPrimitive?.content ?: "",
                    )
                } ?: emptyList()
                StreamEvent.ApprovalRequest(
                    approvalId = a?.get("id")?.jsonPrimitive?.content ?: "",
                    toolCallId = a?.get("toolCallId")?.jsonPrimitive?.content,
                    options = options,
                )
            }

            "turn_end" -> {
                val ok = obj["ok"]?.jsonPrimitive?.content?.toBoolean() ?: false
                val failure = obj["failure"]?.jsonObject
                StreamEvent.TurnEnd(
                    ok = ok,
                    text = obj["result"]?.jsonObject?.get("text")?.jsonPrimitive?.content,
                    code = failure?.get("code")?.jsonPrimitive?.content,
                    error = failure?.get("error")?.jsonPrimitive?.content,
                    hint = failure?.get("hint")?.jsonPrimitive?.content,
                )
            }

            "queue_cleared" -> StreamEvent.QueueCleared

            else -> StreamEvent.Unknown(type)
        }
    }
}

// ── 事件模型 ──────────────────────────────────────────────────────────────

sealed interface StreamEvent {
    data class Hello(val running: Boolean) : StreamEvent
    data class TurnStart(val turnId: String) : StreamEvent
    data class Text(val text: String) : StreamEvent
    data class ApprovalRequest(
        val approvalId: String,
        val toolCallId: String?,
        val options: List<ApprovalOption>,
    ) : StreamEvent

    data class TurnEnd(
        val ok: Boolean,
        val text: String?,
        val code: String?,
        val error: String?,
        val hint: String?,
    ) : StreamEvent

    data object QueueCleared : StreamEvent
    data class Unknown(val type: String) : StreamEvent
}

data class ApprovalOption(val optionId: String, val kind: String) {
    /** 是否「允许」类选项。UI 用它决定按钮颜色。 */
    val isAllow: Boolean get() = kind.startsWith("allow")
}
