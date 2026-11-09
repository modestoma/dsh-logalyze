/**
 * 设置面板与 Host 路由共用的路由常量和 JSON 结构。浏览器端 bundle 也会
 * 编译本文件，因此这里只放类型和常量，不 import 任何 Node 模块。
 *
 * @module dsh-logalyze/settings/contract
 */

/** GET：面板所需的全部状态（生效设置、默认值、仓库与应用）。 */
export const STATE_ROUTE = '/logalyze/state'
/** PUT：保存可编辑设置；DELETE：清除面板覆盖、恢复 cordis.yml 默认值。应用仓库不在这里编辑，来自 dsh-repo 的仓库清单。 */
export const SETTINGS_ROUTE = '/logalyze/settings'
/** POST：立即重新拉取全部仓库，或 body `{ url }` 指定的一个仓库。 */
export const SYNC_ROUTE = '/logalyze/sync'
/** POST：body `{ id }` 立即重新上传一份分析报告，不论上次是否成功。 */
export const REPORT_UPLOAD_ROUTE = '/logalyze/reports/upload'
/** PUT：body `{ tokenEnv, value }` 把分析接口令牌存入 DSH 凭据库；DELETE：body `{ tokenEnv }` 删除已存的值。只接受分析接口令牌的名称。 */
export const TOKEN_ROUTE = '/logalyze/token'

/**
 * POST：日志平台分析接口（Bearer 令牌鉴权，不走 DSH 登录）。它在 DSH 的
 * `/api` 命名空间之外，网关可以把它和需要登录的 DSH 接口分开暴露。
 */
export const ANALYZE_ROUTE = '/open-api/logalyze'

/** One application repository: a dsh-repo catalog repository with the log analysis feature turned on. */
export interface RepoSpec {
  /** Git remote address as the catalog stores it, mirrored by dsh-repo. */
  url: string
  /** Remote branch to follow; omitted follows the remote's default branch. */
  branch?: string
}

/** Credential reference grammar of `@deepseek-ai/dsh-credentials` (a POSIX shell identifier). */
export const TOKEN_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Log URL download policy. */
export interface DownloadSettings {
  /** Allowed host names; `example.com` also admits its subdomains. Empty disables URL downloads. */
  allowedHosts: string[]
  /** Per-file byte ceiling. */
  maxBytes: number
  /** Per-file download timeout in milliseconds. */
  timeoutMs: number
}

/** Application SKILL improvement: children record SKILL gaps, and after the user agrees an improvement child drafts a case and SKILL changes that are submitted as a merge request. */
export interface SkillUpdateSettings {
  /** Whether children are told to record SKILL gaps and top-level agents are offered `logalyze_improve_skill`. */
  enabled: boolean
  /** Most files one improvement may add or change. */
  maxFiles: number
  /** Largest file of an improvement or gap record, in bytes. */
  maxFileBytes: number
}

/** Report directory below the topic's working directory, uploaded as a whole. */
export const REPORT_DIR = 'report'

/** Report entry file inside {@link REPORT_DIR}; written only by this plugin. */
export const REPORT_ENTRY = 'report.md'

/** Placeholders the upload command's arguments may contain. */
export const UPLOAD_PLACEHOLDERS = ['{logId}', '{dir}', '{entry}'] as const

/** How reports of requests with `logId` are uploaded to the caller. */
export interface UploadSettings {
  /**
   * Upload command as an argument vector, run without a shell after every
   * turn of the analysis topic. `{logId}` is the request's `logId`, `{dir}`
   * the absolute report directory, `{entry}` the entry file name relative to it.
   */
  command: string[]
  /** Per-run timeout in milliseconds; a run still going then is killed and counts as failed. */
  timeoutMs: number
  /** Further attempts after a failed run. */
  retries: number
  /** Wait before the first retry in milliseconds; it doubles for each further retry. */
  retryDelayMs: number
  /** Most files the report directory may hold. */
  maxFiles: number
  /** Largest total size of the report directory, in bytes. */
  maxBytes: number
}

/** The log-platform analyze API ({@link ANALYZE_ROUTE}). */
export interface AnalyzeSettings {
  /** Whether the API accepts requests; switched off it answers 404. */
  enabled: boolean
  /** Report upload. */
  upload: UploadSettings
}

/** The settings the Web panel can override; every field is required on the wire. */
export interface EditableSettings {
  /** Minimum age of a repository's last sync before loading `/logalyze` syncs it again, in milliseconds; 0 syncs on every load. */
  fetchIntervalMs: number
  /** Maximum number of child analyses one dispatch may start. */
  maxAppsPerRequest: number
  /** Whole-dispatch wait budget in milliseconds; children still running then are stopped. */
  dispatchTimeoutMs: number
  /** URL download policy. */
  download: DownloadSettings
  /** SKILL improvement. */
  skillUpdates: SkillUpdateSettings
  /** Log-platform analyze API. */
  analyze: AnalyzeSettings
}

/** Keys of {@link EditableSettings}, in panel order. */
export const EDITABLE_KEYS = ['fetchIntervalMs', 'maxAppsPerRequest', 'dispatchTimeoutMs', 'download', 'skillUpdates', 'analyze'] as const satisfies readonly (keyof EditableSettings)[]

/** One editable key. */
export type EditableKey = (typeof EDITABLE_KEYS)[number]

