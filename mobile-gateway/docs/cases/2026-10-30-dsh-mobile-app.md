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
| **ACP `agent_message_chunk` 运行期样本** | ❌ **未验证**（沙箱曾禁 spawn） |
| **SenseVoice 实际转写延迟** | ❌ 未验证（模型未下载） |
| **火山引擎 TTS 真实调用** | ❌ 未实现（用户要求跳过） |
| **APK 构建** | ✅ `assembleDebug` BUILD SUCCESSFUL（47s）；产物 `android/app/build/outputs/apk/debug/app-debug.apk`，17,436,189 字节，另存副本 `mobile-gateway/app-debug-0.1.0.apk`。`aapt2 dump badging`：`com.dsh.mobile` v0.1.0 / minSdk 26 / targetSdk 35 |
| **真机（红米 K80）运行** | ❌ 未验证（未安装、未配对、未跑一轮对话） |

---

## 7. 发布交接块

> 本次**没有版本号变更**（`package.json` 仍是 `0.1.0`，子工程不入根 `package.json` 依赖链），
> 因此不进 `docs/RELEASE-QUEUE.md` 的发布批次；交接信息记在 `docs/HANDOFF.md` 顶部快照
> 「2026-10-30 20:30–20:40（手机端 App 搬进仓库 + APK 构建通过）」。
>
> 上真机前必须做的三件事：① 另开一个终端 `cd mobile-gateway && node src/main.js` 起网关；
> ② 电脑端生成配对码，App 里输入；③ 手机与电脑在同一局域网，且防火墙放行网关端口。

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

