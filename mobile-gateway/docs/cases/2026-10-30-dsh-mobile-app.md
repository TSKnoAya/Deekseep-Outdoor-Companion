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

---

## 15. 2026-10-30 23:09–23:20 真机配对成功后的两个问题

配对本身成功了（网关日志 `15:08:03 新设备配对成功：dev-0e21b2e4d633`），
但进对话页后发消息报：

```
DSH 返回错误：Invalid params: unknown session: 7a0b657f-3339-48db-9505-4c02cd886136
```

同时用户反馈：**底部输入框被系统三大金刚键挡住**。

### 15.1 `unknown session` 的来源

网关每次启动都会 `spawn` 一个**新的 DSH ACP 子进程**。`session/list` 能看到历史会话
（跨进程可见），但 `session/prompt` 只能用**当前进程**认识的会话。
而 App 启动时挑了 `sessions.first()` —— 正好是别的进程留下的死会话，于是第一次说话就炸。

两处修法：

| 位置 | 改动 |
| --- | --- |
| `loadSessionsAndConnect` | 只认「自己上次用过的那个」`lastSessionId`（且必须在列表里）；**没有就新建**，不再拿 `first()` |
| `send()` | 捕获 `unknown session` → 自动新建会话 → 用新会话重发一次（用户无感），并把旧消息保留 |

### 15.2 沉浸式全屏（用户明确要求）

`MainActivity.onCreate`：

```kotlin
WindowCompat.setDecorFitsSystemWindows(window, false)
WindowInsetsControllerCompat(window, window.decorView).apply {
    hide(WindowInsetsCompat.Type.systemBars())
    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
}
```

效果：进入 App 即隐藏状态栏与三大金刚键；底部上滑临时浮出，几秒后自动隐藏。
输入框原有 `imePadding() + navigationBarsPadding()` 保留，键盘弹出时仍会顶上去。

### 15.3 交付方式（这次没让用户手动装）

手机已插 USB 且 `adb` 已授权，直接：

```bash
adb -s fdcc8f0f install -r -d app-debug.apk   # → Success
adb shell am start -n com.dsh.mobile/.MainActivity
```

覆盖安装保留登录态（token 在 EncryptedSharedPreferences 里）。

> 踩坑记录：Git Bash 会把 `adb pull /sdcard/x.png` 的路径改写成 Windows 路径，
> 必须 `export MSYS_NO_PATHCONV=1`，否则报 `No such file or directory`。

### 15.4 第一版修法为什么会“没生效”

第一版把自愈写在 `send()` 的 `catch (GatewayException)` 里，**但那根本不是异常**：
`POST /v1/messages` 立刻返回 202，失败是**之后由 SSE 的 `turn_end` 事件**带回来的。
所以 catch 永远不触发，错误卡照旧显示。

正确位置：`handleEvent` 的 `StreamEvent.TurnEnd(ok=false)` 分支。改法：
- 判断 error 文本是否含 `unknown session` → 调 `recoverSession(最后一条用户消息)`；
- `recoverSession`：新建会话 → 更新 `currentSessionId` → `reconnectStream` →
  把刚才那条用户消息**直接重发**（不重复插入气泡）；
- 用 `recoveringSession` 防重入（SSE 可能连发多个失败事件）；
- 返回 true 表示已接管，调用方不再写错误卡。

**教训**：**异步协议的错误可能来自事件流而不是响应体**。判断「错误从哪来」比写重试更重要。

### 15.5 键盘弹出挡住输入框

用户第三次真机反馈。原因：`imePadding()` 加在了 **Scaffold 的内容 Column** 上，
但 Scaffold 的 `bottomBar`（输入栏）是单独贴屏幕底部绘制的 —— 内容缩了，输入栏不动，
于是被键盘压住。

修法：

```kotlin
Scaffold(
    modifier = Modifier.imePadding(),          // 整个 Scaffold（含 bottomBar）一起抬起
    contentWindowInsets = WindowInsets(0,0,0,0), // 避免与 topBar/bottomBar 的 inset 重复计算
    ...
)
```

- 内容 Column 去掉 `imePadding()`；
- `Composer` 的 Row 加 `navigationBarsPadding()`：沉浸式下导航栏平时隐藏（inset 0），
  上滑唤出时不压住输入框；
- 配对页 `PairingScreen` 也补 `imePadding()`（输配对码时同样会被键盘挡）。

**真机确认（23:23）**：用户手点输入框后反馈「键盘弹出后不会被挡了」→ 此项 ✅ 通过。

> 过程备注：小米 MIUI 默认禁止 `adb shell input tap`（`Injecting input events requires
> INJECT_EVENTS permission`），所以「弹键盘」这一步只能由用户手点，无法脚本化——这也说明
> 自动化验证到不了 UI 交互层，真机手测不可省。

---

## 16. 2026-10-30 23:31–00:10 做 DSH 插件：在设置里管网关/配对码/模型

用户要求：**换模型不该改代码**，并且要能在 **DSH 的设置界面**里改（顺带看网关状态和配对码）。

### 16.1 分两层：网关做实事，插件只做代理

| 层 | 做什么 | 为什么 |
| --- | --- | --- |
| 网关 `/admin/*`（**仅本机回环**） | 状态、发配对码、读/写 ACP 模型、重载 ACP | 配对码只活在网关内存里；换模型必须由「ACP 子进程的爹」重开进程才生效 |
| 插件 host（`/dsh-mobile-gateway/api/*`） | 把上面几个接口转给设置页 | 设置页在 DSH 的 web 界面里，同源 fetch 即可 |
| 插件 client | `settings.section` 插槽里加一页「手机网关」 | 用户可见的入口 |

> 没在插件里直接读文件/改配置：那样会和网关抢同一份状态（配对码在内存、ACP 进程归网关管）。

### 16.2 网关新增的管理接口

| 接口 | 说明 |
| --- | --- |
| `GET  /admin/status` | 版本、监听地址、DSH 是否连接、已配对设备数 |
| `POST /admin/pair` | 生成 6 位配对码（换手机/重装 App 用，不用重启窗口） |
| `GET  /admin/acp-model` | 当前 provider/model + 文件路径 |
| `PUT  /admin/acp-model` | 写 patch（**先备份**）→ 自动重开 ACP 子进程 → 返回 `reloaded` |
| `POST /admin/reload` | 手动重开 ACP |

安全：`pathname.startsWith('/admin/')` 时按 `req.socket.remoteAddress` 卡回环，
非本机直接 403。网关监听 `0.0.0.0`，这些接口能改模型，不能只靠"路径没人知道"。

### 16.3 模型读写的实现（`src/acp-model.js`）

- `readAcpModel(text)` / `withAcpModel(text, {provider, model})`：**只替换 `- id: acp` 那一段**，
  其它条目、注释、空行原样保留；
- 幂等：连写 5 次也只留一段（靠先删掉自己上次写的标记注释）；
- `saveAcpModel` 写前备份成 `cordis.patch.yml.bak-<ts>`；
- 拒绝带空格/换行的 provider/model（YAML 注入面）；
- `test/acp-model.test.js` 11 条钉住上述行为 → 全量 **125/125**。

### 16.4 插件结构（`mobile-gateway/dsh-plugin/`）

```
dsh-plugin/
├─ package.json        dsh.bundle.patch = [./cordis.patch.yml]；dsh.client.platform = web
├─ cordis.patch.yml    insert: { id: mobile-gateway, name: mobile-gateway }
└─ lib/
   ├─ index.js         host：webServer.register 4 条 exact 路由 + 回环校验 + 代理
   └─ client.js        client：__ModuleLoader__ + slots.register("settings.section")
```

