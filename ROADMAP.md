# dsh-ping 未来计划

写给下一个接手这个插件的 Agent。**先读仓库根的 `DESIGN.md`（为什么是这样）与工作区的
`../AGENTS.md`（硬规则与验证手册）**，再动代码。

每条都给了「为什么」与「验收标准」。

---

## P0 — 收尾：两件已经"能用"但还不够稳的事

### 0.1 webhook 通道没有测试 —— ✅ 已完成（2026-09-14）

**做法（已实现）**：新增 `tests/webhook.test.mjs`（26 项），每个用例都跑在**真实
`node:http` 服务**上（"实际有没有 POST 出去、失败时是不是安静的"这种性质，mock 证明不了）：

- `sendWebhook` 直测：POST + `content-type: application/json` + 正文与 payload 逐字节一致；
  2xx 不记日志；非 2xx 记一行 `webhook answered 503` 且不抛；
  拒连立刻 settle；服务器挂起时**按 `webhookTimeoutMs` 收口**（120 ms 预算、2 秒内返回），
  不等默认 5 秒；空 url 是 no-op。
- 插件装配层：真发一条 `running → idle` 之后端点确实收到
  `{kind:'done', title, lines, sessionId, at}`；端点返回 500 时 **console 通道照常**、
  stderr 有记录、事件总线没有被异常打穿；`webhookUrl` 为空或通道关闭时一个请求都不发。

### 0.2 `captureEnvironment` 的默认值需要重新决策（**这条属于 `dsh-restart`，不是本仓库**）

> 记在这里是笔误：`captureEnvironment` 是 `dsh-restart` 写 `launch.json` 的配置项，
> 请到 `../dsh-restart/ROADMAP.md` 跟踪。下面这段原文保留，作为当时的判断依据。

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

### 1.1 只在用户没看页面时通知 —— ✅ 已完成（2026-09-14）

**做法（已实现）**：见 `DESIGN.md` 第 8 节。`client/index.js`（手写 lazy-CJS，**一个包都不
`require`**、不注册插槽、不渲染）在 visibilitychange / focus / blur 与 15 秒心跳时把
`{visible, focused}` POST 到同源路由 `/dsh-ping/presence`；宿主侧 `src/presence.ts` 校验
（两个字段必须是布尔）、盖宿主时钟、按 `presenceTtlMs`（默认 45 秒）判新鲜；
`shouldNotify` 在冷却之后、时长闸之前插一条**只对 `done`** 的抑制。
没有信号 = 不抑制，所以标签页关掉 / 页面崩掉 / 宿主还没重启过，行为与以前完全一致。
新配置：`suppressWhenFocused`（默认 true）、`presenceTtlMs`（默认 45000）。

**验收证据**：
- `tests/presence.test.mjs` 25 项（解析、ttl 边界、宿主时钟、体积上限）；
- `tests/decide.test.mjs` 59 → 69 项（前台抑制只压 `done`；三类 attention 事件不受影响；
  没信号退回时长闸；顺序是 冷却 > 前台 > 时长）；
- `tests/plugin.test.mjs` 43 → 68 项（路由注册、method/体积/类型拒绝、静音与 ttl 恢复、
  路由冲突不影响通知、关掉开关时根本不注册路由）；
- `tests/client.test.mjs` 34 项（事件与心跳、payload 逐字节、二次 apply 不叠定时器、
  fetch 抛错/被拒、`hasFocus` 抛异常、没有 `setInterval` —— 全都不许炸）；
- `tests/presence.browser.mjs` 14 项：**真 Chrome + 真页面**，断言首次上报、blur 后
  `focused:false`、隐藏后 `visible:false`、回来又是 `true,true`。它只观察请求，不停任何服务。

**仍然待做**：宿主是在装上浏览器半边之前启动的，得**重启一次 DSH** 才会把
`dsh-ping/client.js` 放进启动图（`presence.browser.mjs` 会明确打印这个 note，
并改为在页面里手工实例化 bundle，**不会把它伪装成通过**）。

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
2. **CI** —— ✅ **已完成（2026-09-14）**：`.github/workflows/check.yml` 跑 typecheck + 五个测试文件
   （decide / plugin / presence / client / webhook）。`runs-on: windows-latest`（通知通道就是
   in-box PowerShell 5.1 的 toast）、**不配 pnpm 缓存**（没有 lockfile）。
   `toast.e2e.mjs` 与 `presence.browser.mjs` 不入 CI：前者会真弹通知打扰人，后者需要 Web GUI +
   Chrome 且"跳过不算通过"—— 两个都留在本机跑。
3. **CHANGELOG**。
4. **发布到 npm** —— ✅ **已完成（2026-09-13）**：以 `@vanadium-23/dsh-ping@0.1.0` 上线
   （`dsh-ping` 这个名字属于 yoyu-dev，只能用 scope 别名；脚本临时改名、发完还原）。
   走通的做法：**人在真终端里跑** `node ../.scratch/publish-npm.mjs`，pnpm 对每个目标打印一条
   `Authenticate your account at: https://www.npmjs.com/auth/cli/<uuid>` + 二维码，回车 →
   浏览器过 2FA → 该包发布成功。**换凭据解决不了**（`bypass_2fa` token 与 `npm login
   --auth-type=web` 都只解决"读"），**agent 的非 TTY shell 永远过不去** —— 见 `../AGENTS.md`
   第 4.3 节与硬规则 22。
   产物已读回验证（`node ../.scratch/verify-published.mjs`：名字/版本/`repository`/
   `README`+`LICENSE` 齐全，无 `workspace:` 泄漏）。
   **免 token 发布的 workflow 已入库（2026-09-13）**：`.github/workflows/publish.yml` 用
   trusted publishing（OIDC）发布；**只剩 npm 侧的 trusted publisher 配置**（每个包一次，
   需人在浏览器里过 2FA）—— 照工作区根目录的 `TRUSTED-PUBLISHING.md` 做，里面也写了两个
   会静默失败的坑与限制（私有仓库没有 provenance、OIDC 只覆盖 publish 命令、只支持云托管运行器）。

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
