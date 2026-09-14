# dsh-ping 设计说明

记录"为什么这么写"，尤其是三个只有真实运行才会暴露的问题。想快速上手看 [README.md](README.md)。

## 1. 约束：不能再被内部包改名弄坏

调研第三方候选时发现的硬事实（见 README 的对比表）：`dsh-notify-me`、`dsh-notify-xc`、
`dsh-notify-sound` 的**客户端 bundle** 都引用了 `@deepseek-ai/dsh-client-runtime`，而这个包在
0.1.5 已经被改名移除。用户 profile 里那个被禁用的 `dsh-notification` 是同一个死因——它的浏览器端
`require` 了一个不存在的模块，导致整个 Web 客户端加载失败。

于是这个插件立了三条规矩：

1. **浏览器端只做最轻的一件事**。最初的做法是干脆不声明 `dsh.client`（"没有浏览器端就不可能
   把 Web 客户端弄坏"）。第四道闸（见第 8 节）需要它，于是把规矩改写成同样保守、但可验证的形式：
   一个**手写的 lazy-CJS bundle**，**一个包都不 `require`**（连 react 都不用）、不注册任何插槽、
   不渲染任何东西、每层入口都包在 `try/catch` 里；它唯一做的事是向本机同源路由 POST 两个布尔值。
   判定标准没变：**这个 bundle 加载失败时，Web 界面必须完全不知道它存在过。**
2. **不 import 任何 `dsh-*` 内部包**。宿主事件、服务、工具定义都用本地声明的结构类型描述
   （`src/protocol.ts`），字段一律当作可选。唯一运行时依赖是 `@deepseek-ai/schemastery`，
   它是独立版本线的 vendor 包，不随 `dsh-*` 改名而变。
3. **工具不用 `defineTool`**，直接注册普通对象（`{name, description, parameters, output, execute}`）。
   modlens 就是这么做的，证明注册表接受裸定义。

代价是事件负载没有编译期类型。这被测试补回来了：负载形状是照着
`packages/interaction/user-approval/src/types.ts` 等宿主源码写的，并在真实 launcher 里跑过。

## 2. 事件选择

| 用途 | 事件 | 为什么是它 |
|---|---|---|
| 回合结束 | `agent/status`（`running`→`idle`） | 宿主唯一的生命周期状态机，`AgentStatus` 就是 `'idle' \| 'running'`。持久事实在 `session/event` 里，但那是给回放用的，实时控制面在 `agent/*`。 |
| 出错 | `agent/error` | 与状态对里，但错误不该等到回合结束才说。 |
| 等批准 | `approval/request` | 宿主问"谁能批"的瀑布。 |
| 等回答 | `user-questions/request` | 同上，`ask_user_question` 工具最终走到这里。 |
| 回答摘要 | `session/event` 的 `assistant/message` | 通知正文里最有用的是模型最后说了什么。 |

**为什么不去 hook 审批的持久事件**：`approval/asked` 之类是落盘后的事实，而"现在有人卡在等你"
是实时状态。瀑布是在**问**的那一刻触发的，正好是用户需要被打断的那一秒。

### 一次回合只通知一次

`agent/status` → `running` 时记下开始时间；`agent/error` 时标记 `sawError` 并**立刻**发错误通知；
`idle` 时如果这一轮已经报过错就闭嘴，否则发「任务完成」。这样"先报错再结束"不会变成两条通知。

开始时间同时提供了时长，用来（a）显示"用时 2 分 13 秒"，（b）支持 `minTurnDurationMs` 这个闸。

## 3. 噪音模型：什么时候**不**通知

第一版把 `minTurnDurationMs` 默认设成 `0`，理由是"不要偷偷替用户过滤掉东西"。这是错的。一个正常
会话每问一句就是一次回合结束，于是**每问一句弹一次通知**。用户第一反应就是"为什么在不需要通知的
时候频繁弹出"——这个反馈是对的，默认值本身就是设计缺陷。

通知的价值完全建立在"你可能已经走开"这个前提上，而**回合时长是宿主侧唯一拿得到、还说得通的代理
指标**：

