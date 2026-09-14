# dsh-ping

给 DeepSeek Harness 用的**桌面通知插件**：任务跑完、出错、等你批准、等你回答的时候，弹一个
Windows 原生通知，顺便在终端留一行。跑长任务时可以切走窗口，不用一直盯着页面。

```
DSH · 任务完成
重构完成，91 项断言全过。
重构 dsh-ping · proj · 2 分 13 秒
```

## 为什么不直接用现成的

GitHub / npm 上 dsh 通知插件不少，但**能装在你这套 DSH（0.1.5-rc.1）上的不多**。我把候选包拉下来
逐个查了依赖面，结果：

| 包 | 周下载量 | 结论 |
|---|---|---|
| `dsh-notify-me` | 5039 | ✗ 客户端 bundle 声明依赖 `@deepseek-ai/dsh-client-runtime`（该包在 0.1.5 已被移除），并且只声明兼容到 0.1.2-rc.1 |
| `dsh-notify-xc` | 257 | ✗ `lib/client.js` 里直接 `require` 了同一个已移除的包 |
| `dsh-notify-sound` | — | ✗ 同样引用已移除的包 |
| `dsh-notify`（Pasumao） | 112 | ✓ 可用，宿主侧 Windows Toast + 托盘图标 |
| `dsh-notify-windows`（SeverusZh） | 236 | ✓ 可用，宿主侧 Windows Toast |

你机器上那个**已经装了但被禁用**的 `dsh-notification` 就是同一个死因：它的浏览器端还
`require("@deepseek-ai/dsh-client-runtime/client")`，装上会让整个 Web 客户端卡在
"Failed to load plugins"。

所以这个插件按同一个约束从零写：**宿主侧、没有浏览器端、运行时只 import 一个 `schemastery`**
（配置校验库，独立于 `dsh-*` 内部包），不去碰任何会改名的内部模块。这也是它比上面那些"能用"
的候选更抗版本漂移的地方。

## 安装

```bash
# 在 <HARNESS> 下执行
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add file:<PLUGINS>/dsh-ping
```

`dsh-ping` 的 package.json 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它追加进
`dsh.profile.bundles`，**不需要**再往 `cordis.patch.yml` 里手写 insert 行（两处都写会
`duplicate loader entry id`）。装完重启一次 DSH 生效。

卸载：`... plugin --profile web remove dsh-ping`

## 什么时候会通知

| 时机 | 判定依据 | 标题 | 声音 |
|---|---|---|---|
| 一轮任务跑完 | `agent/status` 由 `running` 变 `idle` | `DSH · 任务完成` | Default |
| 出错 | `agent/error` | `DSH · 出错了` | Default |
| 等你批准 | `approval/request` 瀑布 | `DSH · 等你批准` | Reminder |
| 等你回答 | `user-questions/request` 瀑布 | `DSH · 等你回答` | Reminder |

后两个是**长通知**（`duration="long"`）并且用不同的提示音，所以在通知中心一眼能分辨
"跑完了"和"卡在等你"。

一轮里如果先出错、再结束，只会有一条「出错了」，不会重复。

## 不打扰你的几道闸

通知只在"你可能已经走开"时才值得打断你。判定规则：

- **`minTurnDurationMs`（默认 20 秒）**：**只作用于「任务完成」**。短于 20 秒的回合说明你人还在键盘前，
  响一声纯属打扰 —— 你正看着屏幕上的答案。想让每轮都提醒就设 `0`。
- **`suppressWhenFocused`（默认开）**：浏览器半边每 15 秒（以及每次切标签页/切窗口）告诉宿主
  "这个页面是不是可见且在前台"；如果答案是"是"，说明你正在看这一轮的回答，**「任务完成」就不弹**。
  这条比时长闸准：一个跑了 5 分钟但你一直在旁边看的任务不会响，一个 25 秒但你切去浏览器别处的
  任务会响。信号超过 `presenceTtlMs`（默认 45 秒）没更新就作废，退回时长闸 —— 标签页关掉、
  页面崩溃、或者没装浏览器半边，行为都和以前完全一样。
- **`cooldownMs`（默认 30 秒）**：同一会话同一类型 30 秒内只提醒一次，用来吸收连续回合和抖动。
- **`rootsOnly`（默认开）**：只通知根会话。子代理（subagent）、workflow 里各分支的完成都不刷屏。
- **出错 / 等你批准 / 等你回答不受时长闸限制**：这三类是"需要你介入"，哪怕只跑了 2 秒也该叫你
  （仍然受 30 秒冷却约束）。
- 每个时机都能单独关：`notifyOn.done / error / approval / question`；整个插件也能关：`enabled: false`。

一句话版本：**你不在页面上的时候，长时间任务的完成会叫你；你正看着页面，就不叫；
出错和等你决定，任何时候都叫你。**

（"正在看页面"由浏览器半边直接观察 `document.visibilityState` 与 `document.hasFocus()` 得出，
不是猜的。这个半边只 `fetch` 本机同源路由 `/dsh-ping/presence`，不上报任何内容、不注册任何界面、
不依赖任何 `@deepseek-ai/dsh-client-*` 包。）

> 想确认某条通知为什么没弹（或为什么弹了），把 `debug: true` 打开，每条被抑制的通知和原因都会打到
> stderr，例如 `suppressed done (too-short)` / `suppressed done (cooldown)`。

## 先自检，再依赖它

**命令行**（不用启动 DSH，会真弹一条通知）：

```bash
node <PLUGINS>/dsh-ping/lib/smoke.js 随便一句正文
```

