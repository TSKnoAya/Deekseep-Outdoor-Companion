# 手机端 App（DSH Mobile）设计方案

> 状态：设计稿，2026-10-30 起。
> 对应路线：ROADMAP §3 候选 F。本文件回答「怎么做、边界在哪、坏了怎么认」。

---

## 0. 一句话定位

**手机发消息 → 本机网关 → DSH（ACP stdio）→ 结果回手机**，支持语音输入与语音播报。

不碰 DSH Web 层（不依赖 `dsh web`、不依赖端口漂移、不铸造 Cookie）。

---

## 1. 为什么是 ACP 而不是 Web

| 方案 | 结论 | 依据 |
|---|---|---|
| 连 DSH Web GUI | ❌ 否决 | 只监听回环；Cookie 绑 authority，反代必 401（`src/dsh-client.js:74-77`）；协议是 WebSocket RPC，不是 REST |
| `--profile headless` 一次性调用 | ❌ 否决为终态 | **没有审批应答者**：`dsh-headless/lib/index.js` 里零 `approval` 字样，而 base 把策略设为 `ask` → 越权操作静默失败。绕过只能 `danger-full-access`（全放开） |
| **`--profile acp` 常驻 stdio** | ✅ 采用 | 官方自动化协议；有 `session/request_permission`；复用桌面端已登录凭据；无端口无 Cookie |

**已实测**：`initialize` 握手 / `session/new` / `session/list` / 跨进程 `session/list` 可见同一会话；冷启动 2.75–2.78s（3 次取样）。

---

## 2. 架构

```
┌─────────────┐   HTTP+SSE    ┌──────────────┐   stdio JSON-RPC   ┌──────────────┐
│ Android App │ ◄───────────► │  本机网关     │ ◄────────────────► │ DeepSeek     │
│ (Kotlin)    │  局域网/Tail  │ (Node 24)    │   ACP --profile acp │ Harness.exe  │
└─────────────┘               └──────────────┘                    └──────────────┘
       │                             │
       │ 录音/播放                    └── sherpa-onnx.node（ASR，本地）
       └── 可选：系统 SpeechRecognizer（手机本地转写）
```

### 2.1 为什么网关要有「可注入 transport」

沙箱里 `spawn` 是 `EPERM`（已实测），子进程无法启动。所以：

- `AcpClient` 只依赖一个 `transport` 接口（`write(line)` / `onLine(cb)` / `close()`）
- 生产用 `ChildProcessTransport`（spawn `DeepSeek Harness.exe`）
- 测试用 `InMemoryTransport`（假 DSH），**不需要真进程就能测全部协议逻辑**

这不是为测试而测试：ACP 的坑（串行 prompt、阻塞回合、失联重连）只有能跑假服务才测得起。

---

## 3. 网关 HTTP 接口

设计原则：**失败结构化**（`ok:false` + `code` + `error` + `hint`），符合 AGENTS.md §1.7。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/v1/pair` | 一次性配对码 → 设备令牌 |
| `GET` | `/v1/health` | 版本、DSH 是否在线、语音后端状态 |
| `GET` | `/v1/sessions` | 会话列表（透传 ACP `session/list`） |
| `POST` | `/v1/sessions` | 新建会话 |
| `POST` | `/v1/messages` | 发消息（异步，立刻返回 `turnId`） |
| `GET` | `/v1/turns/{id}/stream` | SSE：增量事件流 |
| `POST` | `/v1/approvals/{id}` | **回答审批**（allow-once / reject-once） |
| `POST` | `/v1/asr` | 音频 → 文字（后端可切） |
| `POST` | `/v1/tts` | 文字 → 音频（后端可切，火山未配置时明确报错） |
| `GET` | `/v1/settings` / `PUT` | 语音模式、播报档位 |

配对有两条入口，**手动输入一直是底线**：

- 手动：App 里填「网关地址」+ 6 位码（窗口/设置页都会显示）；
- 扫码：电脑设置页 `POST /admin/pair`（仅回环）返回每个可达地址的二维码矩阵，
  载荷是 `dshmobile://pair?v=1&u=<地址>&c=<码>`；App 用相机（CameraX + ZXing）扫，
  解析成功就复用同一条 `/v1/pair`。系统相机/微信扫到深链也能直接打开 App，
  但**只填入地址与码、不自动连**（外部链接不可信，用户确认地址后再点配对）。
  载荷格式在 `src/pair-qr.js` 与 `pair/PairPayload.kt` 各实现一次，改格式必须两边同步。

### 3.1 关键约束（来自 ACP 实测）

1. **单会话同时只能一个 prompt**：源码原文 `a prompt is already in flight for this session`。网关必须自己排队，不能靠 ACP。
2. **`session/prompt` 阻塞到本轮结束**。所以 `POST /v1/messages` 必须立刻返回，结果走 SSE。一轮可能十几分钟。
3. **审批是服务端主动请求**（`session/request_permission`），手机端必须能回；不回就挂到超时。

### 3.2 网关生命周期

- 网关是**独立进程**，DSH 只负责看状态；默认由 `start-gateway.bat` / 命令行启动。
- DSH 设置页 ① 卡片提供「启动网关」：插件宿主用与 bat 相同的参数
  （`node src/main.js --listen 0.0.0.0:8788 --pair`）spawn，日志写
  `<DSH_HOME>/mobile-gateway/gateway.log`，12 秒内 `/v1/health` 不通就带日志尾部报错。
- 按钮启动的实例随 DSH 退出一起停（`taskkill /T` 连 ACP 子进程）；
  要脱离 DSH 常驻就用 bat。Node 探测顺序见 `dsh-plugin/lib/gateway-process.js`——
  注意 DSH 的 `process.execPath` 是 Electron，不能直接当 node 用。

---

