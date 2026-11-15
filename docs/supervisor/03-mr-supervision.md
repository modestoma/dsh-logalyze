# 03. 代码仓库 MR 自动初审与增量重审设计（审微域）

本文档定义 `dsh-supervisor` 中 **代码仓库合并请求（PR/MR）全生命周期自动监管（审微）** 的感知机制、状态模型、增量重审协议与防死循环护栏。

---

## 一、核心设计目标：告别“无状态复读机评审”

传统 Webhook 触发的 AI Code Review 每次收到 `push` 都开一个全新上下文重看整份 Diff，存在三大顽疾：
1. **失忆复读**：作者已经在评论区解释了“此处因兼容老协议故意保留”，下一轮 Push 机器人又在原处刷一条一模一样的警告。
2. **噪音淹没**：一个 MR 改 5 次就堆几十条过时评论，没人替作者把已修复的问题点 Resolve。
3. **只见局部**：只看孤立的 Unified Diff 片段，不查调用方、类型定义与测试覆盖，满屏痛痒表面的代码风格废话。

基于 `deepseek-harness` 持久化 Session 与本地裸镜像克隆，「审微」实现 **Stateful Incremental Reviewer**：
- **1 个 `(repo, mrNumber)` = 1 个专属持久化 DSH Session**；
- **全仓视野**：在 `<workDir>/repos/<slug>` 中检出真实代码树，可用 `rg` / `read` / `git log` 追踪上下游调用链；
- **增量重审与闭环确认**：记住 `lastReviewedSha` 与未解决线程，新提交只审增量 Diff + 核验旧问题（修好即自动 Resolve），新评论结合完整上下文有理有据回应。

---

## 二、仓库级感知与防抖状态机（`RepoMrWatcher`）

### 1. 仓库接入配置
- `dsh-supervisor` 调用 `dshRepos.featureRegister({ id: 'mr-review', title: 'MR 自动评审', description: '自动发现新合并请求并持续跟进新提交与新评论进行增量重审' })`。
- 管理员在 `dsh-repo` 的「代码仓库 → 仓库」中为需要监管的仓库勾选「MR 自动评审」（功能分支字段可指定只监管合入特定目标分支如 `main`/`dev` 的 MR；留空表示监管该仓库所有目标分支的 MR）。
- 在 `dsh-supervisor` 的「智能监管 → MR 评审」面板可进一步配置细粒度规则：
  - `skipDraft`: 默认 `true`（Draft / WIP 状态的 MR 暂不触发评审，转为 Ready 时自动触发初审）；
  - `pollIntervalMs`: 默认 `45_000`（45 秒）；
  - `debounceMs`: 默认 `90_000`（90 秒合并窗口，避免作者连续 `git push` 或连发 5 条行级回复触发 5 轮重审）；
  - `ignoreLabels`: 如 `['skip-ai-review', 'automated-release']`；
  - `feishuNotify`: `'off' | 'summary-card' | 'topic-sync'`（是否同步在指定飞书研发群投递评审卡片）。

### 2. 事件分类与防死循环铁律（Self-Trigger Prevention）

每次轮询对启用仓库执行 `dshRepos.mrList({ repo, state: 'open', sort: 'updated', updatedAfter: repoCursor })`，对发生变动的 MR 读取其最新 `headSha` 与 `mrDiscussions`，对比本地 `supervised_mrs` 表记录生成待处理信号：

| 信号类型 | 判定条件 | 防自激（死循环）过滤规则 |
| :--- | :--- | :--- |
| **`mr_opened`**（首次评审） | 表中无该 `(repo, mrNumber)` 记录，或此前处于 `draft_skipped` 且现已变为 `draft === false` | 若该 MR 由 `dsh-supervisor` 自己创建（已在表中登记 `origin: 'self-fix' \| 'self-skill'`），不走第三方初审，直接走下述「自产 MR 跟进策略」 |
| **`commits_pushed`**（代码更新） | `mr.headSha !== record.lastReviewedSha` | 若 `mr.headSha` 在 `record.ownPushedShas` 集合内（即机器人自己在协助提交代码），忽略本次 Push 的自审触发 |
| **`discussion_updated`**（新评论/回复） | 存在 `note.id` 晚于 `record.lastNoteCursor`（或按时间戳 + ID 集合差集发现新 Note） | **严格过滤 `note.author.username === botUser.username`**！机器人自己发表的总评、行级意见、线程回复一律只推进游标，**绝不唤醒自身** |
| **`ci_failed`** *(仅自产 MR)* | `record.origin` 为自产 MR，且当前 `headSha` 的 CI 状态首次落定为 `failure` | 同一 `headSha` 最多自动尝试修复 CI 2 次（`autoFixAttempts < 2`），超出后转交飞书话题请求人工介入 |
| **`mr_closed_or_merged`** | 巡检已追踪的活跃记录时发现 `mr.state` 变为 `merged` 或 `closed` | 不唤醒模型；直接更新本地状态为终态、更新飞书根卡状态徽标并清理临时工作区 |

### 3. 防抖合并（Debounce Window）
检测到 `mr_opened`、`commits_pushed` 或 `discussion_updated` 时，写入 `pendingSignals` 并将 `dueAt` 设为 `firstSignalAt + debounceMs`（首次打开的新 MR 可设较短延迟如 `15s`）。窗口到期时将同一 MR 累积的信号（例如“作者先回了 3 条评论，紧接着推了 1 个新 Commit”）**打包为同一轮唤醒输入**一次性送入该 MR 的绑定 Session！

