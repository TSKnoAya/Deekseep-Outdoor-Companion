package com.dsh.mobile.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Log
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * 扫码配对：相机取景 + ZXing 解码，扫到任意 QR 就把文本交给调用方判定。
 *
 * 为什么不用 Google 的 GmsBarcodeScanner / ML Kit：
 * 国行手机（红米 K80 实测）没有 Google Play 服务，那一套要么装不上、要么扫码页打不开。
 * ZXing core 是纯 Java，随 APK 一起走，不依赖任何系统服务。
 *
 * 失败路径都在界面上：没有权限 → 说明 + 「去系统设置」；相机被占用/打不开 → 错误原文 + 重试；
 * 扫不到 → 框内提示。不存在「点了没反应」。
 */
@Composable
fun QrScanScreen(
    onDecoded: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var granted by remember { mutableStateOf(context.hasCameraPermission()) }
    var cameraError by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
    }
    LaunchedEffect(Unit) {
        if (!granted) launcher.launch(Manifest.permission.CAMERA)
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        when {
            !granted -> CameraPermissionBlock(
                onRequest = { launcher.launch(Manifest.permission.CAMERA) },
                onCancel = onCancel,
            )

            cameraError != null -> CameraErrorBlock(
                message = cameraError!!,
                onRetry = {
                    cameraError = null
                    attempt++
                },
                onCancel = onCancel,
            )

            else -> CameraPreview(key = attempt, onDecoded = onDecoded, onCameraError = { cameraError = it })
        }

        if (granted && cameraError == null) {
            IconButton(
                onClick = onCancel,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .statusBarsPadding()
                    .padding(8.dp),
            ) {
                Icon(Icons.Default.Close, contentDescription = "关闭扫码", tint = Color.White)
            }

            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(260.dp)
                    .border(2.dp, Color(0xFF4FC3F7), RoundedCornerShape(16.dp)),
            )

            Text(
                "把电脑设置页里的配对二维码放进框内",
                color = Color.White,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 72.dp, start = 24.dp, end = 24.dp),
            )

            OutlinedButton(
                onClick = onCancel,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(bottom = 16.dp),
            ) {
                Text("手动输入")
            }
        }
    }
}

@Composable
private fun CameraPreview(
    key: Int,
    onDecoded: (String) -> Unit,
    onCameraError: (String) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    // PreviewView 用**非状态**引用持有：工厂里写状态会触发重组，
    // 而 LaunchedEffect 的 key 一变就会取消半路中的绑定（见下方 catch 注释）。
    val previewRef = remember { AtomicReference<PreviewView?>(null) }
    val mainExecutor = remember { ContextCompat.getMainExecutor(context) }
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val done = remember { AtomicBoolean(false) }
    val providerRef = remember { AtomicReference<ProcessCameraProvider?>(null) }

    DisposableEffect(Unit) {
        onDispose {
            providerRef.get()?.unbindAll()
            analysisExecutor.shutdown()
        }
    }

    AndroidView(
        factory = { ctx ->
            PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
                implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            }.also { previewRef.set(it) }
        },
        modifier = Modifier.fillMaxSize(),
    )

    LaunchedEffect(key) {
        val view = previewRef.get() ?: return@LaunchedEffect
        try {
            val provider = awaitCameraProvider(context)
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            val decoder = QrDecoder()
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setTargetResolution(Size(1280, 720))
                .build()
            analysis.setAnalyzer(analysisExecutor) { proxy ->
                if (done.get()) {
                    proxy.close()
                    return@setAnalyzer
                }
                val text = try {
                    decoder.decode(proxy)
                } catch (e: Exception) {
                    null
                } finally {
                    proxy.close()
                }
                if (text != null && done.compareAndSet(false, true)) {
                    mainExecutor.execute { onDecoded(text) }
                }
            }
            provider.unbindAll()
            provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            providerRef.set(provider)
        } catch (e: CancellationException) {
            // 「The coroutine scope left the composition」这类取消不是相机故障：
            // Compose 在重组/离开页面时会用它结束 effect，必须原样抛出去。
            throw e
        } catch (e: Exception) {
            Log.e("QrScanScreen", "camera bind failed", e)
            onCameraError("相机打不开：${e.message ?: e.javaClass.simpleName}")
        }
    }
}

