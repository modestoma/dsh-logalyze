# 观象（dsh-logalyze）

> **观其象，知其因。**

观象是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的日志分析插件。

名称取意于《周易》的观象思想：以日志为象，以推理为径，从复杂的系统运行痕迹中洞察异常、关联线索、追溯根因。

界面上显示的插件名是「观象」；npm 包名、入口命令、工具、路由、配置文件和代码标识统一使用 logalyze。

## 项目状态

初版（未发布到 npm）：打通「`/logalyze` 入口 → 识别应用 → 派发子 Agent 到应用代码仓库 → 汇总结论」这条链路，附带一个示例应用仓库。接口仍可能调整。

## 核心能力

观象的能力按名称拆分为三个层次，由浅入深：

| 能力 | 关注点 | 规划内容 |
|---|---|---|
| **观** | 看见 | 解析日志、提取线索、发现异常 |
| **象** | 理解 | 理解系统行为、关联事件、构建问题全貌 |
| **推演** | 求因 | 借助 AI Agent 自主分析、验证假设、定位根因 |

### 观：解析日志，发现异常

- 解析常见的结构化与半结构化日志格式，统一为可检索的事件记录。
- 提取时间、级别、模块、请求标识、错误信息等关键字段作为线索。
- 识别错误突增、异常堆栈、频率偏离等可疑信号。

### 象：关联事件，构建全貌

- 按时间线、请求链路和组件关系关联分散的日志事件。
- 将多个异常信号归并为同一问题，还原问题发生的上下文。
- 呈现系统在问题时段内的行为全貌，为后续推演提供依据。

### 推演：自主分析，定位根因

- 由 AI Agent 基于「观」与「象」的结果提出根因假设。
- 主动检索更多日志与上下文，对假设逐一验证或排除。
- 输出可追溯的分析过程与结论，说明每个判断所依据的日志证据。

## 工作方式

观象是分体结构：插件只负责识别与派发，各应用的日志分析知识跟着应用代码放在应用自己的仓库里。

```
用户：/logalyze 订单服务昨晚 21 点下单报 500，日志见附件
        │
        ▼
入口 SKILL（意图识别）── 先 fetch 各仓库，应用目录由远端最新提交的 .agents/logalyze.yaml 生成
        │  logalyze_dispatch({ tasks: [{ app, question, logs }] })
        ▼
派发工具：校验应用 id → 下载 URL 日志 → 并行启动子 Agent，等待全部结束
        │  子 Agent 工作目录 = 应用仓库，首条消息以 /<skill> 开头加载该应用的日志分析 SKILL
        ▼
父 Agent 按应用分节汇总，涉及多个应用时给出跨应用的推演
```

