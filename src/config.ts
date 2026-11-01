/**
 * 插件配置：cordis.yml 中的 `config`（经 Standard Schema 在加载时校验）与
 * Web 面板覆盖共用同一套字段校验。
 *
 * @module dsh-logalyze/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { TOKEN_ENV_PATTERN } from './settings/contract.ts'
import type { EditableSettings, RepoSpec } from './settings/contract.ts'

/** Largest delay Node's `setTimeout` honors (2^31 − 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

const URL_SCHEMES = new Set(['https:', 'file:'])
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/**
 * Whether a string is a repository address the `dshRepos` service mirrors: an
 * `https` or `file` URL, or an absolute local path. SSH, scp-like
 * `user@host:path`, `git://`, and other transports are refused.
 * @param value - candidate repository address.
 * @returns whether it is accepted.
 */
export function isAcceptedGitUrl(value: string): boolean {
  if (value.startsWith('-') || /\s/.test(value)) return false
  if (isAbsolute(value)) return true
  try {
    return URL_SCHEMES.has(new URL(value).protocol)
  } catch {
    // Not a URL and not scp-like: refused.
    return false
  }
}

/**
 * Whether a branch name is safe to pass as a git ref argument.
 * @param value - candidate branch name.
 * @returns whether it is accepted.
 */
export function isAcceptedBranch(value: string): boolean {
  return value !== ''
    && !value.startsWith('-')
    && !value.includes('..')
    && !/[\s~^:?*[\\]/.test(value)
    && !value.endsWith('/')
    && !value.endsWith('.lock')
}

/** One application repository: git address and optional branch. */
export const repoSchema = z.object({
  url: z.string().trim().min(1, 'git 地址不能为空').refine(isAcceptedGitUrl, '不支持的 git 地址（支持 https URL、file URL 或本机绝对路径，不支持 ssh 和 user@host:path）'),
  branch: z.string().trim().optional().transform(value => value === '' ? undefined : value)
    .refine(value => value === undefined || isAcceptedBranch(value), '分支名不合法'),
}).strict()

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

const analyzeSchema = z.object({
  enabled: z.boolean().default(false),
}).strict()

const authorSchema = z.object({
  name: z.string().trim().min(1, '提交作者名不能为空').refine(value => !/[<>\n]/.test(value), '提交作者名不能包含 < > 或换行'),
  email: z.string().trim().min(1, '提交作者邮箱不能为空').refine(value => !/[<>\s]/.test(value), '提交作者邮箱不能包含 < > 或空白'),
}).strict()

/** Field validators shared by the cordis config and the panel overlay. */
export const editableFields = {
  repos: z.array(repoSchema).superRefine((repos, issues) => {
    const seen = new Set<string>()
    for (const [index, repo] of repos.entries()) {
      if (seen.has(repo.url)) issues.addIssue({ code: 'custom', path: [index, 'url'], message: `重复的 git 地址：${repo.url}` })
      seen.add(repo.url)
    }
  }),
  fetchIntervalMs: durationMs(0),
  maxAppsPerRequest: z.number().int().min(1).max(32),
  dispatchTimeoutMs: durationMs(1000),
  download: downloadSchema,
  skillUpdates: skillUpdatesSchema,
  analyze: analyzeSchema,
}

const configSchema = z.object({
  repos: editableFields.repos.default([]),
  fetchIntervalMs: editableFields.fetchIntervalMs.default(0),
  maxAppsPerRequest: editableFields.maxAppsPerRequest.default(4),
  dispatchTimeoutMs: editableFields.dispatchTimeoutMs.default(30 * 60 * 1000),
  download: downloadSchema.prefault({}),
  skillUpdates: skillUpdatesSchema.prefault({}),
  analyze: analyzeSchema.prefault({}),
  /**
   * Credential reference (environment-variable name) whose value is the
   * analyze API's bearer token.
   */
  analyzeTokenRef: z.string().trim().regex(TOKEN_ENV_PATTERN, '令牌名称只能包含字母、数字和下划线，且不能以数字开头').default('LOGALYZE_ANALYZE_TOKEN'),
  /**
   * Author and committer of SKILL improvement and onboarding commits;
   * default: the account that owns the host token.
   */
  skillUpdateAuthor: authorSchema.optional(),
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

/** Panel overlay: any subset of the editable settings. */
export const overlaySchema = z.object({
  repos: editableFields.repos.optional(),
  fetchIntervalMs: editableFields.fetchIntervalMs.optional(),
  maxAppsPerRequest: editableFields.maxAppsPerRequest.optional(),
  dispatchTimeoutMs: editableFields.dispatchTimeoutMs.optional(),
  download: downloadSchema.optional(),
  skillUpdates: skillUpdatesSchema.optional(),
  analyze: analyzeSchema.optional(),
}).strict()

/** Validated panel overlay. */
export type SettingsOverlay = z.output<typeof overlaySchema>

/** A complete editable settings payload, as the panel saves it. */
export const editableSettingsSchema = z.object(editableFields).strict()

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
 * Expand `~` and make a configured directory absolute.
 * @param path - configured directory.
 * @returns absolute directory.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return resolve(path)
}

function copyRepos(repos: readonly RepoSpec[]): RepoSpec[] {
  return repos.map(repo => repo.branch === undefined ? { url: repo.url } : { url: repo.url, branch: repo.branch })
}

/**
 * The editable settings a configuration implies.
 * @param config - validated plugin configuration.
 * @returns complete editable settings.
 */
export function defaultsOf(config: LogalyzeConfig): EditableSettings {
  return {
    repos: copyRepos(config.repos),
    fetchIntervalMs: config.fetchIntervalMs,
    maxAppsPerRequest: config.maxAppsPerRequest,
    dispatchTimeoutMs: config.dispatchTimeoutMs,
    download: { ...config.download, allowedHosts: [...config.download.allowedHosts] },
    skillUpdates: { ...config.skillUpdates },
    analyze: { ...config.analyze },
  }
}

/**
 * Apply a panel overlay over the defaults. Each overridden key replaces the
 * default wholesale.
 * @param defaults - settings from the configuration.
 * @param overlay - validated overlay.
 * @returns effective settings.
 */
export function applyOverlay(defaults: EditableSettings, overlay: SettingsOverlay): EditableSettings {
  return {
    repos: overlay.repos === undefined ? defaults.repos : copyRepos(overlay.repos),
    fetchIntervalMs: overlay.fetchIntervalMs ?? defaults.fetchIntervalMs,
    maxAppsPerRequest: overlay.maxAppsPerRequest ?? defaults.maxAppsPerRequest,
    dispatchTimeoutMs: overlay.dispatchTimeoutMs ?? defaults.dispatchTimeoutMs,
    download: overlay.download ?? defaults.download,
    skillUpdates: overlay.skillUpdates ?? defaults.skillUpdates,
    analyze: overlay.analyze ?? defaults.analyze,
  }
}
