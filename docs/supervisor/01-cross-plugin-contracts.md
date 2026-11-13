# 01. 跨插件契约设计：`dsh_channels` 通用动作提议 & `dsh-repo` v8 评审感知

本文档定义 `dsh-supervisor` 所依赖的两项跨插件底层公开契约。两项契约均保持**领域无关（Domain-Agnostic）**，不引入任何耦合“日志分析”或特定业务流程的私有概念。

---

## Part A：`dsh_channels` 通用非阻塞动作提议契约（`feishuActions` v1）

### 1. 为什么需要第 3 类人机协同原语？

`deepseek-harness` 与 `dsh_channels` 目前已有两类人机交互机制，但均属于**回合中阻塞式（Mid-Turn Blocking）**：

| 原语 | 时机与生命周期 | 适用场景 | 为什么不适合监管闭环的后续动作询问？ |
| :--- | :--- | :--- | :--- |
| `approval`（审批卡） | 工具执行前挂起当前回合，超时拒绝 | 模型已决定执行某次具体 `bash` 或 `git push` | 会合挂起占用并发槽位；凌晨自动分析出代码问题，不能让回合挂起等待十几个小时等工程师上班点按钮 |
| `ask_user_question`（问答卡） | 工具执行中挂起当前回合（默认 5 分钟超时） | 当前推理缺少用户澄清就无法继续 | 5 分钟不答整轮分析直接报错失败，导致连分析报告都无法完成交付 |
| **`feishuActions` / `propose_actions`（新增）** | **回合结束处非阻塞登记，本轮正常收束** | **“报告已交付，发现可修代码 / 可改 SKILL，是否需要我继续执行？”** | **零阻塞释放并发槽位；按钮跨天/跨重启持久有效；点击时按动作所需权限判权并开启新一轮跟进回合** |

### 2. 模型侧工具契约：`propose_actions`

由 `dsh_channels` 在飞书路由所属的主 Agent（`delegationDepth === 0`）上挂载工具 `propose_actions`：

- **调用限制**：每个回合最多成功调用 1 次（同一回合第二次调用返回明确提示并拒绝）；子代理（Subagent）不可见/不可调用；当该话题收件箱已有排队中的下一条用户消息时，自动跳过渲染按钮（因为用户已经在继续说话了）。
- **工具参数 Schema（Zod 等价定义）**：

```ts
export interface ProposeActionsInput {
  /** 卡片动作区的一句话引导标题，如 "已定位根因，可选择后续自动处理："（1–120 字） */
  readonly prompt: string
  /** 提供的可选动作按钮列表（1–4 项；插件自动在末尾追加一个灰色的「暂不处理」按钮） */
  readonly actions: readonly {
    /** 动作在本次提议内的唯一短标识，如 'fix_code' | 'improve_skill' */
    readonly id: string
    /** 按钮文案，如 '🔧 修复代码并提 MR'（1–32 字） */
    readonly label: string
    /** 按钮视觉样式：primary 强调推荐项，default 普通项 */
    readonly style?: 'primary' | 'default'
    /**
     * 点击该按钮所需的渠道权限级别（在唤醒模型前由 dsh_channels 直接拦截判权）：
     * - 'chat'（默认）：私聊本人，或群内开启对话准入的成员
     * - 'code-write'：私聊本人开启「代码改动」，或群权限开启「代码改动」
     * - 'wiki-write'：知识库写权限
     * - 'admin'：仅私聊管理员
     */
    readonly requiredAccess?: 'chat' | 'code-write' | 'wiki-write' | 'admin'
    /**
     * 用户点击该按钮后，作为用户跟进消息提交进原 Session 的完整指令文本（1–8000 字）。
     * 由发起提议的 Agent 写入清晰自包含的执行上下文（如目标仓库、根因文件、建议方案或修订号）。
     */
    readonly followUpPrompt: string
    /** 是否允许与其他按钮先后分别点击？默认 false（点击任一动作后整卡结算关闭）；设为 true 时支持如“先点修代码、再点沉淀 SKILL”的多选独立结算 */
    readonly independent?: boolean
  }[]
}
```

