# 04. 持久化模型、安全护栏与演进迁移指南

本文档规定 `dsh-supervisor` 的统一持久化存储结构、并发与安全护栏、Web 管理面板布局，以及从现有 `dsh-logalyze` 代码库演进至 `dsh-supervisor` 的落地指南。

---

## 一、持久化存储模型（`storageDomain: 'dsh_supervisor'`）

所有插件状态统一存放在宿主 `ctx.storageDomain('dsh_supervisor')` 下，不依赖外部数据库，随 `$DSH_HOME` 备份与迁移：

| 表名 | 主键 (`key`) | 核心字段说明 | 生命周期与清理策略 |
| :--- | :--- | :--- | :--- |
| **`watermarks`** | 源标识（如 `'log_platform'` 或 `'repo:<canonicalUrl>'`） | `cursorTime` (ISO)、`cursorId`、`paused`、`lastPollAt`、`lastError`、`consecutiveFailures` | 常驻；随每次成功扫描原子推进 |
| **`pending_batches`** | 分组键哈希 `groupHash` | `productCode`、`componentCode`、`errorCode`、`appId`、`logIds[]`、`windowOpenedAt` | 凑满发车或超时发车后转入 `log_tasks` 并删除本行；重启后接着计时 |
| **`log_tasks`** | `taskId`（平台批次键或 `'feishu:<sessionId>'`） | `source` (`'platform' \| 'feishu'`)、`appId`、`sessionId`、`workDir`、`feishuLaunchKey?`、`inputs[]`、`status` (`'running' \| 'completed' \| 'failed' \| 'interrupted'`)、`revisions[]`（结构化结论与证据快照） | 保留最近 90 天；被 `issues` 代表报告引用的记录豁免自动清理 |
| **`outbox_platform`** | `'<taskId>:rev<N>:<logId>'` | `taskId`、`revision`、`logId`、`status` (`'pending' \| 'uploading' \| 'done' \| 'dead'`)、`analysisId?`、`detailUrl?`、`attempts`、`nextRetryAt`、`lastError?` | `done` 记录保留用于幂等防倒退校核（旧 `revision` 见到更高版本已完成则直接丢弃）；失败指数退避重试，超上限标 `dead` 供面板一键重推 |
| **`issues`** | `issueId`（如 `'ISS-order-0042'`） | `appId`、`title`、`matchCriteria`、`exclusionCriteria?`、`aiDiagnosis`、`aiStatus` (`'located' \| 'pending'`)、`resolutionAdvice`、**`humanConclusion?`**、**`humanStatus?`**、**`assignee?`**、`firstSeenAt`、`lastSeenAt`、`sampleReportUrl?`、`latestReportUrl?`、`fixMrUrl?`、`bitableRecordId?`、`syncDirty` (`boolean`) | 常驻核心知识资产；AI 写入路径在类型层物理禁止触碰 `human*` 字段 |
| **`supervised_mrs`** | `'<canonicalRepoUrl>#<mrNumber>'` | `repo`、`mrNumber`、`origin` (`'external' \| 'self-fix' \| 'self-skill'`)、`sessionId`、`workDir`、`feishuLaunchKey?`、`state` (`'open' \| 'merged' \| 'closed' \| 'draft_skipped'`)、`lastReviewedSha?`、`lastNoteCursor?`、`ownPushedShas[]`、`autoFixAttempts`、`pendingSignals[]`、`dueAt?` | MR 关闭或合并 14 天后自动清理本地 `workDir` 克隆目录，表记录保留 60 天防重 |
| **`circuit_breakers`** | 作用域键（如 `'log:<appId>'` 或 `'mr:<repo>'`） | `windowStartAt`、`triggeredCount`、`trippedUntil?`、`reason?` | 滑动窗口统计；触发熔断后暂停自动拉起新 Session，面板支持手动一键解除 |

---

## 二、安全、并发与防失控护栏

将人工动作转为 Agent 自动监管，必须具备工业级的确定性保险丝：

### 1. 独立并发池与优先级隔离
- **双池隔离**：日志自动分析池（默认并发 `4`）与 MR 自动评审池（默认并发 `3`）各自独立计数，防止某一边突发积压饿死另一边。
- **人工交互优先**：飞书话题内的人工追问、人工点击 `[🔧 修复代码并提 MR]` 直接复用既有 Session，不受自动轮询入站队列阻塞。

### 2. 三重防死循环与成本熔断（Circuit Breakers）
1. **身份自滤**：MR 监管缓存每个代码主机的当前机器人账号（`currentBotUser`），在事件入口层硬性丢弃机器人自身发表的评论、Review 及登记在 `ownPushedShas` 中的提交。
2. **单对象频率上限**：
   - 单个 MR 每天自动唤醒上限默认 `12` 次（与 `dsh-repo` 的 `dailyWakeLimit` 对齐）；
   - 自产修复 MR 针对同一思路的连续 CI 自动修复上限为 `2` 次。
3. **全局与单应用小时预算**：单应用日志批次 > `15 批/小时` 或单仓库 MR 唤醒 > `30 次/小时` 时自动触发熔断（`tripped`），向管理员飞书发一张熔断通知卡并在 Web 面板置顶显示，防止配置失误或上游故障烧空模型配额。

### 3. 权限与沙箱边界
- **只读分析/初审零审批阻塞，高危写操作强门控**：
  - 读日志、读本地镜像克隆、回传日志平台分析结论、对已开启「MR 自动评审」的仓库发表代码评审意见——由监管服务按管理员预设配置自动放行；
  - 推送业务修复分支、创建修复/知识改进 MR——必须由具有飞书 `code-write` 权限的用户点击 Action Card 按钮（或在话题内下达指令）触发，并完整经过 `dsh-repo` 本机代理的受保护分支校验（永远禁止直接 `push` 默认分支、受保护分支或删除远端分支）。
