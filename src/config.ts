/**
 * 插件配置：cordis.yml 中的 `config`（经 Standard Schema 在加载时校验）与
 * Web 面板覆盖共用同一套字段校验。
 *
 * @module dsh-logalyze/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CHAT_ID_PATTERN, TOKEN_ENV_PATTERN, UPLOAD_PLACEHOLDERS } from './settings/contract.ts'
import type { EditableKey, EditableSettings } from './settings/contract.ts'

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

const hostSchema = z.string().trim().toLowerCase()
  .transform(value => value.replace(/^\*\./, ''))
  .refine(value => HOST_NAME.test(value), '域名不合法：只填主机名，例如 oss.example.com')

const durationMs = (min: number) => z.number().int().min(min).max(MAX_TIMER_DELAY_MS)

const downloadSchema = z.object({
  allowedHosts: z.array(hostSchema).default([]),
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(512 * 1024 * 1024),
  timeoutMs: durationMs(1000).default(10 * 60 * 1000),
}).strict()

const skillUpdatesSchema = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(256).default(16),
  maxFileBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(256 * 1024),
}).strict()

/** Default upload command: the log platform's CLI. */
export const DEFAULT_UPLOAD_COMMAND: readonly string[] = ['cli', 'log-analysis', 'upload', '--log-id', '{logId}', '--dir', '{dir}', '--entry', '{entry}']

const PLACEHOLDER = /\{[^{}]*\}/g

const uploadCommandSchema = z.array(z.string().min(1, '回传命令的参数不能为空').max(4096))
  .min(1, '回传命令不能为空').max(64, '回传命令最多 64 个参数')
  .superRefine((argv, issues) => {
    for (const [index, arg] of argv.entries()) {
      for (const token of arg.match(PLACEHOLDER) ?? []) {
        if (!(UPLOAD_PLACEHOLDERS as readonly string[]).includes(token)) issues.addIssue({ code: 'custom', path: [index], message: `未知占位符 ${token}（可用 ${UPLOAD_PLACEHOLDERS.join(' ')}）` })
      }
    }
    if ((argv[0] ?? '').match(PLACEHOLDER) !== null) issues.addIssue({ code: 'custom', path: [0], message: '可执行文件不能包含占位符' })
    for (const required of ['{logId}', '{dir}']) {
      if (!argv.some(arg => arg.includes(required))) issues.addIssue({ code: 'custom', message: `回传命令必须包含 ${required}` })
    }
  })

const uploadSchema = z.object({
  command: uploadCommandSchema.default([...DEFAULT_UPLOAD_COMMAND]),
  timeoutMs: durationMs(1000).default(5 * 60 * 1000),
  retries: z.number().int().min(0).max(20).default(3),
  retryDelayMs: durationMs(1000).default(60 * 1000),
  maxFiles: z.number().int().min(1).max(10_000).default(200),
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(200 * 1024 * 1024),
}).strict()

const analyzeSchema = z.object({
  enabled: z.boolean().default(false),
  defaultChatId: z.string().trim().regex(CHAT_ID_PATTERN, '默认群必须是飞书群的 chat_id（oc_ 开头）').optional(),
  upload: uploadSchema.prefault({}),
}).strict()

/**
 * The former `repos` key: application repositories are now the dsh-repo
 * catalog repositories with the log analysis feature turned on, so any value
 * fails with that instruction.
 */
const retiredRepos = z.never({ error: '应用仓库已改在 dsh-repo 中配置：删除 repos，在「代码仓库 → 仓库」中添加这些仓库并打开「日志分析」功能' }).optional()

/**
 * Field validators shared by the cordis config, the panel overlay, and the
 * panel's save payload, with the defaults cordis.yml falls back to.
 */
export const editableFields = {
  fetchIntervalMs: durationMs(0).default(0),
  maxAppsPerRequest: z.number().int().min(1).max(32).default(4),
  dispatchTimeoutMs: durationMs(1000).default(30 * 60 * 1000),
  download: downloadSchema.prefault({}),
  skillUpdates: skillUpdatesSchema.prefault({}),
  analyze: analyzeSchema.prefault({}),
}