安装（等价于 surfcore 的方式）：`dsh plugin --profile desktop add link:<绝对路径>`
—— 它同时把包名加进 `dsh.profile.bundles` 与 `dependencies`。

### 16.5 一个没验完的地方（诚实记录）

`desktop` profile 被 Electron 应用独占管理（`--dump-config` 直接拒绝：
`profile "desktop" is managed exclusively by the Electron application`），
而且**从这个工具里启动的 GUI 进程会随命令结束被回收**——所以「插件页面到底长什么样」
必须由用户手动打开 DSH 看。已验证的只有：host 半边的模块能被加载、
4 条路由都注册成功（用假 ctx 跑过）。

回滚：把 `~/.dsh/profiles/desktop/package.json` 换回
`package.json.bak-*`（去掉 `mobile-gateway` 依赖与 bundle），重启应用即回到原状。

### 16.6 第一版界面的两个问题（用户截图反馈）

| 问题 | 原因 | 修法 |
| --- | --- | --- |
| provider / model 输入框**溢出卡片** | `width:100%` + `padding` 而没有 `box-sizing:border-box` | 给 `input` 样式加 `boxSizing:'border-box'`；文件路径那行加 `wordBreak:'break-all'` + `maxWidth:60%` |
| **不知道该填什么**（只能靠猜字符串） | 第一版只有两个空输入框 | 新增 `GET /models`，从 DSH 的 `ctx.llm` 取真实清单，界面改成下拉 |

`GET /models` 的实现要点：

```js
const llm = ctx.get('llm');            // 懒取，不用 inject（拿不到就退回手动输入）
const providers = llm.listProviders(); // 已加载的适配器
await llm.listModels(providerId);      // 各自的型号
```

- 某个 provider 查模型失败**只标记不抛**（第三方路由半死不活是常态），不能让整张清单崩；
- 界面：有清单 → 两个 `<select>`（换 provider 时 model 自动落到它的第一个）；
  没清单 / 用户点「手动填写」→ 退回文本框；
- 依赖是懒取的：`ctx.get('llm')` 拿不到时只影响这一块，不会让整页挂掉。

### 16.7 顺带验证到的（这次能验了）

DSH 的 web 端口是**漂移的**（本次 5115，另外 8326/10290 属于别的服务）。
按进程号查出监听端口后 curl：

```
curl http://127.0.0.1:5115/dsh-mobile-gateway/api/status
→ {"ok":true,"running":true,"version":"0.1.0","listen":{"host":"0.0.0.0","port":8788},
   "dsh":{"connected":true,"name":"deepseek-harness-acp"},"devices":2}
```

**这证明「设置页 → 插件 host → 网关 → 真实状态」整条代理链是通的**，
不只是"页面能显示"。客户端 JS 的改动要重启 DSH 才加载。

### 16.8 用户反馈：界面上看不到「网关地址」

第一版 ① 只显示了 `监听 0.0.0.0:8788` —— 那是**网卡的"所有地址"**，不是手机该填的东西。
用户要的是「手机端填哪个 URL」。

修法：
- 网关 `/admin/status` 新增 `addresses`：`{loopbackOnly, list:[{ip,url,tailscale}]}`
  （`lanAddresses()` + `isTailscaleIp()` 复用启动横幅那套判断）；
- 界面 ① 里加一行「手机端『网关地址』填：`http://192.168.1.247:8788` [复制]」；
  Tailscale 地址会额外标注「外出也能用」；
- 回环监听时明确写「只监听了 127.0.0.1，手机连不上」+ 怎么改；
- 一个 IP 都没有时提示「先连 Wi-Fi/网线」；
- 「复制」用 `navigator.clipboard`，非 https 环境会失败——失败就退化成"请手动选中这行"。

实测：

```
curl /admin/status
→ addresses: {"loopbackOnly":false,"list":[{"ip":"192.168.1.247",
   "url":"http://192.168.1.247:8788","tailscale":false}]}
```

---

## 17. 2026-10-31 01:00–01:25 P1 落地：把鱼带到手机（只读注入）+ 深海皮肤

### 17.1 注入链路（网关侧，手机端零改动）

```
手机发消息 → 网关 handlePrompt
            → fish.prepare(sessionId)  ── 读 persona.md + memory-card-prompt-qq.md
            → 前缀 + "\n\n---\n\n" + 用户原话 → ACP prompt
            → 本轮成功 → fish.commit(sessionId)
```

| 文件 | 作用 |
| --- | --- |
| `src/fish-context.js` | 定位角色文件（`resolveFishFiles`）、算签名（`fishSignature`）、拼前言（`buildFishContext`） |
| `src/fish-inject.js` | 决定**这一轮要不要拼**、拼几次、什么时候 forget（纯逻辑，9 条单测） |

**关键设计：不是每轮都拼。** ACP 会话会保存历史，第一轮注入的前言一直留在上下文里；
每轮再拼一遍等于把同一段话重复 N 遍，既烧 token，也会让模型把它当"反复叮嘱"，
越说越像在念设定。所以：第一轮注入 → 记忆文件变了再注入 → 最多 4 次封顶。

前缀**只发给 DSH**，不进手机气泡（手机显示的是自己发的那句），用户看不到设定文本。

### 17.2 实测（真跑，不是单测）

```
[17:08:38] 已注入角色上下文（first）：傲娇助手        ← 人格 196 字 + 记忆 448 字
[17:09:19] 已注入角色上下文（memory-changed）：傲娇助手

问：你还记得我们昨天在群里聊过什么吗？
答：哼…有人非要让我叫他爸爸来着。辈分是这么占的？想得美。
```

回答里的「有人非要让我叫他爸爸」**只存在于 memory-card-prompt-qq.md**，
说明记忆确实进了上下文；语气（"哼…"）也对得上人格卡。

### 17.3 一个重要发现：手机对话本来就会进记忆

第二次注入的触发原因是 `memory-changed`——因为**这一轮手机对话已经被 SurfCore 写进了记忆卡**
（`memory-card-full.md` / `memory-card-prompt-qq.md` 的 mtime 都变成 01:08:54）。
也就是说 **P2（回写）不需要网关做任何事**：SurfCore 自己的管线已经在记。
网关只读、不写，单一写入者原则天然成立。

副作用要记住：手机每聊一轮，记忆就变一次 → 会持续触发重新注入，直到 4 次封顶。
所以长会话里注入开销是**有界的**（最多 4 × ~650 字）。

### 17.4 已验证 / 未验证

| 项 | 状态 |
| --- | --- |
| `/admin/persona` 读到角色（傲娇助手，人格 196 + 记忆 448 字） | ✅ |
| 首轮注入、回答引用记忆里的具体事件 | ✅ |
| 第二轮不重复注入（`already`）、记忆变化时再注入（`memory-changed`） | ✅ |
| 关掉开关后不再注入（对新会话彻底生效；当前会话历史里的删不掉） | ✅ |
| 注入内容污染记忆卡 | ✅ 无（grep 前言特征词，三个文件都是 0 命中） |
| 设置页 ④ 卡片 | ⏳ 需重启 DSH 才能看到 |
| 手机端实际观感 | ⏳ 手机锁屏，截图全黑，需用户看一眼 |

### 17.5 皮肤：深海女仆工坊（暗色）

素材来自本机已装的 DSH 皮肤 `@smalltailqwq/dsh-client-ui-skin-maid-atelier`（7.24MB，49 个文件）。

