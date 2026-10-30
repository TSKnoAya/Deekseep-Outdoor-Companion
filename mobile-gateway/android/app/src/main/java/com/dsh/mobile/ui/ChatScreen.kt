package com.dsh.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(state: AppState, vm: ChatViewModel) {
    var showSettings by remember { mutableStateOf(false) }

    if (!state.paired) {
        PairingScreen(state, vm)
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("DSH", style = MaterialTheme.typography.titleMedium)
                        Text(
                            subtitle(state),
                            style = MaterialTheme.typography.bodySmall,
                            color = when {
                                state.streamLostReason != null -> MaterialTheme.colorScheme.error
                                state.dshConnected -> MaterialTheme.colorScheme.onSurfaceVariant
                                else -> MaterialTheme.colorScheme.error
                            },
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { vm.createSession() }) {
                        Icon(Icons.Default.Add, contentDescription = "新建会话")
                    }
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "设置")
                    }
                },
            )
        },
        bottomBar = {
            Composer(state, vm)
        },
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .imePadding()
                .navigationBarsPadding(),
        ) {
            state.banner?.let { banner ->
                BannerCard(banner) { vm.dismissBanner() }
            }
            state.streamLostReason?.let { reason ->
                BannerCard(
                    Banner("连接中断：$reason", "正在自动重连。如果一直连不上，检查电脑上网关是否还在跑。", true),
                    onDismiss = { vm.retryLastThing() },
                )
            }
            state.queuedNotice?.let { notice ->
                BannerCard(Banner(notice, "不用重复点发送，轮到它会自动发。", false), onDismiss = { })
            }

            // 审批卡片放在最上面：它阻塞着一轮，用户必须最后看到
            state.approvals.forEach { approval ->
                ApprovalCard(approval) { optionId -> vm.answerApproval(approval.id, optionId) }
            }

            val listState = rememberLazyListState()
            val itemCount = state.messages.size + if (state.streamingText.isNotBlank()) 1 else 0
            LaunchedEffect(itemCount, state.streamingText.length) {
                if (itemCount > 0) listState.animateScrollToItem(itemCount - 1)
            }

            if (state.messages.isEmpty() && state.streamingText.isBlank()) {
                EmptyState()
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(12.dp, 8.dp, 12.dp, 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.messages) { msg -> MessageBubble(msg) }
                    if (state.streamingText.isNotBlank()) {
                        item { MessageBubble(ChatMessage(Role.Assistant, state.streamingText), streaming = true) }
                    }
                }
            }

            if (state.thinking) {
                ThinkingBar(onStop = { vm.cancelTurn() })
            }
        }
    }

    if (showSettings) {
        SettingsDialog(state, vm, onClose = { showSettings = false })
    }
}

private fun subtitle(state: AppState): String = when {
    state.streamLostReason != null -> "连接中断"
    !state.dshConnected -> "DSH 未连接"
    state.thinking -> "正在思考…"
    state.currentSessionId != null -> state.currentSessionId.take(14)
    else -> "就绪"
}

// ── 配对 ──────────────────────────────────────────────────────────────────

