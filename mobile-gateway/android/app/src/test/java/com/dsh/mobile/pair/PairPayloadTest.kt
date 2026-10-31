package com.dsh.mobile.pair

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairPayloadTest {

    @Test
    fun `完整载荷解析出地址和配对码`() {
        val p = PairPayloadParser.parse(
            "dshmobile://pair?v=1&u=http%3A%2F%2F192.168.1.247%3A8788&c=717842",
        )
        assertEquals(PairPayload("http://192.168.1.247:8788", "717842"), p)
    }

    @Test
    fun `只有地址的链接也能用，配对码留空`() {
        assertEquals(PairPayload("http://10.0.0.5:8788", null), PairPayloadParser.parse("http://10.0.0.5:8788"))
        assertEquals(
            PairPayload("https://tail.example.ts.net:443/", null),
            PairPayloadParser.parse("  https://tail.example.ts.net:443/  "),
        )
    }

    @Test
    fun `别的 scheme、host 或缺字段一律拒绝`() {
        assertNull(PairPayloadParser.parse(""))
        assertNull(PairPayloadParser.parse("随便一段文字"))
        assertNull(PairPayloadParser.parse("dshmobile://other?v=1&u=http%3A%2F%2F1.2.3.4%3A8788&c=123456"))
        assertNull(PairPayloadParser.parse("dshmobile://pair?v=1&c=123456"))
        assertNull(PairPayloadParser.parse("dshmobile://pair?v=1&u=http%3A%2F%2F1.2.3.4%3A8788"))
        assertNull(PairPayloadParser.parse("dshmobile://pair?u=http%3A%2F%2F1.2.3.4%3A8788&c=12345"))
    }

    @Test
    fun `地址只接受 http 和 https`() {
        assertNull(
            PairPayloadParser.parse("dshmobile://pair?v=1&u=javascript%3Aalert(1)&c=123456"),
        )
        assertNull(
            PairPayloadParser.parse("dshmobile://pair?v=1&u=file%3A%2F%2F%2Fetc%2Fpasswd&c=123456"),
        )
    }

    @Test
    fun `坏掉的百分号编码不崩，按无法识别处理`() {
        assertNull(PairPayloadParser.parse("dshmobile://pair?v=1&u=%E0%A4%A&c=123456"))
    }
}