| 用途 | 原素材 | 处理后 |
| --- | --- | --- |
| 聊天背景 | 暗色宫殿 1586×992 | 1080×2340 覆盖裁切 + 高斯模糊 6 + 压暗 0.62 + 上下渐变 → `skin_bg.webp`（19KB） |
| 空状态吉祥物 | 大立绘 1394×2649 | 高 1000、保留 alpha → `skin_mascot.webp` |
| 空状态 Q 版 | 512×512 头像 | 360×360 → `skin_chibi.webp` |
| 顶栏徽章 | 鲸鱼盾牌 230×320 | 高 132 → `skin_emblem.webp` |

代码只有一个新文件 `ui/Skin.kt`（调色板 + `SkinBackdrop`），以及三处极小改动：
`MainActivity` 换配色与背景层、`ChatScreen` 的 Scaffold 透明化 / 气泡圆角与金边 / 空状态换 Q 版。

**一键回退**：把 `Skin.ENABLED` 改成 `false`，背景图、气泡色、Q 版一起退回原样式。

> ⚠️ 许可：代码 MIT，**美术 CC BY-NC-SA 4.0（禁止商用、必须署名、改动需同许可）**。
> 署名链：角色原作 上善（Pixiv / B 站 上善无形）→ 女仆鲸鱼娘二创 ZipZipPipe → 皮肤作者 Small-tailqwq。
> 自己用没问题；一旦要打包分发（尤其收费）必须先看 `LICENSE-ARTWORK`。

### 17.6 本轮踩到的两个工具坑

1. **`curl` 走了系统代理**：打 `127.0.0.1:8797` 返回 `502 upstream connect failed`（代理在 13306）。
   本机回环调试必须 `curl --noproxy '*'`。
2. **手机锁屏时 `screencap` 全黑**，`mCurrentFocus=NotificationShade` 就是锁屏。
   MIUI 又不许 `adb shell input tap`（INJECT_EVENTS），所以"解锁看皮肤"只能由用户做。

### 17.7 真机反馈：气泡文字是黑的（01:37）

截图里 DSH 的回复几乎看不清——深蓝底 + 黑字。

**根因**：皮肤版把 `MainActivity` 的 `Surface` 换成了 `SkinBackdrop`。`Surface` 不只是铺底色，
它还负责提供 `LocalContentColor`；去掉之后根组合的 `LocalContentColor` 退回 `Color.Black`。
`Card` 的自定义 `containerColor` 又推不出对应的 `onXxx` 色（`contentColorFor` 返回 Unspecified），
于是气泡文字继承了黑色。

修法两处（都要，缺一不可）：
- 根组合：`CompositionLocalProvider(LocalContentColor provides Skin.Ink)`；
- 气泡：`CardDefaults.cardColors(containerColor = ..., contentColor = Skin.Ink)`。

顺带把 `BubbleBot` 从 `0xCC102033` 提到 `0xE6162A42`，深色背景上对比更稳。

> 教训：**换掉 `Surface` 等于同时换掉了文字默认色**。以后凡是"透明化根容器"的改动，
> 都要显式给出 `LocalContentColor`，否则整个界面会退成黑字。

### 17.8 开源署名（准备挂 GitHub，不收费）

新增 `THIRD_PARTY_NOTICES.md`：上游仓库、用到的四个文件、CC BY-NC-SA 4.0 的边界、
以及"想彻底摆脱限制就替换这四个图或关掉 `Skin.ENABLED`"的两条路径。
设置弹窗底部也加了一行署名 —— 许可要求**署名在分发物内可见**，只写在仓库里不够。

---

## 18. 2026-10-31 01:46–01:55 会话列表：让「＋」不再是单向门

用户问「右上角的 + 是干什么的」，一查发现是个体验坑：`＋` 只是新建会话，
但 App **没有任何地方能看历史会话**，点完就再也回不去（对话还在 DSH 里，只是手机上找不到）。

### 18.1 网关：给 `/v1/sessions` 补标题与时间

ACP 的 `session/list` 只给 `{ sessionId, cwd }`，手机上就是一串 uuid。新增 `src/session-meta.js`：

| 步骤 | 说明 |
| --- | --- |
| 定位文件 | 扫 `~/.dsh/sessions/*/`，两种目录命名都认：桌面端 `session-<id>/`、**ACP 端 `<id>/`** |
| 读元数据 | `session.v4.jsonl.zstd` 的 mtime = 最后活动时间；首条 `user/message` = 标题 |
| 缓存 | 按「路径 + mtime + size」，没改过的会话不重复解压 |
| 兜底 | 超过 16MB 不解压、单帧坏了跳过 → 只丢标题，不影响列表 |

### 18.2 三个必须踩过才知道的坑

1. **zstd 是多帧的**。DSH 追加写：每批一个 frame。`zlib.zstdDecompressSync` **只解第一帧**
   （实测整段只回来 237 个字符），必须按魔数 `28 B5 2F FD` 切开逐帧解再拼。
2. **标题被我们自己的前言污染**。手机会话第一条 `user/message` 是人格卡+记忆卡，
   DSH 拿它自动生成 `session/title` → 标题变成「【你是下面这个角色，请一直」。
   解法：`cleanUserText()` 先按 `\n\n---\n\n` 取用户原话；`【…】`/`<system-reminder>`/
   `Current …` 开头的一律判为"不是人说的话"，丢弃后回落到用户消息。
3. **`textOf` 里的 `slice(0,400)`**：前言动辄 700+ 字，分隔符被截掉，标题永远是前言。
   已去掉截断（文件大小本来就有上限）。

额外一条：记忆卡是 CRLF 存的，拼出来的分隔符会变成 `\r\n\r\n---\r\n\r\n`，
`cleanUserText` 必须先归一换行。

### 18.3 App：标题可点 → 会话列表

- 顶栏标题加 `▾`，点开 `DropdownMenu`：`＋ 新对话` + 最近 15 个会话；
- 每项显示「标题 · 多久之前」，当前那个标「当前」；点了就 `openSession()`；
- 新增 `vm.refreshSessions()`（只拉列表，不切会话、不重连 SSE）。

### 18.4 实测输出

```
10-31 01:44 | 现在是这个app的测试对话       | c43fead8
10-31 01:35 | 哪条鱼？                      | eecf521a
10-31 01:11 | 你还记得我们昨天在群里聊过…   | deac4bf6
```

单测 159/159（session-meta 16 条，含多帧/污染/长前言三条回归）。
**UI 未在真机确认**：手机锁屏，`screencap` 全黑。

---

## 19. 2026-10-31 03:45–03:55 手机上要不要连「大肥鱼」：做成可持久化的开关

用户的问题：本地在用 SurfCore 那条鱼，手机上是不是不该也连它。

### 19.1 先说结论（有实测支撑）

| 项 | 结论 |
| --- | --- |
| 能不能关 | 能。`PUT /admin/persona {enabled:false}`，或 DSH 设置 → 手机网关 → ④ 关闭 |
| 关了会不会还写记忆 | **实测：不写**。关闭后发一条「只回复两个字：收到」，`memory-card-*.md` 的 mtime 一动不动（03:41:12 → 03:41:12），网关日志 `已注入角色上下文` 计数为 0 |
| 开着时会不会写 | 会。01:08 那次手机对话把回复写进了 `memory-card-full.md`（mtime 01:08:54） |
| 关了之后旧会话 | **历史里删不掉**。当前会话已经注入过的前言还在上下文里，要新开会话才彻底干净 |

> 保留一句诚实：只观察了 3 秒。若 SurfCore 是批量/延迟落盘，可能更晚才写——
> 但至少不像开着时那样"当场就写"。

### 19.2 以前开关为什么"看起来没生效"

原来只存在内存里：`setEnabled(false)` 之后**重启网关就回到默认开**，
用户会以为开关是假的。现在：

- `src/config.js` 新增 `saveStartupConfigPatch()`：合并写 `~/.dsh/mobile-gateway/config.json`，
  只动 `personaEnabled`，用户手写的 `dshInstall` / `listen` 原样保留；
