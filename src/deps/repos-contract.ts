/**
 * 智能监管中心对 `dshRepos` 服务的窄契约声明（兼容 v7 基础仓库目录/快照/工作区，并完整声明 v8 行级评审与增量感知接口）：
 *
 * - 基础仓库清单（`repoList` / `featureRegister`）、只读快照（`snapshotAcquire`）与可写工作区
 *   （`workspaceCreate` / `workspaceStatus` / `workspacePush`）兼容 `version: 7 | 8`。
 * - MR 自动评审所需的增量查询、行级评审与讨论线程接口（`mrCompare` / `mrDiscussions` /
 *   `mrReview` / `mrDiscussionReply` / `mrDiscussionResolve` / `currentBotUser`）要求 `version: 8`。
 *
 * @module dsh-logalyze/deps/repos-contract
 */

/** Base `dshRepos` contract versions compatible with repository catalog, snapshots, and workspaces. */
export type DshReposVersion = 7 | 8

/** `dshRepos` contract version required for inline MR review and discussion threads. */
export type DshReposReviewVersion = 8

/** Options every call accepts. */
export interface CallOptions {
  /** Aborting stops waiting; a write may still have reached the code host. */
  readonly signal?: AbortSignal
}

/** The host Agent a write is made for: the `agent` a DSH tool's `execute` receives. */
export interface CallerAgent {
  readonly id: string
  readonly session?: { readonly header: { readonly id: string } }
}

/**
 * Caller fields of a write made for an Agent: the provider asks `access/authorize`
 * for its Session and, while its settings say so, shows the user the approval card.
 */
export interface AgentWriteOptions extends CallOptions {
  readonly agent: CallerAgent
  /** The calling tool call, so the approval card shows that call. */
  readonly callId?: string
}

/**
 * Caller fields of a write that may run either on behalf of an Agent (`agent` set)
 * or under the calling supervision plugin's own policy (`agent` omitted).
 */
export interface WriteOptions extends CallOptions {
  readonly agent?: CallerAgent
  readonly callId?: string
}

/** Offset paging of list methods. */
export interface PageParams {
  /** 1-based page; default 1. */
  readonly page?: number
  /** Items per page. */
  readonly perPage?: number
}

/** One page of a list call. */
export interface Page<T> {
  readonly items: readonly T[]
  /** Next page number when the page was full; absent on the last page. */
  readonly nextPage?: number
}

/** A user as the code host shows them. */
export interface RepoUser {
  /** Login (GitHub) or username (GitLab). */
  readonly username: string
  readonly webUrl?: string
}

/**
 * The provider's settings this plugin reads. While `mirrorDir` is undefined,
 * every snapshot and workspace call rejects with `unavailable`.
 */
export interface RepoPublicSettings {
  /** Absolute directory holding the mirrors and snapshots; undefined while none is chosen or unusable. */
  readonly mirrorDir: string | undefined
  /** Why the provider's stored directory is not in use; absent otherwise. */
  readonly mirrorProblem?: string
}

/**
 * Read-only plain files of one commit (no `.git`), shared by every holder of
 * the same repository and commit. Release exactly once.
 */
export interface SnapshotLease {
  /** Catalog address of the repository. */
  readonly repo: string
  /** Full commit id. */
  readonly commit: string
  /** Absolute directory of the files. */
  readonly path: string
  release(): void
}

/** Parameters of {@link DshRepos.snapshotAcquire}. */
export interface SnapshotAcquireParams extends CallOptions {
  readonly repo: string
  /** Branch, tag, or full commit id; default: the catalog entry's baseline branch, or the remote's default branch. */
  readonly ref?: string
}

/** Parameters of {@link DshRepos.workspaceCreate}. */
export interface WorkspaceCreateParams extends WriteOptions {
  readonly repo: string
  /** Absolute directory of the new workspace: missing or empty (its parent is created). */
  readonly path: string
  /** Branch the work starts from and merges into; default: the catalog entry's baseline branch, or the remote's default branch. */
  readonly base?: string
  /** Full commit id on {@link base} to start from; default: the head of {@link base}. */
  readonly commit?: string
  /** Remote branch the workspace pushes to. */
  readonly branch?: string
}