---

## 三、有状态评审工作流（`mr-reviewer` Preset）

### 1. 第一轮：首次全量上下文评审（Initial Review）
1. **准备环境**：在 `<sessionWorkDir>/repos/<slug>` 执行 `dshRepos.workspaceCreate`（检出 `mr.headSha` 对应的源码树，同时本地拥有 `targetBranch` 基线引用）。加载仓库内可能存在的 `.dsh/skills` / `AGENTS.md` / `CLAUDE.md` 项目规范！
2. **深度审查（Prompt & Built-in Skill 约束）**：
   - 先用 `git diff <mergeBase>..<headSha>` 浏览全部变更文件；
   - **强制上下文穿透**：对修改了函数签名、共享类型、数据库 Schema、并发锁或错误处理的文件，必须用 `rg` / `read` 检查仓库内未改动文件的调用方与单元测试，严禁只对着几行 diff 臆测；
   - **信噪比准则**：聚焦真实缺陷（逻辑错误、边界空指针/越界、并发竞态、资源泄漏、安全绕过、破坏兼容性、缺失关键测试），**不刷纯主观命名喜好或 Linter 已管的格式琐事**；没有发现实质问题时，坦率给出简短通过结论（`approve` 或简短 `comment`），绝不硬凑意见。
3. **发布与记录游标**：
   - 调用受控工具 `supervisor_mr_publish_review` 提交结构化评审（总评摘要 + 精确到 `{ path, newLine/oldLine }` 的行级问题列表，每条标明严重度 `[P1 阻断] / [P2 建议] / [P3 探讨]`）；
   - 工具成功后原子更新 `supervised_mrs` 表的 `lastReviewedSha = mr.headSha` 及当前讨论游标。

### 2. 后续轮次 A：新提交增量重审（Incremental Push Re-review）
当 `commits_pushed`（或合并了新评论）唤醒**同一个 Session** 时：
1. 监管器在唤醒前先在本地工作区执行 `git fetch origin` 并将工作树切至最新 `newHeadSha`，向 Session 注入结构化增量包：
   - 增量 Commit 列表（SHA + Commit Message）；
   - `git diff <lastReviewedSha>..<newHeadSha>`（即**仅自上次评审以来的改动**）；
   - 当前所有尚未解决（`unresolved`）的本机器人历史评审线程清单（含 `discussionId`、文件路径、原问题描述）；
   - 本窗口内人类新增的顶层评论或线程回复。
2. **Agent 增量动作三步法**：
   - **Step 1 核销旧账**：逐一核对未解决的历史评审线程——若新代码已正确修复，调用 `supervisor_mr_resolve_thread({ discussionId, comment: '已在 <shortSha> 中确认修复。' })` 自动关闭线程！若修了一半或引入回归，在该原线程下 `reply` 跟进说明，**不在别处另开重复新帖**。
   - **Step 2 回应讨论**：对人类在线程中的反驳或提问，核实代码事实后直接 `reply` 该线程（若人类解释成立，直接回复认可并 `resolve` 该线程！）。
   - **Step 3 审查增量**：仅对 `lastReviewedSha..newHeadSha` 新引入的改动检查是否有新缺陷；最后调用 `supervisor_mr_publish_review` 发简明的增量复审小结并推进 `lastReviewedSha = newHeadSha`。

### 3. 后续轮次 B：纯新评论互动（Discussion-Only Wakeup）
当代码未变（`headSha === lastReviewedSha`），但人类在 MR 下回复了评审线程或在顶层 `@bot` 提问时：
- 唤醒原 Session，仅注入新增的评论上下文；
- Agent 查阅本地 `<sessionWorkDir>/repos/<slug>` 代码核实后，在对应 `discussionId` 下精准回复（或在同意作者解释后直接 Resolve），更新 `lastNoteCursor`，不重跑全量评审。

---

## 四、自产 MR 的闭环跟进（Self-Authored MR Supervision）

当某个 MR 是由 `dsh-supervisor` 在日志分析闭环中经用户点击 `[🔧 修复代码并提 MR]` 或 `[📚 改进分析流程 / 沉淀案例]` 创建时：
1. 创建时即在 `supervised_mrs` 表登记为 `origin: 'self-fix'`（或 `'self-skill'`），绑定创建它的**原修复 Session**。
2. `RepoMrWatcher` 同样持续监控该 MR：
   - **收到人类 Reviewer 的修改意见（`discussion_updated`）**：唤醒原修复 Session → 根据人类评审意见在原工作区修改代码、跑测试、推送新 Commit，并在评审线程下回复“已按意见在 `<sha>` 更新”！
   - **CI 流水线失败（`ci_failed`）**：通过 `dshRepos.ciGet` / `ciLog` 拉取失败作业日志摘要唤醒原修复 Session → 自动修复单测/类型错误并推送（单 Commit 限自动修复 2 次，仍失败则在飞书话题提示人工接手）。
   - **MR 合入（`mr_merged`）**：在关联飞书话题发送合入通知，更新 `IssueMemory` 中对应问题的状态为“修复已合入”，完成真正的端到端研发闭环！
