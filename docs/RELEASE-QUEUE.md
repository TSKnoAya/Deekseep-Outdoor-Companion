# 发布待办队列（编辑会话 → 发布会话）

> 用途：编辑会话每完成一批改动，在这里追加**一个带时间戳的批次**：覆盖到哪个提交、
> 改了哪些文件/功能、case 路径、建议版本、可直接复制的交接块。
> **发布会话从最上面的「待发布」批次复制**，不用翻 `git log`；发布完成后把标题改成「已发布 vX.Y.Z」。
>
> 触发：用户说「好了，总结这次的改动」之类的话时追加（规则见 AGENTS 1.6）。
> 没有进这张表的改动，不允许发布（见 [RELEASE.md](RELEASE.md) 第一节）。

---

## 待发布

### 批次 2026-11-01 22:35 · 手机网关：会话归档「以 DSH 为准」（只读同步）
<!-- release-batch: start=2026-11-01T22:05+08:00 end=2026-11-01T22:35+08:00 commits=待提交 -->

**覆盖提交**：本次编辑会话尚未提交
**建议**：与手机网关前几批一起 minor（0.2.x）

**改了什么**

- 网关：新增 `src/dsh-archive.js`，**只读** DSH 的 `~/.dsh/storages/workspace.json`
  → `global.archivedSessionIds`（mtime+size 缓存，DSH 保存后自动生效；坏档沿用上次结果）。
- `GET /v1/sessions` 默认过滤 DSH 已归档的会话（`?includeArchived=1` 才返回并带 `archived:true`）。
- `GET /v1/sessions` 同时默认过滤「没有任何用户消息」的空会话（`?includeEmpty=1` 调试用），
  与 DSH 桌面端列表保持一致（原来手机会多出两条「（空会话）」）。
- 撤回 §25 的手机侧独立归档：删除 `session-archive.js`、`POST /v1/sessions/:id/archive|unarchive`
  以及 App 的归档/恢复按钮与「显示已归档」开关。
- 归档/取消归档统一在 DSH 桌面端做；手机只跟随，不反向写 DSH 状态（跨进程写无锁，风险大）。
- 配置：网关 `defaultCwd` 指向 DSH 的 `default-workspace`（`~/.dsh/mobile-gateway/config.json`），
  手机**新建**会话归入桌面已有工作区，两边列表从新会话开始同一批（旧会话仍在 mobile-gateway 目录）。

**case**：[mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md](../mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md) §26（归档）、§27（空会话）、§28（工作区归属）

**验证**：`node test/run-all.js` 202/202；`gradle assembleDebug` 成功并已装真机；
未验证：真机下拉点击手感。

**验证**：`node test/run-all.js` 200/200；`gradle assembleDebug` 成功并已装真机
（dex 里旧「显示已归档」文案已消失）；未验证：真机归档后列表刷新观感。

**发布交接**（可直接转给发布会话）：

```
改了哪些文件：
  mobile-gateway/src/{dsh-archive.js（新）, server.js, main.js}
  mobile-gateway/test/{dsh-archive.test.js（新）, server.test.js, run-all.js}
  mobile-gateway/android/.../{GatewayClient.kt, ChatViewModel.kt, ChatScreen.kt}
  docs（HANDOFF、cases §26、RELEASE-QUEUE）
测过什么、结果如何：node 200/200；assembleDebug 成功；APK 已装红米 K80
建议：minor（与手机网关前几批同批）
case：mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md §26（§25 已被取代）
改动层级：/v1/sessions 默认过滤归档（行为变化）；删除了未发布的手机侧归档接口
完整逻辑与爆炸半径：case §26.1–26.3（只读 workspace.json，不写 DSH 状态）
失败路径：DSH 文件缺失/坏档沿用上次结果；网关旧版则 App 照常（只是没有过滤）
没验证：真机上归档后下拉刷新的观感
```

---

### 批次 2026-10-31 20:10 · 手机网关：手机独立选鱼（多角色）
<!-- release-batch: start=2026-10-31T20:05+08:00 end=2026-10-31T20:10+08:00 commits=待提交 -->

**覆盖提交**：编辑会话尚未提交（与扫码配对/启动按钮同一批未提交改动）
**建议**：与前面两批一起发 minor（手机网关 0.2.0）

**改了什么**

- `fish-context.js`：新增 `listCharacters()`；`resolveFishFiles` 接受 `characterId`，
  指定角色缺失时回退桌面当前并标记 `selectionMissing`。
- `fish-inject.js`：`selectedId`（null=跟随桌面）、`setCharacter()` 落盘、状态带 `characters/followingDesktop`；
  切角色触发 `character-switched` 强制重注入（不受上限限制）。
- `server.js`：`PUT /admin/persona` 接受 `enabled` 和/或 `characterId`（null=跟随桌面）；旧写法兼容。
- 插件：`PUT /api/persona` 透传两字段；④ 卡片在多角色时出现下拉，单选/删除角色的提示都在。
- 修：插件同路径 GET+PUT 各注册一次 → DSH 只保留一个方法，点「开启」/「保存并生效」返回
  「方法不对」405。改为每路径注册一次、内部按 method 分发（case §24，含 `test/plugin-routes.test.js`）。
- 配置新增键：`config.json.personaCharacterId`；环境变量 `DSH_MOBILE_PERSONA_CHARACTER` 可覆盖。