| 情况 | 判定 | 理由 |
|---|---|---|
| 回合 < `minTurnDurationMs`（默认 20 秒） | 不弹 | 你还在键盘前，答案你自己会看到 |
| 回合 >= 20 秒 | 弹 | 你可能去干别的了 |
| 出错 / 待批准 / 待回答 | 一定弹（只受冷却约束） | 与"你走没走开"无关，是"需要你介入" |

所以时长闸**只作用于 `done`**。这不是图省事，是语义：闸门回答的是"用户是否可能不在"，而只有
"任务完成"这一类才需要问这个问题——出错和待决定，用户不在场恰恰是最需要叫他的时候。

顺带确认了宿主侧没有更好的信号，也没有别的噪音源：

- `agent/status` 把 `maintenance` 阶段也映射成 `idle`，但 `runMaintenance` 要求进入时已是 idle，
  状态串走的是 idle→idle，`setPhase` 只在状态**串**变化时才 emit，所以维护阶段不会多发一条。
- 子代理由 `parentAgent` + `options.origin === 'subagent'` 双重标记，`rootsOnly` 能可靠过滤；
  workflow 里各分支的完成不会刷屏。
- `agent/error` 只在终点失败边界 `throwError` 里 emit 一次；可重试的失败走
  `agent/request-error` 瀑布，不会每次重试都弹。
- 冷却按「会话 + 类型」计，所以"批准"和"提问"互不压制，连续同类事件才会合并。

## 4. 瀑布：必须 prepend，且必须 next()

`approval/request` 和 `user-questions/request` 都是 **waterfall**：监听器要么认领请求
（返回结果），要么 `next()` 交给下一个。这里有两个陷阱：

1. **不 prepend 就可能永远看不到请求。** 如果真正的应答者（Web UI 那条链路）先注册，它会直接
   认领，我的监听器根本不会被调用——插件会"装上了但从来不通知"。所以两个都用
   `{ prepend: true }`。
2. **必须原样转发。** 监听器写成 `(req, next) => { 通知(req); return next() }`：先做自己的事，
   再把 `next()` 的 Promise 原样返回。返回值不能被吞、不能被改写，否则"谁能批准"这件事就变了。
   一个通知插件把审批搞坏，比不通知严重得多。

所有观察代码都包在 `guard()` 里。测试里专门构造了一个 getter 会抛异常的负载，验证：异常被吞掉、
日志里有记录、`next()` 仍然被调用。

## 5. 三个只有真实运行才会暴露的问题

### 5.1 `detached: true` 让通知静默消失（最严重）

通知用 `spawn` 异步发出、不阻塞会话。最初加了 `detached: true`，理由是"万一在 DSH 退出瞬间发的
通知也别被带走"。结果：**通知一条都没弹出来，而且 PowerShell 还是退出码 0**。

在隔离 profile 里跑真实事件总线时发现：控制台那行 `[dsh-ping] DSH · 任务完成 — …` 打出来了，
但 Windows 通知中心里没有对应记录。用四种 spawn 组合做了对照实验：

| 组合 | 退出码 | 进通知中心 |
|---|---|---|
| `detached=false`, `stdio=ignore` | 0 | **是** |
| `detached=false`, `stdio=pipe` | 0 | **是** |
| `detached=true`, `stdio=ignore` | 0 | 否 |
| `detached=true`, `stdio=pipe` | 0 | 否 |

结论：detached 的 Windows 进程没有控制台，Windows PowerShell 5.1 在这个状态下加载 WinRT 类型、
调用 `Show()`、然后正常退出，**什么都没发生**。去掉 `detached`，靠 `unref()` 保持非阻塞。

这个坑能被抓到，唯一原因是验证做在了"通知中心里有没有这条记录"这一层，而不是"进程退出码是不是 0"。
`tests/toast.e2e.mjs` 现在同时覆盖同步诊断路径和**真实投递路径**——两者 spawn 参数不同，
而只有后者在会话里跑。

### 5.2 手搓的 `session/event` 能把整棵树打崩

