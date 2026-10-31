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

- **一个入口，两种触发。** 入口 SKILL 是 `/logalyze`，dsh 在 Web、TUI、ACP 以及经 dsh_channels 的飞书消息中都能识别它。有可用应用且 `autoInvoke` 开启（默认）时，模型也能自行加载：dsh 给顶层 Agent 的 skill 目录里，观象的描述会列出每个可用应用的名称、id、别名和日志特征（总长不超过 500 字，放不下的只计数），用户说「分析这份订单服务的日志」或贴出带 `OrderController` 的报错时，模型会先加载观象。日志明显不属于任何已注册应用时，入口 SKILL 让模型按普通方式处理，不派发也不追问。分析子 Agent 的工作目录在 `dshRepos` 服务的镜像目录内，改进与起草子 Agent 的工作区在运行目录内，这些位置都不列出观象。应用增删时 dsh 会追加一条新的 skill 目录消息；想要确定触发时仍用 `/logalyze`。
- **派发由代码完成。** 模型只给出应用 id、问题和日志位置；仓库目录、应用 SKILL、并发上限都由插件决定。应用 id 必须与注册表一一对应，否则整次派发被拒绝。
- **日志一律以绝对路径交给子 Agent。** 附件和本机文件直接传路径；消息里的对象存储下载链接由派发工具下载（只允许白名单域名，不带鉴权，限制大小与耗时）。日志包不解压，由应用的日志分析 SKILL 在运行目录里解压。
- **应用目录随时最新。** 每次加载 `/logalyze` 都先经 `dshRepos` 服务 fetch 各仓库（间隔由 `fetchIntervalMs` 控制，默认每次），再从远端分支最新提交的 git 对象读取应用描述生成应用目录。fetch 不改动任何检出，所以正在进行的分析不会挡住更新。最多等待 `refreshWaitMs`，超时就先用已有的目录，fetch 在后台继续。
- **代码快照不可变。** 分析子 Agent 在 `dshRepos` 服务按提交创建的只读快照里工作，派发期间持有快照，结束后释放。
- **运行目录。** 每次派发在父会话目录下创建 `.logalyze/runs/<runId>/<序号>-<应用 id>/`，下载的日志放在这里，分析子 Agent 也只在这里写文件；代码快照对分析子 Agent 只读。
- **等待式派发。** 工具等待所有子 Agent 结束后一次返回，一条消息对应一张完整回复；超过派发超时或调用被取消时停止仍在运行的子 Agent。子会话中不提供派发工具。
- **结果带仓库和提交。** 每个应用的结果写明应用仓库地址和分析的提交（「仓库 <地址>，提交 <前 12 位>」）。用户随后要求修复分析发现的代码问题时，入口 SKILL 让模型按普通编码任务处理，从这个仓库地址和提交开始，不在运行目录或代码快照里改代码。
- **在对话中接入仓库。** 用户给出仓库的 https 地址时，模型可以经用户授权把它加入应用仓库列表；仓库缺少应用描述或 SKILL 时，派一个子 Agent 在可写工作区里起草，经授权后经 `dshRepos` 服务推送为合并请求，见[在对话中接入仓库](#在对话中接入仓库)。
- **SKILL 改进（默认开启）。** 子 Agent 觉得应用的日志分析 SKILL 没能支撑这次分析，或用户指出 SKILL 的记录有误、要求改进时，父 Agent 询问用户是否改进；用户同意后由改进子 Agent 在可写工作区里修改 SKILL 并把问题整理为 `cases/` 下的案例，观象经 `dshRepos` 服务推送到应用仓库的新分支并创建合并请求（GitLab MR 或 GitHub PR）供评审，见 [SKILL 改进](#skill-改进)。

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
    repos:
      - url: https://github.com/example/order-service.git
      - url: https://github.com/example/pay-service.git
        branch: release                # 可选，默认跟随远端默认分支
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
    skillUpdateAuthor:                 # 可选：SKILL 改进与接入初稿提交的作者；省略时由 dshRepos 服务决定
      name: 观象
      email: logalyze@example.com
    analyze:                           # 日志平台分析接口，见下文
      enabled: false                   # 默认关闭
    analyzeTokenRef: LOGALYZE_ANALYZE_TOKEN  # 接口访问令牌在 DSH 凭据库中的名称
```

配置在加载时校验，不合法时插件加载失败。仓库地址只接受 https URL（本机仓库也可以用 `file:` URL 或绝对路径）；ssh 地址、`user@host:path`、`git://` 和 http 地址会被拒绝。

### 仓库拉取

观象自己不运行 git，也不依赖其他插件的包。拉取镜像、读取提交、创建只读快照、打开可写工作区和推送 SKILL 修改都调用运行时的 `dshRepos` 服务（服务版本 2，例如由 [dsh-repo](https://github.com/modestoma/dsh-repo) 提供），它用到的方法见 `src/repos/contract.ts`。没有该服务或服务版本不符时仓库拉取失败，原因显示在设置面板。

主机、访问令牌和镜像目录都在提供 `dshRepos` 的插件中配置；观象面板「应用仓库」分页的「管理主机与令牌」跳到 dsh-repo 的设置页。该服务报告主机或令牌变更后，观象自动重新拉取全部仓库。

子 Agent 的命令在 dsh 的文件沙箱中运行：镜像和代码快照只读，只有父会话的项目目录可写，运行目录就在其中。SKILL 改进和接入起草的工作区也建在运行目录里，所以父会话必须有项目目录，工作区必须位于其中，子 Agent 才能修改工作区里的文件；工作区的 git 元数据留在 `dshRepos` 的镜像里，子 Agent 只改文件，提交和推送由观象进程完成。Linux 的 bubblewrap 沙箱会把 `/tmp` 换成空的临时目录，所以镜像目录不要放在 `/tmp` 下，否则子 Agent 的命令看不到仓库。

### 设置面板

DSH Web 左侧栏的「观象」入口打开整页设置面板：

| 分页 | 内容 |
|---|---|
| 应用仓库 | 仓库 https 地址列表（分支可选）、每个仓库的拉取状态、提交号、应用描述与不可用原因，单个或全部重新拉取，以及跳转到 dsh-repo 主机与令牌设置的按钮 |
| 日志下载 | 允许下载的域名、单文件大小上限、下载超时 |
| 分析接口 | [日志平台分析接口](#日志平台分析接口)的开关、访问令牌（只显示是否已设置）、飞书渠道是否就绪，以及调用地址与字段摘要 |
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

插件拉取仓库后检查这两个文件；缺失、不合法，或多个仓库声明同一个 id 时，相关应用不可用，原因显示在设置面板。应用描述和 SKILL 必须是普通文件，不能是符号链接。DSH 也从 `.dsh/skills/` 加载项目 SKILL，并且同名时它优先，所以应用仓库不要在 `.dsh/skills/` 下留同名的 SKILL。删除地址不会删除本地镜像。

## SKILL 改进

`skillUpdates.enabled` 默认开启（设置面板「高级」→「SKILL 改进」可以关闭）。分析中 SKILL 没覆盖到的问题，以及用户指出的 SKILL 错误，经用户同意后沉淀为 SKILL 修改和案例，以合并请求的形式交给仓库维护者评审。改进有两个来源：分析子 Agent 记录的不足，和用户的反馈。工作区、推送和创建合并请求经 `dshRepos` 服务完成，应用仓库所在的主机要在提供该服务的插件中配置令牌；没有该服务或版本不符时工具报错。

1. **分析子 Agent 记录不足。** 子 Agent 的任务消息多出一节说明：分析完成后，如果 SKILL 没能很好地支撑这次分析（日志格式描述不对、缺少这类故障的排查方法或排除规则、代码路径过时、靠自己摸索才找到根因），就在运行目录写 `skill-gap.md`，记下 SKILL 哪里不足、实际怎样定位、关键日志行（去掉具体数据）和代码位置。子 Agent 不修改 SKILL，SKILL 足够时不写这个文件。
2. **派发结果标出不足。** 派发结束后，观象检查已完成任务的记录（普通文件、UTF-8 文本、大小不超过 `maxFileBytes`），在结果中标出「SKILL 不足」和记录摘要。观象记住本次 DSH 运行中每个已完成的派发任务，供之后的改进引用。
3. **用户也可以主动要求。** 分析按 SKILL 已有的记录走了，用户事后指出那条记录有错；或者在新会话里直接说「优化一下订单服务的日志分析 SKILL」。这时顶层 Agent 先用 `logalyze_show_skill` 读出现有 SKILL（最新同步提交中的文件列表和某个文件，默认 `SKILL.md`，只读），对照着和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后再进入下一步。改进子 Agent 不能和用户对话，所以讨论放在询问之前。
4. **询问用户。** 顶层 Agent 调用 `logalyze_improve_skill`。参数是 `workDir`（本会话一次已完成的派发任务）或 `app`（没有分析时）二选一，加上 `feedback`（用户的纠正，尽量保留原话）和可选的 `logs`；没有不足记录时 `feedback` 必填。工具经 DSH 的审批服务（`ctx.approval`，`@deepseek-ai/dsh-user-approval`）问一次「是否改进 SKILL」，说明不足摘要或用户反馈、仓库和目标分支。经 dsh_channels 使用时显示为飞书决策卡片，在 DSH Web 中显示为审批提示；观象与 dsh_channels 之间没有代码依赖。只有「允许」才继续；拒绝、撤回或没有可回答的界面时不起草也不提交。会话的审批策略为 `never`（例如 DSH 的「完全访问」权限模式）时请求一律被拒绝，所以要在「询问」类权限模式下使用；DSH 组合没有审批服务时工具报错。
5. **改进子 Agent 起草。** 用户同意后，观象经 `dshRepos` 在运行目录下的 `improve-<序号>/repo/` 打开应用最新同步提交的可写工作区（有分析时在该任务的运行目录下，否则在新的 `.logalyze/runs/<runId>/` 下），以它为工作目录启动一个改进子 Agent，首行用 `/logalyze-improve` 加载观象自带的改进指南。任务消息给出改进的依据：有分析时是分析时的问题、结论、`skill-gap.md`（如果有）和日志，有反馈时是用户反馈（与现有内容冲突时以用户反馈为准，并对照代码核实），以及附带的样例日志。子 Agent 直接修改工作区中的 `.agents/skills/<skill>/`：对 `SKILL.md` 或 `references/` 的修改、案例 `cases/<日期>-<slug>.md`（现象、脱敏的日志特征、根因、定位路径、确认与排除、本次 SKILL 改进），以及 `SKILL.md` 中「案例索引」表的一行；改动说明写进工作区之外的 `improve-<序号>/reason.md`，第一行是标题。子 Agent 不执行 git 写操作。等待上限是 `dispatchTimeoutMs`。
6. **检查并推送。** 子 Agent 结束后，观象经 `dshRepos` 读出工作区相对基准提交的改动并检查：只接受 `.agents/skills/<skill>/` 下新增或修改的普通文件，文件名受限，内容是 UTF-8 文本，文件数与大小不超过上限；工作区里其他位置的任何改动（包括临时文件），以及删除、重命名或改变文件类型，都让整份修改不合格；依据一次分析时必须新增或修改 `cases/` 下的一份案例，只依据用户反馈时案例可选；`SKILL.md` 的 frontmatter `name` 不能变，也不能设置 `user-invocable: false`。合格后在 `improve-<序号>/changes.diff` 写出 diff，由观象进程（不是 Agent）经 `dshRepos` 把工作区的改动提交并推送到新分支 `logalyze/skill-<应用 id>-<改动摘要前缀>`，再创建合入跟踪分支的合并请求。用户在第 4 步已经同意，这一步不再询问。工具返回改动文件、改进子 Agent 的改动说明和合并请求链接，父 Agent 转告用户，评审在合并请求中进行。修改不合格或子 Agent 没有完成时工具返回原因，不推送，可以再试一次；同一改动的远端分支已存在时不推送；推送成功但合并请求创建失败时返回分支和失败原因，可以在代码托管平台上手动创建。从不推送到已有分支或默认分支，合并后下次 `/logalyze` 拉取即生效。

**改进指南 `/logalyze-improve`。** 正文在包内的 [skills/logalyze-improve/SKILL.md](skills/logalyze-improve/SKILL.md)，写明怎样判断缺口类型、案例模板与脱敏规则、哪些知识补进 `SKILL.md` 或 `references/`、怎样维护「案例索引」，以及改动说明的格式。和接入套件一样在任何目录都列出，只能由用户输入或首行手势加载；开发者也可以在自己的仓库里输入 `/logalyze-improve`，手动把一次排查沉淀为案例。

注意：

- 支持 GitLab（包括自建实例）和 GitHub。应用仓库的 https 地址要能被 `dshRepos` 识别为已配置主机上的仓库；该主机的令牌要能推送分支和创建合并请求（GitLab 上需要 `api` 权限，GitHub 上需要 Contents 和 Pull requests 的读写权限）。
- 有写权限的令牌可以改动它能访问的所有项目。建议用只覆盖应用仓库的项目或组访问令牌，设置过期时间，并保护应用仓库的默认分支。
- 合并请求以该主机令牌主人的身份创建，提交作者是 `skillUpdateAuthor`，省略时由 `dshRepos` 服务决定。飞书群里点「允许」的人可能不是令牌主人；合并请求描述写明了来源会话与分析提交。
- 日志内容不可信，可能诱导模型写出不当的 SKILL 或在案例里留下未脱敏的数据。观象只限制改动范围，内容需要合并请求的评审者把关。

## 在对话中接入仓库

除了在设置面板添加，用户也可以在对话里说「把 https://gitlab.example.com/shop/order.git 接入观象」。顶层 Agent 有三个工具，子会话中都不提供：

| 工具 | 何时提供 | 做什么 |
|---|---|---|
| `logalyze_add_repo` | 总是 | 参数为仓库 https 地址和可选分支。经用户一次性授权后写入与面板相同的 `settings.json`，等待第一次拉取结束，返回应用可用、需要起草或拉取失败的原因。地址已在列表中时不请求授权，只重新拉取 |
| `logalyze_init_repo` | 有仓库已拉取但缺少应用描述或 SKILL 时 | 参数为仓库地址、可选的用户说明和样例日志（`path` 或白名单内的 `url`）。经 `dshRepos` 在运行目录 `.logalyze/runs/<runId>/init/repo/` 打开最新同步提交的可写工作区，以它为工作目录启动一个起草子 Agent，首行用 `/logalyze-kit` 加载接入套件，直接在工作区写出 `.agents/logalyze.yaml` 和一个日志分析 SKILL（大型仓库按领域拆到 `references/`），说明写在工作区之外的 `init/reason.md`；结束后检查初稿并写出 `init/changes.diff`，不推送 |
| `logalyze_submit_init` | 本会话有起草结果时 | 参数为起草的运行目录（`…/init`）。在其中找到工作区并重新检查初稿；工作区已经推送过时直接报告分支已存在。经用户一次性授权后把工作区的改动提交并推送到新分支 `logalyze/init-<应用 id>-<改动摘要前缀>`，并创建合入跟踪分支的合并请求 |

**接入套件 `/logalyze-kit`。** 观象自带一个 SKILL，写明怎样为应用仓库编写应用描述和日志分析 SKILL：从代码和日志配置里找什么、`logalyze.yaml` 字段、SKILL.md 与 `references/` 的结构模板、约束和自检清单。正文在包内的 [skills/logalyze-kit/SKILL.md](skills/logalyze-kit/SKILL.md)，插件加载时读取，缺失或不合法时加载失败。它在任何目录都列出（包括子 Agent 所在的仓库快照），只能由用户输入或首行手势加载，模型不会自行选用。开发者也可以在自己的仓库里运行 dsh，输入 `/logalyze-kit` 直接编写或改进 SKILL。

初稿的检查规则与拉取时相同：`logalyze.yaml` 合法，SKILL 存在、frontmatter 的 `name` 等于 `skill` 字段、不设置 `user-invocable: false`，应用 id 不与其他仓库重复；工作区的改动只能是 `.agents/logalyze.yaml` 和它指定的 `.agents/skills/<skill>/` 下新增或修改的文件，其他位置的改动、删除、重命名都让初稿不合格，文件数和大小上限沿用 `skillUpdates.maxFiles` 与 `maxFileBytes`（关闭 SKILL 改进时同样生效）。起草子 Agent 的等待上限是 `dispatchTimeoutMs`。授权方式、令牌权限、提交作者（`skillUpdateAuthor`）和合并请求的规则与 [SKILL 改进](#skill-改进) 相同；合并后下一次 `/logalyze` 拉取即启用该应用。用户拒绝提交时，初稿仍在运行目录的工作区中，可以手动提交。

## 日志平台分析接口

日志平台调用观象的分析接口：观象经 [dsh_channels](https://github.com/modestoma/dsh_channels) 的 `feishuTopics` 服务在指定群里发一张分析卡（发起人、触发时间、应用、错误码和日志详情页表格），在卡片下开话题，把平台给的 prompt 原样交给一个新 Session（prompt 开头的斜杠命令由 DSH 展开成对应 SKILL，例如 `/logalyze`），分析过程在话题内流式输出。分析结束后分析卡的状态标签随之更新，群里通过准入的成员都可以在该话题内追问。日志包地址写在 prompt 里，下载、解压、超时都由 prompt 调用的 SKILL 处理（Session 的沙箱需要能访问日志存储地址）。

**前提**：

- dsh_channels 已加载并提供 `feishuTopics` 服务（版本 1）。没有这个服务时观象不注册接口；服务版本不兼容时观象记一条警告，也不注册。设置面板「分析接口」分页显示飞书渠道是否就绪。
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
  "prompt": "/logalyze https://logs.example.com/1.zip https://logs.example.com/2.zip 请分析这些日志"
}
```

- `requesterUserId`：平台发起人的飞书 user_id，分析卡 @ 此人；路由记录里也以此人作为发起人。
- `triggeredAt`：平台上发起分析的时间，1–64 字符，原样显示在分析卡上（时区和格式由平台决定）。
- `app` / `errorCode`：只允许 `A-Z a-z 0-9 . _ -`（1–128 字符），决定工作区 `<dsh_channels baseDir>/analyze/<app>/<errorCode>/`；同一应用同一错误码的所有分析都在这个工作区里，每次分析各有一个话题目录。
- `logDetails`：触发分析的日志在日志平台上的详情页，1–50 条，每条 `name`（1–200 字符）+ `url`（http/https）。只在分析卡的表格里列出，观象不会访问这些地址。
- `chatId`：目标群，必须是 dsh_channels 已授权的群（`/auth group add` 或其面板「访问与授权」），机器人需在群内；dsh_channels `accessMode: open` 时不校验。
- `prompt`：1–100000 字符，原样作为首条用户消息，不追加任何内容。
- 只接受以上 7 个字段，多余字段返回 400。

**响应**：校验通过、分析卡发出后立即返回 `202`：

```json
{ "ok": true, "chatId": "oc_xxx", "messageId": "om_xxx" }
```

`messageId` 是分析卡的消息 id，分析话题挂在它下面。同步错误都带中文 `error`：`401` 令牌无效、`404` 接口开关未打开（或接口未注册）、`405` 不是 POST、`400` 参数或 `Idempotency-Key` 不合法、`403` 目标群未授权、`409` 同一个 `Idempotency-Key` 已被内容不同的请求使用、`413` 请求体超过 1 MiB、`415` 不是 JSON、`502` 分析卡发送失败（如机器人不在群里）、`503` 飞书未连接或未设置令牌。

**去重**：同一个 `Idempotency-Key` 再次请求（包括并发重试）原样返回第一次的结果，不会再发卡、再分析。记录由 dsh_channels 永久保存。分析卡发出后的失败（话题创建、Session 创建）不会回滚这条记录：分析卡的状态变成「失败」并写明原因，需要重试时请换一个新的 `Idempotency-Key`。

**群里看到的**：先是分析卡「@发起人 于 <triggeredAt> 发起了对 X 应用 Y 错误码不良日志的分析」，下面是日志详情页表格，标题栏标签为「分析中」；紧接着话题内一张流式卡片，首轮分析在这里流式输出，带停止按钮。首轮结束后分析卡的标签变成「已完成」「已停止」或「失败」；DSH 在首轮进行中重启时，重新连上飞书后仍是「分析中」的分析卡会改成「已中断」，在话题内回复即可继续。分析话题是群内共享的：群里任何通过 dsh_channels 准入的成员都可以在话题内追问、停止或回答审批卡。卡片、话题与权限的细节见 dsh_channels README 的「群话题服务（feishuTopics）」。

## 通过飞书使用

在飞书里使用 `/logalyze` 不需要观象与 [dsh_channels](https://github.com/modestoma/dsh_channels) 之间的任何接口：dsh_channels 把不在自己命令表中的 `/` 开头消息作为普通 prompt 交给 dsh，dsh 识别 `/logalyze` 后展开入口 SKILL。飞书附件的宿主路径会出现在消息里，入口 SKILL 会把它作为日志路径派发。只有[日志平台分析接口](#日志平台分析接口)经 dsh_channels 的 `feishuTopics` 服务发卡开话题；观象只在开发时依赖 dsh_channels 的类型，运行时按服务名查找，没有加载 dsh_channels 时其余功能不受影响。

## 开发

```sh
pnpm install
pnpm check        # 类型检查（Host 与 Client）+ 单元测试 + 构建 + 两个加载自检
```

`@modesto_ma/dsh-channels` 是开发依赖，只用来引入 `feishuTopics` 服务的类型（`@modesto_ma/dsh-channels/topics`，`import type`），构建产物不包含它。

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，并始终保持 0.x：破坏性变更只升次版本号（如 0.2 → 0.3），不会升到 1.0.0。推送到 `dev` 后，检查通过就自动发布 beta；正式版**只在手动触发时发布**，推送到 `main` 只跑检查。只有 `feat`、`fix` 或破坏性变更会产生新版本，其余类型的提交不发布。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 触发 | 版本 | npm dist-tag |
| --- | --- | --- | --- |
| `main` | 手动 | 正式版，如 `0.1.0` | `latest` |
| `dev` | 推送自动 | 预发布版，如 `0.1.0-beta.1` | `beta` |

发布正式版：在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow** 并选择 `main`。`dry_run` 默认勾选，只预览下一个版本号；取消勾选才真正发布 npm 包、打 tag 并创建 GitHub Release。在 `dev` 上手动触发同样可用，用来预览或补发 beta。安装 beta 版用 `dsh-logalyze@beta`。

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
| `src/analyze/` | 日志平台分析接口：请求校验、令牌、到 `feishuTopics` 的转换 |
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