**case**：[mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md](../mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md) §23

**验证**：`node test/run-all.js` 187/187（+13）；真实数据只读 GET 正常；
未验证：两条鱼之间的界面切换（本机仅 1 条）。

**发布交接**（可直接转给发布会话）：

```
改了哪些文件：
  mobile-gateway/src/{fish-context.js, fish-inject.js, server.js, main.js}
  mobile-gateway/dsh-plugin/lib/{index.js, client.js}
  mobile-gateway/test/{fish-context.test.js, fish-inject.test.js, server.test.js}
  docs（HANDOFF、cases §23、RELEASE-QUEUE）
测过什么、结果如何：node 187/187；真实 SurfCore 只读 GET 返回 characters=[大肥鱼]、followingDesktop=true
建议：minor（与扫码配对/启动按钮同批）
case：mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md §23
改动层级：接口层新增可选字段（/admin/persona 的 characterId、status 的 characters/selectedId…），旧字段兼容
完整逻辑与爆炸半径：case §23.3–23.5（只写 config.json 一个键；不写 SurfCore 文件）
失败路径：case §23.8（角色被删/无角色/参数缺失/宿主旧版，均有界面提示）
没验证：两条鱼之间实际切换的语气变化（本机只有 1 条鱼，选择器按设计不显示）
```

---

### 批次 2026-10-31 20:05 · 手机网关：设置页一键启动/停止网关
<!-- release-batch: start=2026-10-31T19:45+08:00 end=2026-10-31T20:05+08:00 commits=待提交 -->

**覆盖提交**：编辑会话尚未提交（与下面扫码配对同一批未提交改动）
**建议**：与扫码配对一起发；同属 minor（手机网关 0.2.0）

**改了什么**

- 新增 `dsh-plugin/lib/gateway-process.js`：node 探测（DSH 自带 → LocalAppData → ProgramFiles → Electron 兜底）、
  spawn `src/main.js --listen 0.0.0.0:8788 --pair`、12 秒健康检查、日志 `<DSH_HOME>/mobile-gateway/gateway.log`、
  `taskkill /T /F` 停整棵进程树。
- 插件接口：`/status` 网关没跑时返回 `running:false`（不再当错误）+ `managed/log/lastError`；
  新增 `POST /start`、`POST /stop`。
- 设置页 ① 卡片：右上角「启动网关」/「停止网关」；失败红块带原因、日志尾部与日志路径。
- 生命周期：按钮启动的网关随 DSH 退出停止；bat 起的不受影响（卡片会注明）。

**case**：[mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md](../mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md) §21

**验证**：`node test/run-all.js` 174/174（新增 3 条，含失败分支 code/hint/日志断言）；
真实 `main.js` 8791 端口 325ms 起、stop 后释放。

**发布交接**（可直接转给发布会话）：

```
改了哪些文件：
  mobile-gateway/dsh-plugin/lib/gateway-process.js（新）
  mobile-gateway/dsh-plugin/lib/index.js（/status 改造 + /start + /stop + 退出清理）
  mobile-gateway/dsh-plugin/lib/client.js（①卡片启动/停止按钮、失败红块）
  mobile-gateway/test/gateway-process.test.js（新）、test/run-all.js
  docs（DESIGN §3.2、HANDOFF、PITFALLS×2、cases §21、RELEASE-QUEUE）
测过什么、结果如何：node 174/174；真实网关 spawn/stop 在 8791 端口验证通过（325ms up）
建议：minor（与扫码配对同批）
case：mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md §21
改动层级：插件宿主接口新增 /start /stop，/status 从「抛错」改为返回 running:false（后端兼容；前端同版本发布）
完整逻辑与爆炸半径：case §21.2–21.4（3 个进程；写 gateway.log；只接受本机回环）
失败路径：case §21.8（端口占用/秒退/超时/无 node/无源码/bat 起的停不掉，均有红块+下一步）
没验证：DSH 设置页里手点按钮（需重启 DSH）；ELECTRON_RUN_AS_NODE 兜底路径
```

---

### 批次 2026-10-31 19:40 · 手机网关：扫码配对（保留手动输入）
<!-- release-batch: start=2026-10-31T19:10+08:00 end=2026-10-31T19:40+08:00 commits=待提交 -->

**覆盖提交**：编辑会话尚未提交（用户未要求本地提交；发布前先按仓库习惯提交，再取 HEAD）
**建议**：minor → 手机网关 / App **0.2.0**（新增功能，`/v1/pair`、`/admin/pair` 旧字段全部保留）

**改了什么**

- 网关：新增 `src/pair-qr.js`（载荷 + 矩阵）、`src/vendor/qrcode-generator.cjs`（MIT）；
  `POST /admin/pair` 额外返回 `urls[{url,payload,qr{size,rows},tailscale}]`，
  回环/无地址/生成失败时返回 `warn{code,error,hint}`（码本身照常有效）。
- 设置页：② 卡片改为「生成二维码 / 配对码」，内联 SVG 画二维码、多地址切换、倒计时与警示。
- App：配对页新增「扫码配对」（CameraX + ZXing core，无 GMS 依赖）；
  注册 `dshmobile://pair` 深链；解析器 `pair/PairPayload.kt`；新增 CAMERA 权限。
