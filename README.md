# 智能监管（dsh-supervisor）

> **观象察志，审微知著。**

智能监管（npm 包名 `dsh-supervisor`，Cordis 插件名 `supervisor`）是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 AI 原生智能监管中心底座与统一交付插件，下辖两大领域监管能力：

- **观象（日志监管）**：`/supervisor` 入口识别应用、挂载应用代码由主会话直接分析（可选派发子 Agent 并行分析）、从日志平台自动拉取日志分批分析与报告回传、面板归属的应用描述与触发别名设置、可选 DSH SKILL 发现与加载。
- **审微（MR 自动评审）**：自动跟随 `dsh-repo` 中启用「MR 自动评审」的代码仓库，依托 `dshRepos` v8 行级评审契约与 `dsh_supervisor` 共享运行时提供持续增量评审支撑。

详细架构与设计文档见 [`docs/supervisor/README.md`](docs/supervisor/README.md)。

## 项目状态

已完成 M1–M4 全量核心能力交付：

- **M1 跨插件底座与共享运行时**：协同 [dsh_channels](https://github.com/modestoma/dsh_channels)（`feishuActions` v1 非阻塞动作提议卡 + `feishuBitable` v1 多维表格服务端读写）与 [dsh-repo](https://github.com/modestoma/dsh-repo)（`dshRepos` v8 行级评审与讨论线程契约），建立 `dsh_supervisor` 存储域（7 张强类型表）、并发隔离池（`logPool` / `mrPool`）、滑动防抖器、滑动窗口熔断器与幂等 Outbox。
- **M2 审微（MR 自动评审）**：自动跟随启用「MR 自动评审」的仓库，以「1 条 MR = 1 个持久化 `mr-reviewer` Session」完成首次行级评审、Push 增量重审、人类讨论回复与自动 Resolve，以及己方修复 MR（`self-fix` / `self-skill`）的 CI/评审跟进。
- **M3 观象（日志自动监管与闭环处置）**：支持 `/supervisor` 手动入口，以及 `logSupervision` 日志平台增量水位线轮询 + `(product, component, error_code)` 窗口攒批；诊断时 `<workDir>/repos/<app>` 链接到多会话共享的只读代码快照、修代码时才创建可写工作区、`IssueMemory` 检索、Outbox 报告回传，以及经 `propose_actions` 触发的一键 `[🔧 修复代码并提 MR]` / `[📚 改进分析流程 / 沉淀案例]` 闭环。
- **M4 问题库双向同步与统一面板**：本地 `IssueMemory` 与飞书多维表格后台双向幂等同步（严格隔离 AI 列与人工列），提供 Web 左侧栏「智能监管」5 标签页（运行总览 / 应用与日志监管 / MR 自动评审 / 已知问题库 / 模型与高级）整页面板。

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

观象是分体结构：插件负责识别应用、挂载代码与准备日志，各应用的日志分析知识跟着应用代码放在应用自己的仓库里。

```
用户：/supervisor 订单服务昨晚 21 点下单报 500，日志见附件
        │
        ▼
入口 SKILL（意图识别）── 先 fetch 各仓库，应用目录由各仓库最新提交生成
        │  supervisor_mount_apps({ apps, logs })
        ▼
挂载工具：校验应用 id → 为本会话持有各应用的只读代码快照（多会话共享）→ 下载 URL 日志到运行目录
        │  返回代码目录、仓库与提交、仓库 SKILL 路径和日志路径
        ▼
主会话按仓库 SKILL 读日志和代码分析，按应用分节汇总，涉及多个应用时给出跨应用的推演
（可选：多个应用、日志都很大时改用 supervisor_dispatch 交给子 Agent 并行分析，子 Agent 读同一份快照）
```

- **一个入口，两种触发。** 入口 SKILL 是 `/supervisor`，dsh 在 Web、TUI、ACP 以及经飞书渠道插件的飞书消息中都能识别它。有可用应用且 `autoInvoke` 开启（默认）时，模型也能自行加载：dsh 给顶层 Agent 的 skill 目录里，智能监管的描述会列出每个可用应用的名称、id、别名和日志特征（总长不超过 500 字，放不下的只计数），用户说「分析这份订单服务的日志」或贴出带 `OrderController` 的报错时，模型会先加载它。日志明显不属于任何已注册应用时，入口 SKILL 让模型按普通方式处理，不挂载也不追问。分析子 Agent 的工作目录在 `dshRepos` 服务的镜像目录内，改进与起草子 Agent 的工作区在运行目录内，这些位置都不列出入口 SKILL。应用增删时 dsh 会追加一条新的 skill 目录消息；想要确定触发时仍用 `/supervisor`。
- **主会话直接读代码。** 默认由主会话自己分析：`supervisor_mount_apps` 只接受应用 id 和日志位置，代码目录、提交和上限都由插件决定，应用 id 必须与注册表一一对应，否则整次调用被拒绝。主会话的 SKILL 目录不包含快照里的仓库 SKILL，工具按路径列出 `.dsh/skills` 与 `.agents/skills` 下的 SKILL，模型直接读取。
- **可选派发。** 同时分析多个应用、每个应用的日志都很大时，入口 SKILL 允许改用 `supervisor_dispatch` 交给子 Agent 并行分析；子 Agent 的工作目录是同一份共享快照。
- **日志一律以绝对路径给出。** 附件和本机文件直接传路径；消息里的对象存储下载链接由工具下载（只允许白名单域名，不带鉴权，限制大小与耗时）。日志包不解压，分析时在运行目录里解压。
- **应用目录随时最新。** 每次加载 `/supervisor` 都先经 `dshRepos` 服务取各仓库日志分析分支最新提交的只读快照（dsh-repo 取快照前从远端拉取；间隔由 `fetchIntervalMs` 控制，默认每次），读取应用描述生成应用目录。新提交有自己的快照，所以正在进行的分析不会挡住更新。最多等待 `refreshWaitMs`，超时就先用已有的目录，读取在后台继续。
- **代码快照不可变、多会话共享。** 代码目录是 `dshRepos` 服务按提交创建的只读快照（`<镜像目录>/.snapshots/` 下），同一提交只有一份，多个会话和子 Agent 共用。挂载由会话持有：同一会话再次挂载时沿用未变的快照，仓库有新提交时换到新快照；会话最后一次挂载后 `snapshotHoldMs`（默认 4 小时）内没有再挂载就释放，之后读取需要重新挂载。派发期间子 Agent 另外持有快照，结束后释放。
- **运行目录。** 每次挂载或派发在会话目录下创建 `.supervisor/runs/<runId>/`（派发时每个应用一个 `<序号>-<应用 id>/`），下载的日志放在这里，解压结果和中间文件也只写在这里；代码快照只读。
- **等待式派发。** 工具等待所有子 Agent 结束后一次返回，一条消息对应一张完整回复；超过派发超时或调用被取消时停止仍在运行的子 Agent。子会话中不提供派发工具。
- **结果带仓库和提交。** 每个应用的结果写明应用仓库地址和分析的提交（「仓库 <地址>，提交 <前 12 位>」）。用户随后要求修复分析发现的代码问题时，入口 SKILL 让模型按普通编码任务处理，从这个仓库地址和提交开始，不在运行目录或代码快照里改代码。
- **仓库只在 dsh-repo 中配置。** 应用仓库就是 dsh-repo 仓库清单中打开了「日志分析」功能的仓库：观象启动时向 dsh-repo 注册这个功能，读取清单，清单变化（加仓库、删仓库、改分支、开关功能）后立即重新配置并读取应用描述。仓库只能在 dsh-repo 的设置页添加，镜像的拉取和拉取状态也在那里；观象自己不保存仓库列表，也不提供拉取按钮。
- **在对话中起草接入。** 清单里的可写仓库缺少应用描述或 SKILL 时，模型可以派一个子 Agent 在工作区里起草，经 dsh-repo 的审批推送为合并请求，见[在对话中起草接入](#在对话中起草接入)。
- **SKILL 改进（默认开启）。** 主会话或子 Agent 觉得应用的日志分析 SKILL 没能支撑这次分析时，先给出分析结论，在回复末尾附上 SKILL 改进建议；用户在之后的消息里同意（或主动指出 SKILL 的记录有误、要求改进）后，由一个改进子 Agent 把该应用的所有改进点一次改进完，在工作区里修改 SKILL 并把问题整理为 `cases/` 下的案例，观象经 `dshRepos` 服务（推送前由 dsh-repo 审批）推送到应用仓库的新分支并创建合并请求（GitLab MR 或 GitHub PR）供评审，见 [SKILL 改进](#skill-改进)。

## 安装与配置

观象以 dsh bundle 交付（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），Host 半侧运行 `lib/index.js`，浏览器半侧运行 `lib/client.js`。

安装已发布的 npm 版本（推荐）：

```bash
# 在 deepseek-harness 仓库内：把 npm 包安装进 web profile
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add dsh-supervisor
```

本地 checkout 开发时：

```bash
pnpm build
DSH_HOME=$DSH_HOME pnpm dsh plugin --profile web add link:/path/to/dsh-supervisor
```

npm 发行包已包含构建产物；本地 `link:` 安装前必须先执行 `pnpm build`。安装或修改后重启 dsh。包内的 `cordis.patch.yml` 把 `dsh-supervisor` 加入 profile 的 bundle 列表，并提供稳定 `id: supervisor` 的 Loader 行。可在 profile 的 patch 中按该 id 配置默认值：

```yaml
- id: supervisor
  config:
    fetchIntervalMs: 0                 # 加载 /supervisor 时距上次读取超过该时间的仓库先重新读取；0 = 每次
    maxAppsPerRequest: 4               # 单次派发的任务上限
    dispatchTimeoutMs: 1800000         # 等待全部子 Agent 的上限
    download:
      allowedHosts: [oss.example.com]  # 同时允许子域名；为空时不下载 URL
      maxBytes: 536870912
      timeoutMs: 600000
    subagentProvider: spawn            # 子 Agent 使用的 ctx.subagents provider
    subagentMaxDepth: 1                # 子 Agent 委派深度上限；0 = 子 Agent 不能再委派；provider-managed = 不传上限，由 provider 自己控制
    snapshotHoldMs: 14400000           # 会话最后一次挂载应用代码后保留只读快照的时长（最少 60000）
    refreshWaitMs: 15000               # 加载 /supervisor 时等待 fetch 的上限；0 = 不等待
    autoInvoke: true                   # 任务匹配已注册应用时模型可自行加载入口 SKILL；false = 只能输入 /supervisor
    skillUpdates:                      # SKILL 改进，见下文
      enabled: true                    # 默认开启；false = 子 Agent 不记录 SKILL 不足，也不询问
      maxFiles: 16                     # 一次改进最多新增或修改的文件数
      maxFileBytes: 262144             # 改进中单个文件和 SKILL 不足记录的大小上限
    analyze:                           # 日志平台连接与报告回传，见下文（键名沿用旧名）
      platform:                        # 日志平台开放 API（观象是它的 OAuth2 客户端）
        baseUrl: https://logs.example.com           # 在后面拼 /open-api/v1/…
        tokenUrl: https://auth.example.com/oauth/token
        clientId: supervisor
        clientAuth: basic              # basic = HTTP Basic（默认）；body = 表单字段
        scope: log:search log:download log:upload
        timeoutMs: 30000               # 单次接口调用 / 换令牌超时
      upload:                          # 报告回传，见下文；上限默认与日志平台一致
        timeoutMs: 300000              # 单个文件上传超时
        retries: 3                     # 失败后再试的次数
        retryDelayMs: 60000            # 第一次重试前的等待，之后每次加倍
        maxFiles: 50                   # 每个修订的文件数上限（含 report.md）
        maxBytes: 104857600            # 每个修订的总大小上限
        maxFileBytes: 52428800         # 单文件上限
        maxMarkdownBytes: 20971520     # Markdown 文件（含 report.md）上限
        concurrency: 4                 # 同时上传的文件数
    logSupervision:                    # 观象日志平台自动轮询、窗口攒批与闭环处置
      enabled: false                   # 默认关闭
      pollIntervalMs: 60000            # 轮询日志平台归档列表间隔
      pollLagMs: 120000                # 只读取早于「现在 − 该值」归档的日志，容忍时钟偏差与平台迟提交
      batchSizeThreshold: 5            # 同组攒批达到该条数立即发车（1–50）
      maxBatchSize: 20                 # 单批最多容纳日志数（1–50，>= batchSizeThreshold）
      batchWindowMs: 300000            # 首批入槽后最大等待时间（0 表示不额外等待）
      maxConcurrentBatches: 4          # logPool 并发执行上限（1–16）
      appHourlyBatchLimit: 15          # 单应用每小时批次上限（触发 log:<appId> 熔断）
      feishuChatId: oc_xxx             # 自动监管投递的目标飞书群（不填时无头后台运行）
      deliveryMode: quiet-until-done   # quiet-until-done（静默出结论后再发话题）| topic-on-start
      maxUnpackBytes: 536870912        # 单日志槽位累计最大解压字节数
    mrReview:                          # 审微 MR 自动初审、增量重审与己方 MR 跟进
      enabled: true                    # 默认开启（有开启 mr-review 的仓库且 dshRepos 为 v8 时生效）
      pollIntervalMs: 60000            # 巡检 MR 与讨论更新间隔
      debounceMs: 45000                # Push / 评论防抖窗口（合并连续 push；单批最大等待 5 分钟）
      maxConcurrentSessions: 3         # mrPool 并发会话上限（1–16）
      skipDraft: true                  # 自动跳过 Draft / WIP 合并请求
      ignoreLabels: []                 # 命中的标签（精确大小写不敏感匹配）不自动评审
      maxAutoFixAttempts: 2            # 己方修复/SKILL 改进 MR 的自动修复 CI 最大尝试次数
      dailyMrTurnLimit: 12             # 单条 MR 每日自动唤醒次数上限（触发 mr:<repo>#<num> 熔断）
      repoHourlyTurnLimit: 30          # 单仓库每小时自动唤醒次数上限（触发 mr-repo:<repo> 熔断）
      customInstructions: ''           # 团队附加评审规范，注入每次 MR 唤醒提示词（最多 4000 字）
      feishuChatId: oc_xxx             # 可选：MR 熔断/合并冲突需人工介入时的飞书告警群
    issueSync:                         # 已知问题库与飞书多维表格双向同步
      enabled: true                    # 默认开启（填写 bitableUrl 后开始远端同步）
      bitableUrl: https://example.feishu.cn/base/bascnxxx  # /base/<token> 或 /wiki/<node_token>
      table: tblxxx                    # 可选：数据表 ID 或表名（覆盖链接中 ?table=）
      syncIntervalMs: 300000           # 后台周期双向同步间隔（最小 5000）
    platformSecretRef: SUPERVISOR_PLATFORM_CLIENT_SECRET  # 日志平台 client_secret 在 DSH 凭据库中的名称
```

配置在加载时校验，不合法时插件加载失败。应用仓库不在这里配置：以前的 `repos` 键会让插件加载失败，错误说明改到 dsh-repo 的「代码仓库 → 仓库」中添加这些仓库并打开「日志分析」；面板设置文件 `settings.json` 里留有 `repos` 时整个文件不生效，面板显示同样的原因，保存一次即覆盖。旧的仓库列表不会自动迁移。

> **从 `dsh-logalyze` 升级**：首次启动时会自动将 `$DSH_HOME/logalyze` 下既有的 `settings.json`、`applications.json`、`analyses/`、`reports/` 以及无宿主 `storageDomain` 时的 `supervisor/dsh_supervisor.json`（迁往 `domain/dsh_supervisor.json`）幂等迁移到 `$DSH_HOME/supervisor`，并兼容迁移默认的 `LOGALYZE_ANALYZE_TOKEN` / `LOGALYZE_PLATFORM_CLIENT_SECRET` 凭据，且不会覆盖 `$DSH_HOME/supervisor` 中已存在的新文件。

### 应用仓库

智能监管自己不运行 git，也不依赖其他插件的 npm 包。仓库清单、只读快照、会话内共享克隆与推送合并请求都调用运行时的 `dshRepos` 服务（由 [dsh-repo](https://github.com/modestoma/dsh-repo) 提供），契约声明见 `src/deps/repos-contract.ts`。没有该服务或服务版本不符时相关仓库不可用，原因显示在设置面板：

- 插件在 `dshRepos` 服务出现时注册两项仓库级功能：`log-analysis`（标题「日志分析」，`dshRepos` v7/v8 均可）与 `mr-review`（标题「MR 自动评审」，需 `dshRepos` **v8** 提供行级评审、增量 compare 与讨论线程接口；版本为 v7 时面板「MR 自动评审」标出升级提示），插件卸载时撤销注册。
- 启用「日志分析」的仓库不再要求提交 `.agents/logalyze.yaml`：仓库在 dsh-repo 中打开「日志分析」即可被收录，应用描述（`description`）与触发别名（`aliases` / 平台原始 `component_code`）直接在智能监管 Web 面板配置并持久化在 `$DSH_HOME/supervisor/applications.json`；若仓库历史保留 `.agents/logalyze.yaml` 且本地尚无记录，首次同步时自动一次性迁移其描述与别名。
- 日志分析读代码用 `dshRepos.snapshotAcquire` 的只读快照（多会话共享，`<workDir>/repos/<slug>` 在诊断时是指向快照的链接）；修代码、改进 SKILL 和 MR 自动评审通过 `dshRepos.workspaceCreate` 在当前会话工作目录下创建镜像克隆工作区（`<workDir>/repos/<slug>`），从本地裸镜像秒级检出并共享 Git 对象；写操作推送均由 `dshRepos.workspacePush` 经过 dsh-repo 的 `access/authorize` 与写权限门控完成。
- 仓库在清单里的权限决定能做什么：「只读」仅允许分析与 MR 评审，面板标出「只读」；修改代码、改进 SKILL 与提交合并请求需要「可改代码」或「可合并」。Linux 沙箱环境下镜像目录不能放在 `/tmp` 下；飞书会话中读代码需要在渠道插件里放开代码快照目录：把 `<镜像目录>/.snapshots` 加入 `readFence.readableRoots`，并在沙箱 runner 的 `--expose` 中加入同一目录（快照路径带随机后缀、随提交变化，所以要加整个目录）。

### 设置面板

DSH Web 左侧栏的 **「智能监管」** 入口打开统一 5 标签页整页面板（顶部常驻健康指标条，底部联动草稿保存条）：

| 标签页 | ID | 内容与功能 |
|---|---|---|
| **运行总览** | `overview` | 日志与 MR 监管域健康总览、活跃任务计数、异常与已触发熔断器一键解除（`POST /supervisor/breakers/reset`）、平台报告死信队列重试及近期任务/MR 活动 |
| **应用与日志监管** | `log` | 跟随 `dsh-repo` 已开启「日志分析」的应用仓库（支持就地编辑应用描述与单行添加/删除触发别名并保存 `PUT /supervisor/applications`）；`logSupervision` 水位线状态与暂停/恢复/时间回拨控制（`POST /supervisor/log-supervision/watermark`）、攒批参数与轮询安全滞后、日志平台连接与 OAuth2 client_secret（`PUT/DELETE /supervisor/token`）、日志下载/上传限制及最近报告回传与手动重传（`POST /supervisor/reports/upload`） |
| **MR 自动评审** | `mr` | 跟随 `dsh-repo` 已开启「MR 自动评审」的仓库清单（含目标分支与只读/可写标记）、审微运行状态与熔断器、受监管 MR 列表（`open`/`merged`/`closed`/`draft_skipped`、origin 标记及待处理信号）、`mrReview` 并发/防抖/忽略标签/熔断阈值、`customInstructions` 与可选 `feishuChatId` 告警群 |
| **已知问题库** | `issues` | `feishuBitable` v1 就绪状态、一键「立即同步」（`POST /supervisor/issues/sync`）与「检查字段映射」（`POST /supervisor/issues/check` 对 16 列标准 Schema 逐列诊断）、`issueSync` 表格链接/表名/周期配置、本地 `IssueMemory` 问题检索列表与 `humanConclusion` / `fixMrUrl` 状态 |
| **模型与高级** | `advanced` | 只读展示 `cordis.yml` 运行时配置（`platformSecretRef`、`subagentProvider`、`subagentMaxDepth`、`snapshotHoldMs`、`refreshWaitMs`、`autoInvoke`）、仓库读取间隔与派发上限、`skillUpdates` 开关与文件限制，以及清除覆盖恢复默认值（`DELETE /supervisor/settings`） |

面板读取状态走 `GET /supervisor/state`，保存设置走 `PUT /supervisor/settings`（写入 `$DSH_HOME/supervisor/settings.json`，仅保存与 `cordis.yml` 不同的覆盖键并共用同一 Zod 校验），所有 `/supervisor/*` 路由均经过宿主 `connection.requestRejection` 登录与来源校验，写操作另做同源校验。

## 应用仓库约定与内置 SKILL

管理员在 dsh-repo「代码仓库 → 仓库」添加仓库并打开「日志分析」后即可生效，**不再强制要求仓库内预先提交 `.agents/logalyze.yaml` 或指定分析 SKILL**（参见包内 `/supervisor-kit`）。应用描述与触发别名（含中文简称与平台原始 `component_code`）均可在智能监管面板「应用与日志监管」中可视化配置并保存在 `$DSH_HOME/supervisor/applications.json`；若仓库历史上存在旧版 `.agents/logalyze.yaml`，首次同步时自动一次性迁移其描述与别名。

若应用仓库自带专属排查流程，可按标准路径放在 `.dsh/skills/` 或 `.agents/skills/<skill>/SKILL.md`（不得设 `user-invocable: false`），DSH 与 `log-supervisor` 会在检出代码工作区后自动发现并按需加载；无专属 SKILL 时直接结合日志与仓内代码排查。此外，本插件内置 4 个随包指导 SKILL（`src/skill/bundled.ts`）：

| 内置 SKILL | 用途说明 |
|---|---|
| `/supervisor-kit` | 应用接入指引：仓库功能开关、面板描述/别名配置及可选仓内 SKILL 发现规则 |
| `/supervisor-improve` | SKILL 改进指南：缺陷总结、案例模板（`cases/`）、脱敏规范与改动说明格式 |
| `/log-supervisor` | 观象自动监管主 Agent 指南：1:1 日志槽位核验、`IssueMemory` 检索与闭环动作提议规范 |
| `/mr-reviewer` | 审微 MR 监督主 Agent 指南：行级评审准入、增量 Diff 重审、讨论回复与自修检查 |

## SKILL 改进

`skillUpdates.enabled` 默认开启（设置面板「高级」→「SKILL 改进」可以关闭）。分析中 SKILL 没覆盖到的问题，以及用户指出的 SKILL 错误，经用户同意后沉淀为 SKILL 修改和案例，以合并请求的形式交给仓库维护者评审。改进有两个来源：分析子 Agent 记录的不足，和用户的反馈。分析结论总是先给出，改进放在用户同意之后的回合里；同一应用的所有改进点由一个改进子 Agent 一次完成。工作区、推送和创建合并请求经 `dshRepos` 服务完成，应用仓库所在的主机要在提供该服务的插件中配置令牌；没有该服务或版本不符时工具报错。

1. **记录不足。** 主会话自己分析（默认流程）时按同样的标准判断 SKILL 是否不足，在回复末尾给出改进建议；用户同意后把不足、定位步骤、关键日志行（去掉具体数据）和代码位置写进 `supervisor_improve_skill` 的 `feedback`，日志放进 `logs`。派发给子 Agent 时，子 Agent 的任务消息多出一节说明：分析完成后，只有 SKILL 写错了或缺了内容、让它走了弯路或差点得出错误结论时（日志格式描述不对、缺少这类故障的排查方法或排除规则、代码路径过时），才在运行目录写 `skill-gap.md`，记下 SKILL 哪里不足、实际怎样定位、关键日志行（去掉具体数据）和代码位置；只是多查了几步，或缺的是只在这一次出现的细节，不算不足。子 Agent 不修改 SKILL，SKILL 足够时不写这个文件。
2. **先给结论，再给改进建议。** 派发结束后，观象检查已完成任务的记录（普通文件、UTF-8 文本、大小不超过 `maxFileBytes`），在结果中标出「SKILL 不足」和记录摘要。顶层 Agent 照常写完分析结论，在回复末尾附一节「SKILL 改进建议」，每个应用一两句，问用户是否改进，然后结束这一回合，用户不用等改进。观象记住本次 DSH 运行中每个已完成的派发任务，供之后的改进引用。
3. **用户也可以主动要求。** 分析按 SKILL 已有的记录走了，用户事后指出那条记录有错；或者在新会话里直接说「优化一下订单服务的日志分析 SKILL」。这时顶层 Agent 先用 `supervisor_show_skill` 读出现有 SKILL（日志分析分支最新读取的提交中的文件列表和某个文件，默认 `SKILL.md`，只读），对照着和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后再进入下一步。改进子 Agent 不能和用户对话，所以讨论放在改进之前。
4. **用户同意后改进。** 用户在对话中同意后，顶层 Agent 为每个要改的应用调用一次 `supervisor_improve_skill`；工具本身不询问，推送前 dsh-repo 按它的「写操作」设置可能再弹出一次审批（见第 6 步）。参数是 `app`，加上可选的 `feedback`（用户的纠正或补充，尽量保留原话）、`workDirs`（作为依据的分析运行目录）和 `logs`。省略 `workDirs` 时，工具自动取本会话中该应用记录了 `skill-gap.md`、还没改进过的全部分析，所以同一应用的多次分析和用户的补充合并在一次改进里；没有这样的分析时 `feedback` 必填。下面几条由工具保证，不只靠提示词：该应用有本回合派发的分析时工具报错，分析回合不会开始改进（观象从 DSH 的 `session/event` 中数会话结束的 `turn/end`）；同一会话同一应用每回合只发起一次改进、同时只运行一次；发起改进就把用到的分析记为已改进，无论成败之后都不再自动取用，用户要求重试时用 `workDirs` 指定。
5. **改进子 Agent 起草。** 观象经 `dshRepos.workspaceCreate` 在新的运行目录 `.supervisor/runs/<runId>/improve-<序号>/repo/` 创建工作区，起点是基线分支的最新提交，推送分支由 dsh-repo 按分支命名模板生成（见[应用仓库](#应用仓库)），以它为工作目录启动一个改进子 Agent，首行用 `/supervisor-improve` 加载观象自带的改进指南。任务消息给出改进的依据：每次分析的问题、结论、`skill-gap.md`（如果有）、运行目录和日志，用户反馈（与现有内容冲突时以用户反馈为准，并对照代码核实），以及附带的样例日志，并要求所有改进点在这一次修改中完成。子 Agent 直接修改工作区中的 `.agents/skills/<skill>/`：对 `SKILL.md` 或 `references/` 的修改、案例 `cases/<日期>-<slug>.md`（每个不同的问题一个案例，写现象、脱敏的日志特征、根因、定位路径、确认与排除、本次 SKILL 改进），以及 `SKILL.md` 中「案例索引」表的行；改动说明写进工作区之外的 `improve-<序号>/reason.md`，第一行是标题，不写类型前缀。子 Agent 不执行 git 写操作。等待上限是 `dispatchTimeoutMs`。
6. **检查并推送。** 子 Agent 结束后，观象经 `dshRepos.workspaceStatus` 读出工作区相对起始提交的改动（已提交和未提交的都算）并检查：只接受 `.agents/skills/<skill>/` 下新增或修改的普通文件，文件名受限，内容是 UTF-8 文本，文件数与大小不超过上限；工作区里其他位置的任何改动（包括临时文件），以及删除、重命名或改变文件类型，都让整份修改不合格；依据分析时必须新增或修改 `cases/` 下至少一份案例，只依据用户反馈时案例可选；`SKILL.md` 的 frontmatter `name` 不能变，也不能设置 `user-invocable: false`。合格后在 `improve-<序号>/changes.diff` 写出 diff，由观象进程（不是 Agent）调用 `dshRepos.workspacePush`，把工作区的改动提交、推送到工作区的分支并创建合回基线分支的合并请求，一步完成。SKILL 改进的提交只用 `chore` 类型：提交说明首行和合并请求标题都是 `chore: <标题>`，标题开头若带 `feat:`、`fix(...):` 等类型前缀会先去掉。dsh-repo 为调用的会话发 `access/authorize`，并按它的「写操作」设置弹出和它自己的推送工具相同的审批卡片（列出文件、分支和合并请求），用户拒绝时不推送，改动留在工作区。工具返回改动文件、改进子 Agent 的改动说明和合并请求链接，父 Agent 转告用户，评审在合并请求中进行。修改不合格或子 Agent 没有完成时工具返回原因，不推送；用户要求重试时在之后的回合再调用一次；远端分支已有其他提交时不推送；推送成功但合并请求创建失败时返回分支和失败原因，可以在代码托管平台上手动创建。从不推送到已有分支或默认分支，合并后，日志分析分支包含这些改动时，下次 `/supervisor` 即生效。

**改进指南 `/supervisor-improve`。** 正文在包内的 [skills/supervisor-improve/SKILL.md](skills/supervisor-improve/SKILL.md)，写明怎样判断缺口类型、案例模板与脱敏规则、哪些知识补进 `SKILL.md` 或 `references/`、怎样维护「案例索引」，以及改动说明的格式。和接入套件一样在任何目录都列出，只能由用户输入或首行手势加载；开发者也可以在自己的仓库里输入 `/supervisor-improve`，手动把一次排查沉淀为案例。

注意：

- 支持 GitLab（包括自建实例）和 GitHub。应用仓库的 https 地址要能被 `dshRepos` 识别为已配置主机上的仓库；该主机的令牌要能推送分支和创建合并请求（GitLab 上需要 `api` 权限，GitHub 上需要 Contents 和 Pull requests 的读写权限）。
- 有写权限的令牌可以改动它能访问的所有项目。建议用只覆盖应用仓库的项目或组访问令牌，设置过期时间，并保护应用仓库的默认分支。
- 推送和合并请求都为调用的 Agent 发起：`dshRepos` 先发 `access/authorize` 事件问其他插件这个会话能不能改代码（例如飞书渠道插件按发起人或群的权限回答），被拒绝时以 `forbidden` 失败、不问用户；提交者是该主机令牌所属的账号，作者和尾注由其他插件通过 `repo/commit-trailers` 事件决定（例如飞书私聊里作者是发起人，群里加 `Feishu-Chat:` 尾注），观象不再自己配置作者。提交说明末尾有 `DSH-Session: <会话 id>`，合并请求描述也写明了来源会话与分析提交。
- 日志内容不可信，可能诱导模型写出不当的 SKILL 或在案例里留下未脱敏的数据。观象只限制改动范围，内容需要合并请求的评审者把关。

> 除对话式触发 `supervisor_improve_skill` 外，在 `LogSupervisor` 监管话题中也可直接点击非阻塞动作按钮 **`[📚 改进分析流程 / 沉淀案例]`**，在隔离的知识工作区（`repos/<app>-knowledge`）中就地完善 SKILL/解析脚本与 `cases/` 案例，并通过 `supervisor_log_push_mr` 发起独立合并请求。

## 日志平台连接

观象是日志平台（如 digital_system）开放 API 的 OAuth2 client_credentials 客户端，只主动拉取，不对外开放任何接口：DSH 不提供 `/open-api/supervisor`，网关不需要为观象放行路径。日志何时分析、怎样分批，全部由[日志自动监管](#日志自动监管与闭环处置观象)决定。

**前提**：日志平台为观象开一个客户端，授权范围 `log:search log:download log:upload`，挂在能看到相关日志的账号下。

**配置**：在设置面板「应用与日志监管 → 日志平台连接」填接口地址（`analyze.platform.baseUrl`，观象在后面拼 `/open-api/v1/…`）、令牌地址（`tokenUrl`）、`client_id`，并保存 `client_secret`（存入 DSH 凭据库的 `SUPERVISOR_PLATFORM_CLIENT_SECRET`，名称可用 `platformSecretRef` 修改）。客户端认证默认用 HTTP Basic（digital_system 只接受这种方式），也可以改成表单字段（`clientAuth: body`）。访问令牌缓存在内存里，剩余不到 60 秒或接口返回 401 时重新换取（401 只重试一次）。三项没填齐时自动监管不轮询，面板写明缺什么。观象调用的平台接口：

| 用途 | 接口 | scope |
| --- | --- | --- |
| 增量拉取归档日志 | `GET /open-api/v1/logs?archived_from=…&archived_to=…&status=completed` | `log:search` |
| 同组历史统计 | 同上，加 `product_code`、`component_code`、`error_code` | `log:search` |
| 按 id 查日志元数据 | `GET /open-api/v1/logs?log_id=…&log_id=…` | `log:search` |
| 取 10 分钟下载链接 | `GET /open-api/v1/logs/{log_id}/download-url` | `log:download` |
| 创建分析修订 | `POST /open-api/v1/logs/{log_id}/analyses`（带 `Idempotency-Key`） | `log:upload` |
| 直传文件 | `PUT <uploads[].upload_url>`（不带平台令牌） | — |
| 完成分析修订 | `POST /open-api/v1/logs/{log_id}/analyses/{analysis_id}/complete` | `log:upload` |

列表接口只带平台接受的查询参数，平台对未知或空参数返回 400。列表项的 `detail_url`（平台 Web 详情页）用作飞书卡片与报告里的日志链接；平台没给时退回 `<baseUrl>/logs/<log_id>`。

**已下线的分析接口**：以前由日志平台调用 `/open-api/supervisor` 发起分析，现在不再注册这个路由。cordis.yml 里旧的 `analyze.enabled`、`analyze.defaultChatId`、`analyze.maxLogs` 与 `analyzeTokenRef` 仍能加载，但不生效，加载时记一条警告，可以删除；凭据库里的 `SUPERVISOR_ANALYZE_TOKEN` 也不再使用。升级前已经开出的分析话题仍可继续追问：追问的结论照旧回传到对应日志，话题里的日志编号（`{ "ref": "L1" }`）仍可派发。这些分析记录保存在 `$DSH_HOME/supervisor/analyses/`，最多保留 200 份，最近一次活动超过 30 天的在启动时清理。

## 报告回传

自动监管批次经 `supervisor_log_submit` 提交结论后，`OutboxRunner` 为批次中的每份日志生成一份 `report.md`（加上提交时附带的 `attachments`），作为这份日志的一个新分析修订传到日志平台：创建修订（`entry_path` 为 `report.md`，幂等键由任务、修订号和日志 id 组成）→ 按返回的 `uploads[]` 直传文件（不带平台令牌）→ 完成修订，并把平台返回的报告页 `detail_url` 回填到已知问题库。追问后再次提交会产生新修订，平台详情页显示最新完成的修订；修订号只增不减，旧修订不会覆盖新修订。暂时性失败按退避重试，多次失败进入死信，可在面板「运行总览」重试。

**文件规则**（日志平台的要求，固定）：路径最多 255 字节、1–4 段，每段只含英文字母、数字和 `. _ -` 且不以点开头；扩展名为 md/png/jpg/jpeg/gif/webp/csv/txt/json/log；文件不能为空。数量和大小按 `analyze.upload` 的上限（默认与平台一致：每个修订最多 50 个文件含 `report.md`、共 100 MiB，单文件 50 MiB，Markdown 20 MiB）。不符合规则或超出上限的文件、符号链接和特殊文件都不上传，列在报告末尾。

旧版回传命令留下的记录（`$DSH_HOME/supervisor/reports/`）只在面板展示，不再上传，30 天无活动后在启动时删除。

## 日志自动监管与闭环处置（观象）

除手动 `/supervisor` 入口外，开启 `logSupervision.enabled`（需配置好日志平台与 `feishuChatId` 通知群；不填 `feishuChatId` 时以无头模式后台诊断并回传平台）后，`LogSupervisor` 以持久化状态机持续监管日志平台：

- **增量水位线轮询与分组攒批**：按 `archived_at` 水位游标 `[cursorTime, 现在 − pollLagMs)`（保存于 `dsh_supervisor` 存储域 `watermarks` 表，支持在面板「应用与日志监管」或 `POST /supervisor/log-supervision/watermark` 执行暂停、恢复与时间回拨）分页拉取已归档日志，并按 `(product_code, component_code, error_code)` 在 `pending_batches` 表持续攒批：同组累计达到 `batchSizeThreshold`（默认 5，单批上限 `maxBatchSize` 默认 20）或距首发入槽超过 `batchWindowMs`（默认 5 分钟）即切片发车。
- **并发隔离、安全解压与单应用熔断**：全部批次在独立并发池 `logPool`（`maxConcurrentBatches` 默认 4）中调度；单应用滚动 1 小时内批次数超过 `appHourlyBatchLimit`（默认 15）触发 `log:<appId>` 熔断，推送飞书告警并阻塞该应用后续自动发车，直到冷却期结束或在面板「运行总览」点击恢复，不波及其他应用。
- **`log-supervisor` 会话内诊断工具链**：每次批次分配 1 个持久化主 Agent Session（使用内置 `/log-supervisor` 指南）：
  - `supervisor_log_prepare`：幂等下载日志、`maxUnpackBytes` 防 Zip Slip / BOM 限制解压到 `<workDir>/logs/L1..Ln/`，诊断时把 `<workDir>/repos/<appSlug>` 链接到本会话挂载的只读代码快照（`repoKind: "snapshot"`，多会话共享），`workspace: "fix"` 时才换成经 `dshRepos.workspaceCreate` 创建的可写工作区，并预检索 `IssueMemory`（优先透传已有 `humanConclusion`）。
  - `supervisor_issue_search`：在诊断过程中按关键词、错误码或 `issueId` 随时查询本地已知问题库。
  - `supervisor_log_group_stats`：只读查询本批次同 `(product_code, component_code, error_code)` 最近若干天（默认 30，最多 180）的已归档日志数、`sw_version` / `component_version` 分布与首末归档时间，帮助判断问题是新出现还是持续存在；最多扫描 1000 条，超出时标明计数是下限，不返回下载链接。
  - `supervisor_log_submit`：校核 1:1 全槽位覆盖与证据路径真实性后写入 `log_tasks` 修订，写入/更新 `IssueMemory`，并通过单调防倒退的 `OutboxRunner`（`outbox_platform` 表）幂等上传每份日志的 `report.md` 与附件。
  - `supervisor_log_push_mr`：针对 `fix_code`（原地代码分支）或 `improve_skill`（隔离工作区 `<appSlug>-knowledge`），经 `dshRepos.workspacePush` 创建合并请求并自动登记入「审微」MR 持续监管队列。
- **两种飞书投递模式与非阻塞动作闭环**：
  - `quiet-until-done`（默认）：第 1 阶段后台无头完成分析与报告生成，第 2 阶段通过 `feishuTopics` 在目标群发送摘要根卡与精简总结并附带动作按钮；适合高噪异常降噪。
  - `topic-on-start`：批次发车即在飞书开话题流式直播诊断过程，支持人工中途插话追问。
  - 回合结束通过 `feishuActions` v1 / `propose_actions` 自动挂出独立动作卡片：**`[🔧 修复代码并提 MR]`**（要求群/本人具备 `code-write` 权限）与 **`[📚 改进分析流程 / 沉淀案例]`**；点击后零阻塞唤醒同一 Session，先以 `workspace: "fix"` 把 `<workDir>/repos/<appSlug>` 换成可写工作区，再改代码、跑测试、发 MR。终态 `log_tasks` 记录及工作区默认留存 90 天（被 `IssueMemory` 代表报告引用的记录豁免清理）。

## MR 自动评审（审微）

当 `mrReview.enabled` 开启（默认开启）且 `dsh-repo` 提供 `dshRepos` **v8** 时，`MrSupervisor` 自动巡检所有启用了「MR 自动评审」（`mr-review`）的仓库：

- **增量发现与滑动防抖**：周期扫描 `open` 与近期更新 MR，结合 `KeyedDebouncer`（滑动窗口 `debounceMs` 默认 45 秒、最长等待 5 分钟）把短时间内的连续 `git push` 与多条人类评论合并为一次唤醒，避免刷屏与重复消耗。支持跳过 Draft/WIP（`skipDraft: true`）与标签黑名单（`ignoreLabels`，大小写不敏感精确匹配）。
- **1 MR = 1 持久化 `mr-reviewer` Session**：
  - **外部 MR**（`origin: 'external'`）：在 `<mrWorkspacesDir>/<repoSlug>-mr-<number>` 就地结合全仓引用与测试开展首次全量评审；后续新提交时仅拉取 `lastReviewedSha..headSha` 增量 Diff，通过 `supervisor_mr_prepare` / `supervisor_mr_publish_review`（含行级评论与总评，支持在面板或配置追加 `mrReview.customInstructions` 团队规范）、`supervisor_mr_reply_thread` / `supervisor_mr_resolve_thread` 自动解决已修复线程，并用 `supervisor_mr_checkpoint` 更新游标。
  - **己方 MR**（`self-fix` / `self-skill`）：复用发起该 MR 的既有话题 Session 持续跟踪 CI 结果（`ci-failed` 在 `maxAutoFixAttempts` 上限内自动修并登记 `ownPushedSha`）与人类评审意见；遇到合并冲突时禁止自动 rebase/强推，如有配置 `mrReview.feishuChatId` 则发飞书告警卡通知人工介入。
- **自触发防护与多重熔断**：缓存代码主机当前机器人账号（`currentBotUser`）及 `ownPushedShas`（Bounded LRU），入口层硬性过滤机器人自身的评论与提交；设置单 MR 每日上限（`dailyMrTurnLimit: 12`）、单仓库每小时上限（`repoHourlyTurnLimit: 30`）与自修次数上限（`maxAutoFixAttempts: 2`），触限触发熔断并在设置 `mrReview.feishuChatId` 时发飞书告警，可在面板「运行总览」一键重置。已关闭/合并的 MR 克隆工作区保留 14 天、表记录保留 60 天后自动清理。

## 已知问题库与飞书多维表格同步

本地 `dsh_supervisor` 存储域的 `issues` 表通过 `IssueMemory`（与类型隔离的 `IssuesTable`）作为主存储永久沉淀各应用发现的故障模式；配置 `issueSync.bitableUrl` 后，后台 `IssueBitableSyncer` 通过 `dsh_channels` 的 `feishuBitable` v1（`ctx.get('feishuBitable')`）实现**零阻塞双向异步同步**：

- **严格列属权边界（16 列标准 Schema）**：
  - **AI 写入列（13 列）**：`问题ID`（必填文本主键，其余 12 列可选）、`应用`、`标题`、`匹配特征`、`排除特征`、`AI 诊断结论`、`AI 状态`、`解决建议`、`首次发现`、`最近出现`、`示例报告`、`最新报告`、`修复 MR`。本地写入 `IssueMemory` 后在 2 秒防抖窗口触发后台推送，且采用 `expectedAiFingerprint` 并发守卫，推送期间发生的新诊断更新不会丢失 `syncDirty` 标记。
  - **人工拥有列（3 列）**：`人工确认结论`、`人工状态`、`负责人`。**同步器物理禁止写操作触碰人工列**；每次周期（`syncIntervalMs`，默认 5 分钟）或手动触发同步时按 `问题ID` 拉回人工纠偏结果写入本地 `IssueMemory`，在下一次同类日志分析时优先透传给 `log-supervisor` 与 `supervisor_issue_search` 供核验复用。
- **故障隔离与自检**：飞书断连、未配多维表格或表结构缺失时，本地 `IssueMemory` 与日志诊断零受阻，恢复连通后自动补同步；支持在面板「已知问题库」执行 **「检查字段映射」**（`POST /supervisor/issues/check`）查看 16 列逐列匹配、类型兼容与只读列告警，或手动点击 **「立即同步」**（`POST /supervisor/issues/sync`）。

## 通过飞书使用

在飞书里使用 `/supervisor` 不需要与飞书渠道插件之间的耦合依赖：渠道插件把不在自己命令表中的 `/` 开头消息作为普通 prompt 交给 dsh，dsh 识别 `/supervisor` 后展开入口 SKILL。智能监管均以运行时按服务名动态查找的方式消费 `dsh_channels` 提供的公开契约（定义均本地镜像在 `src/deps/`）：

- **`feishuTopics`（v3）**：用于 `LogSupervisor` 自动批次播报/总结卡、旧分析话题的报告链接更新，以及 `MrSupervisor` 告警通知。
- **`feishuActions`（v1）**：用于观象在分析结束卡片挂出非阻塞后续按钮（如 `[🔧 修复代码并提 MR]` / `[📚 改进分析流程 / 沉淀案例]`），并在点击后按渠道权限判权唤醒原 Session。
- **`feishuBitable`（v1）**：用于 `IssueBitableSyncer` 后台读写用户配置的飞书多维表格（支持 `/base/<token>` 与 `/wiki/<node_token>`），与渠道 `feishu_wiki_base_edit` 共用表级写队列。
- **权限与提交身份事件**：写操作授权与 Git 提交署名经 `access/authorize`、`repo/commit-trailers` 中立事件由渠道插件回答，不直接耦合渠道实现。

## 开发

```sh
pnpm install
pnpm check        # 类型检查（Host 与 Client）+ 单元测试 + 构建 + 两个加载自检
```

## 发布

版本号由 semantic-release 按 Conventional Commits 计算，并始终保持 0.x：破坏性变更只升次版本号（如 0.2 → 0.3），不会升到 1.0.0。推送（含合并 PR）到 `main` 后，检查通过就自动发布正式版；beta **只在手动触发时发布**，推送到 `dev` 只跑检查。只有 `feat`、`fix` 或破坏性变更会产生新版本，其余类型的提交不发布。PR 标题需符合 `<type>(<scope>): <summary>`，type 取 `feat | fix | docs | test | refactor | chore | ci`。

| 分支 | 触发 | 版本 | npm dist-tag |
| --- | --- | --- | --- |
| `main` | 推送自动 | 正式版，如 `0.1.0` | `latest` |
| `dev` | 手动 | 预发布版，如 `0.1.0-beta.1` | `beta` |

发布正式版：提 `dev` → `main` 的 PR 并合并，或者直接把 `dev` 推送到 `main`（`git push origin dev:main`，只能快进，且需分支保护允许）。`main` 收到推送后 `pipeline` 先跑检查，通过后发布 npm 包、打 tag 并创建 GitHub Release。发布成功后 workflow 把这个提交带回 `dev`：`dev` 在此之后没有新提交时直接快进，有新提交时在 `dev` 上建一个合并提交（`chore: merge main into dev after stable release`）。这样正式版的 tag 总在 `dev` 的历史里，下一个 beta 从新版本往上算，发版后不用手动把 `main` 合回 `dev`。合并有冲突或被分支保护拒绝时这一步报错，此时手动提 `main` → `dev` 的 PR 合并即可。发布失败时可以在 `main` 上手动触发 `pipeline` 重试。

发布 beta：在 GitHub Actions 的 `pipeline` workflow 点击 **Run workflow** 并选择 `dev`，发布 `dev` 当前提交的 beta 版。勾选 `dry_run` 只预览下一个版本号，不发布。安装 beta 版用 `dsh-supervisor@beta`。

| 路径 | 内容 |
|---|---|
| `src/index.ts` | Cordis 插件入口（`name = 'supervisor'`）与跨插件服务动态监听 |
| `src/service.ts` | 组装共享监管运行时、观象/审微编排器、问题库同步器、入口 SKILL 与工具 |
| `src/runtime/` | 共享监管运行时：`dsh_supervisor` 7 张状态表、并发池、键控防抖器、滑动窗口熔断器、单调修订 Outbox |
| `src/deps/` | 跨插件窄契约：`dshRepos`（v7/v8）、`feishuTopics`（v3）、`feishuActions`（v1）、`feishuBitable`（v1）声明与查找 |
| `src/apps/` | 应用注册表、一次性旧元数据迁移、跟随 dsh-repo 仓库清单（`log-analysis` 与 `mr-review`） |
| `src/log/` | **观象域**：`LogSupervisor` 轮询/攒批、`unpack` 安全解压、`supervisor_log_*` 工具、提示词与报告渲染 |
| `src/mr/` | **审微域**：`MrSupervisor` 增量轮询/防抖、信号去重与自滤、`supervisor_mr_*` 工具与工作区管理 |
| `src/issues/` | `IssueMemory` 本地已知问题库检索与 `IssueBitableSyncer` 飞书多维表格双向同步器 |
| `src/runs/` | 运行目录、日志准入与下载、会话代码快照挂载、子 Agent 运行、工作区准备、改动检查、推送与合并请求 |
| `src/dispatch/` | `/supervisor` 代码挂载工具、可选派发工具与分析子 Agent 首条消息 |
| `src/improve/` | SKILL 查看工具、SKILL 不足记录、改进工具与改进子 Agent 首条消息 |
| `src/skill/` | `/supervisor` 入口 SKILL、快照可选 SKILL 发现封装与 4 个随包指南（`supervisor-kit`、`supervisor-improve`、`log-supervisor`、`mr-reviewer`） |
| `skills/` | `supervisor-kit`、`supervisor-improve`、`log-supervisor`、`mr-reviewer` SKILL 正文 |
| `src/platform/` | 日志平台开放 API OAuth2 客户端（令牌缓存、增量列表与元数据查询、下载签发与修订上传）与 client_secret 凭据读写 |
| `src/report/` | 报告生成与文件清单；旧分析话题的轮次记录、修订上传与持久化 |
| `src/settings/` | 面板契约、应用元数据 `applications.json`、生效设置与覆盖文件、HTTP 路由（含 `/supervisor/issues/*`） |
| `src/client/` | 左侧栏「智能监管」5 标签页整页面板（运行总览 / 应用与日志监管 / MR 自动评审 / 已知问题库 / 模型与高级） |
| `docs/supervisor/` | AI 原生智能监管中心（观象 + 审微）架构、跨插件契约与存储运维设计规格 |
| `examples/order-service/` | 示例应用仓库 |

## 路线图

- [x] 插件结构与 bundle 打包方式（重构重命名为 `dsh-supervisor` / `supervisor`）
- [x] **M1**：跨插件底座原语（`feishuActions` v1、`dshRepos` v8）与 `dsh_supervisor` 共享运行时骨架
- [x] **M2（审微）**：代码仓库 MR 自动初审、Push 增量重审、讨论回复/Resolve 与己方 MR CI 跟进
- [x] **M3（观象）**：日志平台自动轮询攒批、安全解压、仓内共享克隆排查、Outbox 报告回传与「修代码 / 改 SKILL」闭环
- [x] **M4**：本地 `IssueMemory` ↔ 飞书多维表格双向异步同步与 Web「智能监管」5 标签页统一面板
- [ ] 可选进阶：按日志版本号（`swVersion` / `componentVersion`）自动切换参考代码 Tag
- [ ] 可选进阶：更多日志平台 / 代码托管适配器与多维度统计趋势看板

## 许可证

待定。
