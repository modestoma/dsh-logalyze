/**
 * 接入初稿：起草子 Agent 写在运行目录里的 `repo-init/reason.md`（模块划分与依据）
 * 和 `repo-init/files/`（对应仓库的 `.agents/` 目录，含 `logalyze.yaml` 与
 * `skills/<skill>/` 下的文件）。
 *
 * 运行目录对 Agent 可写，读取规则与 SKILL 改进的修改相同；另外只接受
 * `logalyze.yaml` 和它指定的 SKILL 目录下的文件，并把初稿叠加在基准提交上，按
 * 观象拉取仓库时的同一套规则检查应用描述和 SKILL。
 *
 * @module dsh-logalyze/onboard/draft
 */

import { join } from 'node:path'
import { checkAppManifest, parseManifest, skillNameOf, skillPath } from '../repos/manifest.ts'
import type { RepoFileReader } from '../repos/manifest.ts'
import type { AppManifest, SkillUpdateSettings } from '../settings/contract.ts'
import { kindOf, ProposalError, readFileTree, readText } from '../skill-update/proposal.ts'
import type { ProposedFile } from '../skill-update/proposal.ts'

/** Draft directory inside the run directory. */
export const INIT_DIR = 'repo-init'

/** Explanation file inside {@link INIT_DIR}. */
export const INIT_REASON_FILE = 'reason.md'

/** Directory inside {@link INIT_DIR} mirroring the repository's `.agents/`. */
export const INIT_FILES_DIR = 'files'

/** Diff the plugin writes next to the draft, for the user to read. */
export const INIT_DIFF_FILE = 'repo-init.diff'

/** Repository directory the draft files are relative to. */
export const AGENTS_DIR = '.agents'

/** Manifest path relative to {@link AGENTS_DIR}. */
const MANIFEST_FILE = 'logalyze.yaml'

/** A draft whose paths are allowed and whose manifest parses. */
export interface InitDraft {
  readonly reason: string
  /** Files by path relative to `.agents/`. */
  readonly files: readonly ProposedFile[]
  readonly app: AppManifest
}

/**
 * Read one run directory's draft.
 * @param workDir - the drafting task's run directory.
 * @param limits - file count and size ceilings.
 * @returns the draft.
 * @throws ProposalError when the draft is missing, has a disallowed entry or path, or its manifest is invalid.
 */
export async function readInitDraft(workDir: string, limits: Pick<SkillUpdateSettings, 'maxFiles' | 'maxFileBytes'>): Promise<InitDraft> {
  const root = join(workDir, INIT_DIR)
  if (await kindOf(root) !== 'directory') throw new ProposalError(`子 Agent 没有写出初稿目录 ${INIT_DIR}/`)
  const reasonPath = join(root, INIT_REASON_FILE)
  if (await kindOf(reasonPath) !== 'file') throw new ProposalError(`缺少 ${INIT_DIR}/${INIT_REASON_FILE}（模块划分与依据）`)
  const reason = (await readText(reasonPath, `${INIT_DIR}/${INIT_REASON_FILE}`, limits.maxFileBytes)).trim()
  if (reason === '') throw new ProposalError(`${INIT_DIR}/${INIT_REASON_FILE} 不能为空`)
  const filesRoot = join(root, INIT_FILES_DIR)
  if (await kindOf(filesRoot) !== 'directory') throw new ProposalError(`缺少 ${INIT_DIR}/${INIT_FILES_DIR}/（对应仓库的 ${AGENTS_DIR}/ 目录）`)
  const files = await readFileTree(filesRoot, limits)
  const manifestFile = files.find(file => file.path === MANIFEST_FILE)
  if (manifestFile === undefined) throw new ProposalError(`初稿缺少 ${INIT_DIR}/${INIT_FILES_DIR}/${MANIFEST_FILE}`)
  const manifest = parseManifest(manifestFile.content)
  if (!manifest.ok) throw new ProposalError(manifest.error)
  const skillPrefix = `skills/${manifest.app.skill}/`
  const stray = files.find(file => file.path !== MANIFEST_FILE && !file.path.startsWith(skillPrefix))
  if (stray !== undefined) throw new ProposalError(`初稿只能包含 ${MANIFEST_FILE} 和 ${skillPrefix} 下的文件，${stray.path} 不在其中`)
  return { reason, files, app: manifest.app }
}

/**
 * Check a draft laid over the base commit by the rules a sync applies, plus
 * the SKILL name `/<skill>` needs.
 * @param draft - the draft.
 * @param read - reader of the base commit.
 * @throws ProposalError when the application would not be usable.
 */
export async function checkInitDraft(draft: InitDraft, read: RepoFileReader): Promise<void> {
  const drafted = new Map(draft.files.map(file => [`${AGENTS_DIR}/${file.path}`, file.content]))
  const overlay: RepoFileReader = async path => drafted.has(path) ? drafted.get(path) : await read(path)
  const checked = await checkAppManifest(overlay)
  if (!checked.ok) throw new ProposalError(checked.error)
  const skill = skillPath(draft.app.skill)
  const name = skillNameOf(await overlay(skill) ?? '')
  if (name !== draft.app.skill) throw new ProposalError(`${skill} 的 frontmatter name 是${name === undefined ? '（缺失）' : `「${name}」`}，必须等于 skill 字段「${draft.app.skill}」`)
}