- 修：扫码页把 Compose 取消异常误报成「相机打不开」——PreviewView 改 `AtomicReference`、
  放行 `CancellationException`（case §22）。
- APK 17.86MB → 20.70MB（CameraX + ZXing）。

**case**：[mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md](../mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md) §20

**验证**：`node test/run-all.js` 171/171；`gradle testDebugUnitTest` 5/5；`gradle assembleDebug` 成功；
jsQR 独立解码矩阵与插件 SVG 路径均通过。

**发布交接**（可直接转给发布会话）：

```
改了哪些文件：
  mobile-gateway/src/pair-qr.js（新）、src/vendor/qrcode-generator.cjs（新，MIT）
  mobile-gateway/src/server.js（/admin/pair 返回 urls + warn）
  mobile-gateway/dsh-plugin/lib/client.js（②卡片二维码）
  mobile-gateway/android/{app/build.gradle.kts, app/src/main/AndroidManifest.xml,
    .../MainActivity.kt, .../ui/ChatScreen.kt, .../ui/ChatViewModel.kt,
    .../ui/QrScanScreen.kt（新）, .../pair/PairPayload.kt（新）,
    app/src/test/.../PairPayloadTest.kt（新）}
  mobile-gateway/test/{pair-qr.test.js（新）, server.test.js, run-all.js}
  docs（DESIGN/THIRD_PARTY_NOTICES/cases §20/HANDOFF/PITFALLS/RELEASE-QUEUE）
测过什么、结果如何：node 171/171；Kotlin 单测 5/5；assembleDebug 成功（20.7MB）；jsQR 独立解码通过
建议：minor（手机网关/App 0.2.0）
case：mobile-gateway/docs/cases/2026-10-30-dsh-mobile-app.md §20
改动层级：接口层新增字段（/admin/pair 的 urls/warn），/v1/* 完全未改 → 向后兼容
完整逻辑与爆炸半径：case §20.2–20.4（3 个进程；二维码只含一次性 5 分钟配对码；APK +2.8MB）
失败路径：case §20.8（回环/无地址/生成失败/扫到普通码/相机权限/相机占用，全部有界面提示与下一步）
没验证：真机拿手机扫电脑屏幕、HyperOS 深链弹窗、多地址切换观感
```

---

### 批次 2026-10-31 10:20 · Phase 0A 上下文/成本遥测（只测量）
<!-- release-batch: start=2026-10-31T10:20+08:00 end=2026-10-31T10:40+08:00 commits=c7df162 -->

**覆盖提交**：`c7df162`
**建议**：**0.7.24**（若人格卡分层已作为 0.7.23 发布；否则可与它合并为 0.7.23）

**需求**：先建立真实 token/上下文账单，不改行为。

**实现**：
- `src/context-telemetry.js` 旁路 JSONL：wake / model usage / tool 结果字符数+耗时 / turn 起止；
- 插件 `session/event` 采所有会话；bridge 投递 wake 时记录 prompt 总字符与分段；
- `scripts/context-telemetry-report.mjs` 按唤醒原因/工具聚合基线，标 observed/estimated/覆盖缺口；
- 不记录消息正文/工具参数；写失败不影响主链路；不改 prompt、工具、guard、会话策略。

**未做**：Phase 1 工具契约/复合快照；系统提示/工具 schema/历史的精确拆分。

**case**：[docs/cases/2026-10-31-context-telemetry.md](cases/2026-10-31-context-telemetry.md)
**验证**：`node scripts/test-context-telemetry.mjs`；`plugins/surfcore npm test`；
`npm run test:audit` 94/94。
**交接**：同步 `src/{context-telemetry,bridge}.js`、`plugins/surfcore/lib/index.js`、
`scripts/context-telemetry-report.mjs`、测试、docs、manifest。
重启 DSH + QQ 桥接后开始采集；建议 3–7 天基线再进 Phase 1。

---

### 批次 2026-10-31 10:05 · 人格卡分层（0.7.22 后）
<!-- release-batch: start=2026-10-31T10:05+08:00 end=2026-10-31T10:35+08:00 commits=bf673a2 -->

**覆盖提交**：`bf673a2`
**建议**：patch → **0.7.23**

**需求**：人格卡拆成【人格核心】【人格日常】【场景人格】；QQ 分群聊/私聊；
B站/桌宠各用各的场景；全部手动编辑；角色页醒目说明本次改动。

**实现**：
- `persona.md` 继续是人格核心；新增可选 `persona.daily.md` 与
  `persona.scenes/{qq-group,qq-private,bili,pet}.md`；
- `src/persona-layers.js` 统一组合核心→场景→日常，超预算先裁日常/场景；
- QQ 按 `group:`/`private:` 选场景；B站/桌宠接同一套分层；
- `/persona` 三层读写、按层备份恢复；快照/回档带三层；
- 角色页三层手动编辑 + 顶部醒目说明；模型不自动改写；
- 记忆卡/向量记忆未动。

**未做**：日常/场景自动生成、任务型 ContextRecipe、记忆分层、缓存收益实测。

