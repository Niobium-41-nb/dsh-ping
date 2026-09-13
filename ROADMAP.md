# dsh-ping 未来计划

写给下一个接手这个插件的 Agent。**先读仓库根的 `DESIGN.md`（为什么是这样）与工作区的
`../AGENTS.md`（硬规则与验证手册）**，再动代码。

每条都给了「为什么」与「验收标准」。

---

## P0 — 收尾：两件已经"能用"但还不够稳的事

### 0.1 webhook 通道没有测试

**现状**：`channels.ts` 里的 `sendWebhook` 只有代码路径，没有测试覆盖；
`plugin.test.mjs` 里 webhook 是关着的（默认配置就是关的）。

**为什么值得做**：这是唯一的"离开本机"的通知通道，用户不在电脑前时全靠它；
而它现在完全没被验证过（超时、非 2xx、连接失败三种错误路径都只写了日志）。

**验收**：起一个本地 HTTP 服务当 webhook 端点，断言：
- 收到 `{kind, title, lines, sessionId, at}`；
- 非 2xx 时只记日志、不抛；
- 超时时不卡住调用方（`webhookTimeoutMs`）；
- 端点挂掉时其余通道照常工作。

### 0.2 `captureEnvironment` 的默认值需要重新决策

**现状**：默认 `true`，会把启动时的全部环境变量写进 `instances/<key>/launch.json`
（本机实测 **97 个**，含 PATH、代理以及任何 `DEEPSEEK_*` 之类的凭据）。
文件按 `0600` 创建，但 **Windows 不认 Unix 权限位**，实际保护来自 `~/.dsh` 继承的用户 ACL ——
和 `.credentials.yaml`、`settings.yaml` 同级。

**为什么值得做**：这是"原样重启"的前提（不捕获环境就无法精确还原），
但同时也是这个插件里唯一会把凭据落盘的地方。README 已经写明，但默认值仍值得再想一遍。

**可选做法**：默认改为 `false`（Agent 用它自己继承到的环境启动），
或在写盘时对名字匹配 `KEY|TOKEN|SECRET|PASSWORD` 的变量做**脱敏占位**并记录"已脱敏"标记。
后者更复杂（脱敏后重启就不再"原样"），要权衡。

**验收**：无论选哪种，README/DESIGN 与实际行为一致，且**重启后 dsh 仍能正常工作**。

---

## P1 — 让它更"只在该提醒的时候提醒"

### 1.1 只在用户没看页面时通知（最想要的一项）

**现状**：宿主侧拿不到浏览器焦点，只能用回合时长近似（`minTurnDurationMs` 默认 20 秒）。
副作用：一个 25 秒的任务，即使你一直盯着屏幕也会弹一次。

**做法**：加一个客户端半边，用 `document.hasFocus()` / `visibilitychange` 维护
"页面是否在前台"，通过宿主路由告知插件；插件在"前台且有焦点"时抑制 `done` 类通知
（**不该抑制** `error` / `approval` / `question`）。

**约束**（见工作区硬规则 1、2）：
- 客户端半边必须手写 lazy-CJS，只 `require('react')`，`dsh.client.inject` 留空；
- 组件渲染不得抛异常；
- 必须能在宿主拿不到该信号时优雅退化到现在的时长闸。

**验收**：页面在前台时短任务不弹；切到别的窗口后同样的任务会弹；
关掉浏览器（无客户端）时退回时长闸行为。**并且**：客户端半边加载失败时不得影响 Web 界面。

### 1.2 免打扰时段

`quietHours: { from: '23:00', to: '08:00' }`：时段内 `done` 静默，`error`/`approval`/`question` 仍通知
（或可配）。跨零点的区间要处理。

### 1.3 去重粒度

现在按「会话 + 类型 + 冷却」去重，同一个错误反复发生时仍会每隔 30 秒弹一次。
可以考虑对 `detail` 做内容指纹，相同内容在更长时间窗内只弹一次。

---

## P2 — 平台与体验

| 项 | 说明 |
|---|---|
| 跨平台通知 | 现在只有 Windows toast；macOS 用 `osascript`/`terminal-notifier`，Linux 用 `notify-send`。其它平台目前静默降级到 console 输出 —— 至少要在 README 里写清楚 |
| 每种事件可配提示音 | 现在固定 Default（完成/出错）/ Reminder（待决定），可以升成配置项 |
| 通知里带会话跳转 | DSH Web 端目前没有会话级深链路由；等上游支持再加 |
| `dsh_ping_test` 增强 | 现在返回"走通了哪些通道"，可以扩成列出每个通道的可用性与最近一次错误 |

---

## P3 — 工程

1. **与 `dsh-restart` 共享工具代码**：PowerShell 调用、base64/UTF-16LE 编码、最小环境白名单、
   原子写 —— 两边各写了一遍。抽 `dsh-plugin-kit` 时要保留"单文件可复制"的选项，
   因为这个插件刻意不依赖任何本地包（README 里承诺过）。
2. **CI**：typecheck + `decide`/`plugin` 单测；**`toast.e2e.mjs` 必须排除**（需要 Windows + 真实桌面 + 会打扰人）。
3. **CHANGELOG**。
4. **发布到 npm**（2026-09-11 起挂账，2026-09-13 更新结论）：npm 上的 `dsh-ping` 属于别人
   （yoyu-dev），只能以 `@vanadium-23/dsh-ping` 发布；脚本 `../.scratch/publish-npm.mjs`
   负责临时改名与还原（manifest 已补 `repository`）。
   **卡的不是 token**：9-13 实测当前那枚带 `bypass_2fa` 的 token 能读不能发布（npm `EOTP` /
   pnpm `ERR_PNPM_OTP_NON_INTERACTIVE`），**而且 `npm login --auth-type=web` 也不解锁**
   （换过凭据后重发仍是 `EOTP`）。做法只有一个：**人在真终端里跑**
   `node ../.scratch/publish-npm.mjs`，让 CLI 能提示输入动态码（agent 的非 TTY shell 永远过不去）。
   状态与长期方案见 `../AGENTS.md` 第 4.3 节与硬规则 22。

---

## 已知取舍（**故意如此，别"顺手修"**）

- **`minTurnDurationMs` 只作用于 `done`**：出错与待决定是"需要你介入"，与"你走没走开"无关，
  任何时候都该提醒（仍受 30 秒冷却约束）。把它套到 error 上是**回退**，不是改进。
- **`rootsOnly` 默认开**：子代理在父代理回合里跑，逐个通知会刷屏。
- **默认 20 秒 / 30 秒是刻意的**：第一版默认 0 秒 = 每问一句弹一次，用户直接反馈"为什么频繁弹"。
  回归测试 `plugin.test.mjs` 的 "the shipped defaults are quiet" 一节就是防这个回退的，别改默认值去让它变绿。
- **通知助手用 `detached: false`**：detached 的 Windows 进程没有控制台，PowerShell 会**静默失败**（退出码 0）。
  这是实测结论，注释里写了，别改回去。
- **`/health` 的 CORS 只放行回环来源**：公网页面没有理由探测本机的重启守护。
- **通知内容全部走 XML 而不是拼进脚本**：见工作区硬规则 14。

## 验收纪律

改任何东西之后：`tsc --noEmit` → 三个测试全绿（59 + 43 + 10）→ 需要时上隔离 lab profile →
最后才动真实环境。

**`toast.e2e.mjs` 会真弹通知**：只在你确认可以打扰用户时跑；
它的历史读取已加判空（真实历史里有 `Content` 为 `null` 的条目，不判空会误判成"通知没发出去"）。