真实 launcher 的驱动脚本最初 `ctx.emit('session/event', session, {type:'assistant/message', …})`
来喂回答摘要。结果：

```
dsh: fatal load failure: TypeError: SessionLogOffset must be a non-negative safe integer, got undefined
    at SessionProjectionRegistry.drive
    at ping-driver.mjs:31:9
```

伪造的事件缺了 `seq` 之类的持久信封字段，session-projection 的监听器直接抛异常，整棵树倒了。

两件事：其一，这**不是** dsh-ping 的问题——它只读事件、从不 `emit`，而且自己的监听器都有 guard；
其二，它说明**测试夹具也必须遵守宿主契约**。夹具改成只发安全的 `agent/status` 和两个瀑布，
回答摘要的提取逻辑改由 `tests/plugin.test.mjs` 对着 stub context 覆盖。测试因此分成三层：

| 层 | 覆盖什么 | 需要什么 |
|---|---|---|
| `decide.test.mjs` | 判定规则、文本组装、XML 转义与注入抵抗 | 无 |
| `plugin.test.mjs` | 装配、去重、瀑布转发、异常隔离 | 假 context |
| `toast.e2e.mjs` | 通知真的进了 Windows 通知平台 | Windows + 真实弹窗 |
| 隔离 profile 手工验证 | 真实 launcher 挂载 + 真实事件总线 | 一个 lab profile |

### 5.3 正文里工作区名重复

`buildNotice` 在会话没有标题时用工作区名兜底当主语，但附加信息行里又拼了一次工作区，
于是出现 `… · api · api`。单元测试抓到后改成：附加行里的工作区与主语相同时不再重复。

## 6. 安全：通知内容不碰 PowerShell 源码

设计目标：**会话里的任何文本都不可能被当作 PowerShell 求值**。做法是让 PowerShell 脚本成为一个
不含任何插值的常量：

- 脚本经 `-EncodedCommand`（base64 UTF-16LE）传入，命令行上不出现文本；
- 通知内容在 **JS 里**组装成 XML，XML 特殊字符先转义；
- XML 再 base64 编码，经环境变量 `DSH_PING_XML` 送达；脚本只做
  `$xml.LoadXml([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:DSH_PING_XML)))`。

`LoadXml` 的参数是一个 .NET 字符串**值**，不是 PowerShell 表达式，所以文本里的 `$(...)`、反引号、
`'@` 都只是数据。文本里的换行还会被 `flatten()` 压平，进一步保证不会提前终止任何宿主语法。

测试里用一段同时包含 `"$(Start-Process calc.exe)"`、`'@`、`</text></binding>…` 的恶意标题，
断言：注入的文本没有多出任何元素（结构里 `<toast>`/`<binding>` 各只出现一次）、属性不能被提前
闭合、脚本里不含注入文本。*（这条断言最初写错了——把"文本节点里的 `$()`"当成了注入。它确实会
出现在 XML 里，但那是数据。断言改成了真正成立的性质：文本无法离开自己的节点。）*

另外子进程环境是**白名单重建**的（`minimalEnv()`），通知助手只拿到 Windows 必需的那几个变量，
不会顺带继承 API Key。

## 7. 不做的事

- **不做浏览器端通知**：那是踩雷最多的路径（`Notification` API + `dsh-client-*` 内部包）。
  系统通知在窗口切走时反而更可靠。浏览器半边只上报"人在不在看"，不自己弹东西。
- **不去重到"完全静音"**：宁可让用户用 `debug: true` 看到每条被抑制的通知和原因，
  也不引入一套猜不透的抑制规则。
- **不在宿主侧猜窗口焦点**：宿主确实拿不到浏览器焦点。第 8 节的信号来自**页面自己**，
  拿不到时一律退回时长闸 —— 不猜、不硬编码、不假装知道。


## 8. 第四道闸：页面自己说"我在看"

第三版的噪音模型全部建立在"回合时长是有没有走开的代理指标"上。这个代理有两个方向的错：
一个 5 分钟的任务，用户可能一直在屏幕前看着（弹了就是打扰）；一个 25 秒的任务，用户可能早就
切走了（不弹就是失职）。宿主侧**永远**拿不到正确答案，因为"看不看屏幕"只存在于浏览器里。