**会话里**：让模型调用 `dsh_ping_test` 工具，它会弹一条自检通知并回报走通了哪些通道。

**没弹出来？** 按顺序查：`设置 → 系统 → 通知` 里 **Windows PowerShell** 是否被允许；
「专注助手 / 免打扰」是否开着；通知是否进了通知中心但没弹横幅。
（Windows 通知的发送者是 Windows PowerShell 的 AUMID，这是脚本弹 Toast 的标准做法。）

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: dsh-ping
  config:
    rootsOnly: true          # 子代理不通知
    cooldownMs: 30000        # 同会话同类最小间隔
    minTurnDurationMs: 20000 # 「任务完成」短于这个时长不通知（只作用于完成，0 = 每轮都通知）
    suppressWhenFocused: true # 页面可见且在前台时，不弹「任务完成」
    presenceTtlMs: 45000     # 浏览器半边的信号多久算过期（过期就退回上面的时长闸）
    notifyOn:
      done: true
      error: true
      approval: true
      question: true
    channels:
      toast: true            # Windows 原生通知
      console: true          # 终端里打一行
      webhook: false         # POST 到你自己的地址
    webhookUrl: ''           # 例如 https://example.com/hook
    url: ''                  # 点击通知跳转的地址；留空自动用 Web GUI 的回环地址
    maxBodyChars: 180        # 正文摘要截断长度
    titles:                  # 想改文案就改这里
      done: 'DSH · 任务完成'
      error: 'DSH · 出错了'
      approval: 'DSH · 等你批准'
      question: 'DSH · 等你回答'
    debug: false             # 打开后会把每条被抑制的通知和原因打到 stderr
```

## 安全

- **通知正文永远不进 PowerShell 源码。** 脚本是一个常量，经 `-EncodedCommand` 传入；通知内容
  以 XML 形式经环境变量送到脚本里，直接交给 WinRT 的 XML 解析器。会话标题、报错信息、工具名里
  写什么都不可能被当作 PowerShell 求值。
- **XML 值全部转义**，文本不可能跳出自己的节点；文本里的换行会被压平，因此也不可能提前终止任何
  宿主语法。
- **子进程环境是白名单重建的**，只保留 `SystemRoot`/`PATH`/`TEMP` 之类 Windows 必需项 ——
  通知助手不会顺带继承你的 API Key、代理凭据或 token。
- 插件只**读**宿主事件，从不 `emit`；两个瀑布监听器一律 `return next()`，所以它不可能改变
  "谁来批准"。

## 已知限制

- Windows Toast 依赖 Windows PowerShell 5.1（`pwsh` 不行，WinRT 类型投影只在 5.1 里）。
  非 Windows 主机上 toast 通道自动跳过，console / webhook 照常工作。
- **页面在前台时的判定依赖浏览器半边**：DSH 的 Web 页面开着（哪怕是后台标签页）就会上报。
  如果页面没开、或者宿主启动时这个插件还没有浏览器半边（需要重启一次 DSH 才会挂上），
  就只能退回 `minTurnDurationMs` 的时长近似。想彻底不看「任务完成」就 `notifyOn.done: false`。
- **多标签页只认最后一份报告**：同一个人开两个标签页时，后一次上报覆盖前一次；一个标签页可见、
  另一个隐藏，结果以最后说话的那个为准。这是刻意的：单值状态比合并策略好预测。
- 点击通知只能打开 Web GUI 根地址（DSH 的 Web 端目前没有会话级深链路由）。

## 开发

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit      # 类型检查
node node_modules/typescript/bin/tsc -b tsconfig.json               # 编译
node node_modules/tsdown/dist/run.mjs                               # 打包

node --experimental-strip-types tests/decide.test.mjs    # 69 项：判定规则（含前台抑制）与文本/XML 组装
node --experimental-strip-types tests/plugin.test.mjs    # 68 项：假上下文里的装配、路由、瀑布行为
node --experimental-strip-types tests/presence.test.mjs  # 25 项：前端信号的解析、有效期、体积上限
node tests/client.test.mjs                               # 34 项：浏览器半边（stub window + document）
node --experimental-strip-types tests/webhook.test.mjs   # 26 项：webhook 通道（真 HTTP 端点：2xx/非 2xx/超时/拒连）
node tests/presence.browser.mjs                          # 14 项：真浏览器里页面真的上报了前台状态
node --experimental-strip-types tests/toast.e2e.mjs      # 10 项：真弹通知并回读通知中心（会打扰人）
```

`tests/presence.browser.mjs` 需要一个在跑的 Web GUI（`DSH_GUI_URL`，默认 3080）和 Chrome
（`CHROME_PATH`），没有就跳过 —— **跳过不算通过**。它只观察请求，不停任何服务。
如果宿主是在装上浏览器半边之前启动的（启动图里没有 `dsh-ping/client.js`），它会明确打印一行
note 然后改为在页面里手工实例化这个 bundle，**不会把"宿主还没挂上"伪装成通过**；重启一次 DSH
之后它会走宿主自己加载的那条路径。

`node_modules` 里的 `@deepseek-ai/*` 是指向 `<HARNESS>` 的 junction，只用于编译期类型。

**改完代码要让 profile 用上新构建**：pnpm 对 `file:` 依赖是按内容快照装的，直接再跑 `add` 会说
"Already up to date"。要 `remove` 再 `add`，然后重启 DSH。

接下来要做什么，见 [ROADMAP.md](ROADMAP.md)；工作区级的硬规则与验证手册见 `../AGENTS.md`。

详见 [DESIGN.md](DESIGN.md)。
