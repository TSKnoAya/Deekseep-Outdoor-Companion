# 2026-10-30 · DSH 手机端 App（网关 + Android + 语音双模）

> 状态：网关与测试已完成并通过；Android 工程已编译通过并产出 debug APK（见 §6）。

---

## 1. 用户原话（需求来源）

> 「我希望开发一个安卓手机上的应用，作用是通过手机发送消息，到 dsh 里，dsh 处理完再反馈结果到手机上」
> 「不使用 DSH Web，要用本地的 `D:\deepseek\DeepSeek Harness.exe`」
> 「把 A 和 B 的优势和劣势做成对照表」
> 「我打算以后添加语音输入功能和播报功能（语音播放反馈的文本），可行吗？」
> 「1.用云端包…2.做一个切换功能…3.也做一个切换功能」
> 「先跳过火山引擎的部分，只留接口，日后再补」
> 「手机端直接做 App，手机型号是红米 K80」

---

## 2. 完整逻辑（七步）

### ① 链路

```
Android App (Kotlin/Compose)
  │  HTTP + SSE  /v1/*
  ▼
本机网关 (Node 24，无第三方依赖)
  │  stdio JSON-RPC（ACP）
  ▼
D:\deepseek\DeepSeek Harness.exe  --profile acp
  │
  └─ 会话落盘 %DSH_HOME%\sessions\<cwd编码>\<id>\
```

**谁读这些文件**（grep 实测）：

| 文件 | 读者 |
|---|---|
| `state/mobile-gateway/devices.json` | 只有 `src/devices.js`（网关自身） |
| `state/mobile-gateway/settings.json` | 只有 `src/config.js`（网关自身） |
| App 侧令牌 | `data/SettingsStore.kt`（指向 EncryptedSharedPreferences） |

网关**不写** `~/.dsh` 下任何 DSH 自己的文件；它只读（通过 ACP 子进程）。

### ② 机制：为什么这么做

**为什么是 ACP 而不是直接连 Web**（三个已核实的事实）：

1. DSH Web 只监听回环（`netstat` 实测 `127.0.0.1:2318`），端口会漂移；
2. 浏览器会话 Cookie 把 authority 绑进签名载荷（`src/dsh-client.js:74-77`），
   任何改写 Host 的反代都会 401；
3. 协议是 WebSocket RPC（`/api/remote.mux`），不是 REST。

**为什么不用 `--profile headless`**：`dsh-headless/lib/index.js` 里 **零** `approval` 字样，
而 `dsh-base/cordis.patch.yml:262` 把策略设为 `ask`。按 `dsh-user-approval` 的规则，
`ask` + 无应答者 → `unavailable` → **以拒绝方式关闭**。
即：需要越权的操作不是「问你」，而是静默失败。绕过只能 `danger-full-access`（等于全放开）。

**为什么 ACP 的 `session/prompt` 必须异步**：它阻塞到本轮结束（一轮可能十几分钟）。
所以 `POST /v1/messages` 立刻返回 `turnId`，结果走 SSE。

**为什么网关要自己排队**：ACP 源码 `if (this.inflight !== void 0) throw invalidParams$1("a prompt is already in flight for this session")`。
用户会连点两下发送，第二下不能变成红错误。

**为什么 ASR 不用 DSH 的 `speechToText`**：它是 Typert Remote，挂在
`dsh-api-gateway` + `dsh-client-connection`（Web 层）；ACP profile 不挂 gateway，
且 `dsh-acp/lib/index.js:114` 明确 `audio prompt content is not supported`。
所以网关**直接 require DSH 打包的 `sherpa-onnx.node`**（已实测可加载）。

### ③ 爆炸半径