**case**：[docs/cases/2026-10-31-persona-layers.md](cases/2026-10-31-persona-layers.md)
**验证**：`node scripts/test-persona-layers.mjs`；
`plugins/surfcore/scripts/test-character-api.mjs`；`test-client-contract.mjs`；
`plugins/surfcore npm test`；`npm run test:audit` 93/93。
**交接**：同步 `src/{persona-layers,character-persona,bridge}.js`、
`plugins/surfcore/lib/{index,client,scheduler,pet-chat}.js`、测试、docs、manifest。
改动后 QQ 下一条消息 / B站下一次醒来 / 桌宠下一次对话生效；真实页面/注入还需手测。

---

### 已发布 v0.7.21 · 2026-10-31 08:10 · 一键启动 SurfCore / 一键停止（0.7.20 后）
<!-- release-batch: start=2026-10-31T08:10+08:00 end=2026-10-31T08:30+08:00 commits=282dc6c -->

**覆盖提交**：`282dc6c`
**建议**：patch → **0.7.21**

**需求**：一键启动整合成多选 QQ（含 SnowLuma）/ B站 / 桌宠 / 语音；语音本地/云端单选；
下面加一键停止；每项显示状态，切换页一致；失败可见且给建议。

**实现**：
- 概览「一键启动 SurfCore」多选 + 语音分支；「一键停止（全部）」；
- `start-selected` / `stop-selected`，每项 `ok/code/error/hint`；
- 停止顺序语音→QQ→B站→桌宠（语音由桥接托管，避免孤儿进程）；
- `overview.launch` 统一 `bridgeStatus / schedulerStatus / petService / /api/voice/packs`；
- QQ 停止不关闭 SnowLuma 本体；语音未装/桥接未起/平台开关关闭都有结构化错误。

**未做**：真实进程启停手测、语音页深链、SnowLuma 本体停止（设计边界）。

**case**：[docs/cases/2026-10-31-one-click-launch-stop.md](cases/2026-10-31-one-click-launch-stop.md)
**验证**：`node scripts/test-launch-components.mjs`；`plugins/surfcore npm test`
（test-client-contract / test-platform-start-host）；`npm run test:audit` 90/90。
**交接**：同步 `plugins/surfcore/lib/{index,client}.js`、`scripts/test-launch-components.mjs`、
`plugins/surfcore/scripts/{test-client-contract,test-platform-start-host}.mjs`、docs、manifest。
重启 DSH 后页面生效；真实启动/停止需手测。

---

### 已发布 v0.7.20 · 2026-10-30 23:40 · 语音包退出 zip 自动更新
<!-- release-batch: start=2026-10-30T23:40+08:00 end=2026-10-30T23:50+08:00 commits=44bae2d -->

**覆盖提交**：`44bae2d`
**建议**：与 SnowLuma 通道闸门一起发 **0.7.20**

**问题**：语音包没有 `package.json`，被登记为 `updates.components()` 的 `kind:auto`，
下载后按 SurfCore 的 `surfcore-* + package.json + install-manifest` 解析，必然
`verify.bad-archive`；补 `package.json` 也解决不了根目录/清单/config 保留。

**修法**：
- 语音包从自动更新列表移除；不再下载/尝试覆盖；
- 语音页明确“不参与检查更新，需要新版本时用重新导入离线包”，
  导入保留 config.toml / .venv / models / vendor；
- 不改公开语音仓库，不写语音包专用 updater。

**case**：[docs/cases/2026-10-30-voice-pack-no-auto-update.md](cases/2026-10-30-voice-pack-no-auto-update.md)
**验证**：`plugins/surfcore npm test`（test-updates-voice 新增断言）；`npm run test:audit` 89/89。
**交接**：同步 `plugins/surfcore/lib/index.js`、`plugins/surfcore/lib/client.js`、
`plugins/surfcore/scripts/test-updates-voice.mjs`、docs、manifest；重启 DSH 后更新列表不再出现语音包。

---

### 已发布 v0.7.20 · 2026-10-30 19:30 · SnowLuma 断线通道闸门
<!-- release-batch: start=2026-10-30T19:30+08:00 end=2026-10-30T19:50+08:00 commits=44481cc -->

**覆盖提交**：`44481cc`
**建议**：patch → **0.7.20**（0.7.19 已发布，不重复发）

**问题**：SnowLuma 未启动/掉线时，`proactiveCheck` 仍创建 DSH 会话、跑完整 LLM，
发送失败只写 bridge.log，每 40–90 分钟重复空烧。

**修法**：
- `sendWakePromptV2` 开头检查 `qqSendChannelStatus()`：WS 未连接/最近发送失败 →
  不创建 DSH 会话、不投 prompt、不跑模型；
- `sendToQQ` / `onebotSend` 记录成功/失败；连续 3 次失败 → 该会话自动唤醒暂停 30 分钟，
  `scheduleProactiveCheckV2` 不再排下一次；
- SnowLuma `close` 写 L2 `send-channel-down`，`open` 写 L1 恢复；首次发送失败 L1；
- UI SnowLuma 安装卡显示 `diagnosis.hint`；事件中心弹窗给“启动/重启 SnowLuma，
  确认 3000/3001”的建议；
- 新增 `test-snowluma-channel-gate`（断开/暂停不创建 DSH 会话，恢复后可创建）。

**未做**：首次 HTTP 失败预知、`wasted` 精确金额、端口/进程体检。

