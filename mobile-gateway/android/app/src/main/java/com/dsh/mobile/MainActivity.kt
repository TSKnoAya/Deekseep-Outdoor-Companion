package com.dsh.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dsh.mobile.ui.ChatScreen
import com.dsh.mobile.ui.ChatViewModel
import com.dsh.mobile.ui.Skin
import com.dsh.mobile.ui.SkinBackdrop

class MainActivity : ComponentActivity() {
    private val vm: ChatViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // 沉浸式：隐藏状态栏与导航栏（三大金刚键），底部上滑临时唤出、几秒后自动隐藏。
        // 聊天界面底部是输入框，三条键常驻会把发送按钮压住（真机反馈过）。
        // BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE = 用户上滑时以半透明浮层显示，不占布局。
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent {
            val dark = isSystemInDarkTheme()
            // 皮肤开启时统一走深海暗色（亮色背景与这套美术不搭，且对比度不成立）
            val colors = if (Skin.ENABLED) {
                Skin.colorScheme()
            } else if (dark) darkColorScheme(
                primary = Color(0xFF4FC3F7),
                background = Color(0xFF0B1B2B),
                surface = Color(0xFF12263A),
            ) else lightColorScheme(
                primary = Color(0xFF0277BD),
                background = Color(0xFFF7FAFC),
                surface = Color(0xFFFFFFFF),
            )
            MaterialTheme(colorScheme = colors) {
                val state by vm.state.collectAsStateWithLifecycle()
                if (Skin.ENABLED) {
                    // 背景图在 Skin 里统一画；Scaffold 自己设成透明，别盖住图
                    SkinBackdrop { ChatScreen(state = state, vm = vm) }
                } else {
                    Surface(color = MaterialTheme.colorScheme.background) {
                        ChatScreen(state = state, vm = vm)
                    }
                }
            }
        }
    }
}
