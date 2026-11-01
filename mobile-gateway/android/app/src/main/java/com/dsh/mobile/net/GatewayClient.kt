package com.dsh.mobile.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 网关 API 客户端。
 *
 * 设计原则（和网关侧的错误契约对齐）：
 * 1. **失败一律抛 [GatewayException]**，带上 code / error / hint 三件套。
 *    UI 直接拿 hint 显示「下一步点哪」，不要自己编文案。
 * 2. 网络错误也转换成同一类型（code = "network.xxx"），这样 UI 只有一条错误路径。
 * 3. 长回合**不用长连接等**：发消息立刻返回 turnId，结果走 SSE。
 *
 * 超时策略是有讲究的：
 * - 普通 REST：30 秒（新建会话要先冷启动 DSH，实测 2.8 秒，留足余量）
 * - SSE：不设读超时（一轮可能十几分钟），只设 ping 间隔
 */
class GatewayClient(
    @Volatile var baseUrl: String,
    @Volatile var token: String?,
) {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** SSE 用的客户端：读超时要长，否则一轮跑一半就断。 */
    val sseHttp: OkHttpClient = http.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // 永不超时，靠心跳与主动断开来判断
        .build()

    private fun url(path: String): String = baseUrl.trimEnd('/') + path

    private fun authed(path: String): Request.Builder {
        val builder = Request.Builder().url(url(path))
        token?.takeIf { it.isNotBlank() }?.let { builder.header("Authorization", "Bearer $it") }
        return builder
    }

    // ── 底层 ──────────────────────────────────────────────────────────────

    /**
     * 发一个 JSON 请求，返回解析后的 JSON 对象。
     *
     * 注意：网关的失败响应也是 JSON（`{ok:false, code, error, hint}`），
     * 所以**先解析 body 再看状态码**——否则 400 时我们只能拿到一句 "Bad Request"，
     * 用户看不到真正的原因。
     */
    private fun callJson(request: Request): JsonObject {
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw GatewayException(
                code = "network.unreachable",
                error = "连不上网关（${e.message ?: "未知网络错误"}）",
                hint = "确认手机和电脑在同一个 Wi-Fi；电脑上网关是否在跑（地址：$baseUrl）。",
            )
        }
        response.use { res ->
            val text = res.body?.string().orEmpty()
            val obj = try {
                if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text).jsonObject
            } catch (e: Exception) {
                throw GatewayException(
                    code = "network.bad-response",
                    error = "网关返回了看不懂的内容（HTTP ${res.code}）",
                    hint = "确认地址指向的是 DSH 手机网关，不是别的服务。",
                )
            }
            val ok = obj["ok"]?.jsonPrimitive?.content?.toBoolean() ?: (res.isSuccessful)
            if (!ok) {
                throw GatewayException(
                    code = obj["code"]?.jsonPrimitive?.content ?: "http.${res.code}",
                    error = obj["error"]?.jsonPrimitive?.content ?: "请求失败（HTTP ${res.code}）",
                    hint = obj["hint"]?.jsonPrimitive?.content ?: "重试一次；仍然失败就看电脑上的网关日志。",
                )
            }
            return obj
        }
    }

    private fun getJson(path: String): JsonObject =
        callJson(authed(path).get().build())

    private fun postJson(path: String, body: JsonObject): JsonObject =
        callJson(
            authed(path)
                .post(body.toString().toRequestBody(JSON_MEDIA))
                .build(),
        )

    private fun putJson(path: String, body: JsonObject): JsonObject =
        callJson(
            authed(path)
                .put(body.toString().toRequestBody(JSON_MEDIA))
                .build(),
        )

    // ── 业务接口 ──────────────────────────────────────────────────────────

    /**
     * 配对。成功后要把 token 存下来——这里只返回，存储由调用方负责
     * （方便换存储实现，也方便测试）。
     */
    fun pair(code: String, deviceName: String): PairResult {
        val res = postJson(
            "/v1/pair",
            buildJsonObject {
                put("code", code.trim())
                put("deviceName", deviceName)
            },
        )
        val id = res["deviceId"]?.jsonPrimitive?.content
            ?: throw GatewayException("network.bad-response", "配对成功但没拿到设备 id", "重试一次。")
        val t = res["token"]?.jsonPrimitive?.content
            ?: throw GatewayException("network.bad-response", "配对成功但没拿到令牌", "重试一次。")
        token = t
        return PairResult(deviceId = id, token = t)
    }

    fun health(): HealthInfo {
        val res = getJson("/v1/health")
        val dsh = res["dsh"]?.jsonObject
        return HealthInfo(
            version = res["version"]?.jsonPrimitive?.content ?: "?",
            dshConnected = dsh?.get("connected")?.jsonPrimitive?.content?.toBoolean() ?: false,
            dshName = dsh?.get("server")?.jsonObject?.get("name")?.jsonPrimitive?.content,
        )
    }

    fun listSessions(): List<SessionInfo> {
        val res = getJson("/v1/sessions")
        val arr = res["sessions"] as? kotlinx.serialization.json.JsonArray ?: return emptyList()
        return arr.mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            val sid = o["sessionId"]?.jsonPrimitive?.content ?: return@mapNotNull null
            SessionInfo(
                sessionId = sid,
                cwd = o["cwd"]?.jsonPrimitive?.content ?: "",
                title = o["title"]?.jsonPrimitive?.contentOrNull,
                updatedAt = o["updatedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull(),
            )
        }
    }

    fun createSession(cwd: String?): SessionInfo {
        val body = buildJsonObject { if (!cwd.isNullOrBlank()) put("cwd", cwd) }
        val res = postJson("/v1/sessions", body)
        val sid = res["sessionId"]?.jsonPrimitive?.content
            ?: throw GatewayException("network.bad-response", "新建会话没有返回 id", "重试一次。")
        return SessionInfo(sessionId = sid, cwd = cwd ?: "")
    }

    /** 发消息。**立刻返回**，不等回合结束。 */
    fun sendMessage(sessionId: String, text: String): SendResult {
        val res = postJson(
            "/v1/sessions/$sessionId/messages",
            buildJsonObject { put("text", text) },
        )
        return SendResult(
            turnId = res["turnId"]?.jsonPrimitive?.content ?: "",
            queued = res["queued"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
        )
    }

    fun cancel(sessionId: String) {
        postJson("/v1/sessions/$sessionId/cancel", buildJsonObject { })
    }

    fun closeSession(sessionId: String) {
        postJson("/v1/sessions/$sessionId/close", buildJsonObject { })
    }

    fun answerApproval(approvalId: String, optionId: String) {
        postJson("/v1/approvals/$approvalId", buildJsonObject { put("optionId", optionId) })
    }

    fun getSettings(): SettingsSnapshot {
        val res = getJson("/v1/settings")
        return parseSettings(res["settings"]?.jsonObject)
    }

    fun putSettings(patch: JsonObject): SettingsSnapshot {
        val res = putJson("/v1/settings", patch)
        return parseSettings(res["settings"]?.jsonObject)
    }

    fun voiceBackends(): JsonElement {
        return getJson("/v1/voice/backends")
    }

    /** 让网关判断这条该不该念、念哪一段。 */
    fun announce(text: String, mode: String, headsetConnected: Boolean): AnnounceDecision {
        val res = postJson(
            "/v1/announce",
            buildJsonObject {
                put("text", text)
                put("mode", mode)
                put("headsetConnected", headsetConnected)
            },
        )
        return AnnounceDecision(
            speak = res["speak"]?.jsonPrimitive?.content?.toBoolean() ?: false,
            reason = res["reason"]?.jsonPrimitive?.content ?: "",
            text = res["text"]?.jsonPrimitive?.content ?: "",
        )
    }

    /** 上传 WAV 给网关转写。 */
    fun transcribe(wav: ByteArray, providerId: String = "gateway-sherpa"): String {
        val req = authed("/v1/asr?backend=$providerId")
            .post(wav.toRequestBody("audio/wav".toMediaType()))
            .build()
        val res = callJson(req)
        return res["text"]?.jsonPrimitive?.content ?: ""
    }

    private fun parseSettings(o: JsonObject?): SettingsSnapshot = SettingsSnapshot(
        asrBackend = o?.get("asrBackend")?.jsonPrimitive?.content ?: "gateway-sherpa",
        ttsBackend = o?.get("ttsBackend")?.jsonPrimitive?.content ?: "volcengine",
        announceMode = o?.get("announceMode")?.jsonPrimitive?.content ?: "short",
        shortLimit = o?.get("shortLimit")?.jsonPrimitive?.content?.toIntOrNull() ?: 80,
    )

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}

