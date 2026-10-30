package com.dsh.mobile.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 本地设置与令牌存储。
 *
 * 安全要点：**设备令牌必须加密存**。
 * 网关一旦被谁拿到令牌，等于拿到那台电脑的命令执行权。普通 SharedPreferences
 * 是明文 XML，root 设备或有备份权限的应用能直接读。
 *
 * 用 EncryptedSharedPreferences（底层是 Android Keystore 里的 AES256-GCM 密钥）。
 * 代价是这个 API 已被标记 deprecated（Google 建议换成 DataStore + 自管密钥），
 * 但在 minSdk 26 上它仍然是**一行能写完、且密钥在 TEE 里**的最省方案。
 * 真要换，替换点只有本文件。
 *
 * 降级策略：Keystore 不可用（极少数机型/被篡改）时退回普通 SharedPreferences，
 * 但**要记一个标记**，让 UI 能提示「令牌未加密存储」——不能静默降级。
 */
class SettingsStore(context: Context) {

    private val prefs: SharedPreferences
    private val encrypted: Boolean

    init {
        val (p, enc) = try {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val secure = EncryptedSharedPreferences.create(
                context,
                FILE_ENCRYPTED,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            secure to true
        } catch (e: Exception) {
            context.getSharedPreferences(FILE_PLAIN, Context.MODE_PRIVATE) to false
        }
        prefs = p
        encrypted = enc
    }

    /** 令牌是否被加密存储。false 时 UI 应显示警告。 */
    val tokenEncrypted: Boolean get() = encrypted

    var baseUrl: String
        get() = prefs.getString(KEY_BASE_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_BASE_URL, value.trim()).apply()

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(value) {
            val e = prefs.edit()
            if (value.isNullOrBlank()) e.remove(KEY_TOKEN) else e.putString(KEY_TOKEN, value)
            e.apply()
        }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) {
            val e = prefs.edit()
            if (value.isNullOrBlank()) e.remove(KEY_DEVICE_ID) else e.putString(KEY_DEVICE_ID, value)
            e.apply()
        }

    /** 最近一次用的会话 id（让 App 重启后回到同一个对话）。 */
    var lastSessionId: String?
        get() = prefs.getString(KEY_SESSION, null)
        set(value) {
            val e = prefs.edit()
            if (value.isNullOrBlank()) e.remove(KEY_SESSION) else e.putString(KEY_SESSION, value)
            e.apply()
        }

    /** ASR 后端：gateway-sherpa | device-native */
    var asrBackend: String
        get() = prefs.getString(KEY_ASR, "gateway-sherpa") ?: "gateway-sherpa"
        set(value) = prefs.edit().putString(KEY_ASR, value).apply()

    /** 播报档位：all | short | headset-only | off */
    var announceMode: String
        get() = prefs.getString(KEY_ANNOUNCE, "short") ?: "short"
        set(value) = prefs.edit().putString(KEY_ANNOUNCE, value).apply()

    val isPaired: Boolean get() = !token.isNullOrBlank() && baseUrl.isNotBlank()

    fun clearAuth() {
        prefs.edit().remove(KEY_TOKEN).remove(KEY_DEVICE_ID).apply()
    }

    companion object {
        private const val FILE_ENCRYPTED = "dsh_mobile_secure"
        private const val FILE_PLAIN = "dsh_mobile"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SESSION = "last_session"
        private const val KEY_ASR = "asr_backend"
        private const val KEY_ANNOUNCE = "announce_mode"
    }
}
