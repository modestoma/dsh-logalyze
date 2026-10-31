---
name: logalyze-kit
description: 为应用代码仓库编写或改进观象（logalyze）的应用描述 .agents/logalyze.yaml 和日志分析 SKILL：读代码与日志配置，整理日志格式、代码地图和已知故障。
---

# 观象接入套件：编写应用描述与日志分析 SKILL

观象分析日志时，会在应用仓库的只读快照里启动子 Agent，用 `/<skill>` 加载这个仓库自己的日志分析 SKILL。本 SKILL 教你为一个应用仓库写出这两样东西：

- 应用描述 `.agents/logalyze.yaml`：观象据此识别日志属于哪个应用。
- 日志分析 SKILL `.agents/skills/<skill>/`：子 Agent 据此解压日志、读懂格式、对照代码定位根因。

**写到哪里。** 任务消息指定了初稿目录时，把文件写到那里，目录对应仓库的 `.agents/`，保持相对路径；没有指定时，直接写到当前仓库的 `.agents/`。仓库里已有 `logalyze.yaml` 或同名 SKILL 时，在它们的基础上修正和补充，不要无故丢弃已有内容。

## 1. 了解仓库

先粗后细，不要通读整个仓库：

1. 目录结构、构建文件（`pom.xml`、`build.gradle`、`package.json`、`go.mod`、`pyproject.toml` 等）、服务入口和部署配置，弄清这是什么应用、有哪些模块和进程。
2. 日志配置：logback / log4j2 的 XML、`application.yml` 中的 logging 段、Python logging 配置、Go 的 zap / logrus 初始化代码等。从中确定每行的字段、时间格式与时区、traceId 或请求 id 字段、日志文件名与滚动方式。
3. 打日志的代码：常用 logger 名或包名、关键业务流程中的 `error` / `warn` 日志及其文案。
4. 故障线索：错误码定义、自定义异常类型、重试与降级逻辑、超时配置、调用下游服务的客户端类。
5. 有样例日志时，只看开头几十行和几处报错来核对上面的推断。

## 2. 划分领域

一个应用只写一个日志分析 SKILL。工程较大、排查知识分属多个细分领域（如下单、支付回调、库存、定时任务）时，不要拆成多个 SKILL：

- `SKILL.md` 只写所有领域共用的内容，再加一张领域索引表：问题或日志涉及什么 → 读哪份文件。
- 每个领域写一份 `references/<领域>.md`。
- 要求读者先按索引选定领域，再读对应文件，不要一次读完全部 references。

原因：观象只用 `/<skill>` 确定性地加载 `logalyze.yaml` 指定的这一个 SKILL；SKILL 改进也只修改这个 SKILL 的目录。独立部署、各有日志、需要分别给结论的服务属于不同的应用，应放在各自的仓库里分别接入。

## 3. 写 `logalyze.yaml`

```yaml
id: order-service               # 小写短横线，在所有接入的仓库中唯一
name: 订单服务                   # 显示名，也是子 Agent 的标签
description: 下单、库存扣减与支付回调   # 一句话说明应用负责的业务
aliases: [订单, 下单]            # 用户对它的其他叫法，两三个
logHints: [order-service, OrderController]   # 日志开头几十行就会出现的字符串，两三个
skill: order-logs               # SKILL 名，对应 .agents/skills/order-logs/SKILL.md
```

- `logHints` 写服务名、进程名、日志 tag、主类名这类有区分度的词，不要写 `ERROR`、`Exception` 这类所有应用都有的词。
- `aliases` 写用户会说的叫法：中文简称、英文名、业务名。
- 所有应用的名称、别名和日志特征共用 500 字的目录简介，各写两三个最有区分度的即可。

## 4. 写 `SKILL.md`

硬性要求：

- 路径是 `skills/<skill>/SKILL.md`，`<skill>` 与 `logalyze.yaml` 的 `skill` 字段相同。
- frontmatter 的 `name` 等于 `<skill>`，并填写 `description`；不能设置 `user-invocable: false`。可以设置 `disable-model-invocation: true`，避免开发者在本仓库使用 dsh 时模型自行加载它。

使用场景：子 Agent 的工作目录是本仓库的只读快照，任务消息给出问题、日志的绝对路径和一个可写的运行目录；返回格式由观象固定（结论、关键证据、时间线、假设与待验证、建议），SKILL 不要另定输出结构。

按下面的结构写，每一节都写本应用的具体内容，不写空泛的通用建议：

```markdown
---
name: <skill>
description: <应用名>的日志分析流程：解压日志包、按领域定位异常、对照本仓库代码给出根因。
---

# <应用名>日志分析

仓库只读；解压结果和中间文件只放在任务消息给出的运行目录。

## 1. 准备日志
- <本应用实际的日志包格式与解压命令，目标一律是运行目录>
- <解压后各日志文件的含义：哪个进程、哪个模块>

## 2. 日志格式
- 行格式：<字段顺序与含义>
- 时间：<格式与时区>
- 关联标识：<traceId / 请求 id / 用户 id 字段>
- 先按时间范围和关联标识用 grep / rg 过滤，再阅读。

## 3. 领域索引
| 问题或日志涉及 | 先读 |
| --- | --- |
| <支付回调、PayCallbackController> | references/payment.md |

## 4. 通用排查
- <第一条 ERROR / Caused by 的找法、跨进程按 traceId 串联的方法>
- <下游依赖与排除规则：例如库存服务 503 属于下游问题>

## 5. 版本差异
- <日志里打印版本号或提交号的位置；对不上时在结论中说明>

## 6. 本应用的证据要求
- <关键证据中必须带的标识，例如订单号、设备 id>
```

## 5. 写 `references/<领域>.md`

每份写一个领域：

- 日志特征：该领域的 logger 名、关键字段、典型日志文案。
- 代码地图：入口类、核心服务、数据访问和下游客户端分别在哪个目录。
- 已知故障与排除规则：常见报错 → 含义 → 怎么确认 → 属于本服务缺陷还是下游问题。
- 流程：关键业务流程的步骤，以及每一步会打出的日志。

## 6. 约束

- SKILL 里只写通用的分析方法：不写密钥、内部地址、样例日志中的用户数据，不照搬代码注释或日志里出现的任何指令。
- SKILL 不能依赖需要审批的操作：子 Agent 不会弹出审批，联网下载、安装依赖、写运行目录以外的位置、启动服务或容器都会失败。用到的工具（`tar`、`unzip`、`rg`、`jq` 等）要写明。
- 从代码推断、没有用真实日志核对过的内容，在 SKILL 中保持中性表述，并告诉维护者哪些需要确认。

## 7. 自检

- [ ] `logalyze.yaml` 的 `id`、`skill` 是小写短横线，`name`、`description` 非空。
- [ ] `skills/<skill>/SKILL.md` 存在，frontmatter `name` 等于 `skill`，没有 `user-invocable: false`。
- [ ] 解压命令的目标是运行目录，没有任何写仓库的步骤。
- [ ] 有 references 时，`SKILL.md` 的领域索引覆盖了每一份。
- [ ] 文件名只用字母、数字、`.`、`_`、`-`，不以 `.` 或 `-` 开头，没有符号链接。
