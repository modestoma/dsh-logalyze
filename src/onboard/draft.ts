/**
 * 接入初稿：起草子 Agent 在运行目录的工作区 `repo/` 中直接写出的
 * `.agents/logalyze.yaml` 与 `.agents/skills/<skill>/`，以及工作区之外的
 * `reason.md`（模块划分与依据）。
 *
 * 检查规则与观象拉取仓库时相同：应用描述合法，SKILL 存在、frontmatter 的
 * `name` 等于 `skill` 字段、不设置 `user-invocable: false`；改动只能是
 * `logalyze.yaml` 和它指定的 SKILL 目录下新增或修改的文件，读取规则与 SKILL
 * 改进相同。
 *
 * @module dsh-logalyze/onboard/draft
 */

import { join } from 'node:path'
import { checkAppManifest, skillNameOf, skillPath } from '../apps/manifest.ts'
import type { RepoFileReader } from '../apps/manifest.ts'
import { treeReader } from '../apps/tree.ts'
import type { ReposClient } from '../deps/repos.ts'
import type { WorkspaceStatus } from '../deps/repos-contract.ts'
import { checkChanges, readReason, WORKSPACE_DIR } from '../runs/changes.ts'
import type { CheckedChanges } from '../runs/changes.ts'
import type { AppManifest, SkillUpdateSettings } from '../settings/contract.ts'
import { ProposalError } from '../util/files.ts'

/** Repository directory the draft lives in. */
export const AGENTS_DIR = '.agents'

/** Manifest path relative to {@link AGENTS_DIR}. */
const MANIFEST_FILE = 'logalyze.yaml'

/** A draft that passed every check. */
export interface InitDraft {
  readonly reason: string
  readonly app: AppManifest
  readonly changes: CheckedChanges
}

/**
 * A reader of the tree a push of the workspace publishes: changed files from
 * the workspace, every other file from the base commit. A file that exists in
 * the workspace but in neither is excluded by the repository's ignore rules.
 * @param changes - the workspace's changes.
 * @param baseDir - snapshot of the workspace's base commit.
 * @param maxBytes - size ceiling.
 * @returns the reader; it yields undefined for a path the push does not publish.
 */
function publishedReader(changes: WorkspaceStatus, baseDir: string, maxBytes: number): RepoFileReader {
  const { workspace } = changes
  const disk = treeReader(workspace.path, maxBytes)
  const base = treeReader(baseDir, maxBytes)
  const changed = new Map<string, string>()
  for (const file of changes.files) {
    if (file.previousPath !== undefined) changed.set(file.previousPath, 'deleted')
    changed.set(file.path, file.status)
  }
  return async (path) => {
    const status = changed.get(path)
    if (status === 'deleted') return undefined
    if (status !== undefined) return await disk(path)
    const published = await base(path)
    if (published === undefined && await disk(path) !== undefined) throw new ProposalError(`${path} 被仓库的忽略规则（.gitignore 等）排除，推送时不会包含它；请改用不被忽略的文件名`)
    return published
  }
}

/**
 * Check one drafting run's workspace: the application it describes, then the
 * changes against the paths that application allows.
 * @param repos - the `dshRepos` service holding the workspace.
 * @param workDir - the drafting run directory holding {@link WORKSPACE_DIR} and the reason file.
 * @param limits - file count and size ceilings.
 * @param signal - cancellation.
 * @returns the draft.
 * @throws ProposalError when the application would not be usable or a change is not allowed; the service's error when it cannot report the changes.
 */
export async function checkInitDraft(repos: ReposClient, workDir: string, limits: Pick<SkillUpdateSettings, 'maxFiles' | 'maxFileBytes'>, signal?: AbortSignal): Promise<InitDraft> {
  const dir = join(workDir, WORKSPACE_DIR)
  const changes = await repos.require().workspaceStatus({ path: dir, ...signal === undefined ? {} : { signal } })
  const { app } = await repos.withSnapshot(changes.workspace.repo, changes.workspace.baseCommit, signal, async (lease) => {
    const read = publishedReader(changes, lease.path, limits.maxFileBytes)
    const checked = await checkAppManifest(read)
    if (!checked.ok) throw new ProposalError(checked.error)
    const skill = skillPath(checked.app.skill)
    const name = skillNameOf(await read(skill) ?? '')
    if (name !== checked.app.skill) throw new ProposalError(`${skill} 的 frontmatter name 是${name === undefined ? '（缺失）' : `「${name}」`}，必须等于 skill 字段「${checked.app.skill}」`)
    return checked
  })
  const skillPrefix = `skills/${app.skill}/`
  const scope = { root: AGENTS_DIR, allows: (path: string) => path === MANIFEST_FILE || path.startsWith(skillPrefix), description: `${AGENTS_DIR}/${MANIFEST_FILE} 和 ${AGENTS_DIR}/${skillPrefix}` }
  const draft = await checkChanges(changes, scope, limits)
  const reason = await readReason(workDir, limits.maxFileBytes, '模块划分与依据')
  return { reason, app, changes: draft }
}