@Composable
private fun PairingScreen(state: AppState, vm: ChatViewModel) {
    var showHelp by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("连接你的电脑", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "先在电脑上启动 DSH 手机网关，窗口里会打印网关地址和 6 位配对码。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))

        OutlinedTextField(
            value = state.baseUrl,
            onValueChange = vm::updateBaseUrl,
            label = { Text("网关地址") },
            placeholder = { Text("http://192.168.1.10:8788") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            // 这里曾经写成「不以 http 开头就标红」，而实际是会自动补 http://——
            // 用户填 192.168.1.247:8788 看到红框会以为自己填错了（实测被问到过）。
            // 只有真的不像地址（含空格 / 没有冒号）才算错。
            isError = state.baseUrl.isNotBlank() &&
                (state.baseUrl.contains(" ") || !state.baseUrl.contains(":")),
            supportingText = {
                if (state.baseUrl.isNotBlank()) {
                    Text(
                        if (state.baseUrl.startsWith("http")) "例如 http://192.168.1.247:8788"
                        else "会自动补上 http://（也可以直接粘电脑窗口里那行完整地址）",
                    )
                }
            },
        )
        Spacer(Modifier.height(12.dp))

        OutlinedTextField(
            value = state.pairCode,
            onValueChange = vm::updatePairCode,
            label = { Text("6 位配对码") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { vm.pair() }),
            supportingText = { Text("对上表：${state.pairCode.length}/6") },
        )
        Spacer(Modifier.height(20.dp))

        Button(
            onClick = vm::pair,
            enabled = state.busy == null,
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            if (state.busy == "pairing") {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("正在连接…")
            } else {
                Text("配对")
            }
        }

        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = vm::testConnection,
            enabled = state.busy == null,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (state.busy == "testing") "正在测试…" else "测试连接（不需要配对码）")
        }

        state.banner?.let { banner ->
            Spacer(Modifier.height(16.dp))
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = if (banner.ok) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.errorContainer
                    },
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(banner.title, style = MaterialTheme.typography.titleSmall)
                    Spacer(Modifier.height(4.dp))
                    Text(banner.hint, style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        Spacer(Modifier.height(16.dp))
        TextButton(onClick = { showHelp = true }) { Text("找不到配对码？") }
    }

    if (showHelp) {
        AlertDialog(
            onDismissRequest = { showHelp = false },
            title = { Text("怎么拿到配对码") },
            text = {
                Column {
                    Text("1. 在电脑上进入 mobile-gateway 目录")
                    Text("2. 双击 start-gateway.bat（会自己找 node，不用装环境）")
                    Text("   ；没有这个文件就命令行运行：")
                    Text("   node src/main.js --listen 0.0.0.0:8788")
                    Text("3. 那个窗口会打印两样东西（窗口别关）：")
                    Text(
                        "   手机端「网关地址」填：\n   http://192.168.1.247:8788\n   配对码 717842（5 分钟内有效）",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 12.sp,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("注意：电脑和手机要在同一个 Wi-Fi；Windows 防火墙首次要允许「专用网络」。")
                    Text("配对码过期或换手机：重新双击 start-gateway.bat，会打印新码。")
                }
            },
            confirmButton = { TextButton(onClick = { showHelp = false }) { Text("知道了") } },
        )
    }
}

// ── 消息 ──────────────────────────────────────────────────────────────────

@Composable
private fun MessageBubble(msg: ChatMessage, streaming: Boolean = false) {
    val isUser = msg.role == Role.User
    val isError = msg.role == Role.Error
    val bg = when {
        isError -> MaterialTheme.colorScheme.errorContainer
        isUser -> MaterialTheme.colorScheme.primaryContainer
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = bg),
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(if (isUser) 0.86f else 1f),
        ) {
            Column(Modifier.padding(10.dp)) {
                if (isError) {
                    Text("⚠ 出错了", style = MaterialTheme.typography.labelMedium)
                    Spacer(Modifier.height(4.dp))
                }
                Text(
                    if (streaming) msg.text + " ▌" else msg.text,
                    style = MaterialTheme.typography.bodyMedium,
                )
                msg.hint?.let { hint ->
                    Spacer(Modifier.height(6.dp))
                    HorizontalDivider()
                    Spacer(Modifier.height(6.dp))
                    Text(
                        hint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("👋", fontSize = 32.sp)
            Spacer(Modifier.height(8.dp))
            Text(
                "说点什么，或者按住麦克风说话",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun ThinkingBar(onStop: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(8.dp))
            Text("正在思考…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            TextButton(onClick = onStop) { Text("停止") }
        }
    }
}

// ── 审批 ──────────────────────────────────────────────────────────────────

@Composable
private fun ApprovalCard(approval: ApprovalUi, onAnswer: (String) -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer),
        modifier = Modifier.fillMaxWidth().padding(12.dp, 4.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Text("需要你批准", style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(4.dp))
            Text(
                approval.toolCallId?.let { "DSH 想调用工具：$it" } ?: "DSH 请求执行一个操作",
                style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                approval.options.forEach { option ->
                    if (option.isAllow) {
                        Button(onClick = { onAnswer(option.optionId) }) {
                            Text(if (option.kind.contains("always")) "总是允许" else "允许一次")
                        }
                    } else {
                        TextButton(onClick = { onAnswer(option.optionId) }) {
                            Text(if (option.kind.contains("always")) "总是拒绝" else "拒绝")
                        }
                    }
                }
            }
        }
    }
}

// ── 输入栏 ────────────────────────────────────────────────────────────────

@Composable
private fun Composer(state: AppState, vm: ChatViewModel) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Row(
            Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = state.input,
                onValueChange = vm::updateInput,
                modifier = Modifier.weight(1f),
                placeholder = { Text("发消息…") },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { vm.send(state.input) }),
                shape = RoundedCornerShape(20.dp),
            )
            Spacer(Modifier.width(6.dp))
            FilledIconButton(
                onClick = { vm.startVoiceInput() },
                enabled = !state.recording,
                modifier = Modifier.size(44.dp),
            ) {
                if (state.recording) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.Mic, contentDescription = "语音输入", modifier = Modifier.size(20.dp))
                }
            }
            Spacer(Modifier.width(6.dp))
            FilledIconButton(
                onClick = { vm.send(state.input) },
                enabled = state.input.isNotBlank(),
                modifier = Modifier.size(44.dp),
            ) {
                Icon(Icons.Default.Send, contentDescription = "发送", modifier = Modifier.size(20.dp))
            }
        }
    }
}

