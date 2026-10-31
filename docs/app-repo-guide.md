# 应用仓库接入指南

本文写给应用代码仓库的维护者：一个应用要被观象分析，仓库里需要放什么、观象那边需要配什么。

## 分工

观象只负责识别与派发；怎么分析某个应用的日志，由应用仓库自己的 SKILL 决定。

| 谁 | 做什么 |
|---|---|
| 应用仓库 | 提供应用描述 `.agents/logalyze.yaml` 和日志分析 SKILL `.agents/skills/<skill>/SKILL.md`，推送到观象跟踪的分支 |
| 观象部署方 | 同时安装观象和提供 `dshRepos` 服务的插件（如 [dsh-repo](https://github.com/modestoma/dsh-repo)），在 DSH Web 左侧栏的「观象」设置面板里填 git 地址，按需配置日志下载白名单和 SKILL 改进；主机和访问令牌在 dsh-repo 中配置 |
| 观象插件 | 经 `dshRepos` 服务拉取仓库、生成应用目录、下载日志、在应用代码的只读快照里启动子 Agent，并汇总各应用的结论 |

## 接入清单

1. 在仓库里新增 `.agents/logalyze.yaml`，见[应用描述](#应用描述)。也可以在仓库里运行装有观象的 dsh，输入 `/logalyze-kit`，让模型按观象自带的接入套件起草这一步和下一步的文件。
2. 在仓库里新增 `.agents/skills/<skill>/SKILL.md`，见[日志分析 SKILL](#日志分析-skill)。
3. 把这两个文件推送到观象跟踪的分支（默认是远端默认分支）。观象读取的是远端最新提交，不读任何本地检出。
4. 在设置面板「应用仓库」中添加 git 地址，或在对话中让观象添加（见[在对话中接入](#在对话中接入)）；https 私有仓库另在 dsh-repo 中为它所在的主机配置令牌，见[在设置面板接入](#在设置面板接入)。
5. 日志以对象存储链接提供时，在「日志下载」中加入该域名。
6. 面板中该仓库显示为可用后，发一条 `/logalyze <问题>`，附上日志试跑。

## 最小示例

```
order-service/
├── .agents/
│   ├── logalyze.yaml
│   └── skills/
│       └── log-analysis/
│           └── SKILL.md
└── src/ …
```

`.agents/logalyze.yaml`：

```yaml
id: order-service
name: 订单服务
description: 下单、库存扣减与支付回调
aliases: [订单, 下单]
logHints: [order-service, OrderController]
skill: log-analysis
```

`.agents/skills/log-analysis/SKILL.md`：

```markdown
---
name: log-analysis
description: 订单服务的日志分析流程：解压日志包、定位异常、对照本仓库代码给出根因。
---

# 订单服务日志分析

仓库只读；解压和中间文件只放在任务消息给出的运行目录。

## 1. 准备日志
- `.tar.gz` / `.tgz`：`tar -xzf <日志包> -C <运行目录>`
- `.zip`：`unzip -o <日志包> -d <运行目录>`
- 纯文本日志直接读取，不要复制。

## 2. 定位异常
- 日志格式：`时间 级别 [线程] [traceId] 类名 - 消息`。
- 先按时间范围和订单号、traceId 用 `grep` 过滤，再看第一条 `ERROR` / `Caused by`。

## 3. 对照代码
- `com.example.order.*` 位于 `src/main/java/com/example/order/`。
- `InventoryClient` 返回 503 或超时属于库存服务问题，不是本服务缺陷。
```

完整的可运行示例（含示例日志和代码）见 [examples/order-service](../examples/order-service)。

## 应用描述

`.agents/logalyze.yaml` 放在仓库根目录下，必须是普通文件（不能是符号链接）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 小写短横线格式，如 `order-service`。派发和分析请求按它找到应用，在所有接入的仓库中必须唯一 |
| `name` | 是 | 显示名，也是子 Agent 的标签，如「订单服务分析」 |
| `description` | 是 | 一句话说明应用负责什么，出现在入口 SKILL 的应用目录里 |
| `aliases` | 否 | 用户对这个应用的其他叫法，如中文名简称、英文名 |
| `logHints` | 否 | 能从日志里认出本应用的字符串，如服务名、主类名、日志 tag |
| `skill` | 是 | 日志分析 SKILL 名，小写短横线格式；对应 `.agents/skills/<skill>/SKILL.md` |

规则：

- 观象每次加载 `/logalyze` 时先经 `dshRepos` 服务 fetch，再从跟踪分支的最新提交读取应用描述。改了描述或 SKILL，推送后下一次 `/logalyze` 就生效，不用重启。
- 一个仓库对应一个应用。多个仓库声明同一个 `id` 时，这几个仓库全部不可用。
- 描述不合法、SKILL 缺失或设置了 `user-invocable: false` 时，应用不可用，原因显示在设置面板。

## 日志分析 SKILL

### 硬性要求

- 路径是 `.agents/skills/<skill>/SKILL.md`，`<skill>` 与 `logalyze.yaml` 的 `skill` 字段相同，必须是普通文件。
- frontmatter 的 `name` 也要等于 `<skill>`。DSH 按 frontmatter 的 `name` 注册 SKILL，观象派发时用 `/<skill>` 加载它，名称不一致时子 Agent 加载不到。`description` 必填。
- 不能设置 `user-invocable: false`，否则 `/<skill>` 无法加载，观象会把应用标为不可用。
- 可以设置 `disable-model-invocation: true`：开发者在本仓库里使用 dsh 时模型就不会自行加载它，观象的 `/<skill>` 加载不受影响。
- SKILL 目录里可以放 `scripts/`、`references/` 等辅助文件，子 Agent 可以读取和执行，但它们的输出只能写到运行目录。

### 子 Agent 收到什么

观象为每个应用启动一个子 Agent，工作目录是应用仓库在分析时那个提交的只读快照。它的首条消息大致如下：

```
/log-analysis

你是观象派发的日志分析子任务，负责应用「订单服务」（id: `order-service`）。当前工作目录是该应用的代码仓库，检出提交 `3f2a9c1e0b7d`。

## 问题
（父 Agent 整理的现象、时间、关键标识和用户原话要点）

## 日志
- `/…/.logalyze/runs/<runId>/1-order-service/1-app.tar.gz`（下载自 https://oss.example.com/…）；只看本应用相关部分：tag=order

## 工作约束
- 应用仓库只读 …
- 解压结果和中间文件只放在运行目录 `/…/.logalyze/runs/<runId>/1-order-service`。

## 返回格式
结论、关键证据、时间线、假设与待验证、建议，五部分。
```

- 日志一律是绝对路径。附件和本机文件直接给原路径；对象存储链接由观象下载到运行目录。日志包不会被预先解压。
- 一个文件混有多个应用的输出时，会附带 `filter` 说明如何区分。
- 返回格式由观象固定。SKILL 的「输出」部分只补充本应用特有的要求（比如证据中写哪些标识），不要另定一套结构。

### 写作要点

- **先写解压。** 按本应用实际的日志包格式写清命令，解压目标一律是运行目录。仓库只读，解压到仓库里会失败。
- **只读，只写运行目录。** 不改仓库文件，不执行 git 写操作，不 `cd` 到别处写文件。
- **不要依赖需要审批的操作。** 子 Agent 不会弹出审批或提问，通过飞书使用时 dsh_channels 也不转发子 Agent 的审批。联网下载、安装依赖、写运行目录以外的位置、启动服务或容器这类操作会直接失败。需要的工具（`tar`、`unzip`、`rg`、`jq` 等）要在运行 dsh 的机器上预先装好。
- **先过滤再阅读。** 日志可能很大，先按时间、traceId、订单号等用 `grep`/`rg` 缩小范围，不要通读或整体复制。
- **写清日志格式和代码地图。** 每行字段的含义、时间格式与时区、关键 logger 名对应的代码目录、调用链上的上下游服务。
- **写已知故障和排除规则。** 比如「库存服务 503 属于下游问题」。这部分是 SKILL 最有价值的内容，也是 [SKILL 改进](#skill-改进) 最常补充的内容。
- **说明版本对不上时怎么办。** 子 Agent 看的是跟踪分支的最新代码，日志可能来自更早的版本。日志里打印了版本号或提交号时，告诉子 Agent 在哪里找，并在结论中说明版本差异。

### 大型仓库：用 references 拆分领域

工程较大、排查知识分属多个细分领域（如下单、支付回调、库存、定时任务）时，仍然只写一个日志分析 SKILL，把各领域的知识拆到它的 `references/` 下：

```
.agents/skills/order-logs/
├── SKILL.md              # 公共部分 + 领域索引 + 案例索引
├── references/
│   ├── checkout.md       # 下单
│   ├── payment.md        # 支付回调
│   └── inventory.md      # 库存扣减
└── cases/                # SKILL 改进沉淀的案例，一个问题一份
    └── 2026-10-31-pay-callback-timeout.md
```

- `SKILL.md` 只写所有领域共用的内容：解压、日志格式、通用排查步骤，再加一张领域索引表，写明「问题或日志涉及什么 → 读哪份 references」，并要求子 Agent 先按索引选定领域再读对应文件，不要一次读完全部 references。
- 每份 `references/<领域>.md` 写该领域的日志特征（logger 名、关键字段）、代码地图和已知故障与排除规则。
- `cases/` 由 [SKILL 改进](#skill-改进) 维护：每份案例记录一次 SKILL 没覆盖到的问题，`SKILL.md` 末尾的「案例索引」表列出每份案例的关键特征，子 Agent 遇到相符的日志时再读对应案例。也可以手写案例，或在仓库里输入 `/logalyze-improve` 让 dsh 帮你整理。
- 不要拆成多个 SKILL。观象只用 `/<skill>` 确定性地加载 `logalyze.yaml` 指定的这一个；其他 SKILL 要靠子 Agent 按 description 自行挑选，设置了 `disable-model-invocation: true` 的还无法加载。[SKILL 改进](#skill-改进) 也只能修改 `.agents/skills/<skill>/` 目录，放在其他 SKILL 里的知识不会被改进。

references 适合同一个应用内的领域划分。几个领域其实是独立部署、各有日志、需要分别给结论的服务时，它们是不同的应用；目前一个仓库只能声明一个应用，见[应用描述](#应用描述)的规则。

## 让观象认出你的应用

用户输入 `/logalyze` 时一定走观象。没有输入时，只要有可用应用且 `autoInvoke` 开启（默认开启），模型也会在任务匹配时自行加载观象，比如用户说「帮我看下订单服务的报错日志」，或贴出带 `OrderController` 的堆栈。应用描述决定匹配效果：

- 模型看到的观象简介由各应用的 `name（id、aliases、logHints）` 拼接而成，**所有应用共用 500 字的上限**，放不下的应用只计数不列出。`aliases` 和 `logHints` 各写两三个最有区分度的词。
- `aliases` 写用户会说的叫法：中文简称、英文名、业务名。
- `logHints` 写日志开头几十行就会出现的字符串：服务名、进程名、日志 tag、主类名。入口 SKILL 只允许模型看日志开头几十行来判断归属。不要用 `ERROR`、`Exception` 这种所有应用都有的词。
- `description` 写这个应用负责的业务，出现在入口 SKILL 的应用目录表格里，帮助模型区分名字相近的应用。

日志明显不属于任何已注册应用时，模型按普通方式处理，不会派发。

## 在对话中接入

仓库还没有应用描述和 SKILL 时，可以让观象起草，省去前两步：

1. 在 DSH 对话（Web 或飞书）中说「把 `<git 地址>` 接入观象」，可以附上样例日志，并说明模块划分或最常排查的问题。
2. 观象请求授权后把地址加入应用仓库列表并拉取。仓库已有合法的描述和 SKILL 时直接可用。
3. 缺少描述或 SKILL 时，观象派一个子 Agent 在仓库的只读快照里按接入套件 `/logalyze-kit` 读代码和样例日志，起草 `.agents/logalyze.yaml` 和日志分析 SKILL（大型仓库按[领域拆到 references](#大型仓库用-references-拆分领域)），并说明哪些内容是推断、需要你确认。
4. 观象展示改动并请求授权；允许后提交到新分支 `logalyze/init-<应用 id>-…`，创建合入跟踪分支的合并请求。令牌权限要求与 [SKILL 改进](#skill-改进) 相同。
5. 评审并修改合并请求，合并后下一次 `/logalyze` 即启用该应用。

起草的 SKILL 是起点。日志格式、已知故障这些内容来自代码推断，合并前请对照真实日志核对，之后可以靠 SKILL 改进持续补充。

## 在设置面板接入

DSH Web 左侧栏「观象」打开设置面板。面板保存的值写入 `$DSH_HOME/logalyze/settings.json`，也可以在 profile 的 cordis.yml 中按 `id: logalyze` 配置默认值（字段见 [README](../README.md#安装与配置)）。

| 分页 | 应用仓库需要的设置 |
|---|---|
| 应用仓库 | 填 git 地址，分支可选（默认跟随远端默认分支）。支持 https/http/ssh/git/file URL、`user@host:path` 和绝对路径。拉取后显示提交号、应用描述或不可用原因 |
| 日志下载 | 日志以链接提供时，把对象存储域名加入白名单（同时允许其子域名） |
| 高级 | 拉取间隔、单次应用数上限、派发超时、SKILL 改进开关 |

### git 地址与令牌

- 仓库由 `dshRepos` 服务拉取，观象自己不运行 git。没有该服务或服务版本不兼容时，所有仓库都拉取失败，原因显示在面板。
- https 私有仓库所在主机的令牌在 dsh-repo 中配置，「应用仓库」分页的「管理主机与令牌」直接跳过去。主机或令牌变更后观象自动重新拉取全部仓库。
- ssh 地址、`user@host:path`、其他主机和本地路径使用运行 dsh 的机器上已有的 git 凭据（SSH key 或 credential helper），不会弹出交互式输入。
- 令牌权限：只拉取时，GitLab 需要 `read_repository`，GitHub 需要 Contents 读权限。开启 [SKILL 改进](#skill-改进) 时，GitLab 需要 `api`，GitHub 需要 Contents 和 Pull requests 读写权限。
- **建议使用项目访问令牌**（或组访问令牌）：只覆盖要接入的应用仓库，设置过期时间。个人令牌能访问令牌主人有权限的所有项目，加了写权限后风险更大。

### 日志下载

- 只下载 http/https 链接，域名必须在白名单中，链接中不能带用户名和密码。
- 下载不带任何鉴权，私有存储要提供预签名链接或临时下载链接。
- 单文件大小和下载耗时有上限（默认 512 MiB、10 分钟），在「日志下载」中调整。

## SKILL 改进

分析中 SKILL 没覆盖到的问题，以及用户指出的 SKILL 错误，观象会在用户同意后修改 SKILL 并整理为案例，以合并请求的形式交给你评审。默认开启，可以在设置面板「高级」→「SKILL 改进」关闭。

改进有两个来源：

- **分析时发现不足。** 分析子 Agent 觉得 SKILL 没能支撑这次分析时，在运行目录记下哪里不足、实际怎样定位、依据的日志行和代码位置。父 Agent 照常回复分析结论，然后询问用户是否改进。
- **用户主动要求。** 用户指出某次分析套用的 SKILL 记录有错，或者在新会话里直接说要优化某个应用的日志分析 SKILL。父 Agent 先读出现有 SKILL，和用户确认哪部分不对、正确做法是什么、有没有样例日志，问清后询问是否改进。

之后的流程相同：

1. 询问在飞书里是决策卡片，在 Web 里是审批提示。
2. 用户点「允许」后，观象派一个改进子 Agent，按观象自带的改进指南 `/logalyze-improve` 修改 SKILL：把可复用的排查知识补进或改正到 `SKILL.md` 或 `references/`；对应具体问题时写一份案例 `cases/<日期>-<slug>.md`（现象、脱敏的日志特征、根因、定位路径、确认与排除），并在「案例索引」加一行。依据一次分析时必须有案例。
3. 观象检查改动后，经 `dshRepos` 服务以最新提交为起点建新分支 `logalyze/skill-<应用 id>-<改动摘要前缀>`，提交改动，并创建合入跟踪分支的合并请求（GitLab MR 或 GitHub PR）。回复里列出改动的文件和要点，附合并请求链接。

前提与限制：

- **权限模式必须是「询问」类。** 会话的审批策略为 `never`（DSH「完全访问」模式）时询问一律被拒绝，不会起草和推送。
- **支持 GitLab（包括自建实例）和 GitHub。** 应用仓库的 git 地址（https、ssh 或 `user@host:path`）要能被 `dshRepos` 识别为已配置主机上的仓库，该主机的令牌要有上面列出的写权限。
- **合并请求以该主机令牌主人的身份创建。** 提交作者是观象配置的 `skillUpdateAuthor`，省略时也是令牌主人。
- **改动范围只限 `.agents/skills/<skill>/`，依据一次分析时必须包含一份案例。** 观象不提交到已有分支和默认分支，合并由仓库的评审流程决定，合并后下一次 `/logalyze` 生效。

应用仓库维护者应当：

- 保护默认分支，要求合并请求评审后才能合入。
- 用 CODEOWNERS 等方式为 `.agents/skills/` 指定评审人。
- 评审时留意改动内容，尤其是案例里的日志片段是否已脱敏。日志内容不可信，可能诱导模型写出不当的 SKILL；观象只限制改动范围，不判断内容。

## 自检与排错

设置面板「应用仓库」显示每个仓库的状态和不可用原因：

| 面板显示 | 处理 |
|---|---|
| 仓库缺少应用描述 `.agents/logalyze.yaml` | 确认文件已推送到跟踪分支，路径和文件名正确 |
| `.agents/logalyze.yaml` 不合法：… | 按提示修正字段，`id` 和 `skill` 只能是小写字母、数字和短横线 |
| 仓库缺少日志分析 SKILL `.agents/skills/<skill>/SKILL.md` | 目录名要与 `skill` 字段一致 |
| … 设置了 `user-invocable: false` … | 删除该设置 |
| … 不是普通文件 | 把符号链接换成真实文件 |
| 多个仓库声明同一个应用 id | 给其中一个仓库换 `id` |
| 观象需要 dsh-repo 插件… / dsh-repo 的服务与观象不兼容… | 安装或换用提供 `dshRepos` 服务版本 1 的插件 |
| 拉取失败（认证、令牌未设置） | 检查 dsh-repo 中的主机地址和令牌权限；ssh 地址检查本机 SSH key |
| 面板可用，但子 Agent 加载的 SKILL 不是 `.agents/skills/<skill>/` 下这份 | 删除仓库里 `.dsh/skills/` 下的同名 SKILL：DSH 同名时优先加载 `.dsh/skills/` |

面板显示可用但子 Agent 没有按 SKILL 工作时，先检查 SKILL frontmatter 的 `name` 是否与 `skill` 字段一致。

本地试用可以先用 [examples/order-service](../examples/order-service)：把它复制出来初始化为 git 仓库，在面板添加它的绝对路径，然后按示例 README 中的消息试跑。
