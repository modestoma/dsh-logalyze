/**
 * 观象随包提供的指导 SKILL，正文是包内的 `skills/<name>/SKILL.md`，插件加载时
 * 读取并校验，文件缺失或不合法时加载失败：
 *
 * - `/logalyze-kit` 接入套件：怎样为应用仓库编写应用描述和日志分析 SKILL。
 *   接入起草子 Agent 用首行手势加载它。
 * - `/logalyze-improve` 改进指南：怎样把一次分析中 SKILL 没有覆盖的问题整理为
 *   案例并改进 SKILL。SKILL 改进子 Agent 用首行手势加载它。
 *
 * 开发者也可以在自己的仓库里输入 `/<name>` 使用它们。
 *
 * @module dsh-logalyze/skill/bundled
 */

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

/** Onboarding kit skill name, addressed as `/logalyze-kit`. */
export const KIT_SKILL_NAME = 'logalyze-kit'

/** SKILL improvement guide name, addressed as `/logalyze-improve`. */
export const IMPROVE_SKILL_NAME = 'logalyze-improve'

/** Every bundled skill, in listing order. */
export const BUNDLED_SKILL_NAMES = [KIT_SKILL_NAME, IMPROVE_SKILL_NAME] as const

/** Name of one bundled skill. */
export type BundledSkillName = (typeof BUNDLED_SKILL_NAMES)[number]

/** A bundled skill as the provider serves it. */
export interface BundledSkill {
  readonly name: BundledSkillName
  readonly description: string
  /** SKILL.md body without its frontmatter. */
  readonly content: string
}

/**
 * Parse a bundled skill's SKILL.md.
 * @param text - file content.
 * @param name - the skill the file must declare.
 * @returns the name, description, and body.
 * @throws when the frontmatter is missing, its `name` differs, or the description or body is empty.
 */
export function parseBundledSkill(text: string, name: BundledSkillName): BundledSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) throw new Error(`${name} 的 SKILL.md 缺少 frontmatter`)
  const metadata: unknown = parseYaml(match[1] ?? '')
  const fields = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}
  if (fields.name !== name) throw new Error(`${name} 的 SKILL.md frontmatter name 必须是 ${name}`)
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  const content = text.slice(match[0].length).trim()
  if (description === '' || content === '') throw new Error(`${name} 的 SKILL.md 缺少 description 或正文`)
  return { name, description, content }
}

/**
 * Read and parse every bundled skill.
 * @param root - the package's `skills/` directory, ending in `/`.
 * @returns the skills in {@link BUNDLED_SKILL_NAMES} order.
 * @throws when a file cannot be read or is invalid.
 */
export function loadBundledSkills(root: URL): BundledSkill[] {
  return BUNDLED_SKILL_NAMES.map(name => parseBundledSkill(readFileSync(new URL(`${name}/SKILL.md`, root), 'utf8'), name))
}