// ── 数据类 ────────────────────────────────────────────────────────────────

data class PairResult(val deviceId: String, val token: String)

data class HealthInfo(val version: String, val dshConnected: Boolean, val dshName: String?)

data class SessionInfo(
    val sessionId: String,
    val cwd: String = "",
    /** 网关从 DSH 会话文件里读出来的首句；读不到就是 null（老会话/空会话） */
    val title: String? = null,
    /** 最后活动时间（毫秒）；读不到就是 null */
    val updatedAt: Long? = null,
)

data class SendResult(val turnId: String, val queued: Int)

data class SettingsSnapshot(
    val asrBackend: String,
    val ttsBackend: String,
    val announceMode: String,
    val shortLimit: Int,
)

data class AnnounceDecision(val speak: Boolean, val reason: String, val text: String)

/**
 * 网关的结构化错误。
 *
 * **不要只显示 error**——`hint` 才是用户真正需要的那句话。
 * UI 规范：标题用 error，正文用 hint，并提供「重试」。
 */
class GatewayException(
    val code: String,
    val error: String,
    val hint: String,
) : Exception(error) {
    override fun toString(): String = "$code: $error"

    /** 是否值得让用户点「重试」。配对/配置类错误重试没用，要先去改设置。 */
    val retryable: Boolean
        get() = code.startsWith("network.") || code == "request.timeout" || code == "internal.error"
}