## 4. 语音设计

### 4.1 ASR：双模切换

| 模式 | 实现 | 状态 |
|---|---|---|
| `gateway-sherpa` | 网关直接 `require` DSH 打包的 `sherpa-onnx.node`，跑 SenseVoice | 已验 `.node` 可加载；模型首次用时下载（INT8 ≈239MB） |
| `device-native` | Android `SpeechRecognizer`，音频不出手机 | 手机端实现；HyperOS 需引导装离线中文包 |

**为什么不用 DSH 的 `speechToText` 服务**：它是 Typert Remote，挂在 `dsh-api-gateway` + `dsh-client-connection`（Web 层）上。ACP profile 不挂 gateway，且 ACP 明说 `audio prompt content is not supported`（`dsh-acp/lib/index.js:114`）。绕进去等于自己重建 DSH 宿主，不值得。

### 4.2 TTS：可插拔后端 + 四档播报

后端：
| id | 状态 |
|---|---|
| `volcengine` | **只留接口**。缺 AppID/AccessToken 时返回 `code:'tts.provider-not-configured'` + hint 指向控制台 |
| `local-piper` | 预留：sherpa `createOfflineTts` 可跑，但当前无音色模型 |
| `device-native` | Android 系统 TTS，零依赖兜底 |

播报档位：`all` / `short`（≤80字，默认）/ `headset-only` / `off`，
外加硬规则：可打断、代码块/表格/路径不念、首句优先。

### 4.3 火山接口的占位契约（日后补）

```js
// 后端只需实现这两个方法即可接入
{
  id: 'volcengine',
  async probe()                  // → { ok, code?, error?, hint? }
  async synthesize({ text, voice })  // → { audio: Buffer, mime: 'audio/wav' }
}
```

**已确认的接入参数**（写进代码注释，避免以后重新查）：
- 端点 `POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`
- 头 `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id: seed-icl-2.0`
- body `{user:{uid}, req_params:{text, speaker, audio_params:{format:'wav', sample_rate:24000}}}`
- 成功码两种：`0` 和 `20000000`（后者是结束帧，data 为 null）
- 返回是多行 JSON，每行 `data` 是 base64 WAV 分片；首片 RIFF 长度字段是 `0xFFFFFFFF`，必须自己切 PCM
- `resource` 必须是 `seed-icl-2.0`，换 `seed-tts-2.0` 会 403/55000000

---

### 4.4 分发边界：只带接口，不带语音包

- **仓库不包含任何语音包/模型**：本机这套本地 GPT-SoVITS 语音包约 **11GB**
  （models 1.9G + vendor 2.5G + `.venv-gsv` 5.5G + `.venv` 243M + 参考样本 86M），
  且含个人音色素材，不适合公开分发；
- `src/voice/` 只保留后端**接口**：`volcengine`（云端，缺密钥时明确报错）、`device-native`（手机系统 TTS），
  本地 TTS 为占位；用户自行准备模型与密钥；
- 手机端空间的三种选择：
  | 方案 | 手机占用 | 说明 |
  | --- | --- | --- |
  | 云端 TTS（火山等） | 0MB | 需联网与密钥；参考音频留在电脑 |
  | 系统 TTS（`device-native`） | 0MB | 音色由系统提供 |
  | 手机本地轻量 TTS（将来接 sherpa VITS） | 约 60–120MB/音色 + 20–30MB 运行库 | 音色需单独训练/转换 |
  | 本地 ASR（SenseVoice INT8） | 约 239MB | 手机当前可用系统识别（0MB） |
- `.gitignore` 已显式排除 `state/voice-packs/`、`/voice-packs/`、`*.onnx`、`*.safetensors`、
  `*.gguf`、`*.pth`、`*.ckpt`；**发布物里不应出现任何语音/模型文件**。

## 5. 安全边界

1. **默认只监听回环**；要让手机连，必须显式配置 `listen` 到局域网地址，且**必须有设备令牌**。
2. 配对码一次性、限时（默认 5 分钟）、限次数（默认 5 次）。
3. 设备令牌存 Android Keystore（App 侧）；网关侧只存 sha256。
4. **不做端口转发到公网**。要远程用 Tailscale/WireGuard。
5. 审批接口只接受已配对设备；审批动作写审计日志。
6. **二维码 = 一次性凭证**：里面是「地址 + 5 分钟内有效、只能用一次的配对码」。
   能看到电脑屏幕的人本来就能读到码，所以它不扩大攻击面；但不要截图发到群里。
   `/admin/pair` 仍然只接受本机回环请求，远程设备无法自己生成二维码。

---

## 6. 已知风险与未验证

| 项 | 性质 | 处理 |
|---|---|---|
| 同一 `DSH_HOME` 双进程写 `config.json` 无跨进程锁 | 已知风险（BOUNDARIES §8） | 网关只读配置，不写 |
| DSH 升级后 ACP 协议可能变 | 中 | `initialize` 里校验 `protocolVersion`，不匹配明确报错 |
| HyperOS 后台杀进程 | 确定会发生 | 前台服务 + 电池白名单引导 + 断线重连 |
| sherpa 模型下载 239MB | 体验 | 首次使用前显式提示进度 |
| **未验证**：SenseVoice 在本机 CPU 的实际转写延迟 | — | 接上后实测 |
| **未验证**：ACP `agent_message_chunk` 运行期样本 | — | 沙箱禁用 spawn，只能在真机/非沙箱环境补测 |

---

## 7. 怎么验证

```bash
# 网关单测（不需要 DSH、不需要 spawn）
node --test mobile-gateway/test/

# 起网关（真机自测，需非沙箱环境）
node mobile-gateway/src/main.js --listen 0.0.0.0:8788

# App
cd mobile-gateway/android && ./gradlew assembleDebug
```
