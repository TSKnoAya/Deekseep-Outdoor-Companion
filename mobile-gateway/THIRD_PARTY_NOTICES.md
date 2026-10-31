# 第三方素材署名 / Third-party notices

## 代码依赖（随仓库 / APK 分发）

| 组件 | 位置 | 许可 | 用途 |
| --- | --- | --- | --- |
| qrcode-generator 1.4.4（Kazuhiko Arase） | `src/vendor/qrcode-generator.cjs` | **MIT**（版权声明保留在文件头） | 网关生成配对二维码矩阵 |
| ZXing core 3.5.3 | Gradle 依赖 `com.google.zxing:core` | Apache-2.0 | 手机端二维码解码 |
| AndroidX CameraX 1.3.4 | Gradle 依赖 `androidx.camera:*` | Apache-2.0 | 相机预览与取帧 |

> 注意：`qrcode-generator.cjs` **不能改名成 `.js`** —— 本包是 `"type": "module"`，
> 改名后 Node 会按 ESM 解析，UMD 的 `module.exports` 分支不执行，导入会直接失败。

本项目**代码**为 MIT。但 `android/app/src/main/res/drawable-nodpi/skin_*.webp` 这几张图
**不是代码**，它们来自第三方 DSH 皮肤包，许可是 **CC BY-NC-SA 4.0**。

## 深海女仆工坊（maid-atelier）

| 项 | 内容 |
| --- | --- |
| 上游 | https://github.com/Small-tailqwq/dsh-deep-whale |
| npm 包 | `@smalltailqwq/dsh-client-ui-skin-maid-atelier` |
| 本仓库用到的文件 | `skin_bg.webp`（由皮肤包内暗色宫殿背景裁切/模糊/压暗而来）<br>`skin_mascot.webp`（大立绘缩放）<br>`skin_chibi.webp`（Q 版头像缩放）<br>`skin_emblem.webp`（鲸鱼盾牌缩放） |
| 许可 | **CC BY-NC-SA 4.0** —— 署名、**禁止商业使用**、修改后需以相同许可分享 |
| 署名链 | 角色形象原作：**上善**（Pixiv / B 站「上善无形」）<br>女仆鲸鱼娘二次设计：**ZipZipPipe**<br>皮肤作者：**Small-tailqwq** |

### 使用边界（务必遵守）

- 本项目**免费开源、不收费**，符合"非商业"要求；
- 二次分发时**必须保留本文件**，并在 App 内可见位置（设置页「关于」）给出同样署名；
- 若将来出现收费版本、付费墙、赞助解锁、或打包进商业产品 —— 这几张图**必须先替换**为
  自己绘制/购买授权的素材，或单独取得原作者许可；
- 修改这几张图（裁切、调色、模糊算不算"修改"存在解释空间）后，按 SA 条款应以相同许可发布。

### 想完全摆脱这个限制

把 `ui/Skin.kt` 的 `ENABLED` 改成 `false` 即可完全不用这套美术（背景/气泡色/Q 版一起退回原样式），
或用自己的图替换 `drawable-nodpi/skin_*` 四个文件，其余代码无需改动。
