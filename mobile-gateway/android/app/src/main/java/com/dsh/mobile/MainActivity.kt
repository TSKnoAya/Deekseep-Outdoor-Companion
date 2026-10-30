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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dsh.mobile.ui.ChatScreen
import com.dsh.mobile.ui.ChatViewModel

class MainActivity : ComponentActivity() {
    private val vm: ChatViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val dark = isSystemInDarkTheme()
            val colors = if (dark) darkColorScheme(
                primary = Color(0xFF4FC3F7),
                background = Color(0xFF0B1B2B),
                surface = Color(0xFF12263A),
            ) else lightColorScheme(
                primary = Color(0xFF0277BD),
                background = Color(0xFFF7FAFC),
                surface = Color(0xFFFFFFFF),
            )
            MaterialTheme(colorScheme = colors) {
                Surface(color = MaterialTheme.colorScheme.background) {
                    val state by vm.state.collectAsStateWithLifecycle()
                    ChatScreen(state = state, vm = vm)
                }
            }
        }
    }
}