@Composable
private fun CameraPermissionBlock(onRequest: () -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("需要相机权限才能扫码", color = Color.White, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(10.dp))
        Text(
            "相机只在这一页用来识别电脑上的配对二维码，不拍照、不上传。\n" +
                "也可以在下一页手动填写地址和 6 位配对码。",
            color = Color.White.copy(alpha = 0.8f),
            style = MaterialTheme.typography.bodyMedium,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = onRequest, modifier = Modifier.fillMaxWidth()) { Text("允许使用相机") }
        Spacer(Modifier.height(10.dp))
        OutlinedButton(
            onClick = {
                val intent = Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.fromParts("package", context.packageName, null),
                )
                runCatching { context.startActivity(intent) }
            },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("去系统设置里开权限") }
        Spacer(Modifier.height(10.dp))
        TextButton(onClick = onCancel) { Text("先手动输入", color = Color.White) }
    }
}

@Composable
private fun CameraErrorBlock(message: String, onRetry: () -> Unit, onCancel: () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .padding(28.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, color = Color(0xFFFF8A80), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
        Spacer(Modifier.height(10.dp))
        Text(
            "先关掉别的正在用相机的应用（比如相机、微信视频），再点重试。",
            color = Color.White.copy(alpha = 0.8f),
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("重试") }
        Spacer(Modifier.height(10.dp))
        TextButton(onClick = onCancel) { Text("先手动输入", color = Color.White) }
    }
}

// ── 相机 / 解码 ────────────────────────────────────────────────────────────

private fun Context.hasCameraPermission(): Boolean =
    ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

private suspend fun awaitCameraProvider(context: Context): ProcessCameraProvider =
    suspendCancellableCoroutine { cont ->
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                try {
                    cont.resume(future.get())
                } catch (e: Exception) {
                    cont.resumeWithException(e)
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

/**
 * YUV_420_888 → 灰度 → ZXing。
 *
 * 两个坑：
 * 1. 只能用 Y 平面，且 `rowStride` 通常比宽度大（有对齐填充），按 width 直读会歪斜；
 * 2. 传感器输出常是横的（rotationDegrees=90），不转向的话竖屏永远扫不到。
 */
private class QrDecoder {
    private val reader = MultiFormatReader().apply {
        setHints(
            mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ),
        )
    }
    private var lastAttemptAt = 0L

    fun decode(proxy: ImageProxy): String? {
        // 每帧都跑 ZXing 没必要：肉眼能看到码之后 100ms 内再解一次足够，省电省热
        val now = System.currentTimeMillis()
        if (now - lastAttemptAt < 100) return null
        lastAttemptAt = now

        val image = proxy.image ?: return null
        val luma = copyLuminance(image.planes[0], image.width, image.height) ?: return null
        val upright = rotateClockwise(luma, proxy.imageInfo.rotationDegrees)
        val source = PlanarYUVLuminanceSource(
            upright.bytes,
            upright.width,
            upright.height,
            0,
            0,
            upright.width,
            upright.height,
            false,
        )
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        return try {
            reader.decodeWithState(bitmap).text
        } catch (e: NotFoundException) {
            null
        } catch (e: Exception) {
            null
        } finally {
            reader.reset()
        }
    }

    private fun copyLuminance(plane: android.media.Image.Plane, width: Int, height: Int): Luma? {
        if (width <= 0 || height <= 0) return null
        val buffer = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        if (rowStride < width || pixelStride < 1) return null
        val out = ByteArray(width * height)
        val row = ByteArray(rowStride)
        var written = 0
        for (y in 0 until height) {
            val remain = buffer.remaining()
            if (remain <= 0) break
            val n = minOf(rowStride, remain)
            buffer.get(row, 0, n)
            for (x in 0 until width) {
                out[written++] = row[x * pixelStride]
            }
        }
        // 缓冲区不足时宁可放弃这一帧，也不要拿半张图去解（会解出乱码）
        if (written != out.size) return null
        return Luma(out, width, height)
    }

    private fun rotateClockwise(src: Luma, degrees: Int): Luma {
        val w = src.width
        val h = src.height
        return when (((degrees % 360) + 360) % 360) {
            90 -> {
                val out = ByteArray(w * h)
                for (y in 0 until h) {
                    for (x in 0 until w) {
                        out[x * h + (h - 1 - y)] = src.bytes[y * w + x]
                    }
                }
                Luma(out, h, w)
            }
            180 -> {
                val out = ByteArray(w * h)
                for (i in 0 until w * h) out[w * h - 1 - i] = src.bytes[i]
                Luma(out, w, h)
            }
            270 -> {
                val out = ByteArray(w * h)
                for (y in 0 until h) {
                    for (x in 0 until w) {
                        out[(w - 1 - x) * h + y] = src.bytes[y * w + x]
                    }
                }
                Luma(out, h, w)
            }
            else -> src
        }
    }

    private data class Luma(val bytes: ByteArray, val width: Int, val height: Int)
}