**case**：[docs/cases/2026-10-30-snowluma-channel-gate.md](cases/2026-10-30-snowluma-channel-gate.md)
**验证**：`node scripts/test-snowluma-channel-gate.mjs`；`npm run test:audit` 89/89；
`plugins/surfcore npm test`；`node scripts/test-audit-bridge.mjs`。
**交接**：同步 `src/bridge.js`、`src/gate-events.js`、`plugins/surfcore/lib/client.js`、
`scripts/test-snowluma-channel-gate.mjs`、`scripts/audit-bridge-harness.mjs`、manifest、docs。
重启 DSH/桥接后生效；真实停 SnowLuma 观察零 token 增长需手测。

---

### 批次 2026-10-30 17:20 · 闸门事件中心 + 单轮 L3 止血
<!-- release-batch: start=2026-10-30T17:20+08:00 end=2026-10-30T17:35+08:00 commits=3a82618 -->

**覆盖提交**：`3a82618`
**建议**：patch → **0.7.19** 或发布会话当前版本 +1

**新增**：
- `src/gate-events.js`：L0–L3 分级、脱敏、ack、2MB 轮转；
- `src/turn-guard.js` + bridge `guardTurnEvent`：单轮工具步数 40、同一 tool+error 3 次、
  回合内每日额度耗尽 → **cancel-only** 停止 + 直接 QQ 通知；
- `src/dsh-client.cancelTurn()`（不清 inbox）；
- 设置 → 概览「安全提醒」卡片，L2/L3 弹窗；插件 `/gate-events`；
- 兼容性体检 blocker/high 自动进事件中心。

**未做**：单轮费用上限（价格表覆盖不全）、pre-call 阻断、L0/L1 全量生产者接入、
端口/进程归属；报告/文档已标“未检查”。

**case**：[docs/cases/2026-10-30-gate-events-turn-guard.md](cases/2026-10-30-gate-events-turn-guard.md)
**验证**：`node scripts/test-gate-events.mjs`；`npm run test:audit` 88/88；
`plugins/surfcore npm test`；`node scripts/test-audit-bridge.mjs`。
**交接**：同步 `src/gate-events.js`、`src/turn-guard.js`、`src/bridge.js`、`src/dsh-client.js`、
`plugins/surfcore/lib/{index,client}.js`、`scripts/test-gate-events.mjs`、manifest、docs；
重启 DSH 后生效。真实 L2/L3 弹窗与 cancel 时延需手测。

---

### 批次 2026-10-30 16:10 · 插件冲突体检（只读）
<!-- release-batch: start=2026-10-30T16:10+08:00 end=2026-10-30T16:20+08:00 commits=6023a38,36da77c -->

**覆盖提交**：`6023a38`（功能）、`36da77c`（安装清单/接线断言，到本批 HEAD）
**建议**：patch → **0.7.19**（或发布会话当前版本号 +1）

**新增**：设置 → 概览「检查更新」旁「插件体检」。
只读扫描 profile bundles / `cordis.patch.yml` / 已安装包 / 已知第三方插件 / QQ 工具策略。

**能查**：
- 第三方工具是否会被 QQ guard 拒绝（如 `billion-context` 的 5 个上下文工具）；
- 第三方上下文插件是否接管压缩且 `compaction-basic auto=false`；
- 插件未声明工具清单 → `unknown`，报告显示覆盖范围/未检查项；
- 版本/已知规则/`surfcore.compat.json` 声明。

**不能查**：任意第三方工具枚举、最终 prompt、任意自定义状态路径、端口/进程归属、
运行时工具拒绝/重复回复/回合熔断（报告“未检查”）。

**case**：[docs/cases/2026-10-30-plugin-compat-check.md](cases/2026-10-30-plugin-compat-check.md)
**验证**：`node scripts/test-plugin-compat.mjs`；`npm run test:audit` 87/87；
`plugins/surfcore npm test` 全绿；真实 desktop profile 扫描只报 `dsh-whale-widget` 的 unknown info。
**交接**：同步 `plugins/surfcore/lib/compat*.js`、`qq-tool-restrict.mjs` 导出、`client.js`、`index.js`、
`scripts/test-plugin-compat.mjs`、`release/install-manifest.json`、docs。重启 DSH 后按钮生效。

---

### 批次 2026-10-29 23:30 · 管理员称呼投影修复（v0.7.3 后热修）
<!-- release-batch: start=2026-10-29T23:30+08:00 end=2026-10-29T23:40+08:00 commits=00cc8b2 -->

**覆盖提交**：`00cc8b2`
**背景**：`v0.7.3`（212c2b0）只修了浏览中文路径；v0.7.3 不含本修复。
**建议**：patch → **0.7.4**

**问题**：v0.7.2 用户把称呼设为「弥叭」，QQ 提示词仍生成 `称呼「管理员」`，
模型输出「弥叭管理员」。

**根因**：
1. `projectAdminSave` 的 outQq 只写 `ownerQQ`，没投影 `displayName/biliName/gentle`；
2. 桥接独立进程只读 QQ `config.json`，读不到 unified；
3. `adminDisplayName` 没名字时兜底返回 `'管理员'`，把身份词当称呼；
4. 桥接只在启动时读配置。

**修法**：完整 admin 投影写入 QQ config；`adminDisplayName` 空串兜底；提示词明确
「管理员是身份不是称呼」；`ensureAdminProjection()` 启动补投影，桥接在跑自动重启；
`adminFromSources` 回退 QQ 已有 admin，避免升级丢称呼。