/** A workspace: an ordinary git clone whose `origin` reaches the remote through the provider. */
export interface WorkspaceInfo {
  /** Catalog address of the repository. */
  readonly repo: string
  /** Absolute directory. */
  readonly path: string
  /** Branch the work merges into. */
  readonly base: string
  /** Commit the work started from. */
  readonly baseCommit: string
  /** Remote branch the workspace pushes to. */
  readonly branch: string
}

/** One file that differs from the workspace's start commit. */
export interface WorkspaceFileChange {
  /** Path from the repository root, `/`-separated. */
  readonly path: string
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'type-changed'
  /** Former path of a renamed file. */
  readonly previousPath?: string
  /** Whether git treats the file as binary; such files have no line counts. */
  readonly binary: boolean
  readonly additions?: number
  readonly deletions?: number
}

/** What a workspace changed since its start commit, committed or not. */
export interface WorkspaceStatus {
  readonly workspace: WorkspaceInfo
  /** Files differing between the start commit and the working tree (untracked included, ignored excluded). */
  readonly files: readonly WorkspaceFileChange[]
  /** Unified diff from the start commit to the working tree. */
  readonly diff: string
  /** Whether {@link diff} was cut at the provider's diff limit. */
  readonly truncated: boolean
}

/** Parameters of {@link DshRepos.workspacePush}. */
export interface WorkspacePushParams extends AgentWriteOptions {
  /** The workspace directory. */
  readonly path: string
  /** Message of the commit recording uncommitted changes; required when there are any. */
  readonly message: string
  /** Open a pull/merge request from the branch into the workspace's base unless one is open. */
  readonly mr?: { readonly title: string; readonly body?: string }
}

/** Parameters of `workspaceRemove`. */
export interface WorkspaceRemoveParams extends CallOptions {
  readonly path: string
  readonly force?: boolean
}

/** Outcome of `workspaceRemove`. */
export interface WorkspaceRemoveResult {
  readonly path: string
  readonly discardedCommits: number
  readonly discardedChanges: boolean
}

/** A pull/merge request a push reported. */
export interface MrSummary {
  readonly number: number
  readonly webUrl: string
}

/** Outcome of {@link DshRepos.workspacePush}. */
export interface WorkspacePushResult {
  readonly branch: string
  /** Commit the remote branch points to after the push. */
  readonly commit: string
  /** Open requests from the branch after the push, including one opened for {@link WorkspacePushParams.mr}. */
  readonly openMrs: readonly MrSummary[]
  /** The request opened for {@link WorkspacePushParams.mr}; absent when one was already open or none was asked for. */
  readonly createdMr?: MrSummary
  /** Why listing or opening requests failed; the push itself succeeded. */
  readonly mrError?: string
}

/** Access a catalog entry grants, from the least. */
export type RepoAccess = 'read' | 'write' | 'merge'

/** A feature other plugins can turn on per catalog repository. */
export interface RepoFeature {
  /** Lowercase letters, digits, and `-`, starting with a letter; at most 40 characters. */
  readonly id: string
  /** Switch label on the provider's settings page; at most 20 characters. */
  readonly title: string
  /** At most 200 characters. */
  readonly description?: string
}

/** A feature turned on for a catalog repository. */
export interface RepoFeatureSwitch {
  readonly id: string
  /** Branch the feature uses; absent uses the entry's baseline branch. */
  readonly branch?: string
}

/** One catalog repository, as {@link DshRepos.repoList} returns it. */
export interface CatalogRepo {
  readonly id: string
  /** Address as the catalog stores it. */
  readonly url: string
  /** Baseline branch: where code changes start and merge into; absent uses the remote's default branch. */
  readonly base?: string
  readonly access: RepoAccess
  /** Features turned on for the repository. */
  readonly features: readonly RepoFeatureSwitch[]
}

