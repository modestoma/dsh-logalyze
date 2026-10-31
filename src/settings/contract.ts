/**
 * 设置面板与 Host 路由共用的路由常量和 JSON 结构。浏览器端 bundle 也会
 * 编译本文件，因此这里只放类型和常量，不 import 任何 Node 模块。
 *
 * @module dsh-logalyze/settings/contract
 */

/** GET：面板所需的全部状态（生效设置、默认值、仓库与应用）。 */
export const STATE_ROUTE = '/logalyze/state'
/** PUT：保存可编辑设置；DELETE：清除面板覆盖、恢复 cordis.yml 默认值。 */
export const SETTINGS_ROUTE = '/logalyze/settings'
/** POST：立即重新拉取全部仓库，或 body `{ url }` 指定的一个仓库。 */
export const SYNC_ROUTE = '/logalyze/sync'
/** PUT：body `{ tokenEnv, value }` 把分析接口令牌存入 DSH 凭据库；DELETE：body `{ tokenEnv }` 删除已存的值。只接受分析接口令牌的名称。 */
export const TOKEN_ROUTE = '/logalyze/token'

/**
 * POST：日志平台分析接口（Bearer 令牌鉴权，不走 DSH 登录）。它在 DSH 的
 * `/api` 命名空间之外，网关可以把它和需要登录的 DSH 接口分开暴露。
 */
export const ANALYZE_ROUTE = '/open-api/logalyze'

/** One configured application repository. */
export interface RepoSpec {
  /** Git remote address, mirrored by dsh-repo with the token of its host or the machine's existing git credentials. */
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

/** The log-platform analyze API ({@link ANALYZE_ROUTE}). */
export interface AnalyzeSettings {
  /** Whether the API accepts requests; switched off it answers 404. */
  enabled: boolean
}

/** The settings the Web panel can override; every field is required on the wire. */
export interface EditableSettings {
  /** Application repositories to mirror and keep updated. */
  repos: RepoSpec[]
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
export const EDITABLE_KEYS = ['repos', 'fetchIntervalMs', 'maxAppsPerRequest', 'dispatchTimeoutMs', 'download', 'skillUpdates', 'analyze'] as const satisfies readonly (keyof EditableSettings)[]

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
  /** Absolute directory of dsh-repo's fetch-only mirror, once a sync succeeded; children work in commit snapshots dsh-repo creates. */
  dir?: string
  phase: RepoPhase
  /** Latest synced commit, the one the catalog describes and new dispatches use. */
  commit?: string
  /** Committer date of {@link commit}, ISO 8601. */
  commitTime?: string
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
  /** Mirror directory; absent unless `ready`. */
  mirrorDir?: string
}

/**
 * Whether dsh-channels provides the `feishuTopics` service the analyze API
 * posts through: `missing` while it is not loaded, `incompatible` when its
 * contract version is not
 * the one this plugin speaks.
 */
export type TopicsAvailability = 'ready' | 'missing' | 'incompatible'

/** Analyze API view of the panel. */
export interface AnalyzeWire {
  /** Route the log platform posts to. */
  route: string
  /** Credential reference (`analyzeTokenRef`) holding the bearer token. */
  tokenEnv: string
  /** Token status; absent while the DSH composition has no credential store. */
  token?: TokenStatusWire
  topics: TopicsAvailability
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
