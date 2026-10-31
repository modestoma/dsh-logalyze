/**
 * `/logalyze-kit` 接入套件 SKILL：怎样为应用仓库编写应用描述和日志分析
 * SKILL。正文是包内的 `skills/logalyze-kit/SKILL.md`，插件加载时读取并校验，
 * 文件缺失或不合法时加载失败。起草子 Agent 用首行手势加载它，开发者也可以在
 * 自己的仓库里输入 `/logalyze-kit` 使用。
 *
 * @module dsh-logalyze/skill/kit
 */

import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'

/** Kit skill name, addressed as `/logalyze-kit`. */
export const KIT_SKILL_NAME = 'logalyze-kit'

/** The kit skill as the provider serves it. */
export interface KitSkill {
  readonly description: string
  /** SKILL.md body without its frontmatter. */
  readonly content: string
}

/**
 * Parse the kit's SKILL.md.
 * @param text - file content.
 * @returns the description and body.
 * @throws when the frontmatter is missing, its `name` is not `logalyze-kit`, or the description or body is empty.
 */
export function parseKitSkill(text: string): KitSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
  if (match === null) throw new Error(`${KIT_SKILL_NAME} 的 SKILL.md 缺少 frontmatter`)
  const metadata: unknown = parseYaml(match[1] ?? '')
  const fields = typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}
  if (fields.name !== KIT_SKILL_NAME) throw new Error(`${KIT_SKILL_NAME} 的 SKILL.md frontmatter name 必须是 ${KIT_SKILL_NAME}`)
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  const content = text.slice(match[0].length).trim()
  if (description === '' || content === '') throw new Error(`${KIT_SKILL_NAME} 的 SKILL.md 缺少 description 或正文`)
  return { description, content }
}

/**
 * Read and parse the kit's SKILL.md.
 * @param path - file path or URL inside the package.
 * @returns the kit skill.
 * @throws when the file cannot be read or is invalid.
 */
export function loadKitSkill(path: string | URL): KitSkill {
  return parseKitSkill(readFileSync(path, 'utf8'))
}