### 3. 服务侧契约：`FeishuActionsService`（`ctx.get('feishuActions')`）

除模型直接调用 `propose_actions` 工具外，受信任的宿主插件（如 `dsh-supervisor` 在后台完成分析后发话题报告时）也可直接通过服务接口附加动作提议卡：

```ts
export type FeishuActionsServiceName = 'feishuActions'
export type FeishuActionsVersion = 1

export interface ActionProposalSpec extends ProposeActionsInput {
  /** 幂等键（1–200 可见 ASCII），重放返回原卡片信息 */
  readonly key: string
  /** 目标飞书路由当前绑定的 Session ID */
  readonly sessionId: string
}

export type ActionProposalPostResult =
  | { readonly ok: true; readonly replayed: boolean; readonly cardMessageId: string }
  | { readonly ok: false; readonly code: 'invalid' | 'not-connected' | 'unrouted-session' | 'send-failed'; readonly message: string }

export interface FeishuActionsService {
  readonly version: FeishuActionsVersion
  /** 在指定飞书路由话题内发送一张独立的后续动作提议卡 */
  propose(spec: ActionProposalSpec): Promise<ActionProposalPostResult>
  /** 将指定幂等键对应的未决动作卡标记为已替代（例如新一轮重新分析产出了新结论时） */
  supersede(key: string, reason?: string): Promise<void>
}
```

### 4. 持久化、权限拦截与点击唤醒流程

1. **落盘表（`dsh_channels` 存储域新增 `action_proposals` 表）**：
   - 主键 `proposalId`（UUID 或外部 `key` 哈希），保存 `sessionId`、`routeKey`、`chatId`、`cardMessageId`、`prompt`、`actions`、每个 `action.id` 的结算状态（`pending | triggered | dismissed | superseded`、点击人 `userId`、触发时间 `triggeredAt`）以及 `createdAt`（默认保留 14 天，超期点击提示“该提议已过期，请直接在话题中输入指令”）。
2. **新提议自动替代规则**：
   - 同一 `sessionId` 产生新的 `propose_actions` 时，该 Session 此前所有全部处于 `pending` 状态的旧提议卡自动标记为 `superseded`（飞书卡片原地刷新为置灰说明“已被后续新提议替代”）。`/renew` 切换话题 Session 后，旧 Session 的动作卡同样失效。
3. **按钮点击处理（接入 `TurnCardActions`）**：
   - **Step 1 归属与准入检查**：校验点击者是否满足路由归属（私聊仅本人，群话题须在用户表开启 `chat`）；再按按钮声明的 `requiredAccess` 调用 `AccessController.mayUseOnRoute` 检查权限（例如群未开 `codeWrite` 时，卡片下方即时回显提示“当前群未开启「代码改动」权限，请管理员在飞书渠道面板 → 群权限中开启”，按钮保持可点、不消耗提议）。
   - **Step 2 原子状态机防重**：通过 `table.update()` 原子将目标 `action.id` 从 `pending` 置为 `triggered`（若 `independent !== true`，其余 `pending` 项一并置灰关闭）；并发重复点击直接短路忽略。
   - **Step 3 提交跟进回合**：以点击者的飞书身份 Peer（`principal: feishu-user | feishu-group`）构造标准 `channelPrompt`（正文为 `followUpPrompt`，并在前导附上 `<feishu_action_selected id="..." label="..."/>` 标记），调用既有 `continueSession` 流式执行新一轮回复！如此一来，后续产生的 Git 提交自然带上点击者的 `Feishu-User` 署名与 `gitEmail` 作者信息。

---

## Part B：`dsh-repo` 服务契约 v8 升级规范