// ---------------------------------------------------------------------------
// dshRepos v8 MR & Inline Review Types (01-cross-plugin-contracts.md Part B)
// ---------------------------------------------------------------------------

/** Lifecycle state of a pull or merge request. */
export type MrState = 'open' | 'closed' | 'merged'

/** Parameters naming one pull/merge request in a repository. */
export interface NumberParams {
  readonly repo: string
  readonly number: number
}

/** One conversation comment on an issue or pull/merge request. */
export interface CommentInfo {
  readonly id: string
  readonly author: RepoUser
  readonly body: string
  readonly createdAt: string
  readonly webUrl?: string
}

/** One pull request (GitHub) or merge request (GitLab). */
export interface MrInfo {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: MrState
  readonly draft: boolean
  readonly sourceBranch: string
  readonly targetBranch: string
  readonly headSha: string
  readonly author: RepoUser
  readonly labels: readonly string[]
  readonly assignees: readonly RepoUser[]
  readonly createdAt: string
  readonly updatedAt: string
  readonly webUrl: string
}

/** A pull/merge request with its top-level conversation comments. */
export interface MrDetail extends MrInfo {
  readonly comments: readonly CommentInfo[]
}

/** A unified diff. */
export interface MrDiff {
  readonly diff: string
  readonly truncated: boolean
}

/** Aggregated CI result. */
export type CheckState = 'success' | 'failure' | 'pending' | 'none'

/** One CI check, status, or pipeline. */
export interface CheckInfo {
  readonly name: string
  readonly state: Exclude<CheckState, 'none'>
  readonly webUrl?: string
  readonly runId?: number
  readonly jobId?: number
}

/** CI and merge readiness of a pull/merge request. */
export interface MrStatus {
  readonly headSha: string
  readonly checks: readonly CheckInfo[]
  readonly overall: CheckState
  readonly mergeable?: boolean
}

/** Parameters of {@link DshReposV8.mrList} (extended in v8 with `sort` and `updatedAfter`). */
export interface MrListParams extends PageParams {
  readonly repo: string
  /** Default `'open'`. */
  readonly state?: MrState | 'all'
  readonly sourceBranch?: string
  readonly targetBranch?: string
  /** v8: sort order; defaults to `'updated'` for incremental repository polling. */
  readonly sort?: 'created' | 'updated'
  /** v8: ISO-8601 lower bound on `updatedAt` for incremental repository polling. */
  readonly updatedAfter?: string
}

/** Parameters of {@link DshReposV8.mrCompare}. */
export interface MrCompareParams {
  readonly repo: string
  readonly baseSha: string
  readonly headSha: string
}

/** Diff line anchor for inline review comments. */
export interface DiffPosition {
  /** Repository-root-relative path (`/`-separated). */
  readonly path: string
  /** Line number in the new version of the file (required for added/context lines; omitted for pure deletions). */
  readonly newLine?: number
  /** Line number in the old version of the file (required for pure deletions; optional on modified hunks). */
  readonly oldLine?: number
}

/** A single message inside an MR discussion thread. */
export interface DiscussionNote {
  readonly id: string
  readonly author: RepoUser
  readonly body: string
  readonly createdAt: string
  readonly updatedAt?: string
  readonly webUrl?: string
}

/** An inline code review thread or resolvable top-level discussion thread on a PR/MR. */
export interface MrDiscussion {
  /** Unique thread id (GitHub reviewThread GraphQL node id / GitLab discussion id). */
  readonly id: string
  /** `true` for diff-anchored inline code threads; `false` for general conversation threads. */
  readonly inline: boolean
  /** Diff line anchor when `inline` is `true`. */
  readonly position?: DiffPosition
  /** Whether the host supports resolving this thread and whether it is currently resolved. */
  readonly resolvable: boolean
  readonly resolved: boolean
  readonly resolvedBy?: RepoUser
  /** Chronological messages in the thread (`[0]` started the thread). */
  readonly notes: readonly DiscussionNote[]
}

