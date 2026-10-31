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
import type { DshRepos } from '../repos/contract.ts'
import { checkAppManifest, skillNameOf, skillPath } from '../repos/manifest.ts'
import type { AppManifest, SkillUpdateSettings } from '../settings/contract.ts'
import { ProposalError } from '../skill-update/files.ts'
import { checkChanges, readReason, workspaceReader, WORKSPACE_DIR } from '../skill-update/workspace.ts'
import type { CheckedChanges } from '../skill-update/workspace.ts'

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
 * Check one drafting run's workspace: the application it describes, then the
 * changes against the paths that application allows.
 * @param repos - the `dshRepos` service holding the workspace.
 * @param workDir - the drafting run directory holding {@link WORKSPACE_DIR} and the reason file.
 * @param limits - file count and size ceilings.
 * @param signal - cancellation.
 * @returns the draft.
 * @throws ProposalError when the application would not be usable or a change is not allowed; the service's error when it cannot report the changes.
 */
export async function checkInitDraft(repos: DshRepos, workDir: string, limits: Pick<SkillUpdateSettings, 'maxFiles' | 'maxFileBytes'>, signal?: AbortSignal): Promise<InitDraft> {
  const dir = join(workDir, WORKSPACE_DIR)
  const changes = await repos.workspaceChanges(dir, signal === undefined ? {} : { signal })
  const read = workspaceReader(dir, limits.maxFileBytes)
  const checked = await checkAppManifest(read)
  if (!checked.ok) throw new ProposalError(checked.error)
  const { app } = checked
  const skill = skillPath(app.skill)
  const name = skillNameOf(await read(skill) ?? '')
  if (name !== app.skill) throw new ProposalError(`${skill} 的 frontmatter name 是${name === undefined ? '（缺失）' : `「${name}」`}，必须等于 skill 字段「${app.skill}」`)
  const skillPrefix = `skills/${app.skill}/`
  const scope = { root: AGENTS_DIR, allows: (path: string) => path === MANIFEST_FILE || path.startsWith(skillPrefix), description: `${AGENTS_DIR}/${MANIFEST_FILE} 和 ${AGENTS_DIR}/${skillPrefix}` }
  const draft = await checkChanges(changes, scope, limits)
  const reason = await readReason(workDir, limits.maxFileBytes, '模块划分与依据')
  return { reason, app, changes: draft }
}