- `fish-inject` 的 `setEnabled(next, { persist })` 支持回调落盘（测试注入用 `persist:false` 只改内存）；
- 优先级：`DSH_MOBILE_PERSONA` 环境变量 > `config.json.personaEnabled` > 默认开。

实测 config.json 现在长这样：

```json
{ "dshInstall": "D://deepseek", "listen": "0.0.0.0:8788", "personaEnabled": false }
```

### 19.3 为什么这个取舍是对的（给将来的自己）

- 手机上"带鱼"意味着两处对话写进同一张记忆卡，而**手机没有群聊上下文**，
  它会把群里才成立的梗当私聊说；
- 用户本地已经在喂鱼（QQ/桌宠），手机再喂一遍会让记忆分布失真；
- 真要做"带出门"，正确形态不是"共用一张卡"，而是**手机一条独立分支 + 定期摘要合并**。
  那是 P2 的升级版，等桌面侧稳定了再说。

单测 161/161（新增 2 条：落盘回调、`persist:false` 只改内存）。

## 20. 2026-10-31 19:10 扫码配对：把「地址 + 码」塞进一张二维码

### 20.1 用户原话

> 「保留现在的手动输入配对，额外增加扫码配对」

### 20.2 链路

```
电脑 DSH 设置页（dsh-plugin/lib/client.js ②卡片）
  → POST /dsh-mobile-gateway/api/pair（插件代理，仅本机）
  → POST 127.0.0.1:8788/admin/pair（网关，仅回环）
      → devices.issuePairCode()      一次性 6 位码，5 分钟 / 5 次
      → admin.addresses()            本机真实 IPv4（含 Tailscale 段）
      → src/pair-qr.js               dshmobile://pair?v=1&u=…&c=…
                                     → qrMatrix()（vendor qrcode-generator，M 级，37×37）
  → 返回 { code, expiresAt, urls:[{url, payload, qr:{size, rows}}], warn? }
  → 设置页用内联 SVG 画出二维码（不加载任何外部资源）

手机 DSH App 配对页
  → 「扫码配对」→ ui/QrScanScreen.kt（CameraX 预览 + ZXing 解码）
  → pair/PairPayload.kt 解析（与网关同一份格式）
  → ChatViewModel.pairFromScan() → 现有 pair() → POST /v1/pair（手动配对同一条路）

备选入口：系统相机/微信扫到 dshmobile://pair?... → 点链接 → MainActivity 深链 → 同一个 pairFromScan()
（`autoPair=false`：只填字段，不自动连）
```

谁在读这些接口/文件（`grep` 结果）：

| 对象 | 读者 |
| --- | --- |
| `POST /admin/pair` | `dsh-plugin/lib/index.js`（代理）+ `test/server.test.js` |
| `src/pair-qr.js` | `src/server.js`、`test/pair-qr.test.js`、`test/server.test.js` |
| 载荷格式 | 网关 `parsePairPayload`、Android `PairPayloadParser`（两处实现，必须同步改） |

### 20.3 机制：为什么这样切

1. **二维码内容不是「一个网址」，而是「地址 + 一次性码」**。
   只放地址的话，用户还得再手输 6 位码——痛点没消失。码本身 5 分钟过期、只成功一次
   （`devices.pair()` 用定长比较 + 限次），所以二维码泄了也只是一次可用的临时凭证。
2. **网关只出矩阵，不出图片**。DSH 设置页是 web，`<img src="data:image/svg+xml,...">`
   可能被 CSP 拦；把 37×37 的 `0/1` 矩阵交给前端画成内联 `<svg><path>`，
   既不依赖外链，也不受深色主题影响（二维码必须有白底/黑码）。
3. **编码库用 vendor 而不是自己写**。QR 编码（GF(256) 纠错、掩码、版本表）手写一处错就整张废掉，
   而且没有解码器时根本看不出来。选用单文件 MIT 的 `qrcode-generator`（56KB），
   并用 jsQR 独立解码验证过（见 20.7）。
   ⚠️ 本包是 `"type": "module"`，该库是 UMD：**文件必须叫 `.cjs`**，改成 `.js`
   Node 会当 ESM，`module.exports` 分支不执行，`import` 直接报「没有 default 导出」。
4. **手机端不用 GMS / ML Kit**。国行红米 K80 没有 Google Play 服务，
   `GmsBarcodeScanner` 那套扫码页打不开；ML Kit bundled 能离线但要再带 2.4MB Google 依赖。
   ZXing core 是纯 Java（约 500KB），随 APK 走，不依赖系统服务。
5. **解码链路有两个必踩的点**：
   - `ImageProxy.image.planes[0]` 是 Y 平面，但 `rowStride` 通常大于宽度（有对齐填充），
     按 `width` 直读会整帧歪斜 → 永远解不出；必须按 `rowStride` 读、按 `pixelStride` 取样。
   - 传感器输出默认横向（`rotationDegrees=90`），竖屏时不旋转就永远扫不到 → 先转正再交给 ZXing。
6. **深链只认 `dshmobile://pair`**：别的 scheme/host 一律忽略；解析失败时明确告诉用户
   「这不是配对二维码」，不会拿乱码去当网关地址发请求。
7. **深链不自动配对**：任何网页/别人发的链接都能写 `dshmobile://pair?...`，自动连过去等于
   让别人替你选网关（可做成假主机骗你说话）。所以深链只把地址和码填进输入框，
   由用户看清地址后自己点「配对」；App 内扫码是用户主动对准自己电脑，才自动配对。

### 20.4 爆炸半径

| 维度 | 情况 |
| --- | --- |
| 进程 | 3 个：DSH 主进程（设置页插件，web）、网关（Node）、手机 App |
| 读者 | `/admin/pair` 2 个读者；载荷格式 2 份实现 |
| 静默性 | 二维码画错/扫不出来 = 静默失败（扫码器没反馈）→ 用独立解码器验证 + 界面显式失败路径压到最低 |
| 用户数据 | 不碰会话/记忆/令牌；二维码里只有一次性配对码（5 分钟、1 次），不落盘、不出本机 |
| 权限 | App 新增 CAMERA（仅扫码页使用）；APK 17.9MB → 20.7MB（+2.8MB，CameraX + ZXing） |

### 20.5 取舍（至少两条路）

| 方案 | 收益 | 成本 / 风险 | 结论 |
| --- | --- | --- | --- |
| 插件侧直接 `require` 一个 QR 库 | 网关零改动 | DSH 的模块加载器不解析相对路径/裸包，装不进去；改 client.js 包结构风险大 | ❌ |
| 网关返回 data URL 图片（SVG/PNG） | 前端一行 `<img>` | CSP 可能拦 data:；PNG 还要带编码器 | ❌ |
| **网关出矩阵 + 前端内联 SVG** | 无 CSP、无外部资源、可测试 | 前端多 ~30 行画图 | ✅ |
| 终端打印 ASCII 二维码 | 不依赖 DSH 设置页 | cmd 默认位图字体渲染不稳；插件页已够用 | ⏸ 未做 |
| GMS Code Scanner / ML Kit | 代码最少 | 国行无 GMS；ML Kit 再 +2.4MB | ❌ |
| **CameraX + ZXing core** | 无 GMS、离线、体积小 | 自己写 YUV/旋转（约 100 行） | ✅ |

编码器：手写 vs vendor —— 选 vendor（正确性风险远大于 56KB 体积收益）；
用 jsQR 独立解码验证，并在测试里钉住矩阵哈希。

### 20.6 生效与重启