/** A complete editable settings payload, as the panel saves it. */
export const editableSettingsSchema = z.object(editableFields).strict()

/** Compile-time check that the panel wire type and the validators name the same fields. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const editableSettingsMatch: Same<z.output<typeof editableSettingsSchema>, EditableSettings> = true
void editableSettingsMatch

const configSchema = z.object({
  repos: retiredRepos,
  ...editableFields,
  /**
   * Credential reference (environment-variable name) whose value is the
   * analyze API's bearer token.
   */
  analyzeTokenRef: z.string().trim().regex(TOKEN_ENV_PATTERN, '令牌名称只能包含字母、数字和下划线，且不能以数字开头').default('LOGALYZE_ANALYZE_TOKEN'),
  /** Registered `ctx.subagents` provider the children start on. */
  subagentProvider: z.string().trim().min(1).default('spawn'),
  /**
   * How long loading `/logalyze` waits for the repository refresh before it
   * renders the catalog it already has, in milliseconds; the refresh keeps
   * running. 0 never waits.
   */
  refreshWaitMs: durationMs(0).default(15 * 1000),
  /**
   * Whether top-level agents may load the entry skill without `/logalyze`
   * when a task matches the usable applications its description lists.
   */
  autoInvoke: z.boolean().default(true),
}).strict()

/** Validated plugin configuration. */
export type LogalyzeConfig = z.output<typeof configSchema>

/** Standard Schema the Cordis loader validates `config` with before `apply()`. */
export const pluginConfigSchema = configSchema.prefault({})

/** Panel overlay: any subset of the editable settings; a stored key replaces its default wholesale. */
export const overlaySchema = z.object({
  repos: retiredRepos,
  fetchIntervalMs: editableFields.fetchIntervalMs.unwrap().optional(),
  maxAppsPerRequest: editableFields.maxAppsPerRequest.unwrap().optional(),
  dispatchTimeoutMs: editableFields.dispatchTimeoutMs.unwrap().optional(),
  download: downloadSchema.optional(),
  skillUpdates: skillUpdatesSchema.optional(),
  analyze: analyzeSchema.optional(),
}).strict()

/** Validated panel overlay. */
export type SettingsOverlay = z.output<typeof overlaySchema>

const overlayKeysMatch: Same<keyof SettingsOverlay, EditableKey | 'repos'> = true
void overlayKeysMatch

/**
 * Format the first validation issue as one panel/log line.
 * @param error - zod failure.
 * @returns `path: message`.
 */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (issue === undefined) return '配置不合法'
  const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
  return `${where}${issue.message}`
}

/**
 * Validate the raw loader config. The loader has already validated it when the
 * plugin runs under DSH; direct callers (tests, embedding hosts) pass raw input.
 * @param raw - the `config` object, possibly undefined.
 * @returns validated configuration.
 * @throws when the configuration is invalid.
 */
export function resolveConfig(raw: unknown): LogalyzeConfig {
  const parsed = pluginConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new Error(`logalyze: 配置不合法：${describeIssue(parsed.error)}`)
  return parsed.data
}

/**
 * `$DSH_HOME`, defaulting to `~/.dsh`.
 * @param env - process environment.
 * @returns the DSH home directory.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * The editable settings a configuration implies.
 * @param config - validated plugin configuration.
 * @returns complete editable settings, sharing nothing with `config`.
 */
export function defaultsOf(config: LogalyzeConfig): EditableSettings {
  // Parsing without `strict` drops the other configuration keys and copies every value.
  return z.object(editableFields).parse(config)
}

/**
 * Apply a panel overlay over the defaults. Each overridden key replaces the
 * default wholesale.
 * @param defaults - settings from the configuration.
 * @param overlay - validated overlay.
 * @returns effective settings.
 */
export function applyOverlay(defaults: EditableSettings, overlay: SettingsOverlay): EditableSettings {
  const { repos: _retired, ...overrides } = overlay
  return { ...defaults, ...overrides }
}
