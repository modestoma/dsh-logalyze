import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type {
  CommitAuthor,
  DshRepos,
  MirrorState,
  MirrorTreeEntry,
  SnapshotLease,
  WorkspaceChanges,
  WorkspaceFileChange,
  WorkspaceInfo,
  WorkspaceOpenOptions,
  WorkspacePushOptions,
  WorkspacePushResult,
} from '../src/repos/contract.ts'

const run = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8' })).stdout
}

/** git with an explicit environment, for workspace operations that use a private index. */
async function gitEnv(env: Record<string, string>, cwd: string, ...args: string[]): Promise<string> {
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

/** One push a {@link FakeRepos} workspace made. */
export interface RecordedPush {
  readonly dir: string
  readonly branch: string
  readonly message: string
  readonly author?: CommitAuthor
  readonly session?: string
  readonly commit: string
  /** Files of the pushed commit, by path. */
  readonly files: Record<string, string>
}

interface FakeWorkspace {
  readonly url: string
  readonly mirror: string
  readonly index: string
  readonly baseBranch: string
  readonly baseCommit: string
  branch?: string
  head: string
}

const STATUS: Record<string, WorkspaceFileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type-changed' }

/**
 * Whether the provider accepts an address for mirrors and workspaces: HTTPS,
 * `file:` URLs, and absolute local paths.
 */
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
 * A local stand-in for the `dshRepos` service: bare git mirrors and worktree
 * snapshots under `root`, and workspaces whose git metadata (a private index
 * and the mirror) stays outside the checkout. Pushes go to the mirrored
 * remote, which must be a local repository; a remote branch that already
 * exists makes the first push reject with `conflict`. Switches cover host
 * changes, stalled fetches, and snapshot failures. `createChange` rejects
 * unless a test replaces it.
 */
export class FakeRepos implements DshRepos {
  readonly version = 2 as const
  /** While true, `syncMirror` never settles. */
  stalled = false
  /** When set, `acquireSnapshot` rejects with it. */
  snapshotError: Error | undefined
  private readonly listeners = new Set<() => void>()
  private readonly holders = new Map<string, number>()
  private readonly workspaces = new Map<string, FakeWorkspace>()
  /** Every successful push, oldest first. */
  readonly pushes: RecordedPush[] = []

  /** @param root - directory for mirrors and snapshots. */
  constructor(readonly root: string) {}

  mirrorSettings(): { dir: string } {
    return { dir: this.root }
  }

  onHostsChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
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

  async syncMirror(url: string, options: { readonly branch?: string } = {}): Promise<MirrorState> {
    if (!acceptedAddress(url)) throw repoError('invalid', `只支持 HTTPS 地址、file: URL 和本机绝对路径：${url}`)
    if (this.stalled) return await new Promise(() => {})
    const dir = this.mirrorDir(url)
    try {
      if (await exists(dir)) await git(dir, 'fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/heads/*')
      else {
        await mkdir(this.root, { recursive: true })
        await git(this.root, 'clone', '-q', '--bare', url, dir)
      }
    } catch (error) {
      throw repoError('unavailable', `同步镜像失败：${(error as Error).message}`)
    }
    const branch = options.branch ?? (await git(dir, 'symbolic-ref', '--short', 'HEAD')).trim()
    let commit: string
    try {
      commit = (await git(dir, 'rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`)).trim()
    } catch {
      throw repoError('not-found', `分支 ${branch} 不存在`)
    }
    const commitTime = (await git(dir, 'show', '-s', '--format=%cI', commit)).trim()
    return { dir, branch, commit, commitTime }
  }

  async readMirrorFile(url: string, commit: string, path: string): Promise<string | undefined> {
    const [entry] = await this.tree(url, commit, path, false)
    if (entry === undefined) return undefined
    if (entry.type !== 'file') throw repoError('invalid', `${path} 不是普通文件`)
    return await git(this.mirrorDir(url), 'cat-file', 'blob', `${commit}:${path}`)
  }

  async listMirrorTree(url: string, commit: string, path: string): Promise<readonly MirrorTreeEntry[]> {
    return (await this.tree(url, commit, path, true)).filter(entry => entry.path !== path)
  }

  async acquireSnapshot(url: string, commit: string): Promise<SnapshotLease> {
    if (this.snapshotError !== undefined) throw this.snapshotError
    const dir = join(this.root, '.snapshots', basename(this.mirrorDir(url)), commit.slice(0, 12))
    if (!await exists(dir)) {
      await mkdir(dirname(dir), { recursive: true })
      await git(this.mirrorDir(url), 'worktree', 'add', '-q', '--detach', dir, commit)
    }
    this.holders.set(dir, (this.holders.get(dir) ?? 0) + 1)
    let released = false
    return {
      dir,
      release: () => {
        if (released) throw new Error(`snapshot ${dir} released twice`)
        released = true
        this.holders.set(dir, (this.holders.get(dir) ?? 1) - 1)
      },
    }
  }

  async openWorkspace(url: string, options: WorkspaceOpenOptions): Promise<WorkspaceInfo> {
    if (!acceptedAddress(url)) throw repoError('invalid', `只支持 HTTPS 地址、file: URL 和本机绝对路径：${url}`)
    const { dir, baseBranch, commit } = options
    if (await exists(dir)) throw repoError('invalid', `${dir} 已存在`)
    const mirror = this.mirrorDir(url)
    try {
      await git(mirror, 'cat-file', '-e', `${commit}^{commit}`)
    } catch {
      throw repoError('not-found', `提交 ${commit} 不在镜像中`)
    }
    const index = join(this.root, '.workspaces', `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.index`)
    await mkdir(dirname(index), { recursive: true })
    await mkdir(dir, { recursive: true })
    await gitEnv({ GIT_INDEX_FILE: index }, mirror, 'read-tree', commit)
    await gitEnv({ GIT_INDEX_FILE: index }, mirror, `--work-tree=${dir}`, 'checkout-index', '-a')
    this.workspaces.set(dir, { url, mirror, index, baseBranch, baseCommit: commit, head: commit })
    return { url, dir, baseCommit: commit }
  }

  async workspaceChanges(dir: string): Promise<WorkspaceChanges> {
    const workspace = this.workspace(dir)
    const run = (...args: string[]) => gitEnv({ GIT_INDEX_FILE: workspace.index }, workspace.mirror, `--work-tree=${dir}`, ...args)
    await run('add', '-A')
    const names = (await run('diff', '--cached', '-M', '--name-status', '-z', workspace.baseCommit)).split('\0').filter(part => part !== '')
    // `--numstat -z` prints `added<TAB>removed<TAB>path<NUL>`, or for a rename an empty path followed by `old<NUL>new<NUL>`.
    const counts = new Map<string, { additions?: number; deletions?: number }>()
    const stats = (await run('diff', '--cached', '-M', '--numstat', '-z', workspace.baseCommit)).split('\0')
    for (let index = 0; index < stats.length;) {
      const [added = '', removed = '', inline = ''] = (stats[index++] ?? '').split('\t')
      if (added === '') continue
      const path = inline === '' ? (index += 2, stats[index - 1] ?? '') : inline
      counts.set(path, added === '-' ? {} : { additions: Number(added), deletions: Number(removed) })
    }
    const files: WorkspaceFileChange[] = []
    for (let index = 0; index < names.length;) {
      const code = names[index++] ?? ''
      const status = STATUS[code[0] ?? ''] ?? 'modified'
      const previousPath = status === 'renamed' ? names[index++] : undefined
      const path = names[index++] ?? ''
      const count = counts.get(path) ?? {}
      files.push({ path, status, ...previousPath === undefined ? {} : { previousPath }, binary: count.additions === undefined, ...count })
    }
    return {
      workspace: { url: workspace.url, dir, baseCommit: workspace.baseCommit, ...workspace.branch === undefined ? {} : { branch: workspace.branch } },
      files,
      diff: await run('diff', '--cached', '-M', workspace.baseCommit),
    }
  }

  async pushWorkspace(dir: string, options: WorkspacePushOptions): Promise<WorkspacePushResult> {
    const workspace = this.workspace(dir)
    const { branch, message, author, session } = options
    if (workspace.branch !== undefined && workspace.branch !== branch) throw repoError('invalid', `工作区已推送到 ${workspace.branch}`)
    if (branch === workspace.baseBranch) throw repoError('invalid', `不能推送到基准分支 ${branch}`)
    const env = { GIT_INDEX_FILE: workspace.index }
    await gitEnv(env, workspace.mirror, `--work-tree=${dir}`, 'add', '-A')
    const tree = (await gitEnv(env, workspace.mirror, 'write-tree')).trim()
    const headTree = (await git(workspace.mirror, 'rev-parse', `${workspace.head}^{tree}`)).trim()
    if (tree === headTree) throw repoError('invalid', '没有可推送的改动')
    if (workspace.branch === undefined && (await git(workspace.mirror, 'ls-remote', '--heads', 'origin', branch)).trim() !== '') {
      throw repoError('conflict', `远端分支 ${branch} 已存在`)
    }
    const identity = author ?? { name: 'fake', email: 'fake@example.com' }
    const commit = (await gitEnv({
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    }, workspace.mirror, 'commit-tree', tree, '-p', workspace.head, '-m', message)).trim()
    await git(workspace.mirror, 'push', '-q', 'origin', `${commit}:refs/heads/${branch}`)
    workspace.branch = branch
    workspace.head = commit
    const files: Record<string, string> = {}
    for (const path of (await git(workspace.mirror, 'diff', '--name-only', '--diff-filter=AM', workspace.baseCommit, commit)).split('\n').filter(Boolean)) {
      files[path] = await git(workspace.mirror, 'cat-file', 'blob', `${commit}:${path}`)
    }
    this.pushes.push({ dir, branch, message, ...author === undefined ? {} : { author }, ...session === undefined ? {} : { session }, commit, files })
    return { branch, commit }
  }

  async createChange(): Promise<{ readonly webUrl: string }> {
    throw repoError('unavailable', 'createChange is not set up in this test')
  }

  private workspace(dir: string): FakeWorkspace {
    const workspace = this.workspaces.get(dir)
    if (workspace === undefined) throw repoError('not-found', `${dir} 不是工作区`)
    return workspace
  }

  private async tree(url: string, commit: string, path: string, recursive: boolean): Promise<MirrorTreeEntry[]> {
    const output = await git(this.mirrorDir(url), 'ls-tree', '-z', ...recursive ? ['-r', '-t'] : [], commit, '--', path)
    return output.split('\0').filter(line => line !== '').map((line) => {
      const [meta = '', entryPath = ''] = line.split('\t')
      const [mode, type] = meta.split(' ')
      return { path: entryPath, type: mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : type === 'tree' ? 'dir' : 'file' }
    })
  }
}
