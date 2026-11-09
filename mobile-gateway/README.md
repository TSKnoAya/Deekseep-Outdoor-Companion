# mobile-gateway · 把手机接到你自己的 DSH

用手机聊你**电脑上**那个 DSH：会话、流式回复、语音输入、审批、会话历史，全部走本机网关。
不经过任何中转服务器——手机和电脑在同一个网络里就行（出门用 Tailscale）。

可选地把 [SurfCore](https://github.com/Small-tailqwq) 养的角色（人格卡 + 记忆卡）带到手机上，
让「手机上的它」和 QQ 上的是同一条鱼。

> 这是 `surfcore` 仓库里的子工程，位置 `surfcore/mobile-gateway/`。
> 它依赖仓库根的 `src/dsh-port.js`（发现桌面 DSH 端口），**不能单独抽出去跑**。

---

## 1. 它由两部分组成

```
┌──────────────┐   HTTP + SSE    ┌───────────────┐   RPC / stdio   ┌──────────────┐
│  Android App │ ──────────────► │ mobile-gateway │ ──────────────► │     DSH      │
│ (Kotlin)     │ ◄────────────── │  (纯 Node)     │ ◄────────────── │ (你的电脑)   │
└──────────────┘   手机扫码配对   └───────────────┘                 └──────────────┘
```

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 网关 | `src/` | 零第三方依赖的 Node 服务，把 DSH 包装成 REST + SSE |
| Android App | `android/` | Kotlin + Compose，包名 `com.dsh.mobile` |
| DSH 插件 | `dsh-plugin/` | 在 DSH 设置里多一页「手机网关」：状态、配对码、模型、角色、设备管理 |
| 脚本 | `scripts/` | `setup-acp-model.mjs`：把桌面在用的模型接到 ACP profile |

**为什么用 REST + SSE 而不是 WebSocket**：手机端 OkHttp 对 SSE 有一等支持，断线重连语义清晰；
双向只有「发消息 / 答审批」两个动作，REST 更简单，`curl` 就能调试。

## 2. 两条传输（自动选择）

网关连 DSH 有两条路，默认 `auto`：

| 模式 | 何时用 | 特点 |
| --- | --- | --- |
| **桌面 RPC**（`desktop`） | 桌面 DSH 正在运行 | **手机会话与桌面同源**，看到的是同一批会话；记忆只有一个写入者 |
| **ACP 子进程**（`acp`） | 桌面没开，或强制指定 | 自己拉一个 DSH 进程，独立会话；需要单独配模型（见 `scripts/setup-acp-model.mjs`） |

```bash
DSH_MOBILE_TRANSPORT=auto|desktop|acp    # 默认 auto：先试桌面，失败退回 ACP
```

## 3. 快速开始（Windows）

前置：**DSH 桌面端已安装并登录**；Node ≥ 22.15（没有也行，`start-gateway.bat` 会用 DSH 自带的 node）。

```text
1) 双击 mobile-gateway\start-gateway.bat
   - 首次会弹一次 UAC：给防火墙放行 TCP 8788（只放行这一次）
   - 窗口里会打印「手机端网关地址」和 6 位配对码
2) 手机装 android/app/build/outputs/apk/debug/app-debug.apk
   （或仓库里已构建好的 app-debug-0.1.0.apk）
3) 手机打开 App → 扫码（推荐）或手填地址 + 配对码
4) 发一句话试试
```

窗口**开着**手机才能连；关掉就断，但**配对不会失效**。电脑别睡眠。
更细的排错（防火墙「公用/专用」、扫码扫不到、连上但 DSH 未连接）见 [`docs/INSTALL.md`](docs/INSTALL.md)。

## 4. 从源码构建 Android

```bash
cd mobile-gateway/android
JAVA_HOME=<JDK 21> ANDROID_HOME=<Android SDK> gradle assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

- 需要 JDK 21 + Android SDK（compileSdk 35，minSdk 26）
- `local.properties`（SDK 路径）是机器相关配置，已 gitignore
- **只有 debug 签名**：自己装没问题，不能上架/分发（release 签名还没做）

## 5. 配置

启动期配置在 `~/.dsh/mobile-gateway/config.json`（首次运行自动生成模板，已存在则绝不覆盖）：

```json
{
  "dshInstall": "D:\\deepseek",
  "listen": "0.0.0.0:8788",
  "personaEnabled": false
}
```

| 键 | 作用 |
| --- | --- |
| `dshInstall` | DSH 安装目录（一般不用填，会自动探测） |
| `listen` | 监听地址。`0.0.0.0:8788` = 手机能连；`127.0.0.1:8788` = 只有本机能连 |
| `personaEnabled` | 是否把 SurfCore 的角色/记忆带到手机（默认 **false**，在 DSH 设置页 ④ 也能改） |
| `defaultCwd` | 新会话的工作目录，默认网关进程所在目录 |
| `transport` | `auto` / `desktop` / `acp` |

环境变量（优先级高于 config.json）：

| 变量 | 说明 |
| --- | --- |
| `DSH_MOBILE_LISTEN` | 等同 `--listen` |
| `DSH_MOBILE_TRANSPORT` | 传输模式 |
| `DSH_MOBILE_PERSONA=0\|1` | 强制关/开角色注入 |
| `DSH_HOME` | DSH 的用户目录（默认 `~/.dsh`） |
| `DSH_DIR` / `DSH_EXE` / `DSH_ACP_CLI` | 覆盖 DSH 安装位置（探测失败时用） |

命令行：`node src/main.js --listen 0.0.0.0:8788 [--pair] [--dsh-dir <路径>] [-h]`

## 6. 目录结构

```
mobile-gateway/
├─ src/                网关（零依赖）
│  ├─ server.js        HTTP 路由：/v1/*（设备）与 /admin/*（仅本机）
│  ├─ desktop-client.js / acp-client.js   两条传输
│  ├─ fish-context.js / fish-inject.js    「把鱼带到手机」：读人格+记忆，决定何时注入
│  ├─ session-meta.js  会话标题/时间（读 DSH 的会话文件）
│  ├─ devices.js       设备表与配对码
│  └─ voice/           ASR/TTS 后端（sherpa / 设备原生 / 火山接口）
├─ android/            Kotlin + Compose App
├─ dsh-plugin/         DSH 设置页插件（状态/配对/模型/角色/设备）
├─ test/               代码测试（node --test）+ e2e-smoke.mjs（需真 DSH）
├─ docs/               设计、安装、踩坑、case 记录
└─ start-gateway.bat   双击启动（找 node、放行防火墙、打印地址与配对码）
```

## 7. 测试

```bash
node test/run-all.js      # 216 条，全部在进程内跑
node test/e2e-smoke.mjs   # 端到端：起网关 → 配对 → 建会话 → 发消息 → 读 SSE（需真 DSH，会花 token）
```

> **不要用 `node --test test/`**：目录模式会为每个文件 fork 子进程，在受限环境里会 `spawn EPERM`，
> 而且会把挂起的用例判成 `cancelled`（`fail 0` 极易被误读成通过）。

## 8. 已知限制（诚实清单）

- **只有 debug 签名**，不能分发；也只在 Windows + Android 上验证过
- **没有后台常驻**：关掉网关窗口就断，也没有开机自启
- **没有推送**：App 关着时收不到消息；「主动搭话」目前只做到"打开 App 时补发"
- **跨网络**要靠 Tailscale/WireGuard：网关是纯 HTTP，令牌明文，**不要直接映射到公网**
- 角色注入默认关闭；开了就是"阅读" SurfCore 的记忆卡，**不写**
- 语音：电脑侧 ASR 需要自己下模型；火山 TTS 只留了接口
- 会话标题靠读 DSH 的 `session.v4.jsonl.zstd`（多帧解压），文件超 16MB 时只显示时间不显示标题

## 9. 许可与署名

- **代码**：MIT（见 [`LICENSE`](LICENSE)）
- **界面素材**（`android/app/src/main/res/drawable-nodpi/skin_*.webp`）：来自 DSH 皮肤
  [深海女仆工坊 / maid-atelier](https://github.com/Small-tailqwq/dsh-deep-whale)，
  **CC BY-NC-SA 4.0：禁止商用、必须署名、改动需同许可**。
  署名链：角色原作 上善 → 二创 ZipZipPipe → 皮肤 Small-tailqwq。详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- 不想用这套美术：把 `android/.../ui/Skin.kt` 里的 `ENABLED` 改成 `false`，或替换那四个 `skin_*.webp`。