| 改了什么 | 谁读 | 要重启什么 |
| --- | --- | --- |
| `src/pair-qr.js`、`src/server.js`、`src/vendor/*` | 网关进程 | **网关**（start-gateway.bat 那个窗口） |
| `dsh-plugin/lib/client.js`、`lib/index.js` | DSH 设置页 | **DSH**（插件页面代码是启动时加载的） |
| Android 代码/清单/依赖 | 手机 | 重新 `assembleDebug` + `adb install -r -d` |

### 20.7 验证

自动化：

```bash
# 网关 + 载荷/矩阵
node test/run-all.js
# → tests 171 / pass 171 / fail 0（新增 pair-qr 8 条 + server 2 条）

# Android 解析器
cd android && gradle testDebugUnitTest
# → PairPayloadTest：tests=5 failures=0

# APK
gradle assembleDebug
# → BUILD SUCCESSFUL；app-debug.apk 20,696,951 字节
```

独立解码验证（不依赖本项目代码判断对错）：

- 用 jsQR 1.4.0 把 `qrMatrix()` 输出光栅化后解码 → 4 个纠错等级全部还原出同一载荷；
- 用同样方法**复刻插件里的 `qrSvg()` 路径算法**（M/h/v 指令）再解码 → 通过
  （370 段路径），说明「矩阵 → 内联 SVG」这一步没有坐标错位。

未验证（老实写）：

- 真机摄像头对准电脑屏幕的实际扫码成功率（需要人拿着手机扫，自动化做不到）；
- HyperOS 系统相机/微信对 `dshmobile://` 深链的「打开 App」弹窗行为；
- 设置页多地址（以太网 + Tailscale）切换的实际观感。

### 20.8 失败路径（用户看到什么 + 下一步）

| 场景 | 用户看到 | 断言/出处 |
| --- | --- | --- |
| 网关只监听回环 | ②卡片黄色提示「只监听了 127.0.0.1，手机扫了也连不上」+「用 start-gateway.bat…」 | `warn.code=pair.loopback-only`（server 测试） |
| 没有局域网地址 | 「没检测到局域网地址…先连 Wi-Fi/网线」 | `warn.code=pair.no-lan-address` |
| 二维码生成异常 | 「二维码生成失败：…」+「手动填地址和这 6 位码」 | `warn.code=pair.qr-failed` |
| 扫到普通二维码 | 「这不是配对二维码」+「重扫或手动填写」 | `PairPayloadParser.parse()=null` → banner |
| 扫到只有地址的链接 | 「扫到了网关地址，还缺配对码」+「扫带码的那一张」 | `code=null` → banner |
| 从外部深链进来 | 填好地址与码 + 「已从链接填入配对信息」+「确认地址是你的电脑再点配对」 | `autoPair=false`，不自动连 |
| 相机权限被拒 | 全屏说明 +「允许使用相机」/「去系统设置」/「先手动输入」 | QrScanScreen 权限块 |
| 相机打不开/被占用 | 错误原文 +「先关掉别的相机应用，再点重试」+ 重试按钮 | `onCameraError` |
| 配对码过期 | 网关原有 `pair.code-expired` + hint 指向「重新生成」 | 既有测试 |

### 20.9 回滚与残余

- **网关/插件**：回退 `src/server.js` 的 `handleAdminPair`、删除 `src/pair-qr.js` + `src/vendor/`；
  插件 ② 卡片回退到只显示 6 位码。手动配对完全没动，回滚不影响任何既有用法。
- **App**：回退 `QrScanScreen.kt`、`pair/`、`ChatViewModel.pairFromScan`、Manifest 的 CAMERA 与
  intent-filter、build.gradle 三个 CameraX 依赖 + zxing。首启页面只剩手动输入，行为与 0.1.0 一致。
- **残余**：APK 体积 +2.8MB；清单多了 CAMERA 权限（安装页会显示「相机」），
  `THIRD_PARTY_NOTICES.md` 已补 qrcode-generator / ZXing / CameraX 的许可说明。

## 21. 2026-10-31 19:45–20:05 设置页一键启动网关（不用 bat、不用命令行）

### 21.1 用户原话

> 「需要一个不依赖改代码就能拉起网关的按钮」

背景：DSH 设置页里显示「网关状态：关闭」，因为网关是独立进程，用户得自己去双击 `start-gateway.bat`。

### 21.2 链路

```
设置页 ① 卡片「启动网关」
  → POST /dsh-mobile-gateway/api/start（插件代理，仅本机回环）
  → dsh-plugin/lib/index.js  route('POST', '/start')
  → dsh-plugin/lib/gateway-process.js  startGateway()
      → findNode()：DSH 自带 node → %LOCALAPPDATA% 安装目录 → 系统 node → Electron 兜底
      → spawn(node, ['src/main.js', '--listen', '0.0.0.0:8788', '--pair'])
         cwd=仓库目录，stdout/stderr → <DSH_HOME>/mobile-gateway/gateway.log
      → 每 300ms 探 /v1/health，最多 12 秒
  → 返回 { started, pid, port, log }，前端刷新状态
「停止网关」→ POST /api/stop → taskkill /pid <pid> /T /F（连 DSH/ACP 子进程一起收）
DSH 退出 → ctx.effect 清理里 stopGateway()（只停按钮启动的那个）
```

谁读这些接口：设置页 `dsh-plugin/lib/client.js`；`test/gateway-process.test.js`。

### 21.3 机制

1. **为什么参数写死 `--listen 0.0.0.0:8788 --pair`**：与 `start-gateway.bat` 完全一致，
   避免「bat 能起、按钮不能起」；`--pair` 让新设备有码可用，已有设备令牌不受影响。
2. **为什么优先 DSH 自带 node**：DSH 主进程的 `process.execPath` 是 **Electron 的 exe**，
   `spawn(execPath, ['src/main.js'])` 会把它当应用参数，起不来。
   顺序：`DSH_MOBILE_NODE` 环境变量 → `process.resourcesPath/runtime/primary-runtime/dependencies/node/bin/node.exe`
   → `%LOCALAPPDATA%\Programs\DeepSeek Harness\...` → `%ProgramFiles%\nodejs` → `execPath`（本身就是 node 时）
   → 最后才用 Electron 加 `ELECTRON_RUN_AS_NODE=1`。
3. **启动成功的判据是 HTTP 起来**，不是 DSH 连上：`/v1/health` 一响应就返回；
   DSH/ACP 的连接状态在 ① 卡片里单独显示（本来就有）。
4. **停止必须杀进程树**：Windows 上 `child.kill()` 只杀网关本身，它 spawn 的 DSH(ACP)
   会留下来继续吃内存/占模型。用 `taskkill /T /F`。
5. **生命周期跟 DSH 走**：按钮启动的网关在 DSH 退出/插件重载时被停止，
   避免出现「没有窗口、界面上也停不掉」的隐藏进程；想让它脱离 DSH 常驻，用 bat（界面会明确说明）。

### 21.4 爆炸半径

3 个进程（设置页 / DSH 宿主 / 网关+ACP）；写 `~/.dsh/mobile-gateway/gateway.log`（追加）；
不碰会话/记忆/令牌；`/admin/*` 仍是回环限定，`/start` 也只在插件代理里接受本机来源。
最坏情况：端口被占 → 启动失败并显示日志尾部，不会静默。

### 21.5 取舍