当前 `dsh-repo` v7 已具备完善的仓库清单、裸镜像、`workspaceCreate` / `workspacePush`、CI 日志读取与单 MR 监控，但在 **MR 代码评审** 场景存在两处明确缺口：
1. `mrGet` 只返回顶层会话评论（Conversation Comments），**不包含 Diff 行级评审线程（Inline Review Threads）及其 `resolved` 状态**，也没有发往具体文件行号的评审接口。
2. `mrList` 缺少按 `updatedAt` 排序及时间下界过滤，不利于仓库级监管器低成本增量轮询。

### 1. 新增数据结构（`dsh-repo/contract` v8）

```ts
/** Diff 行级定位：指明评论挂在变更文件的哪一侧与哪一行 */
export interface DiffPosition {
  /** 仓库根目录起的相对路径（'/' 分隔） */
  readonly path: string
  /** 新文件行号（新增行或上下文行必填；纯删除行省略） */
  readonly newLine?: number
  /** 旧文件行号（纯删除行必填；修改块可选） */
  readonly oldLine?: number
}

/** 一条讨论线程中的单条消息 */
export interface DiscussionNote {
  readonly id: string
  readonly author: RepoUser
  readonly body: string
  readonly createdAt: string
  readonly updatedAt?: string
  readonly webUrl?: string
}

/** PR/MR 上的一个讨论线程（行级代码评审线程或可解决的顶层线程） */
export interface MrDiscussion {
  /** 线程唯一 ID（GitHub Review Thread GraphQL node_id / GitLab discussion id） */
  readonly id: string
  /** 是否为行级代码线程；false 表示普通顶层讨论 */
  readonly inline: boolean
  /** 行级位置（当 inline 为 true 时提供） */
  readonly position?: DiffPosition
  /** 该线程是否支持标记已解决，以及当前是否已解决 */
  readonly resolvable: boolean
  readonly resolved: boolean
  readonly resolvedBy?: RepoUser
  /** 线程内的消息列表，按时间升序（[0] 为发起评论，后续为回复） */
  readonly notes: readonly DiscussionNote[]
}

/** 一次提交的评审结论类型 */
export type ReviewVerdict = 'comment' | 'approve' | 'request-changes'

/** 待发表的一条行级评审意见 */
export interface DraftInlineComment extends DiffPosition {
  readonly body: string
}

/** mrReview 参数：一次性原子提交总评与多条行级意见 */
export interface MrReviewParams extends NumberParams {
  /** 评审针对的 Head Commit SHA（必传；用于精确锚定 GitHub commit_id 与 GitLab diff_refs，若远端 head 已漂移该如何处理见下） */
  readonly headSha: string
  /** 评审结论：当评审者账号与 MR 作者相同时，服务自动将 approve / request-changes 降级为 comment 并在返回值标记 downgradedVerdict，避免主机 422 报错 */
  readonly verdict: ReviewVerdict
  /** 总体评审摘要正文（verdict 为 comment 且 comments 非空时可省，其余必填；自动追加配置的 signature） */
  readonly body?: string
  /** 行级评审意见列表（最多 50 条） */
  readonly comments?: readonly DraftInlineComment[]
}

export interface MrReviewResult {
  readonly verdict: ReviewVerdict
  /** 因自审限制被自动降级为 comment 时为 true */
  readonly downgradedVerdict?: boolean
  readonly postedComments: number
  /** 个别行号因超出主机 diff hunk 范围而降级合并入总评正文的数量 */
  readonly fallbackInlineCount: number
  readonly webUrl?: string
}
```

### 2. 新增与扩展的服务方法及对应模型工具