**case**：[docs/cases/2026-10-29-admin-display-name-projection.md](cases/2026-10-29-admin-display-name-projection.md)

**验证**：`test-admin-identity`、`test-admin-prompt-wiring`；`npm run test:audit` 83/83；
本机 config 实测提示词含 `称呼「弥叭」`、不含 `称呼「管理员」`。

**发布交接**：同步 `src/admin-identity.js`、`plugins/surfcore/lib/index.js`、`scripts/test-admin-identity.mjs`、`docs/*`；
重启 DSH 后确认插件启动自动补投影/重启桥接，QQ 提示词变为 `称呼「弥叭」`。

---

### 批次 2026-10-29 22:40 · 原生「浏览…」中文路径乱码（v0.7.2 后热修）
<!-- release-batch: start=2026-10-29T22:40+08:00 end=2026-10-29T22:45+08:00 commits=e0fcaf7 -->

**覆盖提交**：`e0fcaf7`
**背景**：`v0.7.2`（5ca9122）之后发现；v0.7.2 不含此修复。
**建议**：patch → **0.7.3**（或按发布会话决定）

**问题**：用户在设置页「导入离线包」选中文目录（如 `D:\...\中文oice-local`），
弹窗报 `IMPORT_PATH_NOT_FOUND`，路径里出现 `�`/`◆`。实际目录存在。
**根因**：Windows PowerShell 5.1 重定向 stdout 用 GBK，Node 按 UTF-8 解码，中文路径损坏。
**修法**：PowerShell 把选中路径写进 UTF-8 临时文件，Node 读文件后删除；不再解析 stdout。
所有「浏览…」（导入/安装目录/SnowLuma）共用 `handleBrowse`，一处修复全部生效。

**case**：[docs/cases/2026-10-29-browse-chinese-path.md](cases/2026-10-29-browse-chinese-path.md)

**验证**：`node --check plugins/surfcore/lib/index.js`；PowerShell 中文路径写 UTF-8 临时文件、Node 读回一致；
真实选择框需重启 DSH 后手测。

**发布交接**：同步 `plugins/surfcore/lib/index.js`、`docs/*`；重启 DSH 后点一次「导入离线包」选中文目录验证。

---

### 批次 2026-10-29 17:00–18:15 · 语音包离线导入 + 参考音频下载修复 + local/cloud 候选包
<!-- release-batch: start=2026-10-29T17:00+08:00 end=2026-10-29T18:15+08:00 commits=a6dadac -->

**覆盖提交**：`a6dadac`（本批次全部代码/文档）
**覆盖到**：2026-10-29 18:15（+08:00）
**建议**：patch → **0.6.23**（与今天前两批同版）

**case**
- [docs/cases/2026-10-29-voice-pack-offline-import.md](cases/2026-10-29-voice-pack-offline-import.md)
- [docs/cases/2026-10-29-cloud-sample-download.md](cases/2026-10-29-cloud-sample-download.md)

**候选离线包（POC，未上传网盘）**
- `D:\surfcore-poc\release\voice-local-offline-v1.0.0-win-x64.zip`（4.7G，SHA256 `9e0a409dce55da45f3049b4a63e596dc4e0a59e517b61e1b44b2f7ef4e68347c`）
- `D:\surfcore-poc\release\voice-cloud-offline-v1.0.0-win-x64.zip`（249M，SHA256 `8ea837706aacf6867ed454f124f878550a696a1b4ba3da1af53e8e46a47ab7ae`）
- 含微调 age12、GPL 合规目录；无 `config.toml`/密钥；云端 speaker 已清空。

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 第三批（17:00–18:15）· 建议并入 v0.6.23】
覆盖提交：a6dadac

一、改了什么
1) 语音包离线导入（local/cloud 共用）
   - 新增 src/voice-pack-import.js：类型/必需文件/manifest sha256/配置/pyvenv 校验；
     copyTree 支持进度/取消，默认只复制、不移动源目录。
   - src/voice-packs.js：inspectImport/startImport/cancelImport/deleteImportSource/
     deleteImportBackup；复制到 .import-*，旧包备份，rename 切换，失败恢复；
     在最终路径改写 pyvenv.cfg；Windows 扫描锁用 120×500ms 重试。
   - src/bridge.js：import-inspect/import/import-cancel/import-delete-source/
     import-delete-backup；ImportError 统一 {code,error,hint,missing,detail}。
   - plugins/surfcore/lib/client.js：导入按钮、确认框（类型/来源/目标/大小/版本/完整性）、
     进度/取消、错误弹窗、源/备份删除；删除旧“手动指定包目录”。
   - plugins/surfcore/lib/index.js：云端参考音频改为 fetch+Blob 下载；新增
     POST /voice/packs/sample-open（explorer /select），解决 target=_blank 没反应。
2) 文档
   - 两个 case、PITFALLS #83/#84/#85、CHANGELOG、HANDOFF、RELEASE 计数 81。

二、测了什么、结果
- npm run test:audit → 83/83
- npm run test:regressions → 全部通过
- plugins/surfcore npm test → 全绿
- node scripts/test-voice-pack-import.mjs → 9/9
- 真实 7.9G 导入：D:/surfcore-poc/stage/voice-local → import-real-packs/voice-local，
  目标 7.6G，源目录保留，pyvenv 指向最终 runtime；.venv/.venv-gsv import 通过。
