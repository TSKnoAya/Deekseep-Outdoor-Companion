package com.dsh.mobile.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import com.dsh.mobile.R

/**
 * 手机端皮肤：「深海女仆工坊」（暗色）。
 *
 * 素材来自本机已装的 DSH 皮肤包 `@smalltailqwq/dsh-client-ui-skin-maid-atelier`，
 * **许可为 CC BY-NC-SA 4.0：禁止商用、必须署名、改过的图要同样许可**。
 * 署名链：角色原作 上善（Pixiv / B 站 上善无形）→ 女仆鲸鱼娘二创 ZipZipPipe →
 * 皮肤作者 Small-tailqwq。自己用没问题；要打包发给别人（尤其收费）请先看 LICENSE-ARTWORK。
 *
 * 为什么把颜色集中在这个文件：
 * 皮肤是"一层皮"，不该散落在各页里。想换回原来的蓝白配色，把 [ENABLED] 改成 false
 * 即可（背景图与气泡色会一起退回），不需要删资源、不需要改布局。
 */
object Skin {
    /** 一键开关：false = 回到原来的简洁蓝白主题。 */
    const val ENABLED = true

    /** 深海夜色（背景兜底色，图没加载出来时也不会闪白）。 */
    val NavyDeep = Color(0xFF06101D)
    val Navy = Color(0xFF0A1626)

    /** 蕾丝金：标题、边框、强调。 */
    val Gold = Color(0xFFC5A468)
    val GoldDim = Color(0x59C5A468)

    /** 文字：主 / 次。 */
    val Ink = Color(0xFFEAF1FA)
    val InkDim = Color(0xFF9FB2C9)

    /** 气泡：自己（偏亮蓝）与对方（偏深）。都用半透明，让背景透一点出来。 */
    val BubbleUser = Color(0xE61D3A5C)
    val BubbleBot = Color(0xCC102033)
    val BubbleError = Color(0xE63A1F22)

    /** 输入栏 / 顶栏的底：带透明度的深蓝，压住背景但不像一块黑板。 */
    val Chrome = Color(0xE60B1828)

    /** Material 配色：皮肤固定走暗色（深海是夜景，亮色版对比度不成立）。 */
    fun colorScheme() = darkColorScheme(
        primary = Gold,
        onPrimary = Color(0xFF1A1206),
        secondary = Color(0xFF7FB3D5),
        background = NavyDeep,
        onBackground = Ink,
        surface = Navy,
        onSurface = Ink,
        surfaceVariant = Color(0xFF152438),
        onSurfaceVariant = InkDim,
        primaryContainer = BubbleUser,
        onPrimaryContainer = Ink,
        error = Color(0xFFFF8A80),
        errorContainer = BubbleError,
        onErrorContainer = Color(0xFFFFD9D6),
        outline = GoldDim,
    )
}

/**
 * 背景层：一张压暗模糊的深海宫殿 + 一层竖渐变薄纱。
 *
 * 为什么再盖一层渐变而不是只靠图片：不同手机亮度/色彩管理差异很大，
 * 只压图片在某些机器上会让白字发灰。这层薄纱是最后一道保险。
 */
@Composable
fun SkinBackdrop(content: @Composable () -> Unit) {
    Box(
        Modifier
            .fillMaxSize()
            .background(Skin.NavyDeep),
    ) {
        if (Skin.ENABLED) {
            Image(
                painter = painterResource(R.drawable.skin_bg),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
                alpha = 0.92f,
            )
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            0f to Color(0x5905101C),
                            0.45f to Color(0x2605101C),
                            1f to Color(0x9905101C),
                        ),
                    ),
            )
        }
        content()
    }
}