- **一个入口，两种触发。** 入口 SKILL 是 `/logalyze`，dsh 在 Web、TUI、ACP 以及经飞书渠道插件的飞书消息中都能识别它。有可用应用且 `autoInvoke` 开启（默认）时，模型也能自行加载：dsh 给顶层 Agent 的 skill 目录里，观象的描述会列出每个可用应用的名称、id、别名和日志特征（总长不超过 500 字，放不下的只计数），用户说「分析这份订单服务的日志」或贴出带 `OrderController` 的报错时，模型会先加载观象。日志明显不属于任何已注册应用时，入口 SKILL 让模型按普通方式处理，不派发也不追问。分析子 Agent 的工作目录在 `dshRepos` 服务的镜像目录内，改进与起草子 Agent 的工作区在运行目录内，这些位置都不列出观象。应用增删时 dsh 会追加一条新的 skill 目录消息；想要确定触发时仍用 `/logalyze`。
- **派发由代码完成。** 模型只给出应用 id、问题和日志位置；仓库目录、应用 SKILL、并发上限都由插件决定。应用 id 必须与注册表一一对应，否则整次派发被拒绝。
- **日志一律以绝对路径交给子 Agent。** 附件和本机文件直接传路径；消息里的对象存储下载链接由派发工具下载（只允许白名单域名，不带鉴权，限制大小与耗时）。日志包不解压，由应用的日志分析 SKILL 在运行目录里解压。
- **应用目录随时最新。** 每次加载 `/logalyze` 都先经 `dshRepos` 服务 fetch 各仓库（间隔由 `fetchIntervalMs` 控制，默认每次），再从远端分支最新提交的只读快照读取应用描述生成应用目录。新提交有自己的快照，所以正在进行的分析不会挡住更新。最多等待 `refreshWaitMs`，超时就先用已有的目录，拉取在后台继续。
- **代码快照不可变。** 分析子 Agent 在 `dshRepos` 服务按提交创建的只读快照里工作，派发期间持有快照，结束后释放。
- **运行目录。** 每次派发在父会话目录下创建 `.logalyze/runs/<runId>/<序号>-<应用 id>/`，下载的日志放在这里，分析子 Agent 也只在这里写文件；代码快照对分析子 Agent 只读。
- **等待式派发。** 工具等待所有子 Agent 结束后一次返回，一条消息对应一张完整回复；超过派发超时或调用被取消时停止仍在运行的子 Agent。子会话中不提供派发工具。
- **结果带仓库和提交。** 每个应用的结果写明应用仓库地址和分析的提交（「仓库 <地址>，提交 <前 12 位>」）。用户随后要求修复分析发现的代码问题时，入口 SKILL 让模型按普通编码任务处理，从这个仓库地址和提交开始，不在运行目录或代码快照里改代码。
- **仓库只在 dsh-repo 中配置。** 应用仓库就是 dsh-repo 仓库清单中打开了「日志分析」功能的仓库：观象启动时向 dsh-repo 注册这个功能，读取清单，清单变化（加仓库、删仓库、改分支、开关功能）后立即重新配置并拉取。观象自己不保存仓库列表。
- **在对话中接入仓库。** 用户给出仓库的 https 地址时，模型可以经用户授权把它加入 dsh-repo 的仓库清单并打开日志分析；仓库缺少应用描述或 SKILL 时，派一个子 Agent 在工作区里起草，经 dsh-repo 的审批推送为合并请求，见[在对话中接入仓库](#在对话中接入仓库)。
- **SKILL 改进（默认开启）。** 子 Agent 觉得应用的日志分析 SKILL 没能支撑这次分析时，父 Agent 先给出分析结论，在回复末尾附上 SKILL 改进建议；用户在之后的消息里同意（或主动指出 SKILL 的记录有误、要求改进）后，由一个改进子 Agent 把该应用的所有改进点一次改进完，在工作区里修改 SKILL 并把问题整理为 `cases/` 下的案例，观象经 `dshRepos` 服务（推送前由 dsh-repo 审批）推送到应用仓库的新分支并创建合并请求（GitLab MR 或 GitHub PR）供评审，见 [SKILL 改进](#skill-改进)。

## 安装与配置

观象以 dsh bundle 交付（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），Host 半侧运行 `lib/index.js`，浏览器半侧运行 `lib/client.js`。

安装已发布的 npm 版本（推荐）：

```bash
# 在 deepseek-harness 仓库内：把 npm 包安装进 web profile
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add dsh-logalyze
```

本地 checkout 开发时：

```bash
pnpm build
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-logalyze
```

npm 发行包已包含构建产物；本地 `link:` 安装前必须先执行 `pnpm build`。安装或修改后重启 dsh。包内的 `cordis.patch.yml` 把 `dsh-logalyze` 加入 profile 的 bundle 列表，并提供稳定 `id: logalyze` 的 Loader 行。可在 profile 的 patch 中按该 id 配置默认值：

```yaml
- id: logalyze
  config:
    fetchIntervalMs: 0                 # 加载 /logalyze 时距上次拉取超过该时间的仓库先 fetch；0 = 每次
    maxAppsPerRequest: 4               # 单次派发的任务上限
    dispatchTimeoutMs: 1800000         # 等待全部子 Agent 的上限
    download:
      allowedHosts: [oss.example.com]  # 同时允许子域名；为空时不下载 URL
      maxBytes: 536870912
      timeoutMs: 600000
    subagentProvider: spawn            # 子 Agent 使用的 ctx.subagents provider
    refreshWaitMs: 15000               # 加载 /logalyze 时等待 fetch 的上限；0 = 不等待
    autoInvoke: true                   # 任务匹配已注册应用时模型可自行加载入口 SKILL；false = 只能输入 /logalyze
    skillUpdates:                      # SKILL 改进，见下文
      enabled: true                    # 默认开启；false = 子 Agent 不记录 SKILL 不足，也不询问
      maxFiles: 16                     # 一次改进最多新增或修改的文件数
      maxFileBytes: 262144             # 改进中单个文件和 SKILL 不足记录的大小上限
    analyze:                           # 日志平台分析接口，见下文
      enabled: false                   # 默认关闭
      upload:                          # 报告回传（请求带 logId 时），见下文
        command: [cli, log-analysis, upload, --log-id, '{logId}', --dir, '{dir}', --entry, '{entry}']
        timeoutMs: 300000              # 单次上传超时
        retries: 3                     # 失败后再试的次数
        retryDelayMs: 60000            # 第一次重试前的等待，之后每次加倍
        maxFiles: 200                  # 报告目录文件数上限
        maxBytes: 209715200            # 报告目录总大小上限
    analyzeTokenRef: LOGALYZE_ANALYZE_TOKEN  # 接口访问令牌在 DSH 凭据库中的名称
```

配置在加载时校验，不合法时插件加载失败。应用仓库不在这里配置：以前的 `repos` 键会让插件加载失败，错误说明改到 dsh-repo 的「代码仓库 → 仓库」中添加这些仓库并打开「日志分析」；面板设置文件 `settings.json` 里留有 `repos` 时整个文件不生效，面板显示同样的原因，保存一次即覆盖。旧的仓库列表不会自动迁移。

### 应用仓库与拉取

观象自己不运行 git，也不依赖其他插件的包。仓库清单、只读快照、工作区和推送 SKILL 修改都调用运行时的 `dshRepos` 服务（服务版本 6，例如由 [dsh-repo](https://github.com/modestoma/dsh-repo) 提供），它用到的方法见 `src/repos/contract.ts`。没有该服务或服务版本不符时观象没有应用仓库，原因显示在设置面板。

- 观象在服务出现时注册功能 `log-analysis`（标题「日志分析」），dsh-repo 设置页的每个仓库多一个「日志分析」开关；插件卸载时撤销注册。
- 应用仓库是 `repoList({ feature: 'log-analysis' })` 返回的仓库，按清单里的分支拉取：每次拉取取该分支最新提交的只读快照（`snapshotAcquire`，dsh-repo 先从远端 fetch），从快照读出应用描述和 SKILL 后立即释放。清单变化后观象重新配置注册表，新出现或分支变了的仓库立即拉取，被删除或关掉功能的仓库在进行中的分析结束后移除。
- 仓库在清单里的权限决定观象能做什么：「只读」可以分析；起草接入（`logalyze_submit_init`）和 SKILL 改进要推送分支、创建合并请求，需要「可改代码」，否则 dsh-repo 以 `not-allowed` 拒绝，原因转告用户。

主机、访问令牌和镜像目录都在提供 `dshRepos` 的插件中配置；观象面板「应用仓库」分页的「在 dsh-repo 中管理仓库」跳到 dsh-repo 的设置页。该服务报告主机或令牌变更后，观象自动重新拉取全部仓库。镜像目录没有默认值：服务报告未设置（`settingsGet().mirrorDir` 为 `undefined`）时，仓库拉取、代码快照、SKILL 改进和接入起草都失败并带上服务给出的原因，面板「应用仓库」分页显示提示和「去设置镜像目录」按钮；设置后下一次 `/logalyze` 或「重新拉取」即恢复。

子 Agent 的命令在 dsh 的文件沙箱中运行：镜像和代码快照只读，只有父会话的项目目录可写，运行目录就在其中。SKILL 改进和接入起草的工作区也建在运行目录里，所以父会话必须有项目目录，工作区必须位于其中，子 Agent 才能修改工作区里的文件。工作区是 dsh-repo 创建的普通 git 克隆，带自己的 `.git`，`origin` 经 dsh-repo 的本机 git 代理访问远端；子 Agent 被要求只改文件、不执行 git 写操作，提交和推送由观象经 `workspacePush` 完成。dsh-repo 不允许工作区套在另一个工作区里，所以会话目录本身是 dsh-repo 工作区时（例如在 dsh-repo 设置页「工作区」里新建的目录中开的会话）无法改进 SKILL 或起草接入，工具报出 dsh-repo 的原因。Linux 的 bubblewrap 沙箱会把 `/tmp` 换成空的临时目录，所以镜像目录不能放在 `/tmp` 下（dsh-repo 拒绝这样的目录），否则子 Agent 的命令看不到仓库。飞书会话的文件访问被渠道插件限制在话题目录内，所以部署时镜像目录不能在 DSH 主目录或渠道的会话目录下，并且要把代码快照目录 `<镜像目录>/.snapshots` 加入渠道插件的可读目录，分析子 Agent 才读得到代码。

### 设置面板

DSH Web 左侧栏的「观象」入口打开整页设置面板：

| 分页 | 内容 |
|---|---|
| 应用仓库 | 只读：dsh-repo 清单中打开了「日志分析」的仓库，每个仓库的分支、拉取状态、提交号、应用描述与不可用原因，单个或全部重新拉取，以及跳转到 dsh-repo 设置页的按钮 |
| 日志下载 | 允许下载的域名、单文件大小上限、下载超时 |
| 分析接口 | [日志平台分析接口](#日志平台分析接口)的开关、访问令牌（只显示是否已设置）、飞书渠道是否就绪、[报告回传](#报告回传)的命令与上限、最近 50 份报告的回传记录（可手动重新上传），以及调用地址与字段摘要 |
| 高级 | 更新间隔、单次应用数上限、派发超时、SKILL 改进开关与文件上限，恢复 cordis.yml 配置 |

面板保存的值写入 `$DSH_HOME/logalyze/settings.json`（只保存与 cordis.yml 不同的字段），按与配置相同的规则校验；分析接口令牌存入 DSH 凭据库。面板接口 `/logalyze/*` 使用 DSH 自己的登录与来源校验，写操作另做同源校验。

## 应用仓库约定

每个应用仓库需要两样东西（完整示例见 [examples/order-service](examples/order-service)，接入步骤与 SKILL 写作要点见[应用仓库接入指南](docs/app-repo-guide.md)）：

`.agents/logalyze.yaml` 应用描述：

```yaml
id: order-service               # 小写短横线格式，派发与分析请求按它对应应用
name: 订单服务                   # 显示名，也是子 Agent 的标签
description: 下单、库存扣减与支付回调
aliases: [订单, 下单, order]     # 用户对它的其他叫法
logHints: [order-service, OrderController]   # 能识别本应用日志的字符串
skill: log-analysis             # 对应 .agents/skills/log-analysis/SKILL.md
```

`.agents/skills/<skill>/SKILL.md`：这个应用的日志分析流程（如何解压日志包、日志格式、代码结构、常见问题）。它不能设置 `user-invocable: false`，因为派发时用 `/<skill>` 加载。

插件拉取仓库后检查这两个文件；缺失、不合法，或多个仓库声明同一个 id 时，相关应用不可用，原因显示在设置面板。应用描述和 SKILL 必须是普通文件，不能是符号链接。DSH 也从 `.dsh/skills/` 加载项目 SKILL，并且同名时它优先，所以应用仓库不要在 `.dsh/skills/` 下留同名的 SKILL。从清单删除仓库或关掉日志分析不会删除本地镜像。

## SKILL 改进

`skillUpdates.enabled` 默认开启（设置面板「高级」→「SKILL 改进」可以关闭）。分析中 SKILL 没覆盖到的问题，以及用户指出的 SKILL 错误，经用户同意后沉淀为 SKILL 修改和案例，以合并请求的形式交给仓库维护者评审。改进有两个来源：分析子 Agent 记录的不足，和用户的反馈。分析结论总是先给出，改进放在用户同意之后的回合里；同一应用的所有改进点由一个改进子 Agent 一次完成。工作区、推送和创建合并请求经 `dshRepos` 服务完成，应用仓库所在的主机要在提供该服务的插件中配置令牌；没有该服务或版本不符时工具报错。

1. **分析子 Agent 记录不足。** 子 Agent 的任务消息多出一节说明：分析完成后，只有 SKILL 写错了或缺了内容、让它走了弯路或差点得出错误结论时（日志格式描述不对、缺少这类故障的排查方法或排除规则、代码路径过时），才在运行目录写 `skill-gap.md`，记下 SKILL 哪里不足、实际怎样定位、关键日志行（去掉具体数据）和代码位置；只是多查了几步，或缺的是只在这一次出现的细节，不算不足。子 Agent 不修改 SKILL，SKILL 足够时不写这个文件。
2. **先给结论，再给改进建议。** 派发结束后，观象检查已完成任务的记录（普通文件、UTF-8 文本、大小不超过 `maxFileBytes`），在结果中标出「SKILL 不足」和记录摘要。顶层 Agent 照常写完分析结论，在回复末尾附一节「SKILL 改进建议」，每个应用一两句，问用户是否改进，然后结束这一回合，用户不用等改进。观象记住本次 DSH 运行中每个已完成的派发任务，供之后的改进引用。
3. **用户也可以主动要求。** 分析按 SKILL 已有的记录走了，用户事后指出那条记录有错；或者在新会话里直接说「优化一下订单服务的日志分析 SKILL」。这时顶层 Agent 先用 `logalyze_show_skill` 读出现有 SKILL（最新同步提交中的文件列表和某个文件，默认 `SKILL.md`，只读），对照着和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后再进入下一步。改进子 Agent 不能和用户对话，所以讨论放在改进之前。
4. **用户同意后改进。** 用户在对话中同意后，顶层 Agent 为每个要改的应用调用一次 `logalyze_improve_skill`。改进子 Agent 起草期间不再询问；推送前由 dsh-repo 弹出一次审批（见第 6 步）。参数是 `app`，加上可选的 `feedback`（用户的纠正或补充，尽量保留原话）、`workDirs`（作为依据的分析运行目录）和 `logs`。省略 `workDirs` 时，工具自动取本会话中该应用记录了 `skill-gap.md`、还没改进过的全部分析，所以同一应用的多次分析和用户的补充合并在一次改进里；没有这样的分析时 `feedback` 必填。下面几条由工具保证，不只靠提示词：该应用有本回合派发的分析时工具报错，分析回合不会开始改进（观象从 DSH 的 `session/event` 中数会话结束的 `turn/end`）；同一会话同一应用每回合只发起一次改进、同时只运行一次；发起改进就把用到的分析记为已改进，无论成败之后都不再自动取用，用户要求重试时用 `workDirs` 指定。
5. **改进子 Agent 起草。** 观象经 `dshRepos.workspaceCreate` 在新的运行目录 `.logalyze/runs/<runId>/improve-<序号>/repo/` 从应用最新同步提交创建工作区，推送分支是新的 `logalyze/skill-<应用 id>-<runId>`，以它为工作目录启动一个改进子 Agent，首行用 `/logalyze-improve` 加载观象自带的改进指南。任务消息给出改进的依据：每次分析的问题、结论、`skill-gap.md`（如果有）、运行目录和日志，用户反馈（与现有内容冲突时以用户反馈为准，并对照代码核实），以及附带的样例日志，并要求所有改进点在这一次修改中完成。子 Agent 直接修改工作区中的 `.agents/skills/<skill>/`：对 `SKILL.md` 或 `references/` 的修改、案例 `cases/<日期>-<slug>.md`（每个不同的问题一个案例，写现象、脱敏的日志特征、根因、定位路径、确认与排除、本次 SKILL 改进），以及 `SKILL.md` 中「案例索引」表的行；改动说明写进工作区之外的 `improve-<序号>/reason.md`，第一行是标题，不写类型前缀。子 Agent 不执行 git 写操作。等待上限是 `dispatchTimeoutMs`。
6. **检查并推送。** 子 Agent 结束后，观象经 `dshRepos.workspaceStatus` 读出工作区相对起始提交的改动（已提交和未提交的都算）并检查：只接受 `.agents/skills/<skill>/` 下新增或修改的普通文件，文件名受限，内容是 UTF-8 文本，文件数与大小不超过上限；工作区里其他位置的任何改动（包括临时文件），以及删除、重命名或改变文件类型，都让整份修改不合格；依据分析时必须新增或修改 `cases/` 下至少一份案例，只依据用户反馈时案例可选；`SKILL.md` 的 frontmatter `name` 不能变，也不能设置 `user-invocable: false`。合格后在 `improve-<序号>/changes.diff` 写出 diff，由观象进程（不是 Agent）调用 `dshRepos.workspacePush`，把工作区的改动提交、推送到工作区的分支并创建合入跟踪分支的合并请求，一步完成。SKILL 改进的提交只用 `chore` 类型：提交说明首行和合并请求标题都是 `chore: <标题>`，标题开头若带 `feat:`、`fix(...):` 等类型前缀会先去掉。dsh-repo 为调用的会话发 `access/authorize`，并按它的「写操作」设置弹出和它自己的推送工具相同的审批卡片（列出文件、分支和合并请求），用户拒绝时不推送，改动留在工作区。工具返回改动文件、改进子 Agent 的改动说明和合并请求链接，父 Agent 转告用户，评审在合并请求中进行。修改不合格或子 Agent 没有完成时工具返回原因，不推送；用户要求重试时在之后的回合再调用一次；远端分支已有其他提交时不推送；推送成功但合并请求创建失败时返回分支和失败原因，可以在代码托管平台上手动创建。从不推送到已有分支或默认分支，合并后下次 `/logalyze` 拉取即生效。

**改进指南 `/logalyze-improve`。** 正文在包内的 [skills/logalyze-improve/SKILL.md](skills/logalyze-improve/SKILL.md)，写明怎样判断缺口类型、案例模板与脱敏规则、哪些知识补进 `SKILL.md` 或 `references/`、怎样维护「案例索引」，以及改动说明的格式。和接入套件一样在任何目录都列出，只能由用户输入或首行手势加载；开发者也可以在自己的仓库里输入 `/logalyze-improve`，手动把一次排查沉淀为案例。

注意：

- 支持 GitLab（包括自建实例）和 GitHub。应用仓库的 https 地址要能被 `dshRepos` 识别为已配置主机上的仓库；该主机的令牌要能推送分支和创建合并请求（GitLab 上需要 `api` 权限，GitHub 上需要 Contents 和 Pull requests 的读写权限）。
- 有写权限的令牌可以改动它能访问的所有项目。建议用只覆盖应用仓库的项目或组访问令牌，设置过期时间，并保护应用仓库的默认分支。
- 推送和合并请求都为调用的 Agent 发起：`dshRepos` 先发 `access/authorize` 事件问其他插件这个会话能不能改代码（例如飞书渠道插件按发起人或群的权限回答），被拒绝时以 `forbidden` 失败、不问用户；提交者是该主机令牌所属的账号，作者和尾注由其他插件通过 `repo/commit-trailers` 事件决定（例如飞书私聊里作者是发起人，群里加 `Feishu-Chat:` 尾注），观象不再自己配置作者。提交说明末尾有 `DSH-Session: <会话 id>`，合并请求描述也写明了来源会话与分析提交。
- 日志内容不可信，可能诱导模型写出不当的 SKILL 或在案例里留下未脱敏的数据。观象只限制改动范围，内容需要合并请求的评审者把关。

## 在对话中接入仓库

除了在 dsh-repo 的仓库清单里添加，用户也可以在对话里说「把 https://gitlab.example.com/shop/order.git 接入观象」。顶层 Agent 有三个工具，子会话中都不提供：

| 工具 | 何时提供 | 做什么 |
|---|---|---|
| `logalyze_add_repo` | 总是 | 参数为仓库 https 地址和可选分支。先发 `access/authorize`（级别 `admin`），再经用户一次性授权，然后调用 `dshRepos.repoAdd` 把仓库加入 dsh-repo 仓库清单并打开日志分析：新条目权限为「可改代码」，已有条目只打开功能、权限和分支不变（分支不同时报错）。授权和审批都由观象完成，调用 dsh-repo 时不带 Agent，dsh-repo 不再询问。等待第一次拉取结束，返回应用可用、需要起草或拉取失败的原因。地址已是应用仓库时不请求授权，只重新拉取 |
| `logalyze_init_repo` | 有仓库已拉取但缺少应用描述或 SKILL 时 | 参数为仓库地址、可选的用户说明和样例日志（`path` 或白名单内的 `url`）。经 `dshRepos` 在运行目录 `.logalyze/runs/<runId>/init/repo/` 从最新同步提交创建工作区（推送分支为新的 `logalyze/init-<runId>`），以它为工作目录启动一个起草子 Agent，首行用 `/logalyze-kit` 加载接入套件，直接在工作区写出 `.agents/logalyze.yaml` 和一个日志分析 SKILL（大型仓库按领域拆到 `references/`），说明写在工作区之外的 `init/reason.md`；结束后检查初稿并写出 `init/changes.diff`，不推送 |
| `logalyze_submit_init` | 本会话有起草结果时 | 参数为起草的运行目录（`…/init`）。在其中找到工作区并重新检查初稿；这份初稿已经推送过时直接报告分支已存在。调用 `dshRepos.workspacePush`，经 dsh-repo 的审批把工作区的改动提交、推送到工作区的分支，并创建合入跟踪分支的合并请求；提交说明首行和合并请求标题是 `chore: 接入观象日志分析：<应用名>（<应用 id>）` |

**接入套件 `/logalyze-kit`。** 观象自带一个 SKILL，写明怎样为应用仓库编写应用描述和日志分析 SKILL：从代码和日志配置里找什么、`logalyze.yaml` 字段、SKILL.md 与 `references/` 的结构模板、约束和自检清单。正文在包内的 [skills/logalyze-kit/SKILL.md](skills/logalyze-kit/SKILL.md)，插件加载时读取，缺失或不合法时加载失败。它在任何目录都列出（包括子 Agent 所在的仓库快照），只能由用户输入或首行手势加载，模型不会自行选用。开发者也可以在自己的仓库里运行 dsh，输入 `/logalyze-kit` 直接编写或改进 SKILL。

初稿的检查规则与拉取时相同：`logalyze.yaml` 合法，SKILL 存在、frontmatter 的 `name` 等于 `skill` 字段、不设置 `user-invocable: false`，应用 id 不与其他仓库重复；工作区的改动只能是 `.agents/logalyze.yaml` 和它指定的 `.agents/skills/<skill>/` 下新增或修改的文件，其他位置的改动、删除、重命名都让初稿不合格，文件数和大小上限沿用 `skillUpdates.maxFiles` 与 `maxFileBytes`（关闭 SKILL 改进时同样生效）。起草子 Agent 的等待上限是 `dispatchTimeoutMs`。推送前由 dsh-repo 为调用的会话发 `access/authorize`，并按它的「写操作」设置经 DSH 的审批服务弹出审批：经 dsh_channels 使用时显示为飞书决策卡片，在 DSH Web 中显示为审批提示；只有「允许」才推送，会话的审批策略为 `never`（例如 DSH 的「完全访问」权限模式）时请求一律被拒绝。令牌权限、提交作者和合并请求的规则与 [SKILL 改进](#skill-改进) 相同；合并后下一次 `/logalyze` 拉取即启用该应用。检查按推送后的内容进行：被仓库忽略规则（如 `.gitignore`）排除的文件不会被推送，应用描述或 SKILL 被忽略时初稿不合格。用户拒绝提交时，初稿仍在运行目录的工作区中，可以再次提交或手动提交。

## 日志平台分析接口

日志平台调用观象的分析接口：观象经飞书渠道插件的 `feishuTopics` 服务（例如由 [dsh_channels](https://github.com/modestoma/dsh_channels) 提供）在指定群里发一张分析卡（发起人、触发时间、应用、错误码和日志详情页表格），在卡片下开话题，把平台给的 prompt 原样交给一个新 Session（prompt 开头的斜杠命令由 DSH 展开成对应 SKILL，例如 `/logalyze`），分析过程在话题内流式输出。分析结束后分析卡的状态标签随之更新，群里通过准入的成员都可以在该话题内追问。日志包地址写在 prompt 里，下载、解压、超时都由 prompt 调用的 SKILL 处理（Session 的沙箱需要能访问日志存储地址）。

**前提**：

- 飞书渠道插件已加载并提供 `feishuTopics` 服务（版本 2）。没有这个服务时观象不注册接口；服务版本不兼容时观象记一条警告，也不注册。设置面板「分析接口」分页显示飞书渠道是否就绪。
- 只有带 Web 的 profile（web、desktop）有这个接口，headless 没有。

**开启**：在设置面板「分析接口」打开开关（`analyze.enabled`，默认关，保存后立即生效），并在同一页保存访问令牌（建议 32 位以上随机串）。令牌存入 DSH 凭据库的 `LOGALYZE_ANALYZE_TOKEN`（名称可用 `analyzeTokenRef` 修改），也可以设置同名环境变量或写进 `.env`。接口挂在 DSH Web 服务上（与 Web 界面同一端口），路径 `/open-api/logalyze` 放在 DSH 的 `/api` 之外，网关可以把它与需要登录的 DSH 接口分开放行；DSH 通过反向代理挂在前缀下时，地址随之带上前缀（如 `https://<域名>/dsh/open-api/logalyze`）。该路由不走 DSH 登录 cookie，访问令牌是唯一凭据。开关关闭时所有请求返回 404；令牌每次请求都重新读取，轮换后下一次请求生效；令牌未设置时所有请求返回 503。

**请求**：

```http
POST /open-api/logalyze
Authorization: Bearer <令牌>
Idempotency-Key: <平台生成的唯一值，1-200 个可见 ASCII 字符>
Content-Type: application/json

{
  "requesterUserId": "a1b2c3d4",
  "triggeredAt": "2026-10-22 19:30",
  "app": "camera",
  "errorCode": "E1001",
  "logDetails": [
    { "name": "设备 A 崩溃日志", "url": "https://logs.example.com/detail/1" },
    { "name": "设备 B 崩溃日志", "url": "https://logs.example.com/detail/2" }
  ],
  "chatId": "oc_xxx",
  "prompt": "/logalyze https://logs.example.com/1.zip https://logs.example.com/2.zip 请分析这些日志",
  "logId": "LA-20261022-0001"
}
```

- `requesterUserId`：平台发起人的飞书 user_id，分析卡 @ 此人，首轮以此人的身份提交，所以此人要在飞书渠道插件的用户表里有对话权限（否则返回 `403`）；话题归群，群里有对话权限的成员都能追问。
- `triggeredAt`：平台上发起分析的时间，1–64 字符，原样显示在分析卡上（时区和格式由平台决定）。
- `app` / `errorCode`：只允许 `A-Z a-z 0-9 . _ -`（1–128 字符），显示在分析卡上并参与请求指纹。每次分析的话题目录由飞书渠道插件按群和话题决定（`<baseDir>/groups/<chat_id>/<话题 id>/`），观象不再指定工作区。
- `logDetails`：触发分析的日志在日志平台上的详情页，1–50 条，每条 `name`（1–200 字符）+ `url`（http/https）。只在分析卡的表格里列出，观象不会访问这些地址。
- `chatId`：目标群，机器人需在群内；群本身不需要授权，群话题的知识库与代码改动权限在飞书渠道插件设置面板的群权限里按群配置。
- `prompt`：1–100000 字符，原样作为首条用户消息；带 `logId` 时最多 98000 字符，观象在后面追加一节「报告文件」，说明报告目录的写法（见[报告回传](#报告回传)），不带时不追加任何内容。
- `logId`：可选，日志平台上这次分析的 id，1–128 个 `A-Z a-z 0-9 . _ -`，不能以 `-` 或 `.` 开头。带上后观象在每一轮结束时把报告回传给平台；它计入幂等指纹。
- 只接受以上 8 个字段，多余字段返回 400。

**响应**：校验通过、分析卡发出后立即返回 `202`：

```json
{ "ok": true, "chatId": "oc_xxx", "messageId": "om_xxx" }
```

`messageId` 是分析卡的消息 id，分析话题挂在它下面。同步错误都带中文 `error`：`401` 令牌无效、`404` 接口开关未打开（或接口未注册）、`405` 不是 POST、`400` 参数或 `Idempotency-Key` 不合法、`403` 发起人（`requesterUserId`）没有对话权限、`409` 同一个 `Idempotency-Key` 已被内容不同的请求使用、`413` 请求体超过 1 MiB、`415` 不是 JSON、`502` 分析卡发送失败（如机器人不在群里）、`503` 飞书未连接或未设置令牌。

**去重**：同一个 `Idempotency-Key` 再次请求（包括并发重试）原样返回第一次的结果，不会再发卡、再分析。记录由飞书渠道插件永久保存。分析卡发出后的失败（话题创建、Session 创建）不会回滚这条记录：分析卡的状态变成「失败」并写明原因，需要重试时请换一个新的 `Idempotency-Key`。

**群里看到的**：先是分析卡「@发起人 于 <triggeredAt> 发起了对 X 应用 Y 错误码不良日志的分析」，下面是日志详情页表格，标题栏标签为「分析中」；紧接着话题内一张流式卡片，首轮分析在这里流式输出，带停止按钮。首轮结束后分析卡的标签变成「已完成」「已停止」或「失败」；DSH 在首轮进行中重启时，重新连上飞书后仍是「分析中」的分析卡会改成「已中断」，在话题内回复即可继续。分析话题是群内共享的：群里任何通过 dsh_channels 准入的成员都可以在话题内追问、停止或回答审批卡。卡片、话题与权限的细节见 dsh_channels README 的「群话题服务（feishuTopics）」。

## 报告回传

请求带 `logId` 时，观象把分析结论整理成一个报告目录，在分析话题的每一轮结束后调用回传命令上传整个目录，平台网页端渲染其中的入口文件。

**报告目录**：话题的实际工作目录下的 `report/`（`<渠道 baseDir>/analyze/<app>/<errorCode>/topics/<话题>/report/`）；话题没能建立时改用 `$DSH_HOME/logalyze/reports/<报告 id>/report/`。

- 入口 `report.md` 只由观象生成：开头是应用、错误码、发起时间和首轮状态，接着是「分析结论」（首轮的最终回复），之后每有一轮追问就追加一节「追问 N」（用户的问题加这一轮的最终回复）。每次上传前按记录重写这个文件，模型写进目录的同名文件会被替换。
- 其他文件由分析 Agent 写入：追加在 prompt 后的「报告文件」一节要求它把图片、日志片段、较长的分析过程等放进 `report/`，并在回复中用 `report/` 开头的相对路径引用。写入 `report.md` 时这些链接会去掉 `report/` 前缀，变成相对报告目录的路径。本轮新增或改动、回复里却没有引用的文件，追加在该节末尾的「本轮文件」里，图片内嵌，其他文件列成链接。
- 回复里引用本机绝对路径、`report/` 以外的路径或不存在的文件时照常上传，并在回传记录里列出这些链接。
- 首轮失败、被停止或话题没能建立时，「分析结论」写明状态和原因；DSH 在首轮进行中重启时写明已中断，在话题内回复继续后，后续轮次照常追加。

**回传命令**：`analyze.upload.command` 是参数列表，不经过 shell 执行，工作目录是报告目录。`{logId}` 换成请求的 `logId`，`{dir}` 换成报告目录的绝对路径，`{entry}` 换成 `report.md`；命令必须包含 `{logId}` 和 `{dir}`，可执行文件本身不能含占位符。默认命令是 `cli log-analysis upload --log-id {logId} --dir {dir} --entry {entry}`，每一轮都以相同参数调用，由平台的 CLI 处理更新。命令在 DSH 进程的环境变量下运行，需要能在 `PATH` 中找到。

**上传规则**：

- 同一份报告的上传串行执行；上传进行中又有新的轮次结束时，结束后再上传一次最新内容。
- 命令失败（非零退出、超时、找不到命令）后按 `retryDelayMs` 起步、每次加倍的间隔重试 `retries` 次；仍失败时停在「上传失败」，下一轮结束或在面板点「重新上传」时再试。
- 报告目录里有符号链接或其他非普通文件，或者文件数、总大小超过 `maxFiles` / `maxBytes` 时不上传，回传记录写明原因，等内容变化或手动重新上传。
- 回传记录保存在 `$DSH_HOME/logalyze/reports/`，DSH 重启后继续上传没有完成的报告，并核对仍在等待首轮的报告：首轮在观象未运行时结束的，「分析结论」注明没有记录到回复。

**前提**：飞书渠道插件的 `feishuTopics` 服务要提供话题状态查询（`state`、`launchKeyOf` 和 `feishu-topics/status` 事件）。旧版本没有这些功能时，接口照常接受请求，但报告不会回传，面板会提示升级。

## 通过飞书使用

在飞书里使用 `/logalyze` 不需要观象与飞书渠道插件之间的任何接口：渠道插件把不在自己命令表中的 `/` 开头消息作为普通 prompt 交给 dsh，dsh 识别 `/logalyze` 后展开入口 SKILL。飞书附件的宿主路径会出现在消息里，入口 SKILL 会把它作为日志路径派发。只有[日志平台分析接口](#日志平台分析接口)经渠道插件的 `feishuTopics` 服务发卡开话题；观象在 `src/analyze/feishu-topics.ts` 本地声明它用到的服务接口，不依赖渠道插件的包，运行时按服务名查找，没有加载时其余功能不受影响。写操作的授权和提交身份同样只经 `access/authorize`、`repo/commit-trailers` 两个中立事件由渠道插件回答（见[SKILL 改进](#skill-改进)）。

## 开发

```sh
pnpm install
pnpm check        # 类型检查（Host 与 Client）+ 单元测试 + 构建 + 两个加载自检
```

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，并始终保持 0.x：破坏性变更只升次版本号（如 0.2 → 0.3），不会升到 1.0.0。推送到 `dev` 后，检查通过就自动发布 beta；正式版**只在手动触发时发布**，推送到 `main` 只跑检查。只有 `feat`、`fix` 或破坏性变更会产生新版本，其余类型的提交不发布。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 触发 | 版本 | npm dist-tag |
| --- | --- | --- | --- |
| `main` | 手动 | 正式版，如 `0.1.0` | `latest` |
| `dev` | 推送自动 | 预发布版，如 `0.1.0-beta.1` | `beta` |

发布正式版：在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow** 并选择 `main`。workflow 取 `dev` 当前的提交，把 `main` 快进到这个提交，再自动触发一次新的 `pipeline` 运行，在 `main` 的新提交上发布正式版（npm 来源证明记录的是触发运行的提交，所以发布要放在快进之后新开的运行里；Actions 里会看到两次运行）。正式版的 tag 因此打在 `dev` 的提交上：不用再提 `dev` → `main` 的 PR，发版后也不用把 `main` 合回 `dev`，`dev` 的下一个 beta 自动从新版本往上算。`main` 有 `dev` 没有的提交时无法快进，workflow 报错停止。`dry_run` 默认勾选，只预览 `dev` 当前提交的下一个版本号，不移动 `main`；取消勾选才真正快进 `main`、发布 npm 包、打 tag 并创建 GitHub Release。在 `dev` 上手动触发同样可用，用来预览或补发 beta。安装 beta 版用 `dsh-logalyze@beta`。

| 路径 | 内容 |
|---|---|
| `src/index.ts` | Cordis 插件入口 |
| `src/service.ts` | 生效设置、注册表、入口 SKILL 与各工具的注册 |
| `src/repos/` | `dshRepos` 服务需求与查找、应用描述校验、应用注册表 |
| `src/skill/` | `/logalyze` 入口 SKILL 与随包指导 SKILL（`/logalyze-kit`、`/logalyze-improve`）的 provider |
| `skills/logalyze-kit/` | 接入套件 SKILL 正文 |
| `skills/logalyze-improve/` | SKILL 改进指南正文 |
| `src/dispatch/` | 派发工具、日志下载、子 Agent 首条消息与运行 |
| `src/skill-update/` | SKILL 查看工具、SKILL 不足记录、改进工具与改进子 Agent 首条消息、工作区改动检查、推送与合并请求 |
| `src/onboard/` | 在对话中添加仓库、在工作区起草应用描述与 SKILL、推送接入合并请求 |
| `src/analyze/` | 日志平台分析接口：请求校验、令牌、`feishuTopics` 接口声明与转换 |
| `src/report/` | 报告回传：轮次记录、`report.md` 生成、目录检查、回传命令、持久化 |
| `src/settings/` | 面板契约、覆盖文件、HTTP 路由 |
| `src/client/` | 左侧栏入口与设置页面 |
| `examples/order-service/` | 示例应用仓库 |

## 路线图

- [x] 确定插件结构与 bundle 打包方式（分体派发初版）
- [ ] 按日志中的版本号切换应用代码版本
- [ ] 观：通用日志解析与异常检测工具，供各应用 SKILL 复用
- [ ] 象：事件关联与问题全貌
- [ ] 推演：Agent 驱动的根因分析
- [ ] 使用文档与示例

## 许可证

待定。
