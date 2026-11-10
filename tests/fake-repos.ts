import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  CatalogRepo,
  DshRepos,
  MrSummary,
  RepoFeature,
  SnapshotAcquireParams,
  SnapshotLease,
  WorkspaceCreateParams,
  WorkspaceFileChange,
  WorkspaceInfo,
  WorkspacePushParams,
  WorkspacePushResult,
  WorkspaceStatus,
} from '../src/deps/repos-contract.ts'

const run = promisify(execFile)

/** git with a clean configuration; `env` adds variables such as a private index. */
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env } })).stdout
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false)
}

/**
 * A rejection in the form `dshRepos` uses.
 * @param code - failure class.
 * @param message - readable reason.
 * @returns the error.
 */
export function repoError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'RepoError', code })
}

/**
 * The rejection `dshRepos` uses when the user did not approve a write.
 * @param outcome - approval outcome.
 * @returns the error.
 */
export function declinedError(outcome: 'rejected' | 'cancelled' | 'unavailable'): Error {
  return Object.assign(repoError('declined', `用户没有批准（${outcome}），没有执行`), { outcome })
}

/** One push a {@link FakeRepos} workspace made. */
export interface RecordedPush {
  readonly path: string
  readonly branch: string
  readonly message: string
  /** Session of the Agent the push was made for. */
  readonly session: string | undefined
  readonly callId: string | undefined
  readonly commit: string
  /** Files of the pushed commit that differ from the start commit, by path. */
  readonly files: Record<string, string>
  readonly mr: WorkspacePushParams['mr']
}

const STATUS: Record<string, WorkspaceFileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type-changed' }

const IDENTITY = { GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@example.com', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@example.com' }

/** Whether the provider accepts an address: HTTPS, `file:` URLs, and absolute local paths. */
function acceptedAddress(url: string): boolean {
  if (isAbsolute(url)) return true
  try {
    return ['https:', 'file:'].includes(new URL(url).protocol)
  } catch {
    // scp-like `user@host:path` is not a URL.
    return false
  }
}

/**
 * A local stand-in for the `dshRepos` service: bare git mirrors and
 * plain-file snapshots under `root`, and workspaces that are ordinary clones
 * of the remote, which must be a local repository or stand in {@link origins}. Switches cover host
 * changes, stalled fetches, snapshot failures, declined or failing pushes,
 * and merge requests (none open unless {@link openMr} is set). The catalog is
 * {@link catalog}.
 */
export class FakeRepos implements DshRepos {
  readonly version = 7 as const
  /** Catalog repositories; change it with {@link setCatalog} to notify observers. */
  catalog: CatalogRepo[] = []
  /** Registered features by id. */
  readonly features = new Map<string, RepoFeature>()
  /** Local repositories that stand in for remote addresses, by address; an address not listed is cloned as given. */
  readonly origins = new Map<string, string>()
  /** While true, fetching a mirror never settles. */
  stalled = false
  /** While true, the provider reports no mirror directory and every mirror call rejects, as dsh-repo does before one is chosen. */
  mirrorUnset = false
  /** When set, {@link snapshotAcquire} rejects with it. */
  snapshotError: Error | undefined
  /** When set, {@link workspacePush} rejects with it before pushing, as for a declined approval. */
  pushError: Error | undefined
  /** Opens the merge request a push asks for; while unset, a push asking for one reports {@link mrError}. */
  openMr: ((input: { readonly repo: string; readonly branch: string; readonly base: string; readonly title: string; readonly body?: string }) => Promise<MrSummary>) | undefined
  /** Reported when a push asks for a merge request while {@link openMr} is unset. */
  mrError = 'merge requests are not set up in this test'
  /** Every {@link snapshotAcquire} call, oldest first. */
  readonly acquires: SnapshotAcquireParams[] = []
  /** Every {@link workspaceCreate} call, oldest first. */
  readonly creates: WorkspaceCreateParams[] = []
  /** Every {@link workspacePush} call, oldest first, including rejected ones. */
  readonly pushCalls: WorkspacePushParams[] = []
  /** Every successful push, oldest first. */
  readonly pushes: RecordedPush[] = []
  private readonly catalogListeners = new Set<() => void>()
  private readonly listeners = new Set<() => void>()
  private readonly holders = new Map<string, number>()
  private readonly workspaces = new Map<string, WorkspaceInfo>()

  /** @param root - directory for mirrors and snapshots. */
  constructor(readonly root: string) {}

  settingsGet(): { mirrorDir: string | undefined } {
    return { mirrorDir: this.mirrorUnset ? undefined : this.root }
  }

  hostOnChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async repoList(params: { readonly feature?: string } = {}): Promise<readonly CatalogRepo[]> {
    return this.catalog.filter(repo => params.feature === undefined || repo.features.some(item => item.id === params.feature))
  }

  featureRegister(feature: RepoFeature): () => void {
    this.features.set(feature.id, feature)
    this.emitReposChange()
    return () => {
      this.features.delete(feature.id)
      this.emitReposChange()
    }
  }

