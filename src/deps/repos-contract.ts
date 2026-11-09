/**
 * 观象对 `dshRepos` 服务（version 6）的需求：只声明观象调用的方法和读取的
 * 字段。服务在运行时经 `ctx.get('dshRepos')` 取得，由任何按这一约定提供该服务
 * 的插件实现；观象不依赖提供方的包。
 *
 * 服务方维护仓库清单：只有清单里的仓库可以访问，每个仓库有权限（读、改代码、
 * 合并）和其他插件注册的功能开关。观象注册「日志分析」功能，只使用打开了这个
 * 功能的仓库。
 *
 * 快照是某个提交的只读普通文件（没有 `.git`），每次取用前服务方先从远端拉取。
 * 工作区是普通 git 克隆，`origin` 经服务方的本机 git 代理访问远端；推送和合并
 * 请求由 {@link DshRepos.workspacePush} 一步完成。每个方法在预期内的失败时以
 * `name` 为 `RepoError`、带字符串 `code` 的错误拒绝（例如 `conflict` 表示远端
 * 分支已变，`declined` 表示用户没有批准，`invalid` 表示参数违反约定）。
 *
 * @module dsh-logalyze/deps/repos-contract
 */

/** The `dshRepos` service version this plugin calls. */
export type DshReposVersion = 6

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
 * Caller fields of a write made for an Agent: the provider asks
 * `access/authorize` for its Session and, while its settings say so, shows
 * the user the same approval card its own tool shows (a refusal rejects with
 * `declined`, writes turned off with `forbidden`).
 */
export interface AgentWriteOptions extends CallOptions {
  readonly agent: CallerAgent
  /** The calling tool call, so the approval card shows that call. */
  readonly callId?: string
}

/**
 * The provider's settings this plugin reads. The provider has no default
 * mirror directory: while `mirrorDir` is undefined every snapshot and
 * workspace call rejects with `unavailable` and a message saying where to
 * choose one.
 */
export interface RepoPublicSettings {
  /** Absolute directory holding the mirrors and the snapshots; undefined while none is chosen or the stored choice is unusable. */
  readonly mirrorDir: string | undefined
  /** Why the provider's stored directory is not in use; absent otherwise. */
  readonly mirrorProblem?: string
}

/**
 * Read-only plain files of one commit (no `.git`), shared by every holder of
 * the same repository and commit. The directory stays unchanged until
 * released; release exactly once.
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
  /** Branch, tag, or full commit id; default: the catalog entry's branch, or the remote's default branch. */
  readonly ref?: string
}

/** Parameters of {@link DshRepos.workspaceCreate}. */
export interface WorkspaceCreateParams extends AgentWriteOptions {
  readonly repo: string
  /** Absolute directory of the new workspace: missing or empty (its parent is created). */
  readonly path: string
  /** Branch the work merges into; default: the remote's default branch. */
  readonly base?: string
  /** Full commit id on {@link base} to start from. */
  readonly commit?: string
  /** New remote branch the workspace pushes to; created by the first push. Never the default branch, {@link base}, or a protected branch. */
  readonly branch: string
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
  /** Open requests from the branch after the push, including one opened for {@link WorkspacePushParams.mr}; empty for a repository on no code host. */
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

/** One catalog repository, as {@link DshRepos.repoList} returns it. */
export interface CatalogRepo {
  readonly id: string
  /** Address as the catalog stores it. */
  readonly url: string
  /** Branch to follow; absent follows the remote's default branch. */
  readonly branch?: string
  readonly access: RepoAccess
  /** Feature ids turned on for the repository. */
  readonly features: readonly string[]
}

/** Parameters of {@link DshRepos.repoAdd}. Without an Agent the provider asks nothing: this plugin authorizes and approves the change itself. */
export interface RepoAddParams extends CallOptions {
  /** HTTPS address on a configured host, `file:` URL, or absolute local path. */
  readonly repo: string
  readonly branch?: string
  /** Access of a new entry; an existing entry keeps its access. Default `read`. */
  readonly access?: RepoAccess
  /** Feature ids to turn on. */
  readonly features?: readonly string[]
}

/** Outcome of {@link DshRepos.repoAdd}. */
export interface RepoAddResult {
  readonly status: 'added' | 'updated' | 'unchanged'
  readonly repo: CatalogRepo
}

/** The `dshRepos` methods this plugin calls. */
export interface DshRepos {
  readonly version: DshReposVersion
  /**
   * The catalog repositories.
   * @param params - `feature` lists only the repositories with that feature turned on.
   * @returns the repositories in catalog order.
   */
  repoList(params?: { readonly feature?: string } & CallOptions): Promise<readonly CatalogRepo[]>
  /**
   * Register a feature; the provider's settings page shows a switch for it on every repository.
   * @returns disposer that withdraws the registration.
   */
  featureRegister(feature: RepoFeature): () => void
  /**
   * Observe catalog changes.
   * @param listener - runs after each change.
   * @returns disposer that stops the observation.
   */
  repoOnChange(listener: () => void): () => void
  /**
   * Add a repository to the catalog, or turn features on for the entry holding it.
   * @returns the outcome and the entry.
   * @throws `conflict` when the entry follows another branch; `not-allowed` for an address on an unconfigured host.
   */
  repoAdd(params: RepoAddParams): Promise<RepoAddResult>
  /** @returns the settings this plugin reads. */
  settingsGet(): RepoPublicSettings
  /**
   * Observe host, token, and mirror directory changes that can change what a snapshot can reach.
   * @param listener - runs after each change.
   * @returns disposer that stops the observation.
   */
  hostOnChange(listener: () => void): () => void
  /**
   * Fetch the repository and hold read-only files of a commit.
   * @returns the lease, naming the commit the ref resolved to.
   * @throws `not-found` for a missing ref, `unavailable` while no mirror directory is set or git fails.
   */
  snapshotAcquire(params: SnapshotAcquireParams): Promise<SnapshotLease>
  /**
   * Clone the repository into a new workspace and check out its branch at the start commit.
   * @returns the workspace.
   * @throws `invalid` for a bad path, branch, or commit; `not-found` for a missing base or commit.
   */
  workspaceCreate(params: WorkspaceCreateParams): Promise<WorkspaceInfo>
  /**
   * Describe what a workspace changed since its start commit.
   * @throws `not-found` when the path is not a workspace.
   */
  workspaceStatus(params: { readonly path: string } & CallOptions): Promise<WorkspaceStatus>
  /**
   * Commit the uncommitted changes, push the workspace to its branch, and with `mr` open a request unless one is open; the provider authorizes and approves it for the Agent.
   * @returns the push outcome.
   * @throws `declined` when the user did not approve; `conflict` when the remote branch moved; `invalid` for nothing to push; `forbidden` when the host or `access/authorize` refused.
   */
  workspacePush(params: WorkspacePushParams): Promise<WorkspacePushResult>
}