// ── 提示条 ────────────────────────────────────────────────────────────────

@Composable
private fun BannerCard(banner: Banner, onDismiss: () -> Unit) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
        modifier = Modifier.fillMaxWidth().padding(8.dp, 4.dp),
    ) {
        Column(Modifier.padding(10.dp)) {
            Text(banner.title, style = MaterialTheme.typography.titleSmall)
            Spacer(Modifier.height(3.dp))
            Text(banner.hint, style = MaterialTheme.typography.bodySmall)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) {
                    Text(if (banner.retryable) "重试" else "知道了")
                }
            }
        }
    }
}

// ── 设置 ──────────────────────────────────────────────────────────────────

@Composable
private fun SettingsDialog(state: AppState, vm: ChatViewModel, onClose: () -> Unit) {
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("设置") },
        text = {
            Column {
                Text("语音输入", style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(4.dp))
                Segmented(
                    options = listOf("gateway-sherpa" to "电脑识别", "device-native" to "手机识别"),
                    selected = state.asrBackend,
                    onSelect = vm::setAsrBackend,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    when (state.asrBackend) {
                        "gateway-sherpa" -> "音频会发到电脑上转写。识别质量更好，需要电脑开着。"
                        else -> "识别在手机上完成，音频不出手机。需要系统装了中文离线语音包。"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(16.dp))
                Text("语音播报", style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(4.dp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    listOf(
                        "all" to "全部播报",
                        "short" to "只播短回答",
                        "headset-only" to "仅耳机时播",
                        "off" to "关闭",
                    ).forEach { (id, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            androidx.compose.material3.RadioButton(
                                selected = state.announceMode == id,
                                onClick = { vm.setAnnounceMode(id) },
                            )
                            Text(label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text(
                    "代码块、表格、文件路径不会被念出来；长回答只念首句。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Spacer(Modifier.height(16.dp))
                HorizontalDivider()
                Spacer(Modifier.height(8.dp))
                Text("连接", style = MaterialTheme.typography.labelLarge)
                Text(state.baseUrl, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                Text(
                    "网关 v${state.gatewayVersion ?: "?"} · DSH ${if (state.dshConnected) "已连接" else "未连接"}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("关闭") } },
        dismissButton = {
            TextButton(onClick = { vm.unpair(); onClose() }) { Text("解除配对") }
        },
    )
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (id, label) ->
            val isSel = selected == id
            if (isSel) {
                Button(onClick = { onSelect(id) }) { Text(label) }
            } else {
                TextButton(onClick = { onSelect(id) }) { Text(label) }
            }
        }
    }
}