| 服务方法 (`dshRepos`) | 模型工具名 (`repo_*`) | 权限级别 | 行为说明 |
| :--- | :--- | :--- | :--- |
| `mrList` *(扩展参数)* | `repo_mr_list` | `read` | 新增可选参数 `sort?: 'created' \| 'updated'`（默认 `'updated'`）与 `updatedAfter?: string`（ISO 时间戳），便于仓库级轮询只读有变动的 MR |
| `mrCompare` *(新增)* | `repo_mr_compare` | `read` | 参数 `{ repo, baseSha, headSha }`，返回两 Commit 间的增量 `MrDiff`（优先直接利用本地裸镜像计算或调主机 Compare API），供增量重审精确获取两次评审之间的改动 |
| `mrDiscussions` *(新增)* | `repo_mr_discussions` | `read` | 参数 `{ repo, number, onlyUnresolved?: boolean, page?, perPage? }`，返回分页的 `Page<MrDiscussion>` |
| `mrReview` *(新增)* | `repo_mr_review` | `write` (`code-write`) | 一次性提交结构化评审（总评 + 行级评论）；若某条行级评论的行号不在远端 Diff Hunk 内被主机拒绝，自动兜底折叠进总评以防整次评审丢失 |
| `mrDiscussionReply` *(新增)* | `repo_mr_discussion_reply` | `write` (`code-write`) | 参数 `{ repo, number, discussionId, body }`，在指定讨论线程下回复 |
| `mrDiscussionResolve` *(新增)* | `repo_mr_discussion_resolve` | `write` (`code-write`) | 参数 `{ repo, number, discussionId, resolved: boolean }`，标记线程已解决或重新打开 |
| `currentBotUser` *(新增)* | *(仅插件服务方法)* | — | 参数 `{ repo }`，返回该仓库所属主机当前令牌对应的 `RepoUser`（带短期内存缓存），供 `dsh-supervisor` 精确识别并过滤机器人自身发出的评论与推送 |

> **关于监管服务的自动写操作审批策略**：
> 当 `dsh-supervisor` 的 `mr-reviewer` 代表系统监管策略发表代码评审评论/Resolve 线程时：
> - 若通过模型工具调用且部署开启了 `tools.writes: 'ask'`，常规人工会话会弹审批卡；
> - 对于已由管理员在「仓库清单」中显式打开「MR 自动评审」功能的仓库，`dsh-supervisor` 提供专用受控工具 `supervisor_mr_publish_review`，内部核对调用方确实为该仓库绑定的官方评审 Session 且目标 MR 一致后，以插件自身授权身份调用 `dshRepos.mrReview(..., { signal })`（不传 `agent`，免逐条弹飞书审批卡阻塞无人值守初审；但任何 `workspacePush` / `mrMerge` 仍严格走 `agent` 授权与人工门控！）。

### 3. GitHub 与 GitLab 双端协议映射表

| 能力点 | GitHub (`@octokit/rest` + GraphQL) | GitLab (`@gitbeaker/rest`) |
| :--- | :--- | :--- |
| **读取讨论线程 (`mrDiscussions`)** | GraphQL 查询 `repository.pullRequest.reviewThreads`（一次请求同时拿到 `id`, `isResolved`, `isOutdated`, `path`, `line`, `startLine`, `comments`） | `MergeRequestDiscussions.all(projectId, mrIid)`（拿到 `id`, `individual_note`, `notes[].position`, `notes[].resolvable`, `notes[].resolved`） |
| **批量提交行级评审 (`mrReview`)** | `pulls.createReview({ commit_id, event: 'COMMENT'\|'APPROVE'\|'REQUEST_CHANGES', body, comments: [{ path, line, side: 'RIGHT'\|'LEFT', body }] })` | 逐条 `MergeRequestDiscussions.create`（携带 `position: { position_type: 'text', base_sha, start_sha, head_sha, new_path, old_path, new_line, old_line }`，先从 MR `diff_refs` 读取三元组 SHA）+ 总评 Note；`approve` 调 `MergeRequestApprovals.approve` |
| **回复讨论线程 (`mrDiscussionReply`)** | `pulls.createReplyForReviewComment` 或 GraphQL `addPullRequestReviewThreadReply` | `MergeRequestDiscussions.addNote(projectId, mrIid, discussionId, body)` |
| **解决/重开线程 (`mrDiscussionResolve`)** | GraphQL `resolveReviewThread` / `unresolveReviewThread`（传入 `threadId`） | `MergeRequestDiscussions.resolve(projectId, mrIid, discussionId, resolved)` |