- 桥接 /api/voice/packs/sample?id=voice-cloud 实测 200 + 922,604B WAV。

三、层级与兼容
- 实现层：导入事务/复制/环境改写；桥接新增只读检查+写操作；插件 UI。
- 接口：新增 import-* 路由；既有接口不变；结构化错误只在 import 链路启用。
- 表现层：设置页导入入口；旧手动指定入口移除。
- 包：候选 zip 仍是 POC 目录，未上传网盘；导入功能在 SurfCore 侧，不要求重打 zip。

四、失败路径
- 类型不符/结构缺失/manifest 哈希不符/目标运行/磁盘不足：导入前拒绝，目标/旧包不动。
- 复制/切换/pyvenv 改写失败：清临时目录、恢复旧包；恢复失败保留 backup 并报
  IMPORT_ROLLBACK_FAILED。
- 取消：只清临时目录；源目录/旧包不动；清理失败报残留路径。
- 无 manifest：先拒绝，用户确认后 allowUnverified 才继续，成功标记 verified:false。

五、没验证
- 设置页实际点击导入/确认框/错误弹窗/删除源/删除备份（需重启 DSH 后手测）。
- DSH 重启后桥接新路由是否生效。
- 真实 7.9G 的取消/旧包恢复现场；UI 的 sample-open（explorer）也未手点。
- 许可：piper GPL、huayan 数据集、age12 微调权重仍待确认；候选包不能直接公开上传。

