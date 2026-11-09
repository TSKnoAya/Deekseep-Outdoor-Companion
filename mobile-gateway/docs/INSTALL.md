# 安装与排错

面向第一次用的人。目标：**十分钟内**在手机上说上第一句话。

---

## 0. 你需要什么

| 项 | 要求 |
| --- | --- |
| 电脑 | Windows 10/11，**DSH 桌面端已安装并登录**（网关要连着它） |
| 手机 | Android 8.0+（minSdk 26），和电脑在**同一个路由器**下 |
| Node | ≥ 22.15；没有也没关系，启动脚本会用 DSH 自带的 node |
| 网络 | 同一局域网。出门用 Tailscale（见 `docs/TAILSCALE.md`） |

## 1. 启动网关

在电脑上双击：

```
surfcore\mobile-gateway\start-gateway.bat
```

它会做四件事：

1. 找到 node（PATH → `%ProgramFiles%\nodejs` → **DSH 自带的运行时**）；
2. 首次运行时**弹一次 UAC**，加防火墙规则 `DSH-Mobile-Gateway-8788`（只为放行入站 TCP 8788）；
3. 打印**手机端网关地址**（自动探测本机 IPv4，Tailscale 地址会单独标注）；
4. 没有任何已配对设备时，自动生成 **6 位配对码**。

窗口里应该看到类似：

```
网关已启动：http://0.0.0.0:8788
   手机端「网关地址」填下面这个：
   http://192.168.1.247:8788
   首次使用：配对码 717842（5 分钟内有效）
桌面 DSH 传输已连接：http://127.0.0.1:11612
使用桌面 DSH 传输（手机会话与桌面同源）
```

> 窗口**不要关**。关掉 = 手机断线（但配对不会失效，下次再开就能用）。

命令行等价写法（调试用）：

```bash
cd surfcore/mobile-gateway
node src/main.js --listen 0.0.0.0:8788      # 加 --pair 可强制打印新配对码
```

## 2. 装 App

APK 在 `mobile-gateway/app-debug-0.1.0.apk`（或自己构建，见 README §4）。
传到手机安装即可。小米/红米会在「安装未知来源应用」拦一下，允许一次就好。

## 3. 配对

两种方式，二选一：

| 方式 | 步骤 |
| --- | --- |
| **扫码**（推荐） | 网关窗口/DSH 设置页显示二维码 → App 里点「扫码」→ 对准 |
| **手填** | App 里填 `192.168.1.247:8788`（会自动补 `http://`）+ 6 位配对码 |

配对码 5 分钟有效、一次性。过期就：

```bash
node src/main.js --listen 0.0.0.0:8788 --pair
```

或在 DSH →「手机网关」→ ② 点「生成配对码」（不用关窗口）。

配对成功后 App 会一直记住（token 存在 `~/.dsh/mobile-gateway/devices.json`），
**以后不用再配对**，除非你重装 App 或在设备管理里吊销了它。

## 4. 排错

### 连不上，App 里报 `after 10000ms`

**先看是"超时"还是"被拒绝"**，两者原因完全不同：

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| 很快返回 `connection refused` | 端口没进程在听 | 网关没启动，回去看 §1 |
| 等 10 秒后 `after 10000ms` | 包被**静默丢弃**，通常是防火墙 | 见下面 |

防火墙最常见的原因是**网络类别**：Windows 常把以太网判成「公用网络」，
而规则如果只对「专用网络」生效，公用下照样丢包。检查：

```powershell
Get-NetConnectionProfile | Select-Object Name, NetworkCategory
Get-NetFirewallRule -DisplayName "DSH-Mobile-Gateway-8788" | Select-Object Profile
```

`Profile` 必须是 `Any`。改：

```powershell
# 需要管理员
netsh advfirewall firewall set rule name="DSH-Mobile-Gateway-8788" new profile=any enable=yes
```

### 能连上，但显示「DSH 未连接」

网关在跑，但它连不上 DSH。三种情况：

1. **DSH 没开** → 打开桌面端；
2. **桌面端在跑但端口发现失败** → 看网关窗口日志里 `桌面 DSH 传输不可用：…` 的原因；
   可以强制走 ACP：`DSH_MOBILE_TRANSPORT=acp node src/main.js --listen 0.0.0.0:8788`；
3. **ACP 模式下报 `no API key for provider route`** → 手机走的是独立 DSH 进程，要给它配模型：

   ```bash
   node scripts/setup-acp-model.mjs --dry-run    # 先看要写什么
   node scripts/setup-acp-model.mjs              # 账号型；或 --provider our-free-model --model kilo-auto/free
   ```

### 扫码扫不到

- 二维码有有效期（5 分钟），过期重新生成；
- 手机相机对屏幕反光敏感，稍微侧一点、调亮屏幕；
- 也可以直接手填地址 + 配对码，效果一样。

### 会话里出现「（空会话）」

旧版本每次打开 App 会自动建一个空会话。**2026-11-10 之后的 APK 已修**，装新版即可。

### 手机上「哪条鱼」显示"没找到角色"

网关读的是 SurfCore 的 `~/.dsh/surfcore/characters/`：

- 没建角色 → 去 SurfCore 里建一个；
- 有角色但显示没找到 → 把网关窗口日志和 `~/.dsh/surfcore/characters/current.json` 一起发出来；
- 用了旧布局（`roles/角色卡.md`）也支持，会自动识别。

## 5. 卸载 / 回滚

| 想做的事 | 做法 |
| --- | --- |
| 只是不用了 | 关掉窗口、手机卸载 App |
| 清掉配对 | DSH →「手机网关」→ ⑤ 吊销，或直接删 `~/.dsh/mobile-gateway/devices.json` |
| 清掉所有网关状态 | 删 `~/.dsh/mobile-gateway/`（配置、设备表、设置） |
| 移除防火墙规则 | `netsh advfirewall firewall delete rule name="DSH-Mobile-Gateway-8788"`（管理员） |
| 从 DSH 卸载插件 | `dsh plugin --profile desktop remove mobile-gateway` |

网关不改注册表、不写 PATH、不开机自启——删目录就干净了。
