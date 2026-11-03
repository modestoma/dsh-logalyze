/**
 * 观象对 `dshRepos` 服务（version 2）的需求：只声明观象调用的方法和读取的
 * 字段。服务在运行时经 `ctx.get('dshRepos')` 取得，由任何按这一约定提供该服务
 * 的插件实现；观象不依赖提供方的包。
 *
 * 镜像和工作区只接受 HTTPS 地址、`file:` URL 和本机绝对路径。每个方法在预期内
 * 的失败时以 `name` 为 `RepoError`、带字符串 `code` 的错误拒绝（例如
 * `conflict` 表示远端分支已存在，`invalid` 表示参数违反约定）。
 *
 * @module dsh-logalyze/repos/contract
 */

/** The `dshRepos` service version this plugin calls. */
export type DshReposVersion = 2

/** Options every call accepts. */
export interface CallOptions {
  /** Aborting stops waiting; a write may still have reached the code host. */
  readonly signal?: AbortSignal
}

/** Where the provider keeps local mirrors. */
export interface MirrorSettings {
  /** Absolute directory holding the mirrors and the snapshots. */
  readonly dir: string
}

/** A mirror after a successful clone or fetch. */
export interface MirrorState {
  /** Absolute directory of the fetch-only mirror. */
  readonly dir: string
  /** The requested branch, or the remote's default branch. */
  readonly branch: string
  /** Full commit id the branch points to after the fetch. */
  readonly commit: string
  /** Committer date of {@link commit}, ISO 8601. */
  readonly commitTime: string
}

/** One entry of a mirror tree listing. */
export interface MirrorTreeEntry {
  /** Path from the repository root, `/`-separated. */
  readonly path: string
  readonly type: 'file' | 'dir' | 'symlink' | 'submodule'
}

/**
 * A read-only checkout of one commit. The directory stays unchanged until
 * released; release exactly once.
 */
export interface SnapshotLease {
  /** Absolute directory of the checkout. */
  readonly dir: string
  release(): void
}

/** Name and email recorded on a commit. */
export interface CommitAuthor {
  readonly name: string
  readonly email: string
}

/** Fields of a new pull or merge request. */
export interface ChangeCreate extends CallOptions {
  readonly title: string
  readonly body: string
  readonly sourceBranch: string
  readonly targetBranch: string
}

/** Options of {@link DshRepos.openWorkspace}. */
export interface WorkspaceOpenOptions extends CallOptions {
  /** Absolute directory of the checkout; must not exist yet (its parent is created). */
  readonly dir: string
  /** Branch the work starts from and later merges into. */
  readonly baseBranch: string
  /** Full commit id to start from, fetched by an earlier {@link DshRepos.syncMirror}. */
  readonly commit: string
}

/** A writable checkout opened by {@link DshRepos.openWorkspace}. */
export interface WorkspaceInfo {
  /** Repository address the workspace pushes to. */
  readonly url: string
  /** Absolute directory of the checkout. */
  readonly dir: string
  /** Commit the work started from. */
  readonly baseCommit: string
  /** Remote branch fixed by the first {@link DshRepos.pushWorkspace}; absent before it. */
  readonly branch?: string
}

/** One file that differs from the workspace's base commit. */
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

/** Everything a workspace changed relative to its base commit, committed or not. */
export interface WorkspaceChanges {
  readonly workspace: WorkspaceInfo
  /** Files differing between the base commit and the working tree (untracked files included, ignored files excluded). */
  readonly files: readonly WorkspaceFileChange[]
  /** Unified diff from the base commit to the working tree. */
  readonly diff: string
}

/** Options of {@link DshRepos.pushWorkspace}. */
export interface WorkspacePushOptions extends CallOptions {
  /** New remote branch; the first push fails with `conflict` when the remote already has it. */
  readonly branch: string
  /** Message of the commit recording the uncommitted changes. */
  readonly message: string
  /** Author and committer of that commit; default: the account that owns the host token. */
  readonly author?: CommitAuthor
  /** Session added to that commit's message as a `DSH-Session:` trailer. */
  readonly session?: string
}

/** Outcome of {@link DshRepos.pushWorkspace}. */
export interface WorkspacePushResult {
  readonly branch: string
  /** Commit the remote branch points to after the push. */
  readonly commit: string
}

/** The `dshRepos` methods this plugin calls. */
export interface DshRepos {
  readonly version: DshReposVersion
  /** @returns where mirrors and snapshots live. */
  mirrorSettings(): MirrorSettings
  /**
   * Observe host or token changes that can change what a sync can reach.
   * @param listener - runs after each change.
   * @returns disposer that stops the observation.
   */
  onHostsChange(listener: () => void): () => void
  /**
   * Clone the address as a fetch-only mirror, or fetch it, and resolve the branch head.
   * @param url - HTTPS address, `file:` URL, or absolute local path.
   * @returns the mirror and the branch head.
   */
  syncMirror(url: string, options?: CallOptions & { readonly branch?: string }): Promise<MirrorState>
  /**
   * Read one regular file of a fetched commit.
   * @returns UTF-8 text, or undefined when the commit has no such path.
   * @throws when the path is not a regular file.
   */
  readMirrorFile(url: string, commit: string, path: string, options?: CallOptions): Promise<string | undefined>
  /**
   * List the entries below a directory of a fetched commit, recursively.
   * @returns entries, or an empty list when the path does not exist.
   */
  listMirrorTree(url: string, commit: string, path: string, options?: CallOptions): Promise<readonly MirrorTreeEntry[]>
  /** @returns a held read-only checkout of the commit. */
  acquireSnapshot(url: string, commit: string, options?: CallOptions): Promise<SnapshotLease>
  /**
   * Check out a commit as a writable working tree whose git metadata stays
   * outside the checkout: agents edit files only, and {@link pushWorkspace}
   * records and pushes the changes. The caller owns the directory.
   * @param url - HTTPS address, `file:` URL, or absolute local path.
   * @returns the workspace.
   * @throws `invalid` for an unsupported address or a directory that exists.
   */
  openWorkspace(url: string, options: WorkspaceOpenOptions): Promise<WorkspaceInfo>
  /**
   * Describe what a workspace changed since its base commit.
   * @param dir - directory passed to {@link openWorkspace}.
   * @returns the changes.
   */
  workspaceChanges(dir: string, options?: CallOptions): Promise<WorkspaceChanges>
  /**
   * Commit the uncommitted changes and push them to a new remote branch, never forcing.
   * @param dir - directory passed to {@link openWorkspace}.
   * @returns the push outcome.
   * @throws `conflict` when the remote branch exists before the first push; `invalid` for the base or default branch or nothing to push.
   */
  pushWorkspace(dir: string, options: WorkspacePushOptions): Promise<WorkspacePushResult>
  /** @returns the new pull or merge request. */
  createChange(repo: string, change: ChangeCreate): Promise<{ readonly webUrl: string }>
}