| 方案 | 收益 | 代价 | 结论 |
| --- | --- | --- | --- |
| 让用户继续双击 bat | 零代码 | 就是这次要解决的痛点 | ❌ |
| 插件 `spawn('cmd', ['/c','start-gateway.bat'])` | 复用 bat 的防火墙逻辑 | 会弹一个黑窗口、`pause` 会挂住、退出码拿不到 | ❌ |
| **插件直接 spawn node + main.js** | 无窗口、可等待、可停止、日志可读 | 自己维护 node 探测与进程树 | ✅ |
| DSH 启动时自动拉起 | 更省一步 | 用户可能只想用桌面端；端口/权限副作用不该自动发生 | ❌（先做按钮） |
| 停止用 `child.kill()` | 简单 | ACP 子进程漏掉 | ❌ |
| **`taskkill /T /F`** | 收干净 | Windows 专属分支 | ✅ |

### 21.6 生效与重启

改的是插件宿主代码（`dsh-plugin/lib/index.js`、新增 `gateway-process.js`）+ 设置页前端
（`client.js`），**都需要重启 DSH** 才加载。

### 21.7 验证

- `node test/run-all.js` → **174/174**（新增 `gateway-process` 3 条：node 探测顺序、
  真起假网关→重复启动→停止、秒退失败必须带 `code/hint` 与日志尾部）。
- 真实链路（用真 `main.js`，端口 8791）：3.25 秒内 HTTP up → `/v1/health` ok →
  `stopGateway()` 后端口释放（探活为 down）。
- 未验证：DSH 设置页里点按钮（需要重启 DSH 后在界面上手点）；
  Electron 兜底路径（本机有 DSH 自带 node，走不到 `ELECTRON_RUN_AS_NODE`）。

### 21.8 失败路径

| 场景 | 用户看到 | 断言/出处 |
| --- | --- | --- |
| 8788 被占用 / 进程秒退 | 红块：`网关没起来：进程退出（code=1 …）` + 日志最后几行 + 日志路径 + 常见原因 | `gateway.start-failed`（单测断言 hint 含日志） |
| 12 秒没监听 | 同上，reason=启动超时 | 同上 |
| 找不到 node | 红块：`没找到可用的 node.exe` + 「装 Node 22+ 或设 DSH_MOBILE_NODE」 | `gateway.node-missing` |
| 找不到网关源码 | 红块 + 「插件和网关要放同一目录」 | `request.not-found` |
| 网关是 bat 起的，点停止 | 红块：「这个网关不是从 DSH 启动的」+「关掉那个窗口」 | `gateway.not-managed` |
| 宿主是旧版（没重启 DSH） | 红块：「DSH 还在运行旧版插件（缺少启动接口，HTTP 405）」+「完全退出 DSH 再打开」 | `isStaleHost()` 识别 405 / 「方法不对」 |

### 21.9 回滚与残余

回滚：删 `gateway-process.js`、`index.js` 的 import 与 4 个路由改动、`client.js` 的
启动/停止按钮与两个 handler，恢复旧版 ① 卡片文案；删测试文件与 `run-all.js` 一行。
残余：`gateway.log` 会持续追加（每次点击都写一行启动头）——想清理由用户手动删。

## 22. 2026-10-31 20:05 扫码页误报「相机打不开」：Compose 取消异常被当成故障

### 22.1 现象

真机点「扫码配对」→ 界面红字：`相机打不开：The coroutine scope left the composition`，
下方提示「关掉别的用相机的应用」，但当时只开了本 App。

### 22.2 根因（不是相机）

`The coroutine scope left the composition` 是 Compose 的
`LeftCompositionCancellationException`，只在 `LaunchedEffect` 被取消时抛出。

1. `QrScanScreen` 用 `LaunchedEffect(previewView, key)`，`previewView` 是 `mutableStateOf`，
   由 `AndroidView(factory)` 在组合期写入；
2. effect 在 apply 阶段执行时，读到的 `previewView` 已经是新值 → 真的进入相机绑定并挂起；
3. 状态写入触发重组，key 变化 → 旧 effect 被取消 → 挂起处抛出取消异常；
4. `catch (e: Exception)` 把取消异常当业务错误显示出来（UI 上就成了「相机打不开」）。

### 22.3 修法

- PreviewView 改为 `AtomicReference` 持有（工厂写 ref 不触发重组），`LaunchedEffect(key)` 只用重试计数；
- 通用 catch 之前先 `catch (e: CancellationException) { throw e }`；
- 真异常加 `Log.e("QrScanScreen", "camera bind failed", e)`，便于 logcat 抓栈。

### 22.4 验证

- `gradle assembleDebug` 成功；dex 里有 `camera bind failed` 字符串（确认装的是新包）；
- 已 `adb install -r -d` 到红米 K80；
- **待用户实测**：点「扫码配对」应直接出现取景画面。
- 回滚：还原 `QrScanScreen.kt` 的 CameraPreview 段即可，其他不受影响。

## 23. 2026-10-31 20:10 手机独立选鱼：本地多条鱼时，手机用哪条

### 23.1 用户原话

> 「这部分，是当本地有多条鱼，可以选择手机上是哪条鱼，的意思吗？」
> （原实现不是选择器，只读桌面当前角色）→「做」

### 23.2 语义

| 选择 | 行为 |
| --- | --- |
| 未选（默认） | **跟随桌面当前角色**：`characters/current.json` 指向谁，手机就用谁 |
| 固定某条 | 无论桌面切到哪条，手机始终用这条（`config.json.personaCharacterId`） |
| 固定的角色被删了 | 回退到桌面当前角色，状态里 `selectionMissing:true`，界面黄字提示重选 |
| 切换之后 | **下一条消息**立即换人（强制重新注入，不受每会话 4 次上限限制）；旧会话上下文里仍是原角色，建议新开会话 |

### 23.3 链路

```
设置页 ④ 卡片 <select>（只有 >1 条鱼时出现）
  → PUT /dsh-mobile-gateway/api/persona {characterId}   （插件代理，仅本机）
  → PUT /admin/persona                                  （网关，仅回环）
      → fish.setCharacter(id) → selectedId，落盘 config.json.personaCharacterId
  → 状态返回 characters/selectedId/followingDesktop/selectionMissing

每轮发消息：
  server.handlePrompt → fish.prepare(sessionId)
      → buildFishContext({ characterId: selectedId })   ← 空 = 跟随 current.json
      → 角色变了 → prefix「【角色已经换成「X」…】」+ 新人设+记忆
```

代码：`fish-context.js` 的 `listCharacters()` / `resolveFishFiles({characterId})`、
`fish-inject.js` 的 `selectedId` / `character-switched`、`server.js` 的 `handleAdminPutPersona`、
`dsh-plugin/lib/client.js` 的下拉框。

### 23.4 机制与取舍

- **为什么默认跟随而不是默认固定第一条**：大多数时候手机就是"出门时的那条鱼"，
  跟着桌面走才符合直觉；只有用户显式选过才固定。
- **为什么用 `index.json` 而不是扫目录**：名字、更新时间都在里面（SurfCore 自己维护）；
  扫目录只是 `index.json` 缺失时的兜底。
- **指定角色找不到时为什么不猜目录**：猜错等于把另一条鱼的记忆灌进去，比不做更糟；
  所以退回桌面当前角色并显式标记。
- **为什么换角色不受注入次数上限限制**：上限是为了防止"记忆更新"频繁重灌；
  换角色是用户的显式动作，上下文里还是旧人格时必须说清楚，否则模型会继续演错人。
- **为什么状态要带 `characters` 列表**：设置页下拉需要；网关本来就只能读，不额外写 SurfCore。

### 23.5 爆炸半径

网关内存里多一个 `selectedId` 与会话记账（`characterId`）；只写 `config.json` 的一个键
（`personaCharacterId`）；不写 SurfCore 的任何文件；不新增端口/权限。

### 23.6 生效与重启

- 网关代码：**重启网关**（按钮「停止 → 启动」或 bat）。
- 设置页下拉：**重启 DSH**（宿主与前端都改了）。
- 已注入过的旧会话：切角色只影响后续消息的前缀，旧上下文里仍有原角色；**新开会话**才彻底干净。