### 8.1 信号

`client/index.js`（手写 lazy-CJS）在页面里做四件事：

1. `document` 的 `visibilitychange`、`window` 的 `focus`/`blur` 时各上报一次；
2. 每 15 秒心跳一次（页面被切走时事件不一定可靠，心跳是兜底）；
3. `apply` 时立刻上报一次（宿主可能在页面之后才起来）；
4. 上报体只有 `{visible, focused}`，POST 到同源路由 `/dsh-ping/presence`，
   `credentials: 'same-origin'` + `keepalive: true`。

`visible` 读 `document.visibilityState`（旧接口 `document.hidden` 兜底），`focused` 读
`document.hasFocus()`（抛异常按 false 处理）。这两个 API 是页面自己的事实，不需要任何人猜。

宿主侧 `src/presence.ts` 只做三件事：**解析**（两个字段必须是布尔值，别的都丢掉）、
**打时间戳**（用宿主时钟 `receivedAt`，不信页面上的时间 —— 一台时钟错乱的机器不能把插件钉死
在静音状态）、**判新鲜**（`presenceTtlMs` 默认 45 秒，心跳的 3 倍）。

### 8.2 判定顺序与作用范围

`shouldNotify` 里这条闸排在冷却之后、时长闸之前：

```
enabled → kind → subagent → cooldown → 【前台抑制（只对 done）】 → 时长闸（只对 done） → ok
```

- **只抑制 `done`**。出错、待批准、待回答是"需要你介入"，跟"你看没看屏幕"无关。
- **没有信号就是不抑制**（`foreground` 没有值 ≠ false）：标签页关掉、页面崩了、没装浏览器半边、
  宿主没重启过 —— 全都退回原来的时长闸，行为与第三版一致。
- **报告是易腐的**：45 秒没更新就当没信号。所以"关掉标签页之后再也没人上报"不会把通知永久静音。
- 报告体上限 4 KiB（超了直接丢），只接受 POST（其他方法 405）。

### 8.3 为什么单独一条路由，而不是复用别的

路由是插件命名空间下的 exact 路由 `/dsh-ping/presence`，不走 `/api`，和 `dsh-restart` 的
`/dsh-restart/status` 同一个理由（见工作区 AGENTS 第 3 节：插件路由不经过连接的请求栅栏）。
它是**只写**的：页面往里写、宿主只读内存里的最新一份，没有任何东西回吐给页面 ——
一个不需要鉴权的热点路由，能说的越少越好。

### 8.4 验证

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `tests/presence.test.mjs`（25 项） | 解析（拒非布尔/数组/null）、ttl 边界（恰好等于算新鲜）、宿主时钟判定、体积上限 |
| 判定 | `tests/decide.test.mjs`（+10 项） | 前台抑制只压 `done`；`error`/`approval`/`question` 一律不受影响；没信号退回时长闸；顺序（冷却 > 前台 > 时长） |
| 装配 | `tests/plugin.test.mjs`（+25 项） | 路由注册与 method/体积/类型拒绝、真发一条 status 之后的静音、ttl 过期后恢复、路由冲突不影响通知 |
| 浏览器半边 | `tests/client.test.mjs`（34 项） | 事件/心跳/首次上报、payload 逐字节、二次 apply 不叠定时器、fetch 抛错/被拒/hasFocus 抛异常/无 setInterval 都不炸 |
| 真浏览器 | `tests/presence.browser.mjs`（14 项） | 真页面 + 真 DOM：首次上报、blur 后 `focused:false`、隐藏后 `visible:false`、回来又是 `true,true` |

浏览器检查里那条"宿主启动图里还没有 `dsh-ping/client.js` 就手工实例化 bundle"的兜底是刻意的：
**它会在屏幕上打印 note**，不会让"宿主还没挂上"看起来像"通过"；重启一次 DSH 之后走的就是宿主
自己加载那条路径。
