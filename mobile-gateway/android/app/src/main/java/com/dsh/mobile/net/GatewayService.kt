package com.dsh.mobile.net

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.dsh.mobile.MainActivity
import com.dsh.mobile.R

/**
 * 前台服务：让 SSE 长连接在锁屏/切后台后不被杀。
 *
 * 为什么必须有它：HyperOS（红米 K80 的系统）对后台进程非常激进。
 * 普通后台连接在息屏几分钟后就会被断，而 DSH 一轮可能跑十几分钟——
 * 结果就是「手机放兜里，每次掏出来都显示连接中断」。
 *
 * 前台服务不能免死，但能大幅提高存活率。它必须：
 * 1. 有常驻通知（用户能看见，也能点回 App）；
 * 2. 在 Android 14+ 声明 foregroundServiceType；
 * 3. 通知渠道用低优先级，避免每次弹横幅。
 *
 * 注意：**它不做业务**。真正的连接在 ViewModel/AcpConnection 里，
 * 这里只提供一个「进程别被回收」的锚点。业务放这里会带来
 * 「服务重启但 UI 不知道」的双份状态问题。
 */
class GatewayService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification)
        }
        // START_STICKY：被杀后系统会尝试重启。重启后 ViewModel 会自动重连。
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "保持连接",
            NotificationManager.IMPORTANCE_LOW, // 不出横幅、不响铃
        ).apply {
            description = "让手机在锁屏后仍能收到 DSH 的执行结果"
            setShowBadge(false)
        }
        mgr.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("DSH 已连接")
            .setContentText("保持在线，随时能收到执行结果")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(open)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "dsh_mobile_connection"
        private const val NOTIF_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, GatewayService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, GatewayService::class.java))
        }
    }
}