### 23.7 验证

- `node test/run-all.js` → **187/187**（新增：角色列表、指定角色读取、缺失回退、签名随角色变化、
  切角色强制重注入、setCharacter 落盘/内存、/admin/persona 四个契约用例）。
- 真实 SurfCore 数据（网关 8791，只读）：`characters:[{id:char-mvupjovg,name:大肥鱼}]`、
  `selectedId:null`、`followingDesktop:true`、人格 476 字 / 记忆 452 字。
- 未验证：界面下拉的真实点击（本机目前只有 1 条鱼，选择器按设计不显示）；
  两条鱼之间的实际切换与语气对比。

### 23.8 失败路径

| 场景 | 用户看到 | 断言/出处 |
| --- | --- | --- |
| 固定的角色被删 | 黄字「之前固定的角色不存在，现在临时用桌面当前角色，请重新选」 | `selectionMissing` |
| 本机没有角色 | ④ 卡片原有「没找到 SurfCore 的角色」 | `reason=no-character` |
| PUT 两个字段都不给 | 400 + hint「characterId 传角色 id；null 表示跟随」 | server 测试 |
| 宿主是旧版 | 与启动按钮同款 405 提示（需重启 DSH） | `isStaleHost()` |

### 23.9 回滚与残余

回退 `fish-context.js` / `fish-inject.js` / `server.js` / 插件三处，删除 `personaCharacterId` 配置键即可；
默认行为（跟随桌面）与之前完全一致。残余：切换角色的瞬间旧会话上下文里有前后两个角色，
我们只能追加"角色已换"说明，删不掉历史。

## 24. 2026-10-31 20:20 点「开启」提示「方法不对」：插件同路径只保留了一个 HTTP 方法

### 24.1 现象

④ 卡片点「开启」→ 红字「方法不对」；GET 状态一直正常。
（推测：③ 卡片的「保存并生效」也是同一个原因，它同样是 GET+PUT 同路径。）

### 24.2 根因

插件里每个方法各调一次 `ctx.webServer.register({ kind:'exact', path, handler })`：
`/api/persona` 先注册 GET、再注册 PUT。DSH 的 webServer **按路径**建路由，
同路径第二次注册把前一个顶掉 → PUT 请求落到「只剩 GET」的那条，被包装器判 405「方法不对」。
请求根本没到网关（网关日志无记录），所以不是网关/角色逻辑的问题。

### 24.3 修法

一个路径只注册一次，handler 内部按 `req.method` 分发（`byPath: Map<path, {GET, PUT}>`）；
未注册的方法仍回 405，但不再影响同路径其它方法。

### 24.4 验证

- 新增 `test/plugin-routes.test.js`：用「同 path 后注册覆盖前注册」的假 ctx 复现 DSH 语义，
  断言每个路径只注册一次、GET/PUT 各自可达、DELETE 仍 405、非本机 403、旧 `{enabled}` 调用兼容。
- `node test/run-all.js` → **193/193**。
- **待用户实测**：重启 DSH 后点「开启」/「保存并生效」。

### 24.5 生效与回滚

插件宿主代码，**重启 DSH** 生效。回滚：还原 `apply()` 里的 `route()` 实现即可（会退回 405 bug）。

## 25. 2026-11-01 22:25 会话太多：手机下拉加「归档」（只隐藏，不删文件）

> 本节方案已被 §26 取代：归档以 DSH 为准，手机只读同步，不再保留手机侧归档名单。

### 25.1 用户原话

> 「app 上点右上角的下拉，有很多对话，没有删除或者归档的方法」

### 25.2 先定语义（这里差点删错东西）

手机下拉里的会话**不全是手机建的**：`/v1/sessions` 返回的是本机 DSH 能看到的全部会话，
桌面端的也在里面。如果做「删除文件」，会把电脑上的对话一起删掉。
所以按用户拍板：**归档 = 只从这台手机的列表里隐藏**，会话文件一个字节都不动，桌面完全不受影响。

| 方案 | 结果 | 结论 |
| --- | --- | --- |
| 只隐藏（写归档名单） | 手机看不到；桌面照常；可随时恢复 | ✅ 采用 |
| 移到 `~/.dsh/_quarantine/` | 桌面也消失；可恢复 | ❌ 波及桌面 |
| 彻底删文件 | 不可恢复；还要判断哪些是手机会话 | ❌ 风险太高 |

### 25.3 链路

```
App 下拉 → POST /v1/sessions/:id/archive   （或 /unarchive）
  → src/server.js handleArchiveSession → deps.archive（src/session-archive.js）
  → 写 <stateDir>/archived-sessions.json（临时文件 + rename）
GET /v1/sessions → 每条会话额外带 archived: true/false
App：默认过滤 archived；下拉底部「显示已归档（N）」可展开并逐条恢复
```

### 25.4 机制

- **写盘失败要回滚内存**：先改 Set 再写盘，写失败就把 id 删回去并返回 false —— 否则接口报错、
  但列表里已经隐藏，两边矛盾（这一条有单测钉住）。
- **id 白名单**：只允许 `[A-Za-z0-9._:-]{1,200}`，不把任意字符串写进名单。
- **幂等**：重复归档、取消一个本来就不在名单里的 id，都返回成功。
- **坏档不炸**：`archived-sessions.json` 损坏时按空名单处理，并记日志（不让网关起不来）。

### 25.5 爆炸半径

只写 `~/.dsh/mobile-gateway/archived-sessions.json` 一个文件；不读不写任何会话文件；
不影响桌面端、不影响 ACP 会话本身；接口都在现有鉴权之后。

### 25.6 生效与重启

- 网关代码：**重启网关**；
- App：已重新构建并 `adb install -r -d`（保留登录态）。

### 25.7 验证

- `node test/run-all.js` → **202/202**（新增 session-archive 6 条 + 接口 3 条：
  标记透传、归档/取消、非法 id 400+hint、无令牌 401）
- `gradle assembleDebug` 成功；APK 已装真机，dex 里确认含「仅从手机隐藏」文案
- 未验证：真机上下拉逐条归档的点击手感

### 25.8 失败路径

| 场景 | 用户看到 |
| --- | --- |
| 归档名单写不进去 | 红条「会话 id 不合法，或归档名单写不进去」+ 提示看网关日志 |
| 网关旧版本（没有该接口） | 红条显示网关返回的 404/错误（App 不会假装成功） |
| 手机离线 | 「连不上网关」+ 地址/防火墙提示（现有网络错误路径） |

### 25.9 回滚

删 `src/session-archive.js` + server 两处路由与列表标记 + main 的 archive 注入 + App 的归档 UI；
归档名单文件留着也不会影响旧版本（旧版本不读它）。

## 26. 2026-11-01 22:35 归档以 DSH 为准（撤回手机侧独立归档）

> §25 的方案（手机自己存一份归档名单）已被本节取代：DSH 只有「归档」没有「删除」，
> 用户要求「以 DSH 为准，保持和 DSH 同步」。

### 26.1 DSH 的归档在哪

- 状态：`~/.dsh/storages/workspace.json` → `global.archivedSessionIds`（会话 id 数组，全局）。
- 能力：DSH 桌面端 `WorkspaceController.archiveSession(sessionId, { stopActivity })` / `unarchiveSession`，
  属于 workspace 服务（桌面/Web 层），**ACP profile 不挂它**，所以网关拿不到。

### 26.2 最终做法（只读跟随）

- 网关新增 `src/dsh-archive.js`：只读上面那个文件，`mtime+size` 缓存，DSH 保存后自动生效；
  坏档保留上一次结果，不把列表清空。