/** Application description read from `<repo>/.agents/logalyze.yaml`. */
export interface AppManifest {
  /** Registry id the dispatch tool and analysis requests address. */
  id: string
  /** Display name, also the child agent's label. */
  name: string
  /** What the application does, used for intent recognition. */
  description: string
  /** Other names users call the application by. */
  aliases: string[]
  /** Strings that identify this application's log lines (tags, process names, class names). */
  logHints: string[]
  /** Project skill name under `.agents/skills/<skill>/SKILL.md` that analyzes this application's logs. */
  skill: string
}

/** Lifecycle of one repository checkout. */
export type RepoPhase = 'pending' | 'syncing' | 'ready' | 'failed'

/** One repository as the panel shows it. */
export interface RepoStatusWire {
  url: string
  branch?: string
  phase: RepoPhase
  /** Latest synced commit, the one the catalog describes and new dispatches use; children work in snapshots of it that dsh-repo creates. */
  commit?: string
  /** Last completed sync attempt, epoch milliseconds. */
  syncedAt?: number
  /** Application description read from {@link commit}. */
  app?: AppManifest
  /** Why the repository is unusable (`failed`), or why the last update failed while an older commit stays usable (`ready`). */
  error?: string
  /** Whether the application is offered to intent recognition and dispatch. */
  available: boolean
  /** Child analyses currently running in snapshots of this repository. */
  activeRuns: number
}

/** Whether one referenced token has a value — never the value. */
export interface TokenStatusWire {
  tokenEnv: string
  /** Whether resolving the reference currently returns a value. */
  configured: boolean
  /** Credential store layer supplying the value (`file`, `env`, `project-env`, `user-env`); absent while unconfigured. */
  source?: string
  /** Whether the panel can store a value for this reference. */
  writable: boolean
  /** Why the credential store could not describe the reference. */
  error?: string
}

/**
 * Whether dsh-repo provides the `dshRepos` service this plugin mirrors
 * repositories and submits SKILL improvements and setup drafts through: `missing` while it is not
 * loaded, `incompatible` when its contract version is not the one this
 * plugin speaks.
 */
export type ReposAvailability = 'ready' | 'missing' | 'incompatible'

/** dsh-repo view of the panel. */
export interface ReposWire {
  availability: ReposAvailability
  /** Mirror directory; absent unless `ready`, and absent while the provider has none chosen (repositories cannot be fetched until it is set in the provider's settings). */
  mirrorDir?: string
  /** The provider's reason for not using its stored mirror directory; absent otherwise. */
  mirrorProblem?: string
}

/**
 * Whether the Feishu channel plugin provides the `feishuTopics` service the analyze API
 * posts through: `missing` while it is not loaded, `incompatible` when its
 * contract version is not
 * the one this plugin speaks.
 */
export type TopicsAvailability = 'ready' | 'missing' | 'incompatible'

/** How the first turn of an analysis ended, or how the analysis failed to start. */
export type ReportStatus = 'done' | 'stopped' | 'error' | 'failed' | 'interrupted'

/** Upload progress of one report. */
export type UploadPhase = 'pending' | 'running' | 'waiting' | 'done' | 'failed'

/** One tracked report as the panel shows it. */
export interface ReportWire {
  /** Stable id of the report (derived from the request's `Idempotency-Key`). */
  id: string
  logId: string
  app: string
  errorCode: string
  triggeredAt: string
  /** Epoch ms when the request was accepted. */
  acceptedAt: number
  /** First-turn outcome; absent while the first turn is running. */
  status?: ReportStatus
  /** Follow-up turns recorded after the first one. */
  followups: number
  /** Absolute report directory; absent until the topic's working directory is known. */
  dir?: string
  phase: UploadPhase
  /** Epoch ms of the last finished upload attempt. */
  lastAttemptAt?: number
  /** Epoch ms of the last successful upload. */
  uploadedAt?: number
  /** Why the last attempt failed. */
  error?: string
  /** Links in the recorded replies the caller cannot open. */
  warnings: string[]
}

/** Analyze API view of the panel. */
export interface AnalyzeWire {
  /** Route the log platform posts to. */
  route: string
  /** Credential reference (`analyzeTokenRef`) holding the bearer token. */
  tokenEnv: string
  /** Token status; absent while the DSH composition has no credential store. */
  token?: TokenStatusWire
  topics: TopicsAvailability
  /** Most recently accepted reports, newest first. */
  reports: ReportWire[]
}

/** `GET /logalyze/state` response. */
export interface StateWire {
  /** Effective settings: cordis.yml values with panel overrides applied. */
  settings: EditableSettings
  /** cordis.yml values before panel overrides. */
  defaults: EditableSettings
  /** Keys the panel currently overrides. */
  overridden: EditableKey[]
  /** Why the overlay file was ignored (unreadable or invalid); panel saves replace it. */
  overlayError?: string
  repos: RepoStatusWire[]
  dshRepo: ReposWire
  /** Whether the DSH composition provides `ctx.credentials`; without it the analyze token cannot be stored or read. */
  credentialsAvailable: boolean
  analyze: AnalyzeWire
}

/** Successful mutation response. */
export interface MutationOk {
  ok: true
  state: StateWire
}

/** Failed request response. */
export interface MutationError {
  ok: false
  error: string
}
