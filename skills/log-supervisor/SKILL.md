---
name: log-supervisor
description: 智能监管（观象）统一日志监管与问题闭环规范，覆盖材料准备、已知问题库检索（人工结论优先）、逐份结构化提交及「修代码 / 改 SKILL」主动门控闭环。
---

# 智能监管（观象）日志分析与闭环工作流

你正在一个由 `dsh-logalyze`（观象）管理的日志监管会话中工作。平台自动批次与飞书人工分析共用同一套目录与工具链。

## 标准执行步骤

### 1. 准备材料（`supervisor_log_prepare`）
- 首轮先调用 `supervisor_log_prepare`（平台任务传 `taskId`；飞书人工分析传 `app` 与附件/URL `logs`）。
- 工具会在当前工作区准备好：
  - `logs/manifest.json` 与逐槽位安全解压后的 `logs/L1..Ln/`；
  - `repos/<app-slug>/` 可检索源码与可选仓库 SKILL（`.dsh/skills` / `.agents/skills`）；
  - `scratch/` 临时脚本与导出图表附件工作区；
  - 同应用本地 `IssueMemory` 候选已知问题。
- 若发现候选 `IssueMemory` 条目包含 `humanConclusion` 或 `humanStatus`，**人工确认结论优先级最高**，务必逐条比对当前日志现象，切勿被过往 AI 误判覆盖。

### 2. 逐份日志独立核验
- 若某个槽位 `unpackStatus === 'corrupted'`（归档损坏），在结论中直接以 `status: "corrupted_log"` 如实报告，切勿影响同批其余有效槽位的分析。
- 使用 `bash`、`rg` 或在 `scratch/` 编写解析脚本逐份核验 `logs/L1..Ln/`。**严禁未经逐份核对就把 `L1` 的结论直接复制给整个批次！**
- 排查过程中提取到新异常类名、错误码或特征时，随时调用 `supervisor_issue_search` 查询历史相似问题、匹配条件与排除条件。

### 3. 显式提交结构化结论（`supervisor_log_submit`）
- 所有结论只能通过 `supervisor_log_submit` 正式落盘与回传日志平台，禁止只在文本中口头总结而不调用该工具。
- 入参必须满足：
  - `items` 必须与 `manifest.json` 中的 `L1..Ln` 严格 1:1 对齐，不漏项、不重项；
  - `status === "diagnosed"` 时至少提供一条可追溯的 `evidences`（真实存在的文件相对路径如 `logs/L1/...` 或 `repos/<app-slug>/...` + 行号/时间戳 + 关键摘录）；
  - 归因 `rootCauseCategory === "code_defect"` 时必须附带定位到的代码文件路径、行号与当前基准提交；
  - 通过 `issueLink` 关联已有 `issueId`（`{ mode: "existing", issueId }`）或登记新问题草稿（`{ mode: "new", title, matchCriteria, resolutionAdvice }`）；
  - 若需要附带额外分析产物（如时间线或图表 Markdown），保存在 `scratch/` 下并通过 `attachments` 提交。

### 4. 主动询问「修代码 / 改 SKILL」（仅飞书互动会话 & 仓库可写）
- 若当前处于面向人类的飞书会话且已获 `propose_actions` 工具，同时 `supervisor_log_submit` 报告目标仓库为可写（`writable: true`）：
  - **代码缺陷修复（`fix_code`）**：当至少一份日志确认 `rootCauseCategory === "code_defect"` 且定位清楚代码根因时，调用 `propose_actions` 挂出：
    - `id: "fix_code"`, `label: "🔧 修复代码并提 MR"`, `style: "primary"`, `requiredAccess: "code-write"`, `independent: true`
    - `followUpPrompt` 中写清 `taskId`、`repos/<app-slug>` 路径、基准 commit、根因位置与验证要求。
  - **知识沉淀/SKILL 改进（`improve_skill`）**：当发现分析流程/仓库 SKILL 可优化或定位出值得沉淀的新典型案例时，在同一张提议卡中挂出（或单独挂出）：
    - `id: "improve_skill"`, `label: "📚 改进分析流程 / 沉淀案例"`, `style: "default"`, `requiredAccess: "code-write"`, `independent: true`
    - `followUpPrompt` 中写清需先调用 `supervisor_log_prepare({ workspace: "knowledge" })` 在隔离工作区修改文档/SKILL。
  - 若你在后台静默模式（无 `propose_actions` 工具）中分析，系统会在投递飞书汇总卡时自动附带符合条件的动作按钮，无需你手动调用卡片工具。

### 5. 用户点击按钮后的闭环交付（`supervisor_log_push_mr`）
- **点击「🔧 修复代码并提 MR」被唤醒后**：
  1. 确认工作区在 `repos/<app-slug>`（必要时调用 `supervisor_log_prepare({ workspace: "diagnosis" })`）；
  2. 修改代码并补充单元测试，通过 `bash` 运行验证检查；
  3. 调用 `supervisor_log_push_mr({ kind: "fix_code", commitMessage, mrTitle, mrBody, issueId })` 完成审批检查、推送分支、创建 MR、回填 `IssueMemory.fixMrUrl`，并自动登记到「审微」MR 监管队列持续跟进 CI 与评审评论。
- **点击「📚 改进分析流程 / 沉淀案例」被唤醒后**：
  1. **必须先调用** `supervisor_log_prepare({ workspace: "knowledge" })`，在独立隔离目录 `repos/<app-slug>-knowledge` 中工作，绝不把文档/SKILL 改动混入业务修复分支；
  2. 修改 `.agents/skills/` 或案例文档，随后调用 `supervisor_log_push_mr({ kind: "improve_skill", ... })` 推送独立 MR 并登记审微监管。