- `GET /v1/sessions`：默认**过滤掉 DSH 已归档的会话**；`?includeArchived=1` 才返回并带 `archived:true`（调试用）。
- 删除 §25 的手机侧 `archive/unarchive` 接口与 App 按钮——归档/取消统一在 DSH 里做。
- App 下拉空态文案改为「还没有历史会话（在电脑 DSH 里归档的不会出现在这里）」。

### 26.3 为什么不做双向（手机也能归档）

| 路线 | 问题 |
| --- | --- |
| 网关直接写 `workspace.json` | DSH 内存里也有这份状态且无跨进程锁，会被覆盖/互相踩（BOUNDARIES §8） |
| 网关 → 插件 → workspaceController | 可行但要多一条「网关找 DSH Web 端口 → 插件路由 → 控制器」的链路，兼容性没验证 |
| **只读跟随**（采用） | 零写风险；归档操作在 DSH，手机即时同步 |

如果以后确实要「手机点归档、DSH 也归档」，再按第二条做，并且要先验证控制器 API。

### 26.4 验证

- `node test/run-all.js` → **200/200**（dsh-archive 5 条：读取、mtime 自动生效、缺文件、坏档保留、脏数据过滤；
  接口 2 条：默认过滤 + includeArchived、归档接口已移除返回 404）。
- APK 重建并已装红米 K80；dex 确认旧「显示已归档」文案已消失。
- 未验证：真机上归档后下拉刷新的观感。

### 26.5 回滚

恢复 §25 的 `session-archive.js` 与接口/UI 即可；或只保留只读同步、恢复手机按钮作为「仅手机隐藏」（会重新分叉，不建议）。

## 27. 2026-11-01 22:50 手机比 DSH 多两个「空会话」→ 过滤无消息会话

### 27.1 现象

用户：手机上比 DSH 桌面端多两个「（空会话）」。

### 27.2 定位（对文件，不对猜测）

列出所有非归档会话并按有无用户消息分类，恰好两个没有标题：

| 会话 | 所在工作区 | 大小 | 状态 |
| --- | --- | --- | --- |
| `session-214caa84-…` | default-workspace | 431 B | 空（只有会话头） |
| `session-46d8cd00-…` | state-agents | 359 B | 空（只有会话头） |

原因：`/v1/sessions` 把 ACP 返回的**所有**非归档会话都返回了；DSH 桌面端对「没有任何消息」的会话不展示。
手机没有做同样的过滤，于是多出这两条。

### 27.3 修法

`handleListSessions` 增加空会话过滤：有 `sessionMeta`（能读出标题）且 `title` 为 null 时默认不返回；
调试用 `?includeEmpty=1`。与 `?includeArchived=1` 独立。

### 27.4 验证

- `node test/run-all.js` → **200/200**；新增断言：默认列表不含 `sess-empty`，`includeEmpty=1` 时才出现。
- 未验证：真机重启网关后的列表（网关当前未运行）。

### 27.5 残余

App 在「上次会话没有任何消息」的情况下，会因为找不到 `lastSessionId` 而新建一个空会话——
这些空会话现在也被列表过滤掉（不再显示），但文件会留在 ACP 工作区目录里。
若以后觉得堆积，可改成「先尝试 resume 上次会话，失败再新建」。

## 28. 2026-11-01 23:40 手机新建会话落到 DSH 工作区（两边列表同一批）

### 28.1 问题

手机会话的 cwd 是 `...\surfcore\mobile-gateway`，这个目录不在 DSH 登记的 3 个工作区里，
所以它们在 DSH 桌面端**根本看不到**（手机 29 条、桌面 0 条），只能靠归档/空会话过滤勉强对齐。

### 28.2 做法

把网关的 `defaultCwd` 指到 DSH 已有工作区：

```json
// ~/.dsh/mobile-gateway/config.json
{ "defaultCwd": "C:\Users\dfer5\Documents\deepseek-harness\default-workspace" }
```

- `session/new` 不带 cwd 时用 `meta.defaultCwd`（`src/server.js`），所以**手机新建的会话**会归到
  `--C-Users-…-default-workspace--` 目录，DSH 的 default-workspace 列表里能直接看到；
- 验证（临时网关 8791 实测）：新建会话落盘路径
  `~/.dsh/sessions/--C-Users-dfer5-Documents-deepseek-harness-default-workspace--/<uuid>`。

### 28.3 注意

- 必须用**反斜杠**写路径：DSH 工作区记录的是 `C:\...`；正斜杠可能导致工作区匹配不上。
- 只影响**新会话**；旧的 11 条（未归档、在 mobile-gateway 目录）仍在手机侧。
  想让他们也出现在桌面：在 DSH 里把 `...\surfcore\mobile-gateway` 添加为工作区（UI 操作），
  或忽略（它们只属于手机）。
- 这是 `config.json` 的一个键，改回/删掉即回滚，重启网关生效。

### 28.4 验证

- 临时网关实测新会话目录正确（见 28.2）。
- 网关已重启（当前运行版本包含 defaultCwd）。
- 未验证：App 新建会话后在 DSH 桌面端刷新看到的实际观感。

## 29. 2026-11-02 00:15 点进旧会话没有历史 → 新增会话历史接口

### 29.1 现象

手机下拉里点开已有会话，聊天区是空的；只有之后新发/新回的消息。

### 29.2 根因

App 的 `openSession()` 只做三件事：切换 sessionId、清空消息、重连 SSE。
**它从来没有拉过历史**——以前下拉里几乎都是手机刚建的会话，所以不明显；
现在下拉里出现桌面端的旧会话（default-workspace），一点进去就是空白。

ACP 协议没有「取历史」的方法（只有 prompt / stream / list / resume），
但会话本身完整落在 `~/.dsh/sessions/…/session.v4.jsonl.zstd`，只读解析即可。

### 29.3 实现

网关：

- `session-meta.js` 新增 `extractHistory(raw, {limit})`：只收 `user/message` 与 `assistant/message`，
  跳过 `system/message` 等事件；用户消息里如果带我们注入的前言（`\n\n---\n\n` 分隔 / 以【】开头），
  剥掉前言只留原话；普通消息原样保留（不会因为以 `<` 开头就被吞）。
- `createSessionMeta().history(sessionId, {limit})`：定位同一个会话文件 → 多帧 zstd 解压 → 解析；
  文件不存在返回 `reason:'no-file'`（新会话正常情况），超过 16MB 返回 `too-large`。
- `GET /v1/sessions/:id/history?limit=200`（要鉴权）：返回 `{messages, truncated, updatedAt}`。

App：

- `GatewayClient.history()`；`openSession()` 先把历史回填（只在这里还空着时回填，避免盖掉用户刚发的消息），
  读取失败给红条「历史消息没读出来」+ 网关 hint；SSE 仍照常订阅新事件。

### 29.4 验证

- `node test/run-all.js` → **204/204**（extractHistory 3 条 + 接口 1 条）。
- 真实数据（临时网关 8791）：`586221c0` 返回 `[{"role":"user","text":"你是金花吗？"}]`。
- APK 已构建；**手机当前未连接**，待插上 USB 后 `adb install` 再验。

### 29.5 取舍

| 方案 | 问题 |
| --- | --- |
| 让 ACP 返回历史 | 协议没有该能力 |
| App 自己存聊天记录 | 换手机/重装就丢，且和桌面端不一致 |
| **只读解析会话文件**（采用） | 多帧 zstd 解析成本；大文件按 16MB 上限保护 |

### 29.6 残余

- 历史只取最后 200 条（`limit` 可调），更早的不显示。
- 助手消息里的工具调用/思考块不展示，只保留文本。