- **宿主进程沙箱**：所有监管创建的后台 Session 默认绑定 `workspace-write` 沙箱策略，仅可写自身 `<workDir>`，无法篡改宿主配置、其他会话目录或 `$DSH_HOME/.credentials.yaml`。

---

## 三、Web 管理面板设计（左侧栏 →「智能监管」）

原「观象」侧栏面板升级为统一的 **「智能监管（Supervisor）」** 整页面板，顶部常驻运行状态栏（日志轮询状态、MR 巡检状态、活跃任务数、熔断告警徽标、全局暂停/恢复开关），下方设 5 个标签页：

| 标签页 | 管理与可观测内容 |
| :--- | :--- |
| **1. 运行总览** | 正在运行与最近完成的日志诊断批次、活跃监管中的 MR 列表（点击可直接跳入对应 DSH Session 查看完整推理过程或人工接管）、熔断器状态与平台回传死信重试按钮 |
| **2. 应用与日志监管** | 跟随 `dsh-repo` 已启用「日志分析」的仓库列表（编辑应用业务描述与触发别名 Badge）；日志平台连接凭据、轮询窗口（条数/等待时长/并发）、默认飞书通知群与投递模式（开局建话题 vs 产出建话题） |
| **3. MR 自动评审** | 跟随 `dsh-repo` 已启用「MR 自动评审」的仓库列表；配置 Draft 跳过策略、防抖窗口、忽略标签、评审严厉度提示补充及可选飞书通知群 |
| **4. 已知问题库** | 本地 `IssueMemory` 搜索浏览视图；飞书多维表格 URL 绑定、字段映射自检、最近同步时间与手动立即同步按钮 |
| **5. 模型与高级** | 为 `log-supervisor` 与 `mr-reviewer` 分别指定模型/推理强度档位（例如初审/定位用高推理档，简单增量核销用标准档）、工作目录根路径与历史保留天数 |

---

## 四、从 `dsh-logalyze` 到 `dsh-supervisor` 的演进与复用指南

当前本地 `dsh-logalyze` 已重置回干净的 `origin/dev`（`a8a6def`），此前实验分支已完整归档在本地 `archive/*` 分支中。正式启动开发时，按以下清单取舍演进，避免重复造轮子：

### 1. 包与目录演进规划
- **仓库与包标识**：仓库目录可重命名/演进为 `dsh-supervisor`，`package.json` 包名定为 `dsh-supervisor`（Cordis Loader 稳定 `id: supervisor`，斜杠入口支持 `/logalyze` 与 `/supervise`）。
- **推荐源码目录结构**：
  ```text
  src/
  ├── index.ts                  # Cordis 插件入口：组装存储、连接器、两大监管域与 Web 路由
  ├── config.ts                 # 配置 Schema 校验
  ├── runtime/                  # 共享监管底座：storage 封装、并发池、防抖器、熔断器、幂等 Outbox
  ├── deps/                     # 外部插件窄契约声明：dshRepos(v8)、feishuTopics(v3)、feishuActions(v1)
  ├── apps/                     # 应用仓库目录跟随与别名匹配（向 dsh-repo 注册 log-analysis & mr-review）
  ├── log/                      # 【观象域】platform/client、poller、batcher、unpack、tools、preset/skills
  ├── mr/                       # 【审微域】watcher、signals、tools、preset/skills
  ├── issues/                   # 本地 IssueMemory 存储检索 + 飞书多维表格双向异步同步器
  └── client/                   # Web 左侧栏「智能监管」React 面板
  ```

### 2. 既有代码资产去留对照表

| 既有代码来源 | 处置方式 | 说明 |
| :--- | :--- | :--- |
| `src/platform/client.ts`、`src/report/upload.ts`、`src/report/manifest.ts` *(当前 `dev`)* | **✅ 直接保留复用** | OAuth2 令牌缓存刷新、预签名链接过期重签、单文件/总大小预算控制与并发直传已经过充分打磨与测试，直接迁入 `src/log/platform/` |
| `src/runs/download.ts` 与 ZIP 安全解压逻辑 | **✅ 保留复用** | 白名单域名下载、大小/超时限制与防 Zip Slip 解压直接作为 `supervisor_log_prepare` 底层实现 |
| `archive/defect-loop-app-settings` (`c17c4c1`) 中的应用描述/别名 Badge UI 与 `applications.json` 存储 | **✅ 挑选复用** | 移除必选 `.agents/logalyze.yaml` 限制、单行回车生成可删别名标签的设置体验非常契合新架构，可直接挑入 `src/apps/` 与 `src/client/` |
| `src/onboard/*`（旧仓库初始化向导）、`src/dispatch/*`（旧强制派发子 Agent 入口）*(当前 `dev`)* | **🗑️ 废弃移除** | 新架构下无 manifest 也可直接分析，且由主 Agent 结合会话内克隆直接分析、按需自主派发子 Agent |
| `archive/defect-loop-channels` (`26ad33e` / `dsh_channels` `85cca27`) 中的 `feishuAnalysis` 与 `SAFE_TOOLS` | **🗑️ 彻底废弃** | 已由「会话内 `workspaceCreate` 共享克隆 + 通用 `feishuActions` 非阻塞动作提议卡」完美替代，不再污染渠道层 |