  repoOnChange(listener: () => void): () => void {
    this.catalogListeners.add(listener)
    return () => { this.catalogListeners.delete(listener) }
  }

  /** Report a catalog change to every observer. */
  emitReposChange(): void {
    for (const listener of [...this.catalogListeners]) listener()
  }

  /**
   * Replace the catalog with repositories that have the given features, and notify observers.
   * @param repos - addresses with an optional baseline branch and an optional branch of every feature.
   * @param features - feature ids every repository has.
   */
  setCatalog(repos: readonly { readonly url: string; readonly base?: string; readonly branch?: string }[], features: readonly string[] = ['log-analysis']): void {
    this.catalog = repos.map((repo, index) => ({
      id: index.toString(16).padStart(12, '0'),
      url: repo.url,
      ...repo.base === undefined ? {} : { base: repo.base },
      access: 'write',
      features: features.map(id => ({ id, ...repo.branch === undefined ? {} : { branch: repo.branch } })),
    }))
    this.emitReposChange()
  }

  /** Report a host or token change to every observer. */
  emitHostsChange(): void {
    for (const listener of this.listeners) listener()
  }

  /** @returns the number of snapshot leases not yet released. */
  heldSnapshots(): number {
    return [...this.holders.values()].reduce((sum, count) => sum + count, 0)
  }

  /**
   * @param url - repository address.
   * @returns the mirror directory of the address.
   */
  mirrorDir(url: string): string {
    return join(this.root, `${basename(url)}-${createHash('sha256').update(url).digest('hex').slice(0, 8)}`)
  }

  async snapshotAcquire(params: SnapshotAcquireParams): Promise<SnapshotLease> {
    this.acquires.push(params)
    if (this.snapshotError !== undefined) throw this.snapshotError
    const { repo } = params
    const mirror = await this.sync(repo)
    const commit = await this.resolve(mirror, params.ref ?? this.catalog.find(entry => entry.url === repo)?.base)
    const path = join(this.root, '.snapshots', basename(mirror), commit.slice(0, 12))
    if (!await exists(path)) {
      await mkdir(path, { recursive: true })
      const index = `${path}.index`
      await git(mirror, ['read-tree', commit], { GIT_INDEX_FILE: index })
      await git(mirror, [`--work-tree=${path}`, 'checkout-index', '-a'], { GIT_INDEX_FILE: index })
      await rm(index, { force: true })
    }
    this.holders.set(path, (this.holders.get(path) ?? 0) + 1)
    let released = false
    return {
      repo,
      commit,
      path,
      release: () => {
        if (released) throw new Error(`snapshot ${path} released twice`)
        released = true
        this.holders.set(path, (this.holders.get(path) ?? 1) - 1)
      },
    }
  }

