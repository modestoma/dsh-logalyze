/**
 * 插件配置：cordis.yml 中的 `config`（经 Standard Schema 在加载时校验）与
 * Web 面板覆盖共用同一套字段校验。
 *
 * @module dsh-logalyze/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { CHAT_ID_PATTERN, TOKEN_ENV_PATTERN } from './settings/contract.ts'
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

const MIB = 1024 * 1024

const optionalUrl = (label: string) => z.string().trim()
  .transform(value => (value === '' ? undefined : value))
  .pipe(z.url({ protocol: /^https?$/u, error: `${label}必须是 http(s) 地址` }).max(2048).optional())
  .optional()

const platformSchema = z.object({
  baseUrl: optionalUrl('日志平台接口地址'),
  tokenUrl: optionalUrl('日志平台令牌地址'),
  clientId: z.string().trim().max(512).transform(value => (value === '' ? undefined : value)).optional(),
  clientAuth: z.enum(['body', 'basic']).default('body'),
  scope: z.string().trim().max(1024).default('log:search log:download log:upload'),
  timeoutMs: durationMs(1000).default(30 * 1000),
}).strict()

const uploadSchema = z.object({
  timeoutMs: durationMs(1000).default(5 * 60 * 1000),
  retries: z.number().int().min(0).max(20).default(3),
  retryDelayMs: durationMs(1000).default(60 * 1000),
  maxFiles: z.number().int().min(1).max(10_000).default(50),
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(100 * MIB),
  maxFileBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(50 * MIB),
  maxMarkdownBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(20 * MIB),
  concurrency: z.number().int().min(1).max(16).default(4),
}).strict()

/** Largest `analyze.maxLogs`: the platform's limit of ids per metadata query. */
export const MAX_LOGS_LIMIT = 100

const analyzeSchema = z.object({
  enabled: z.boolean().default(false),
  defaultChatId: z.string().trim().regex(CHAT_ID_PATTERN, '默认群必须是飞书群的 chat_id（oc_ 开头）').optional(),
  maxLogs: z.number().int().min(1).max(MAX_LOGS_LIMIT).default(10),
  platform: platformSchema.prefault({}),
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
  /**
   * Credential reference (environment-variable name) whose value is the log
   * platform's OAuth2 client secret.
   */
  platformSecretRef: z.string().trim().regex(TOKEN_ENV_PATTERN, '凭据名称只能包含字母、数字和下划线，且不能以数字开头').default('LOGALYZE_PLATFORM_CLIENT_SECRET'),
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
}).strict().refine(config => config.platformSecretRef !== config.analyzeTokenRef, { path: ['platformSecretRef'], message: '日志平台 client_secret 与分析接口令牌不能用同一个凭据名称' })

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