| 维度 | 评估 |
|---|---|
| 进程数 | 1 个网关 + 1 个 ACP 子进程。ACP 挂了网关自动重连（指数退避，封顶 30s） |
| 读者数 | 只读 DSH 的会话（经 ACP）；不写 DSH 任何文件 |
| 用户数据 | 只碰 `%DSH_HOME%\mobile-gateway\`（新建目录） |
| 密钥 | 网关不存火山密钥以外的凭据；设备令牌只存 sha256 |
| 花钱 | **网关本身不花钱**。AMP：只有用户自己发消息时才消耗 DSH 的 token |
| 静默失败 | 全部结构化（`ok:false` + `code` + `error` + `hint`），85 条测试里有 40+ 条专测失败路径 |

### ④ 取舍（两条备选）

| 路线 | 收益 | 成本 | 风险 | 回滚 | 结论 |
|---|---|---|---|---|---|
| **ACP stdio（采用）** | 有审批、复用登录态、无端口无 Cookie | 常驻进程 + 异步回合 | 中（DSH 升级可能改协议） | 停网关即回退 | ✅ |
| headless 一次性调用 | 最省，1 天能出原型 | 低 | **高**：无审批应答者，只能全放开或干不了 | 删脚本 | ❌ 只适合做通道验证 |
| 连 DSH Web | 复用现成 UI | 低 | 高：Cookie 绑 authority，反代必 401 | — | ❌ |

### ⑤ 生效与重启

| 改了什么 | 要重启什么 |
|---|---|
| 网关 `src/*.js` | 重启网关进程 |
| 网关 `settings.json`（App 里改设置） | **不用重启**（现读） |
| App 代码 | 重新 `assembleDebug` 并安装 |
| DSH 本体升级 | 先跑 `node test/run-all.js`；`initialize` 会校验协议版本 |

### ⑥ 验证（命令 + 预期）

```bash
# 网关全量测试（85 条）
node test/run-all.js
# 预期：ℹ tests 85 / ℹ pass 85 / ℹ fail 0

# 只跑失败路径相关
node test/run-all.js --grep 失败
```

**为什么用 `node test/run-all.js` 而不是 `node --test test/`**：
本仓库开发沙箱禁止 spawn 子进程，而 `node --test` 的目录模式会为每个测试文件 fork
（实测 `spawn EPERM`）。`run-all.js` 用进程内 `run()`，一个进程跑完全部。

### ⑦ 回滚与残余

- 回滚：删 `mobile-gateway/` 目录即可；网关不在任何启动项里，不写注册表、不改 PATH。
- 工具链装在 `D:\dsh-android`（独立目录），删掉不影响系统。
- **残余未验证**见 §6。

---

## 3. 交付物

| 路径 | 说明 |
|---|---|
| `mobile-gateway/src/` | 网关（errors / transport / acp-client / devices / hub / server / config / main / voice） |
| `mobile-gateway/test/` | 5 个测试文件，85 条断言 |
| `mobile-gateway/android/` | Kotlin + Compose 工程 |
| `mobile-gateway/DESIGN.md` | 设计文档（协议、边界、火山接口契约） |

---

## 4. 语音设计（用户明确要求的三点）

1. **用云端包** → 火山引擎后端；**但现在只留接口**（用户要求「先跳过」）。
   缺配置时返回 `tts.provider-not-configured` + 指向控制台的 hint，**不假装成功**。
2. **ASR 双模切换**：
   - `gateway-sherpa`：网关 require `sherpa-onnx.node` 跑 SenseVoice（音频走电脑）
   - `device-native`：Android `SpeechRecognizer`（音频不出手机）
   切换在 App 设置页，**立刻生效**（本地写 + 尝试同步网关，同步失败不阻塞）。
3. **播报四档切换**：`all` / `short`（默认）/ `headset-only` / `off`。
   外加三条硬规则（不分档位）：代码块表格路径不念、长回答只念首句、纯符号不念。
   规则在**两处**实现且语义一致：网关 `voice/announce.js`、App `Speaker.stripForSpeech`
   （因为火山没配时走纯本地播报，不经过网关）。

---

## 5. 一处必须承认的取舍

**「网关识别」这条 ASR 路径目前只到「接口就绪」，没接手机端录音上传。**
原因：需要实现 16kHz 单声道 PCM16 的 WAV 录音（AudioRecord + 手写 44 字节头），
这部分没做，App 里点麦克风会明确提示「请先切到手机本地转写」。

这是**有意的诚实失败**，不是遗漏：与其传一段格式不对的音频让 SenseVoice
静默转出乱码（最难受的一类 bug），不如直接告诉用户现在哪条路能用。

---

## 6. 验证状态（诚实记录）

| 项 | 状态 |
|---|---|
| 网关 85 条单测 | ✅ 85/85（连跑 3 次均 85/85、0 cancelled，见 §8） |
| ACP 握手 / 建会话 / 跨进程 list | ✅ 实测通过（前序会话） |
| `sherpa-onnx.node` 可 require | ✅ 实测 |
| **ACP `agent_message_chunk` 运行期样本** | ✅ **已通**（2026-10-30 21:5x，见 §11.4：收到 `text` 事件与完整回复）。此前状态：⚠️ 半通：`node test/e2e-smoke.mjs` 已跑出 `hello → turn_start → turn_end` 真实回合，但 LLM 调用被 DSH 拦下（`llm-deepseek: no API key for provider route "deepseek-official"`），**文本块 0 个**，见 §9 |
| **SenseVoice 实际转写延迟** | ❌ 未验证（模型未下载） |
| **火山引擎 TTS 真实调用** | ❌ 未实现（用户要求跳过） |
| **APK 构建** | ✅ `assembleDebug` BUILD SUCCESSFUL（47s）；产物 `android/app/build/outputs/apk/debug/app-debug.apk`，17,436,189 字节，另存副本 `mobile-gateway/app-debug-0.1.0.apk`。`aapt2 dump badging`：`com.dsh.mobile` v0.1.0 / minSdk 26 / targetSdk 35 |
| **真机（红米 K80）运行** | ❌ 未验证（未安装、未配对、未跑一轮对话） |

---

## 7. 发布交接块

> 本次**没有版本号变更**（`package.json` 仍是 `0.1.0`，子工程不入根 `package.json` 依赖链），
> 因此不进 `docs/RELEASE-QUEUE.md` 的发布批次；交接信息记在 `docs/HANDOFF.md` 顶部快照
> 「2026-10-30 20:30–20:40」与「2026-10-30 21:00–21:20」。

### 上真机的完整步骤（含地址与配对码从哪来）

网关**默认只监听 `127.0.0.1:8788`**（回环）。回环地址对手机来说指的是手机自己，
所以不换监听地址就永远连不上。正确姿势：

```bash
cd surfcore/mobile-gateway
node src/main.js --listen 0.0.0.0:8788
```

窗口里会打印三样东西（就是你要找的答案）：

```
[21:07:46] 网关已启动：http://0.0.0.0:8788
[21:07:46]    手机端「网关地址」填下面这个：
[21:07:46]    http://192.168.1.247:8788        ← 填进 App「网关地址」
[21:07:46]   首次使用：配对码 717842（5 分钟内有效）  ← 填进 App「6 位配对码」
```

1. App 里「网关地址」填 **http://电脑局域网IP:8788**（App 会自动补 `http://`）。
2. 「6 位配对码」填窗口里那 6 位数字（5 分钟有效）。
3. 手机与电脑同一 Wi-Fi；Windows 防火墙首次会弹窗，要允许**专用网络**。
4. 配对码过期 / 换手机 / 重装 App：`node src/main.js --listen 0.0.0.0:8788 --pair`
   （**已配对过设备后，启动默认不再打码**——否则任何人重启一下就能拿到码，是个漏洞）。

> 端口被占用时换一个：`--listen 0.0.0.0:8790`，App 里地址同步改端口。

---

## 8. 2026-10-30 20:30–20:40 续做记录（搬进仓库 + APK 构建）

沙箱里的 `state/slang-agent/mobile-gateway/` 已被 gitignore（`.gitignore` 第 6 行 `state/`），
**代码原本完全不在版本控制里**。本次按「先防丢、再构建」的顺序收尾：

| 动作 | 结果 |
|---|---|
| 搬进仓库 | 源码/测试/文档复制到 `mobile-gateway/`，排除 `android/app/build`、`android/.gradle`、`android/.kotlin`（62MB → 397KB） |
| 新增 `.gitignore` | 忽略 `node_modules/`、Android 构建产物、`local.properties`（机器相关）、`*.apk`、`_dbg.*` |
| 测试复核 | 搬家后首次跑出 **81/85 pass + 4 cancelled**，见下「修掉的一个 flaky」 |
| APK 构建 | 首次 `compileDebugKotlin` 失败（2 处类型错误），修完 47s 构建成功 |

### 修掉的一个 flaky（不是搬家的锅）

搬家后 4 条用例变成 `cancelled`，一度看着像「复制坏了」。实际是两个独立问题叠加：

1. `src/acp-client.js:184` 的请求超时计时器是 `timer.unref()` 的（**刻意的**：不让一个超时定时器
   把进程钉住）。而 node:test 在事件循环空转时会把仍挂起的用例判成 `cancelled`——**不是 fail**，
   汇总里 `pass` 不到 85 却 `fail 0`，极易被误读成通过。
2. 这条用例之前能过，靠的是「恰好还有别的活句柄撑着事件循环」，属顺序依赖的偶发。
   修法：用例自己拿一个 1000ms 的 ref 定时器撑住循环，断言完再 `clearTimeout`。
   改完 `pass 85 / fail 0 / cancelled 0`，连跑 3 次稳定。

> 教训值得记：**`cancelled` 不等于成功**。验收脚本必须同时看 `pass` 与 `cancelled` 两个数。

### 修掉的两处 Kotlin 编译错误

`ui/ChatViewModel.kt` 的 `setAnnounceMode` / `setAsrBackend` 里
`buildJsonObject { put("announceMode", mode) }` 把 `String` 直接塞给了要求 `JsonElement` 的
`put` 重载 → 改成 `put("announceMode", JsonPrimitive(mode))` 并补 `import kotlinx.serialization.json.JsonPrimitive`。
（顺带把两处全限定名 `kotlinx.serialization.json.buildJsonObject` 收敛成 import。）

### 仍未做（交接给下一个人）

1. **真机跑一轮**：`adb install app-debug.apk` → 起网关 → 输配对码 → 发一条消息 → 看 SSE 流式回包。
2. **ACP 运行期样本**：这条只在真机/真进程里才出现（`agent_message_chunk`），沙箱跑不出来。
3. **手机录音上传**（`gateway-sherpa`）：需 AudioRecord 采 16kHz 单声道 PCM16 + 手写 44 字节 WAV 头。
4. **火山 TTS**：用户明确「先跳过」，只留接口与 `tts.provider-not-configured` 的诚实报错。


---

## 9. 2026-10-30 21:00–21:20 端到端冒烟（补掉「运行期样本」这个洞）

用户问「网关地址和配对码在哪看」，一查发现两个**会让这一步直接卡死**的问题，都已修：

### 9.1 `--listen` 是个假开关

`main.js` 的端口占用提示写着「换一个：`--listen 127.0.0.1:8790`」，但**代码从没解析过 argv**。
照提示敲只会得到 `node: bad option`。而网关默认 `127.0.0.1:8788`，手机永远连不上——
用户按文档操作会得到「App 一直转圈」，且没有任何提示告诉他为什么。

修法（`src/cli.js` 新增，`test/cli.test.js` 14 条钉住）：
- `--listen host:port` / `--listen=host:port` 真的生效（覆盖 `resolveConfig`）；
- 非法地址直接打用法并 `exit 1`，不静默落到默认值；
- 回环监听时打印「手机连不上 + 该怎么改」；非回环监听时**自动探测本机 IPv4 并打印可填地址**
  （过滤 `127.*` 与 `169.254.*`，后者是 DHCP 没拿到地址，写出来只会误导）。

### 9.2 配对过一台设备后，再也拿不到新码

首次启动会打码（`devices.json` 为空时）；可 `/v1/devices` 要令牌，于是：
**一旦配对过一台，换手机/重装 App 就无路可走**，只能删 `devices.json`（文档里没写，等于死路）。

修法：新增 `--pair`，强制生成并打印新码。同时把「已配对就不打码」写进逻辑——
不能无条件打，否则任何人重启一下网关就等于拿到配对码，那是个洞。

### 9.3 端到端冒烟脚本 `test/e2e-smoke.mjs`

不进 `test/run-all.js`（需要真 DSH、会花 token），手动跑：

```bash
node test/e2e-smoke.mjs          # 默认 8791 端口
```

它把整条链真跑一遍：起网关（子进程）→ 抠配对码 → `/v1/pair` → `/v1/sessions` →
连 SSE → `/messages` → 等 `turn_end` → 打印收到的事件类型与文本块。

### 9.4 冒烟结果（重要，且没好听的）

```
[e2e] 拿到配对码 362249
[e2e] 配对成功
[e2e] DSH 已连接
[e2e] 建会话 591930df-e3dc-47c6-9afd-09c141651383
[e2e] 已提交 turn turn-1793365894181-x6hiwj
[e2e] 收到事件类型： hello, turn_start, turn_end
[e2e] 文本块数量： 0
[e2e] turn_end： ok:false, failure.code=acp.turn-failed,
      error="DSH 返回错误：Internal error: turn failed: llm-deepseek:
             no API key for provider route \"deepseek-official\";
             store DEEPSEEK_API_KEY through the credentials service"
```

**结论分两半，不能混着说：**

| 环节 | 结果 |
| --- | --- |
| 网关 HTTP（配对/鉴权/建会话/SSE 订阅/提交） | ✅ 全通 |
| 网关 ↔ DSH 的 ACP 握手与回合生命周期 | ✅ `turn_start` / `turn_end` 真跑出来了，**失败也是结构化回传**（不是静默转圈） |
| DSH 内部调 LLM | ❌ 缺 `deepseek-official` 这条 provider route 的密钥 |

第三条**不是网关的 bug**：网关拉起的 ACP 子进程是全新的 DSH 实例，它只能看到
`~/.dsh/.credentials.yaml` 里的 `deepseek-account-platform/default` 这类 grant，
看不到桌面端登录态的模型路由。桌面端 UI 能用，是因为它走 Web 层 + 已登录凭据。

**三条可选出路**（已于 §11 解决，此处保留供回溯）：
1. 给网关进程注入 `DEEPSEEK_API_KEY`（platform.deepseek.com 申请）——最直接；
2. 在 DSH 桌面端「模型」页把 `deepseek-official` 这条路由配上密钥（走 credentials service）；
3. 放弃 ACP，让网关照 surfcore 现在的做法连 Web 层（`discoverDshBaseUrl()` + 离线铸 Cookie）。
   **代价**：DESIGN §1 否决 Web 的三条理由（只监听回环 / Cookie 绑 authority / WebSocket RPC）
   会全部复活，只是「同一台机器上」能绕过；跨机器不行。

> 在第三条路走通之前，**手机上发消息会看到一条明确的错误**（`acp.turn-failed` + 上面那句英文），
> 不会假装成功。这是有意的：宁可报错，也不要让用户以为「发了但 DSH 不理我」。

---

## 10. 2026-10-30 21:25–21:45 路径配置化（为「别人用自己的电脑」铺路）

用户明确了两件事：
1. 情景一要求**出门（4G/5G）也能用**；
2. 情景二是「别人**只经过他自己的电脑**，不经过我的电脑」。

第 2 条把「路径写死在我这台机器」变成了硬阻塞——别人装在不同的目录，网关直接起不来。

### 10.1 改了什么

| 改动 | 落点 |
| --- | --- |
| 新增安装位置探测 | `src/paths.js`：`candidateDirs()` / `detectInstall()` / `resolveDshPaths()` |
| 三处硬编码路径删除 | `src/config.js` 不再有 `D:/deepseek/...`，改为 `null` 交给探测 |
| 新增启动配置 `config.json` | `~/.dsh/mobile-gateway/config.json`（`dshInstall` / `listen` / `defaultCwd`），首次运行自动写模板，已存在绝不覆盖；坏文件隔离后按默认启动 |
| 新增 `--dsh-dir` | 探测不到时手动指定；优先级：命令行 > 环境变量 > config.json > 探测 |
| 启动横幅 | 打印 `DSH 安装目录：…（来源：detect/arg/config/env-dir/env-file）`，Tailscale 地址单独标注 `← Tailscale，外出也能用` |
| 新增 16 条路径测试 | `test/paths.test.js`（注入假 fs，能证明「装在 C 盘也认得出」） |
| 出门方案文档 | 新增 `docs/TAILSCALE.md` |

### 10.2 探测顺序

1. `--dsh-dir` → 2. `DSH_DIR`/`DSH_INSTALL_DIR` → 3. `DSH_EXE`/`DSH_ACP_CLI`/`DSH_SHERPA_NATIVE`（单文件覆盖）
→ 4. `config.json` 的 `dshInstall` → 5. 自动探测：
`%LOCALAPPDATA%\Programs\DeepSeek Harness`、`%PROGRAMFILES%\...`、`%USERPROFILE%\Desktop\...`、
C 到 H 各盘下的 `deepseek` / `DeepSeek` / `dsh` 目录，最后兜底扫各盘根下名字像 deepseek 的文件夹。

### 10.3 顺带修掉的一个真 bug：判断 asar 里的文件

第一版探测在本机就报「找不到 cli」——因为 `cli.js` 打在 `app.asar` 里，
**普通 Node fs 看不进 asar**，`existsSync` 恒为 false，可它其实完全能用（Electron 能读）。
现在 `isInsideAsar()` 把 asar 内路径排除在「存在性判断」之外，`app.asar.unpacked` 仍按真实目录判断。
（这是必须记的一条：**asar 内的路径不能拿 fs 判存在**。）

### 10.4 验证

- `node test/run-all.js` → **114/114**（新增 16 条路径测试 + 补 asar 用例）。
- 本机实测：`DSH 安装目录：D:/deepseek（来源：detect）`，自动写出的 `config.json`
  内容为 `{"dshInstall":"D://deepseek","listen":"0.0.0.0:8788"}`。
- 优先级实测：`--listen 127.0.0.1:8793` 覆盖了 config.json 里的 `0.0.0.0:8788`。
- `/v1/health` 返回 `dsh.connected=true`；未带令牌访问 `/v1/sessions` → **401**（鉴权仍然有效）。
- e2e 冒烟回归：链路仍通，**仍然卡在 provider key**（§9.4，未变）。

### 10.5 还没做的（距「发布给别人用」还差什么）

| 还差 | 说明 |
| --- | --- |
| release 签名 | 现在只有 debug 签名，不能正经分发 |
| 首次启动向导 | 现在靠终端文案；普通用户需要 App 内引导（装 DSH → 填地址 → 配对） |
| 模型密钥 | 每个用户自己的 DSH 要有可用 provider route，否则发消息必失败（§9.4） |
| 网络方案 | 自用走 Tailscale（`docs/TAILSCALE.md`）；给别人用得靠「用户各自搭」或做中转服务 |
| 后台常驻 | 网关没有开机自启/守护，关窗口就停 |

---

## 11. 2026-10-30 21:38–22:00 打通模型：ACP 的默认模型藏在 `id: acp` 里

§9.4 那个「no API key」的阻塞已经解决。过程值得完整记下来，因为它推翻了两个常识假设。

### 11.1 走过的三条死路（都别重走）

| 试法 | 结果 |
| --- | --- |
| 给网关设 `DEEPSEEK_API_KEY` 环境变量 | 用户没有平台密钥，且这条路要求先充值 |
| 改 `~/.dsh/profiles/acp/cordis.patch.yml` 里的 **`agent-default-model`** | **完全无效**——改完照样报同一个错。ACP 根本不读这个插件 |
| 猜「ACP 会读桌面端的模型设置」 | 不会。桌面端的 `provider: our-free-model` 写在 `profiles/desktop/cordis.patch.yml`，ACP profile 只加载 `dsh-base` + `dsh-acp-app`，看不到 |

### 11.2 定位方法（这条最有复用价值）

DSH 自带 `--dump-config`，能把「bundle + profile patch + 根 patch」合成后的完整树打出来：

```bash
"/d/deepseek/DeepSeek Harness.exe" --expose-internals \
  "D:/deepseek/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" \
  --profile acp --dump-config > /tmp/acp-config.txt
```

在 dump 里搜 `deepseek-official`，答案就一行：

```yaml
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-official     # ← 写死在这里，不是 agent-default-model
    model: deepseek-v4-flash
```

**教训**：配置没生效时，先 `--dump-config` 看合成结果，别靠猜插件 id。

### 11.3 最终改法（两条，按需）

**A. 用账号型 provider（已登录 DSH 即可，不额外花钱）**

```yaml
- id: acp
  name: '@deepseek-ai/dsh-acp'
  config:
    provider: deepseek-account
    model: deepseek-v4.1-flash
```

实测报错从 `no API key` 变成 **`Insufficient Balance`**——说明路由通了，卡在账号余额。

**B. 用本机已装的免费模型插件（本机最终采用）**

```bash
# ① 装进 acp profile（会把 bundle 一起加进 package.json）
"...\DeepSeek Harness.exe" --expose-internals "...\cli.js" plugin --profile acp add \
  "file:C:/Users/dfer5/.dsh/profiles/desktop/dsh-our-free-model-2.7.3.tgz"

# ② 改默认模型
- id: acp
  config:
    provider: our-free-model
    model: kilo-auto/free
```

两条路都固化成了脚本：`mobile-gateway/scripts/setup-acp-model.mjs`
（默认写 A；`--provider our-free-model --model kilo-auto/free` 写 B；`--dry-run` 只打印；
文件里已有配置时**拒绝覆盖**，只打印要手工合并的片段）。

### 11.4 实测结果（**第一次真正跑通**）

```
[e2e] 收到事件类型： hello, turn_start, text, turn_end
[e2e] 文本块数量： 1
[e2e] 拼起来： "收到"
[e2e] turn_end： ok:true, result:{stopReason:"end_turn", text:"收到"}, durationMs:2838
[e2e] ✅ 端到端通过
```

**连跑两次都通过**（2838ms / 2956ms）。这意味着：手机发消息 → 网关 → ACP → 模型 → 流式回包，
这条链的每一环都被真实验证过，不再是"单元测试全绿但没人跑过"。

### 11.5 对用户 DSH 安装做的改动（可回滚）

| 文件 | 改动 | 备份 |
| --- | --- | --- |
| `~/.dsh/profiles/acp/cordis.patch.yml` | 写入 `id: acp` 的模型覆盖 | `cordis.patch.yml.bak-20261030-213947` |
| `~/.dsh/profiles/acp/package.json` | 依赖 + bundles 加 `dsh-our-free-model` | `package.json.bak-*` |
| `~/.dsh/profiles/acp/node_modules/` | pnpm 从本机 tgz 装了一次（离线） | 删掉即可 |

**只影响 ACP profile，桌面端（`profiles/desktop`）一个字节都没动。**

---

## 12. 2026-10-30 22:37–22:50 真机第一步：装上了，但不知道地址和码

用户把 APK 装到红米 K80，**App 能启动**，但卡在「网关地址 / 6 位配对码填什么」——
因为电脑端网关根本没启动，而这两样只在网关窗口里打印。

### 12.1 排查出的三个拦路石

| 拦路石 | 实情 |
| --- | --- |
| **这台电脑没有系统 node** | `where node` 无结果；PATH 里的 node 是 WorkBuddy 自带的。让用户「命令行敲 node」必然失败 |
| **Windows 防火墙默认拦入站** | 三个 profile 都 Enabled、无任何放行规则 → 手机连 8788 会被拦 |
| **App 地址框会误标红** | 输入 `192.168.1.247:8788` 被判 `isError`（条件写成「不以 http 开头就错」），但实际会自动补 `http://` |

### 12.2 改了什么

| 改动 | 落点 |
| --- | --- |
| 新增双击启动器 | `mobile-gateway/start-gateway.bat`：自动找 node（PATH → `%ProgramFiles%\nodejs` → **DSH 自带运行时**），切 UTF-8 控制台，带 `--listen 0.0.0.0:8788 --pair` |
| 首次自动放行防火墙 | 脚本检测 `DSH-Mobile-Gateway-8788` 规则，缺失时用 UAC 提权添加（实测已添加成功）；失败则提示「右键 → 以管理员身份运行」 |
| 修地址框误标红 | `ChatScreen.kt`：只有含空格 / 没有冒号才算错；提示文案改成「会自动补 http://（也可以直接粘窗口里那行完整地址）」 |
| 帮助弹窗改成真实可执行的步骤 | 先「双击 start-gateway.bat」，命令行为备选 |
| APK 重打包 | `app-debug-0.1.0.apk`（17.5 MB） |

### 12.3 关于 .bat 的两个坑（记下来）

1. **编码**：UTF-8 的 .bat 在 cmd 里会被按 GBK 解析，中文注释直接让脚本崩（实测刷了一屏
   「不是内部或外部命令」）。→ 改成**纯 ASCII 的 .bat**，中文一律交给 node 打印。
2. **代码页冲突**：`chcp 936` 能让 .bat 里的中文正常，但 node 输出 UTF-8 会变乱码；
   `chcp 65001` 则相反。→ 结论就是 **.bat 只写 ASCII，`chcp 65001` 给 node 用**。

### 12.4 用户现在要做的三步

1. 双击 `surfcore\mobile-gateway\start-gateway.bat`（第一次弹 UAC 点「是」）。
2. 窗口里两行，直接抄进 App：
   `手机端「网关地址」填：http://192.168.1.247:8788`
   `配对码 ###### （5 分钟内有效）`
3. App 里点配对。窗口**不能关**，电脑**不能睡**。

> 注意：本会话里打印过好几次配对码（717842 / 244770 / 650750 …），**全部已失效**——
> 网关进程一退出码就作废，每次启动都会打印新的。

---

## 13. 2026-10-30 22:48–23:00 真机配对失败 = App 的致命 bug（网络全在主线程）

用户截图：地址 `http://192.168.1.247:8788` + 码 `650750`，提示「**配对失败：null**」。

### 13.1 先排除的两个可能

| 可能 | 判断 |
| --- | --- |
| 超过 5 分钟 | 那个 `650750` 确实是我自己测试进程打印的，进程一死就作废——**但不是本次主因** |
| 网关没开 | 查 `netstat` 确实没有 8788 监听——**但也不足以解释 `null`** |

关键线索是 **`null`**：如果只是连不上，`GatewayClient.callJson` 会捕获 `IOException` 并给出
「连不上网关（…）+ 确认同 Wi-Fi」；如果是码错，服务端会返回 `pair.*` 结构化错误。
两者都不该是 `null`。

### 13.2 真凶：`NetworkOnMainThreadException`

`ChatViewModel` 里 **9 处** `viewModelScope.launch { … }` 直接在里面调 OkHttp 的
**阻塞式 `execute()`**，全程没有 `withContext(Dispatchers.IO)`。
`viewModelScope` 默认跑在 `Dispatchers.Main`，Android 会在主线程做 socket 操作时抛
`NetworkOnMainThreadException` —— **这个异常的 message 就是 null**，于是落到
`catch (e: Exception)` 分支，界面显示「配对失败：null」。

也就是说：**旧 APK 在任何网络请求上都必然失败**，跟配对码、防火墙、时间窗口都无关。
之前一直只用 `e2e-smoke.mjs`（Node 侧）验证，App 侧从没跑过一轮真实请求，所以这个 bug
藏到了真机上才暴露。

### 13.3 修了什么

| 修复 | 落点 |
| --- | --- |
| 9 处网络协程改 `launch(Dispatchers.IO)`（配对/测试连接/载入会话/建会话/发消息/取消/审批/设置） | `ChatViewModel.kt` |
| 语音输入、TTS 两处**保持 Main**（`SpeechRecognizer` 与 `TextToSpeech` 需要主线程 Looper） | 同上，未改动 |
| 异常翻译不再出现 `null` | 新增 `describeException()`：message 为空时至少打类名 |
| 新增「测试连接（不需要配对码）」按钮 | 打 `/v1/health`，能当场区分「连不上」与「码错了」；成功用绿色、失败用红色 |
| 地址框误标红 | 判据改为「含空格 / 无冒号」才算错 |
| APK 重打包 | 17.5 MB |

### 13.4 结论（给用户的一句话）

**必须装新 APK**：旧的那版不可能配对成功，不是操作问题。
装好后先点「测试连接」——出现绿色的「连上了：网关 v0.1.0 / DSH 已连接」，
再填窗口里刚打印的 6 位码（5 分钟内点配对）。

---

## 14. 2026-10-30 23:02–23:10 真机通了：防火墙只放行了「专用网络」

装上新 APK 后点「测试连接」，报错变成人话了：

```
连不上网关（failed to connect to /192.168.1.247 (port 8788)
from /192.168.1.10 (port 40666) after 10000ms）
```

### 14.1 关键判据：`after 10000ms` = 超时，不是被拒绝

| 现象 | 含义 |
| --- | --- |
| `connection refused`（很快返回） | 端口没进程在听 → 网关没启动 |
| **`after 10000ms` / 超时** | 包被**静默丢弃** → 通常是防火墙 DROP，不是网关没开 |

### 14.2 真凶：网络类别是 Public，规则只放行 Private

```
Get-NetConnectionProfile → Name="网络 2" InterfaceAlias=以太网 NetworkCategory=Public
Get-NetFirewallRule DSH-Mobile-Gateway-8788 → Profile = Private
```

Windows 把这块以太网判成了「公用网络」（很常见），而之前脚本建规则时用的是
`profile=private` → 入站在 Public 配置下仍然被丢。手机同网段（192.168.1.10 → .247），
所以不是路由/Wi-Fi 问题。

修法：`netsh advfirewall firewall set rule name="DSH-Mobile-Gateway-8788" new profile=any enable=yes`
（需管理员，实测 exitcode=0）。启动脚本也改成建规则时就用 `profile=any`，
并在规则已存在时尝试放宽到 any。

### 14.3 用手机真机跑完整链（adb，绕开 App 界面）

手机插 USB、`adb devices` 授权后，用手机自带的 curl 直接打网关：

```bash
adb shell "curl -s -m 10 -X POST -H 'content-type: application/json' \
  -d '{\"code\":\"913789\",\"deviceName\":\"adb-verify\"}' http://192.168.1.247:8788/v1/pair"
# → {"ok":true,"deviceId":"dev-a1bfe561491c","token":"..."}

adb shell "curl -s -X POST -H 'authorization: Bearer <token>' -d '{}' .../v1/sessions"
# → sessionId=28dd210f-…

adb shell "curl -s -X POST -H 'authorization: Bearer <token>' \
  -d '{\"text\":\"只回复两个字：收到\"}' .../v1/sessions/<sid>/messages"

adb shell "curl -s -N -m 12 -H 'authorization: Bearer <token>' .../v1/sessions/<sid>/stream"
# → data: {"type":"hello",...}
# → data: {"type":"text","text":"收到"}
# → data: {"type":"turn_end","ok":true,"result":{"text":"收到"},"durationMs":2624}
```

**这是第一次在真机上把「配对 → 建会话 → 发消息 → 流式回包」全部走通**（2624ms）。
证明网关、防火墙、DSH、模型路由四段都没问题——剩下的只是 App 界面这一层。

### 14.4 注意（交接）

- 测试用的设备 `adb-verify`（`dev-a1bfe561491c`）留在 `devices.json` 里；没有吊销接口，
  想清掉就停网关后删 `~/.dsh/mobile-gateway/devices.json`。
- 配对码是一次性的：我给 App 另发了一个 `POST /v1/devices` 新码（需令牌），
  但**5 分钟有效**，过期只能重启网关重新打。
