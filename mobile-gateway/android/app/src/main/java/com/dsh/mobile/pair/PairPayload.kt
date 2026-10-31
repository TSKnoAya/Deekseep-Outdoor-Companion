package com.dsh.mobile.pair

import java.net.URI
import java.net.URLDecoder

/**
 * 扫码结果 → 「网关地址 + 配对码」。
 *
 * 和网关 `src/pair-qr.js` 是同一份格式的两处实现，改格式要两边一起改：
 *   dshmobile://pair?v=1&u=<地址>&c=<6 位码>
 * 另外兼容只有地址的普通 http(s) 链接（`code` 为 null，让用户补 6 位码）。
 *
 * 为什么不直接把扫到的文本交给网关：地址会落到 `http://` 请求里，
 * 必须先确认 scheme 是 http/https，避免 `javascript:`、`file:` 之类的东西。
 */
data class PairPayload(
    val url: String,
    /** null = 扫到的是普通地址链接，缺配对码。 */
    val code: String?,
)

object PairPayloadParser {

    const val SCHEME = "dshmobile"
    const val HOST = "pair"

    private val CODE = Regex("^\\d{6}$")

    fun parse(raw: String?): PairPayload? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null

        if (isHttp(text)) {
            return if (hasHost(text)) PairPayload(text, null) else null
        }

        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        if (!SCHEME.equals(uri.scheme, ignoreCase = true)) return null
        if (uri.host != HOST) return null
        val query = parseQuery(uri.rawQuery ?: return null)

        val url = query["u"]?.trim().orEmpty()
        val code = query["c"]?.trim().orEmpty()
        if (!isHttp(url) || !hasHost(url)) return null
        if (!CODE.matches(code)) return null
        return PairPayload(url, code)
    }

    private fun isHttp(url: String): Boolean =
        url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)

    private fun hasHost(url: String): Boolean {
        val u = runCatching { URI(url) }.getOrNull() ?: return false
        return !u.host.isNullOrBlank()
    }

    /** URLSearchParams 的编码方式（`+` 也是空格），所以用 URLDecoder 对称解回来。 */
    private fun parseQuery(raw: String): Map<String, String> =
        raw.split('&')
            .filter { it.isNotEmpty() }
            .mapNotNull { part ->
                val i = part.indexOf('=')
                val key = if (i < 0) part else part.substring(0, i)
                val value = if (i < 0) "" else part.substring(i + 1)
                runCatching { decode(key) to decode(value) }.getOrNull()
            }
            .toMap()

    private fun decode(s: String): String = URLDecoder.decode(s, "UTF-8")
}