  async workspaceCreate(params: WorkspaceCreateParams): Promise<WorkspaceInfo> {
    this.creates.push(params)
    const { repo, path } = params
    if (!acceptedAddress(repo)) throw repoError('invalid', `只支持 HTTPS 地址、file: URL 和本机绝对路径：${repo}`)
    if (await exists(path) && (await readdir(path)).length > 0) throw repoError('invalid', `${path} 不是空目录`)
    const mirror = await this.sync(repo)
    const base = params.base ?? this.catalog.find(entry => entry.url === repo)?.base ?? (await git(mirror, ['symbolic-ref', '--short', 'HEAD'])).trim()
    // Like dsh-repo's default template `dsh/{session}`.
    const branch = params.branch ?? `dsh/${params.agent.session?.header.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'nosession'}`
    if (branch === base) throw repoError('invalid', `不能推送到基线分支 ${branch}`)
    const existing = (await git(mirror, ['for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`])).trim()
    if (existing !== '' && params.commit !== undefined) throw repoError('invalid', `远端已有分支 ${branch}，不能指定起始提交`)
    const baseCommit = existing !== '' ? existing : await this.resolve(mirror, params.commit ?? base)
    await mkdir(dirname(path), { recursive: true })
    await git(dirname(path), ['clone', '-q', '--no-checkout', this.origins.get(repo) ?? repo, path])
    await git(path, ['checkout', '-q', '-b', branch, baseCommit])
    const info: WorkspaceInfo = { repo, path, base, baseCommit, branch }
    this.workspaces.set(path, info)
    return info
  }

  async workspaceStatus(params: { readonly path: string }): Promise<WorkspaceStatus> {
    const workspace = this.workspace(params.path)
    const index = join(this.root, '.workspaces', `${createHash('sha256').update(workspace.path).digest('hex').slice(0, 16)}.index`)
    await mkdir(dirname(index), { recursive: true })
    const inside = (...args: string[]) => git(workspace.path, args, { GIT_INDEX_FILE: index })
    await inside('read-tree', 'HEAD')
    await inside('add', '-A')
    const names = (await inside('diff', '--cached', '-M', '--name-status', '-z', workspace.baseCommit)).split('\0').filter(part => part !== '')
    // `--numstat -z` prints `added<TAB>removed<TAB>path<NUL>`, or for a rename an empty path followed by `old<NUL>new<NUL>`.
    const counts = new Map<string, { additions?: number; deletions?: number }>()
    const stats = (await inside('diff', '--cached', '-M', '--numstat', '-z', workspace.baseCommit)).split('\0')
    for (let position = 0; position < stats.length;) {
      const [added = '', removed = '', inline = ''] = (stats[position++] ?? '').split('\t')
      if (added === '') continue
      const path = inline === '' ? (position += 2, stats[position - 1] ?? '') : inline
      counts.set(path, added === '-' ? {} : { additions: Number(added), deletions: Number(removed) })
    }
    const files: WorkspaceFileChange[] = []
    for (let position = 0; position < names.length;) {
      const code = names[position++] ?? ''
      const status = STATUS[code[0] ?? ''] ?? 'modified'
      const previousPath = status === 'renamed' ? names[position++] : undefined
      const path = names[position++] ?? ''
      const count = counts.get(path) ?? {}
      files.push({ path, status, ...previousPath === undefined ? {} : { previousPath }, binary: count.additions === undefined, ...count })
    }
    return { workspace, files, diff: await inside('diff', '--cached', '-M', workspace.baseCommit), truncated: false }
  }

  async workspacePush(params: WorkspacePushParams): Promise<WorkspacePushResult> {
    this.pushCalls.push(params)
    const workspace = this.workspace(params.path)
    if (this.pushError !== undefined) throw this.pushError
    const { path, branch, baseCommit } = workspace
    await git(path, ['add', '-A'])
    if ((await git(path, ['status', '--porcelain'])).trim() !== '') await git(path, ['commit', '-q', '-m', params.message], IDENTITY)
    const commit = (await git(path, ['rev-parse', 'HEAD'])).trim()
    const remote = (await git(path, ['ls-remote', '--heads', 'origin', branch])).trim().split('\t')[0]
    if (commit === (remote ?? '') || commit === baseCommit) throw repoError('invalid', '没有可推送的改动')
    try {
      await git(path, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`])
    } catch (error) {
      throw repoError('conflict', `远端分支 ${branch} 已经变化：${(error as Error).message}`)
    }
    const files: Record<string, string> = {}
    for (const file of (await git(path, ['diff', '--name-only', '--diff-filter=AM', baseCommit, commit])).split('\n').filter(Boolean)) {
      files[file] = await git(path, ['cat-file', 'blob', `${commit}:${file}`])
    }
    this.pushes.push({ path, branch, message: params.message, session: params.agent.session?.header.id, callId: params.callId, commit, files, mr: params.mr })
    const result = { branch, commit }
    if (params.mr === undefined) return { ...result, openMrs: [] }
    if (this.openMr === undefined) return { ...result, openMrs: [], mrError: this.mrError }
    try {
      const opened = await this.openMr({ repo: workspace.repo, branch, base: workspace.base, title: params.mr.title, ...params.mr.body === undefined ? {} : { body: params.mr.body } })
      return { ...result, openMrs: [opened], createdMr: opened }
    } catch (error) {
      return { ...result, openMrs: [], mrError: (error as Error).message }
    }
  }

  private workspace(path: string): WorkspaceInfo {
    const workspace = this.workspaces.get(path)
    if (workspace === undefined) throw repoError('not-found', `${path} 不是工作区`)
    return workspace
  }

  /** Clone or fetch the mirror of an address. */
  private async sync(url: string): Promise<string> {
    if (!acceptedAddress(url)) throw repoError('invalid', `只支持 HTTPS 地址、file: URL 和本机绝对路径：${url}`)
    if (this.mirrorUnset) throw repoError('unavailable', '镜像目录未设置：请到「代码仓库」设置页的「高级」里选择一个目录')
    if (this.stalled) return await new Promise(() => {})
    const dir = this.mirrorDir(url)
    try {
      if (await exists(dir)) await git(dir, ['fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/heads/*'])
      else {
        await mkdir(this.root, { recursive: true })
        await git(this.root, ['clone', '-q', '--bare', this.origins.get(url) ?? url, dir])
      }
    } catch (error) {
      throw repoError('unavailable', `同步镜像失败：${(error as Error).message}`)
    }
    return dir
  }

  /** The commit a branch or commit id names in a mirror; undefined: the default branch. */
  private async resolve(mirror: string, ref: string | undefined): Promise<string> {
    const name = ref ?? (await git(mirror, ['symbolic-ref', '--short', 'HEAD'])).trim()
    for (const candidate of [`refs/heads/${name}`, name]) {
      try {
        return (await git(mirror, ['rev-parse', '--verify', '-q', `${candidate}^{commit}`])).trim()
      } catch {
        // Not this form of the ref; try the next.
      }
    }
    throw repoError('not-found', `${name} 不存在`)
  }
}
