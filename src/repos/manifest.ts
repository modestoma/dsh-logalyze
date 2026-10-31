/**
 * 应用仓库内 `.agents/logalyze.yaml` 应用描述的解析与校验，以及对应日志分析
 * SKILL 的存在性检查。
 *
 * @module dsh-logalyze/repos/manifest
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { describeIssue } from '../config.ts'
import type { AppManifest } from '../settings/contract.ts'

/** Manifest path relative to the repository root. */
export const MANIFEST_PATH = '.agents/logalyze.yaml'

/** Kebab-case identifier, the same rule DSH applies to skill names. */
export const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const textList = z.array(z.string().trim().min(1)).default([])

const manifestSchema = z.object({
  id: z.string().regex(KEBAB_ID, 'id 必须是小写短横线格式，例如 order-service'),
  name: z.string().trim().min(1, 'name 不能为空'),
  description: z.string().trim().min(1, 'description 不能为空'),
  aliases: textList,
  logHints: textList,
  skill: z.string().regex(KEBAB_ID, 'skill 必须是小写短横线格式的 SKILL 名'),
})

/** Outcome of reading one repository's application description. */
export type ManifestRead =
  | { readonly ok: true; readonly app: AppManifest }
  | { readonly ok: false; readonly error: string }

/**
 * Repository-relative directory of an application's analysis skill, which DSH
 * discovers as a project skill.
 * @param skill - skill name.
 * @returns `.agents/skills/<skill>`.
 */
export function skillDir(skill: string): string {
  return `.agents/skills/${skill}`
}

/**
 * Repository-relative path of an application's analysis skill.
 * @param skill - skill name.
 * @returns `.agents/skills/<skill>/SKILL.md`.
 */
export function skillPath(skill: string): string {
  return `${skillDir(skill)}/SKILL.md`
}

/**
 * Parse manifest text.
 * @param text - YAML content.
 * @returns the validated manifest or the first problem.
 */
export function parseManifest(text: string): ManifestRead {
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    return { ok: false, error: `${MANIFEST_PATH} 不是合法 YAML：${(error as Error).message}` }
  }
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: `${MANIFEST_PATH} 不合法：${describeIssue(parsed.error)}` }
  return { ok: true, app: parsed.data }
}

function frontmatterOf(text: string): Record<string, unknown> | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1]
  if (frontmatter === undefined) return undefined
  try {
    const metadata: unknown = parseYaml(frontmatter)
    return typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : undefined
  } catch {
    // Malformed frontmatter is reported by DSH's own skill loader, not here.
    return undefined
  }
}

/**
 * Whether a SKILL.md opts out of user invocation, which would turn the
 * dispatch prompt's `/<skill>` gesture into plain text.
 * @param text - SKILL.md content.
 * @returns whether frontmatter sets `user-invocable: false`.
 */
export function disablesUserInvocation(text: string): boolean {
  return frontmatterOf(text)?.['user-invocable'] === false
}

/**
 * The name a SKILL.md registers under, which `/<skill>` addresses.
 * @param text - SKILL.md content.
 * @returns the frontmatter `name`, or undefined when absent or not a string.
 */
export function skillNameOf(text: string): string | undefined {
  const name = frontmatterOf(text)?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * Reads one repository file by its path relative to the repository root.
 * Resolves `undefined` when the file does not exist and rejects on any other
 * failure.
 */
export type RepoFileReader = (path: string) => Promise<string | undefined>

/**
 * Read and check one repository: the manifest exists and is valid, and its
 * analysis skill exists and is user-invocable.
 * @param read - file reader rooted at the repository (a checkout or one commit).
 * @returns the application description or the reason it is unusable.
 */
export async function checkAppManifest(read: RepoFileReader): Promise<ManifestRead> {
  let text: string | undefined
  try {
    text = await read(MANIFEST_PATH)
  } catch (error) {
    return { ok: false, error: `无法读取 ${MANIFEST_PATH}：${(error as Error).message}` }
  }
  if (text === undefined) return { ok: false, error: `仓库缺少应用描述 ${MANIFEST_PATH}` }
  const manifest = parseManifest(text)
  if (!manifest.ok) return manifest
  const skill = skillPath(manifest.app.skill)
  let skillText: string | undefined
  try {
    skillText = await read(skill)
  } catch (error) {
    return { ok: false, error: `无法读取 ${skill}：${(error as Error).message}` }
  }
  if (skillText === undefined) return { ok: false, error: `仓库缺少日志分析 SKILL ${skill}` }
  if (disablesUserInvocation(skillText)) return { ok: false, error: `${skill} 设置了 user-invocable: false，派发时无法用 /${manifest.app.skill} 加载` }
  return manifest
}

/**
 * Read and check one checkout on disk.
 * @param dir - repository root.
 * @returns the application description or the reason it is unusable.
 */
export async function readAppManifest(dir: string): Promise<ManifestRead> {
  return await checkAppManifest(async (path) => {
    try {
      return await readFile(join(dir, path), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  })
}
