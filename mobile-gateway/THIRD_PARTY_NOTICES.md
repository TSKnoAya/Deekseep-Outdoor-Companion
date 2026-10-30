# 第三方素材署名 / Third-party notices

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