六、发布时请
- 同步 public 镜像：src/voice-pack-import.js、src/voice-pack-secrets.js、src/voice-packs.js、
  src/bridge.js、scripts/test-voice-pack-import.mjs、scripts/test-audit.mjs、
  plugins/surfcore/lib/{index.js,client.js}、docs/*
- CHANGELOG [Unreleased] 折进 0.6.23
- 重启 DSH 后手测：设置页导入本地/云端包、错误弹窗、参考音频下载/打开目录
- 许可未确认前不要把候选 zip 传到公开网盘
```

**状态**：待发布

### 批次 2026-10-29 13:45–14:30 · 提问回答身份来源 + 主人特权审计 + 权限清单（与上一批同版）
<!-- release-batch: start=2026-10-29T13:45+08:00 end=2026-10-29T14:30+08:00 commits=d976dc0 -->

**覆盖提交**：`d976dc0`（本批次全部改动）
**覆盖到**：2026-10-29 14:30（+08:00）
**建议**：patch → **0.6.23**（与上一批一起发）

**case 文档**
- [docs/cases/2026-10-29-owner-question-audit.md](cases/2026-10-29-owner-question-audit.md)

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 第二批（13:45–14:30）· 建议并入 v0.6.23】
覆盖提交：d976dc0

一、改了什么
1) 提问回答带程序身份来源
   - 新增 src/question-answers.js：[仅主人] 判定、谁能消费 pending、按题型编码来源
   - src/bridge.js：registerPending 记 ownerOnly；消费点非主人不消费 owner-only 提问（不吞消息）；
     handlePendingAnswer 按真实 sender 填来源
   - DSH 单选不允许 selected+custom 并存 → 单选 custom("选项文字"+来源) selected=[]；
     多选 selected + custom(来源)
2) 主人特权操作审计
   - 新增 src/owner-audit.js：state/owner-audit.jsonl，1MB×5、90 天清理、跨文件读尾、失败 health
   - src/bridge.js：7 类事件（审批/提问回答/角色切换/封闭模式拒绝/语音/鱼群 bypass/记忆告警）
   - GET /api/owner-audit（console token；agent token 显式 403）；/api/status 暴露 health
3) 插件与 preset
   - lib/index.js：/owner-audit 代理 + /owner-audit/open（固定 state/，无用户输入）
   - lib/client.js：管理员卡「管理操作记录（最近 50 条）」弹窗（操作者打码）
   - dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 17 条提问分类规则；已重建 preset patch
4) 文档
   - 新增 docs/guides/PERMISSIONS.md；case 2026-10-29-owner-question-audit.md；
     PITFALLS #82、HANDOFF、CHANGELOG、docs/README 索引、RELEASE 计数 80

二、测了什么、结果
- npm run test:audit → 80/80
- npm run test:regressions → 全部通过
- cd plugins/surfcore && npm test → exit 0
- node scripts/test-question-answers.mjs / test-owner-audit.mjs → 通过（含失败分支）

三、层级与兼容
- 实现层：提问编码/消费、审计写入、桥接接线
- 接口：新增只读 GET /api/owner-audit（console token；agent 403），既有接口无破坏；DSH answers 形状按官方约束
- 表现层：设置页弹窗；preset 文本新增一条分类规则

四、失败路径
- 单选 selected 必须为空（否则 DSH bad-response）；owner-only + 非主人不消费 pending；
  审计写入/轮转/清理失败 → health + 限频日志，不静默、不阻塞、不截断；
  审计读取 agent token 一律 403。

五、没验证
- 真实 DSH 问答往返（单选题 custom-only 的模型可见文本）
- 设置页弹窗手点 / 打开文件夹
- preset 安装到 DSH profile + 重启 DSH 后的实际生效提示词
- PERMISSIONS.md 里 5 项「待补程序断言」

六、发布时请
- 同步 public 镜像：src/question-answers.js、src/owner-audit.js、src/bridge.js、
  scripts/{test-audit.mjs,test-question-answers.mjs,test-owner-audit.mjs,audit-bridge-harness.mjs}、
  plugins/surfcore/lib/{index.js,client.js}、plugins/surfcore/presets/qq-chat-v2.patch.yml、
  dsh/agent-presets/qq-chat-v2/agent.cordis.yml、docs/*
- 重启 DSH 后验证 preset 生效与完整问答链路（owner/非主人 × 单选/多选各一次）
- CHANGELOG 的 [Unreleased] 折进 0.6.23
```

**状态**：待发布

### 批次 2026-10-29 11:55–12:35 · SnowLuma 检测 + 失败弹窗 + 云端凭据 + 报错/记录规则
<!-- release-batch: start=2026-10-29T11:55+08:00 end=2026-10-29T12:35+08:00 commits=e07c7e3,161ec97,aa3f7cc,8ef7510,3c4bc5a -->

**覆盖提交**：`e07c7e3`（云端凭据）、`161ec97`（SnowLuma 检测）、`aa3f7cc`（记录规则）、
`8ef7510`（失败弹窗）、`3c4bc5a`（报错规范）、以及本文档所在的提交（队列机制）。
**覆盖到**：2026-10-29 12:35（+08:00）—— 本批次最后一次提交。
**建议**：patch → **0.6.23**

**case 文档**
- [docs/cases/2026-10-29-voice-cloud-credentials.md](cases/2026-10-29-voice-cloud-credentials.md)
- [docs/cases/2026-10-29-snowluma-detect-manual-path.md](cases/2026-10-29-snowluma-detect-manual-path.md)

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 批次 · 建议 v0.6.23（patch）】

一、改了什么
1) 云端语音包凭据边界（e07c7e3）
   - src/voice-packs.js：stripCloudCredentials / ensurePackConfig；新装清空 cloud_app_id/cloud_access_key，
     重装保留用户填的；start() 未配置拒绝启动；list() 暴露 needsCloudConfig
   - plugins/surfcore/lib/client.js、public/console.html：装后引导、通用 placeholder、待填提示
   - 回归 scripts/test-voice-cloud-credentials.mjs（26 断言 + 4 rejections，已进 test:audit）
2) SnowLuma 检测（161ec97）
   - 新增 plugins/surfcore/lib/snowluma-install.js（归一 / 候选 / tried）
   - plugins/surfcore/lib/index.js：detect-snowluma 可选 path；显式路径只校验它、不回退猜测
   - plugins/surfcore/lib/client.js：概览 SnowLuma 卡「浏览…」
   - 回归 plugins/surfcore/scripts/test-snowluma-install.mjs（已进 npm test）
3) 失败弹窗 + 结构化错误（8ef7510）
   - snowLumaMissingReport（code/title/error/hint/tried）；前端 ErrorModal；网络异常也弹窗
   - 同一测试文件扩到 30 项（其中 8 项专测失败报告）
4) 规则与流程（aa3f7cc / 3c4bc5a / 本文档）
   - AGENTS 1.6（讲透逻辑+记录+交接块）、1.7（失败必须可见可行动）
   - docs/guides/ERROR-REPORTING.md、docs/RELEASE.md 交接格式、docs/cases/_TEMPLATE.md、docs/RELEASE-QUEUE.md

二、测了什么、结果
- npm run test:audit → 78/78
- cd plugins/surfcore && npm test → exit 0
- node scripts/test-voice-cloud-credentials.mjs → 通过（26+4）；临时目录读取加 EBUSY/ENOENT 重试
  （Windows Defender/索引器会短暂占住刚写的 config.toml，之前的 77/78 假红是环境抖动，不是产品失败）
- node plugins/surfcore/scripts/test-snowluma-install.mjs → 30 项通过

三、改动层级与兼容
- 云端凭据：实现层（安装清洗 / 启动闸），无接口语义变化
- SnowLuma：实现层 + 接口只加可选 path、失败响应加 code/title/hint/tried（向后兼容）+ UI
- config.json 无新增必填字段；snowluma.launcherPath 语义不变

四、失败路径
- 云端包未配置：start 被拒并提示填三项；检测失败：ErrorModal（试过位置可展开 + 浏览/下载两个按钮）
- 失败分支均有断言

五、没验证
- 真机从 GitHub 公开包全新安装语音（会真下依赖）
- 真机点「浏览…」原生框 / 看失败弹窗（需要桌面会话）
- 公开镜像 surfvoicecloud / surfvoicelocal 的 config.example.toml 里的真实 AppID 未改（编辑器不碰公开仓库）

六、发布时请
- 同步 public 镜像：plugins/surfcore/lib/{client.js,index.js,snowluma-install.js}、
  plugins/surfcore/scripts/test-snowluma-install.mjs、plugins/surfcore/package.json（测试链）
- 把公开镜像两个 config.example.toml 的 cloud_app_id 换成占位符
- CHANGELOG 的 [Unreleased] 折进 0.6.23
```

**状态**：待发布

---

## 已发布

（空）