/** Parameters of {@link DshReposV8.mrDiscussions}. */
export interface MrDiscussionsParams extends NumberParams, PageParams {
  readonly onlyUnresolved?: boolean
}

/** Overall verdict of a structured code review submission. */
export type ReviewVerdict = 'comment' | 'approve' | 'request-changes'

/** One pending inline review comment to publish atomically with a review. */
export interface DraftInlineComment extends DiffPosition {
  readonly body: string
}

/** Parameters of {@link DshReposV8.mrReview}. */
export interface MrReviewParams extends NumberParams {
  /** Head commit SHA the review was conducted against. */
  readonly headSha: string
  /** Review verdict; automatically downgraded to `'comment'` on self-authored MRs (`downgradedVerdict: true`). */
  readonly verdict: ReviewVerdict
  /** Overall review summary Markdown (optional only when `verdict === 'comment'` and `comments` is non-empty). */
  readonly body?: string
  /** Inline diff comments (at most 50). */
  readonly comments?: readonly DraftInlineComment[]
}

/** Outcome of {@link DshReposV8.mrReview}. */
export interface MrReviewResult {
  readonly verdict: ReviewVerdict
  /** `true` when `approve` or `request-changes` was downgraded to `comment` due to self-review restrictions. */
  readonly downgradedVerdict?: boolean
  readonly postedComments: number
  /** Number of inline comments folded into the summary body because their lines fell outside remote diff hunks. */
  readonly fallbackInlineCount: number
  readonly webUrl?: string
}

/** Parameters of {@link DshReposV8.mrDiscussionReply}. */
export interface MrDiscussionReplyParams extends NumberParams {
  readonly discussionId: string
  readonly body: string
}

/** Parameters of {@link DshReposV8.mrDiscussionResolve}. */
export interface MrDiscussionResolveParams extends NumberParams {
  readonly discussionId: string
  readonly resolved: boolean
}

/** Base `dshRepos` methods compatible across v7 and v8. */
export interface DshRepos {
  readonly version: DshReposVersion
  repoList(params?: { readonly feature?: string } & CallOptions): Promise<readonly CatalogRepo[]>
  featureRegister(feature: RepoFeature): () => void
  repoOnChange(listener: () => void): () => void
  settingsGet(): RepoPublicSettings
  hostOnChange(listener: () => void): () => void
  snapshotAcquire(params: SnapshotAcquireParams): Promise<SnapshotLease>
  workspaceCreate(params: WorkspaceCreateParams): Promise<WorkspaceInfo>
  workspaceStatus(params: { readonly path: string } & CallOptions): Promise<WorkspaceStatus>
  workspacePush(params: WorkspacePushParams): Promise<WorkspacePushResult>
  workspaceRemove?(params: WorkspaceRemoveParams): Promise<WorkspaceRemoveResult>
}

/** Full `dshRepos` v8 contract including MR incremental polling, inline reviews, and discussion management. */
export interface DshReposV8 extends DshRepos {
  readonly version: DshReposReviewVersion
  mrList(params: MrListParams & CallOptions): Promise<Page<MrInfo>>
  mrGet(params: NumberParams & CallOptions): Promise<MrDetail>
  mrDiff(params: NumberParams & CallOptions): Promise<MrDiff>
  mrStatus(params: NumberParams & CallOptions): Promise<MrStatus>
  mrCompare(params: MrCompareParams & CallOptions): Promise<MrDiff>
  mrDiscussions(params: MrDiscussionsParams & CallOptions): Promise<Page<MrDiscussion>>
  mrReview(params: MrReviewParams & WriteOptions): Promise<MrReviewResult>
  mrDiscussionReply(params: MrDiscussionReplyParams & WriteOptions): Promise<DiscussionNote>
  mrDiscussionResolve(params: MrDiscussionResolveParams & WriteOptions): Promise<unknown>
  currentBotUser(params: { readonly repo: string } & CallOptions): Promise<RepoUser>
}
