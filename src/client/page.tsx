/**
 * 左侧栏「观象」主区页面：应用仓库、日志下载、分析接口、高级（含 SKILL 改进）四个
 * 分页，后三个共用一份草稿和底部保存条。应用仓库分页只读：仓库在 dsh-repo 的
 * 仓库清单中添加并打开「日志分析」功能，镜像的拉取和拉取状态都在 dsh-repo；
 * 分页显示各仓库的应用状态并提供跳转。读取应用描述期间每 2 秒刷新状态；打开「分析接口」分页时每 5 秒刷新回传记录。
 *
 * @module dsh-logalyze/client/page
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AnalysisWire, AnalyzeWire, EditableKey, EditableSettings, LegacyReportWire, PlatformClientAuth, ReportStatus, RepoStatusWire, StateWire, TokenStatusWire, UploadPhase } from '../settings/contract.ts'
import { clearToken, fetchState, messageOf, resetSettings, retryReport, saveSettings, saveToken } from './api.ts'
import { CHAT_ID_PATTERN } from '../settings/contract.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '观象'

const KB = 1024
const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'repos' | 'download' | 'analyze' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'repos', label: '应用仓库' },
  { id: 'download', label: '日志下载' },
  { id: 'analyze', label: '分析接口' },
  { id: 'advanced', label: '高级' },
]

/** Editable text form of the settings. */
interface Draft {
  fetchIntervalMin: string
  maxAppsPerRequest: string
  dispatchTimeoutMin: string
  allowedHosts: string[]
  maxMb: string
  timeoutSec: string
  skillUpdatesEnabled: boolean
  skillMaxFiles: string
  skillMaxKb: string
  analyzeEnabled: boolean
  /** Default group chat id; blank means none. */
  analyzeDefaultChatId: string
  maxLogs: string
  platformBaseUrl: string
  platformTokenUrl: string
  platformClientId: string
  platformClientAuth: PlatformClientAuth
  platformScope: string
  platformTimeoutSec: string
  uploadTimeoutSec: string
  uploadRetries: string
  uploadRetryDelaySec: string
  uploadMaxFiles: string
  uploadMaxMb: string
  uploadMaxFileMb: string
  uploadMaxMarkdownMb: string
  uploadConcurrency: string
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100)
}

function toDraft(settings: EditableSettings): Draft {
  return {
    fetchIntervalMin: trimNumber(settings.fetchIntervalMs / MINUTE),
    maxAppsPerRequest: String(settings.maxAppsPerRequest),
    dispatchTimeoutMin: trimNumber(settings.dispatchTimeoutMs / MINUTE),
    allowedHosts: [...settings.download.allowedHosts],
    maxMb: trimNumber(settings.download.maxBytes / MB),
    timeoutSec: trimNumber(settings.download.timeoutMs / 1000),
    skillUpdatesEnabled: settings.skillUpdates.enabled,
    skillMaxFiles: String(settings.skillUpdates.maxFiles),
    skillMaxKb: trimNumber(settings.skillUpdates.maxFileBytes / KB),
    analyzeEnabled: settings.analyze.enabled,
    analyzeDefaultChatId: settings.analyze.defaultChatId ?? '',
    maxLogs: String(settings.analyze.maxLogs),
    platformBaseUrl: settings.analyze.platform.baseUrl ?? '',
    platformTokenUrl: settings.analyze.platform.tokenUrl ?? '',
    platformClientId: settings.analyze.platform.clientId ?? '',
    platformClientAuth: settings.analyze.platform.clientAuth,
    platformScope: settings.analyze.platform.scope,
    platformTimeoutSec: trimNumber(settings.analyze.platform.timeoutMs / 1000),
    uploadTimeoutSec: trimNumber(settings.analyze.upload.timeoutMs / 1000),
    uploadRetries: String(settings.analyze.upload.retries),
    uploadRetryDelaySec: trimNumber(settings.analyze.upload.retryDelayMs / 1000),
    uploadMaxFiles: String(settings.analyze.upload.maxFiles),
    uploadMaxMb: trimNumber(settings.analyze.upload.maxBytes / MB),
    uploadMaxFileMb: trimNumber(settings.analyze.upload.maxFileBytes / MB),
    uploadMaxMarkdownMb: trimNumber(settings.analyze.upload.maxMarkdownBytes / MB),
    uploadConcurrency: String(settings.analyze.upload.concurrency),
  }
}

function integer(text: string, label: string, allowZero = false): number {
  const value = positive(text, label, allowZero)
  if (!Number.isInteger(value)) throw new Error(`${label}必须是整数`)
  return value
}

function positive(text: string, label: string, allowZero = false): number {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) throw new Error(`${label}必须是${allowZero ? '非负' : '正'}数`)
  return value
}

/** A trimmed optional text field, omitted when blank. */
function optionalText<K extends string>(text: string, key: K): Partial<Record<K, string>> {
  const trimmed = text.trim()
  return (trimmed === '' ? {} : { [key]: trimmed }) as Partial<Record<K, string>>
}

function fromDraft(draft: Draft): EditableSettings {
  const maxApps = positive(draft.maxAppsPerRequest, '单次应用数上限')
  if (!Number.isInteger(maxApps)) throw new Error('单次应用数上限必须是整数')
  const maxFiles = positive(draft.skillMaxFiles, '改进文件数上限')
  if (!Number.isInteger(maxFiles)) throw new Error('改进文件数上限必须是整数')
  const defaultChatId = draft.analyzeDefaultChatId.trim()
  if (defaultChatId !== '' && !CHAT_ID_PATTERN.test(defaultChatId)) throw new Error('默认群必须是飞书群的 chat_id（oc_ 开头）')
  return {
    fetchIntervalMs: Math.round(positive(draft.fetchIntervalMin, '更新间隔', true) * MINUTE),
    maxAppsPerRequest: maxApps,
    dispatchTimeoutMs: Math.round(positive(draft.dispatchTimeoutMin, '派发超时') * MINUTE),
    download: {
      allowedHosts: draft.allowedHosts.map(host => host.trim()).filter(host => host !== ''),
      maxBytes: Math.round(positive(draft.maxMb, '单文件大小上限') * MB),
      timeoutMs: Math.round(positive(draft.timeoutSec, '下载超时') * 1000),
    },
    skillUpdates: {
      enabled: draft.skillUpdatesEnabled,
      maxFiles,
      maxFileBytes: Math.round(positive(draft.skillMaxKb, '改进单文件大小上限') * KB),
    },
    analyze: {
      enabled: draft.analyzeEnabled,
      ...defaultChatId === '' ? {} : { defaultChatId },
      maxLogs: integer(draft.maxLogs, '单次日志数上限'),
      platform: {
        ...optionalText(draft.platformBaseUrl, 'baseUrl'),
        ...optionalText(draft.platformTokenUrl, 'tokenUrl'),
        ...optionalText(draft.platformClientId, 'clientId'),
        clientAuth: draft.platformClientAuth,
        scope: draft.platformScope.trim(),
        timeoutMs: Math.round(positive(draft.platformTimeoutSec, '平台接口超时') * 1000),
      },
      upload: {
        timeoutMs: Math.round(positive(draft.uploadTimeoutSec, '单个文件上传超时') * 1000),
        retries: integer(draft.uploadRetries, '重试次数', true),
        retryDelayMs: Math.round(positive(draft.uploadRetryDelaySec, '重试间隔') * 1000),
        maxFiles: integer(draft.uploadMaxFiles, '报告文件数上限'),
        maxBytes: Math.round(positive(draft.uploadMaxMb, '报告总大小上限') * MB),
        maxFileBytes: Math.round(positive(draft.uploadMaxFileMb, '单文件大小上限') * MB),
        maxMarkdownBytes: Math.round(positive(draft.uploadMaxMarkdownMb, 'Markdown 文件大小上限') * MB),
        concurrency: integer(draft.uploadConcurrency, '同时上传文件数'),
      },
    },
  }
}

function sameSettings(draft: Draft, settings: EditableSettings): boolean {
  try {
    return JSON.stringify(fromDraft(draft)) === JSON.stringify(settings)
  } catch {
    // An unparsable draft differs from any saved settings.
    return false
  }
}

function formatTime(iso: string | number | undefined): string {
  if (iso === undefined) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString()
}

function appPill(repo: RepoStatusWire): JSX.Element {
  if (repo.phase === 'syncing') return <span className="lz__pill lz__pill--warn"><span className="lz__dot" />读取中</span>
  if (repo.available) return <span className="lz__pill lz__pill--ok"><span className="lz__dot" />已配置</span>
  if (repo.commit !== undefined && repo.app === undefined) return <span className="lz__pill lz__pill--warn" title={repo.writable ? '在对话中让观象起草接入（logalyze_init_repo）' : undefined}><span className="lz__dot" />{repo.writable ? '缺应用描述，可初始化' : '缺应用描述'}</span>
  if (repo.phase === 'failed' || repo.phase === 'ready') return <span className="lz__pill lz__pill--bad"><span className="lz__dot" />不可用</span>
  return <span className="lz__pill"><span className="lz__dot" />等待读取</span>
}

function Overridden({ keys, name }: { keys: readonly EditableKey[]; name: EditableKey }): JSX.Element | null {
  return keys.includes(name) ? <span className="lz__tag lz__tag--accent">面板设置</span> : null
}

/** Page props supplied by the client entry. */
export interface LogalyzePageProps {
  /** Opens dsh-repo's page on the Plugins panel; absent hides the link. */
  readonly openRepoSettings?: (() => void) | undefined
}

/**
 * Main-column page for the `main` slot.
 * @param props - navigation supplied by the client entry.
 * @returns the page.
 */
export function LogalyzePage({ openRepoSettings }: LogalyzePageProps): JSX.Element {
  return (
    <section className="lz-page" aria-label={PANEL_TITLE}>
      <div className="lz-page__content">
        <LogalyzePanel openRepoSettings={openRepoSettings} />
      </div>
    </section>
  )
}

/**
 * The `main` slot component, bound to a way of opening dsh-repo's settings.
 * @param openRepoSettings - opens dsh-repo's page on the Plugins panel, or undefined while that panel is unavailable.
 * @returns component rendering {@link LogalyzePage}.
 */
export function boundLogalyzePage(openRepoSettings: () => (() => void) | undefined): () => JSX.Element {
  return () => <LogalyzePage openRepoSettings={openRepoSettings()} />
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

/**
 * Panel body: loads state, edits a draft, saves.
 * @param props - navigation supplied by the client entry.
 * @returns the panel.
 */
export function LogalyzePanel({ openRepoSettings }: LogalyzePageProps): JSX.Element {
  const [state, setState] = useState<StateWire | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft | undefined>()
  const [tab, setTab] = useState<TabId>('repos')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()

  const adopt = useCallback((next: StateWire, resetDraft: boolean) => {
    setState(next)
    if (resetDraft) setDraft(toDraft(next.settings))
  }, [])

  const reload = useCallback(async (resetDraft: boolean) => {
    try {
      adopt(await fetchState(), resetDraft)
      setLoadError(undefined)
    } catch (error) {
      setLoadError(messageOf(error))
    }
  }, [adopt])

  useEffect(() => { void reload(true) }, [reload])

  const syncing = state?.repos.some(repo => repo.phase === 'syncing') === true
  useEffect(() => {
    if (!syncing) return
    const timer = setInterval(() => { void reload(false) }, 2000)
    return () => { clearInterval(timer) }
  }, [syncing, reload])

  useEffect(() => {
    if (tab !== 'analyze') return
    const timer = setInterval(() => { void reload(false) }, 5000)
    return () => { clearInterval(timer) }
  }, [tab, reload])

  const dirty = state !== undefined && draft !== undefined && !sameSettings(draft, state.settings)

  const run = async (action: () => Promise<StateWire>, success: string, resetDraft: boolean): Promise<StateWire | undefined> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await action()
      adopt(next, resetDraft)
      setNotice({ kind: 'ok', text: success })
      return next
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    if (draft === undefined) return
    let settings: EditableSettings
    try {
      settings = fromDraft(draft)
    } catch (error) {
      setNotice({ kind: 'error', text: messageOf(error) })
      return
    }
    void run(() => saveSettings(settings), '已保存', true)
  }

  if (state === undefined || draft === undefined) {
    return (
      <div className="lz">
        {loadError === undefined
          ? <div className="lz__loading">加载中…</div>
          : <div className="lz__notice lz__notice--error">{loadError} <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { void reload(true) }}>重试</button></div>}
      </div>
    )
  }

  const available = state.repos.filter(repo => repo.available).length
  return (
    <div className="lz">
      <header className="lz__head">
        <div className="lz__headRow">
          <h1 className="lz__title">{PANEL_TITLE}</h1>
          <span className={`lz__pill ${available > 0 ? 'lz__pill--ok' : 'lz__pill--warn'}`}><span className="lz__dot" />{available} 个应用可用</span>
          {syncing ? <span className="lz__pill lz__pill--warn"><span className="lz__dot" />读取中</span> : null}
        </div>
        <div className="lz__meta">观其象，知其因。在对话中输入 /logalyze 描述问题并附上日志，观象会按应用派发分析。</div>
        <div className="lz__tabs" role="tablist">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="lz__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
          ))}
        </div>
      </header>
      {state.overlayError === undefined ? null : <div className="lz__notice lz__notice--error">面板设置文件未生效：{state.overlayError}。保存一次会用当前内容覆盖它。</div>}
      <div className="lz__body" role="tabpanel">
        {tab === 'repos' ? <ReposTab state={state} openRepoSettings={openRepoSettings} /> : null}
        {tab === 'download' ? <DownloadTab draft={draft} setDraft={setDraft} overridden={state.overridden} /> : null}
        {tab === 'analyze'
          ? <AnalyzeTab
              draft={draft}
              setDraft={setDraft}
              analyze={state.analyze}
              credentialsAvailable={state.credentialsAvailable}
              overridden={state.overridden}
              busy={busy}
              onSaveCredential={async (tokenEnv, value) => await run(() => saveToken(tokenEnv, value), tokenEnv === state.analyze.tokenEnv ? '已保存分析接口令牌，下一个请求起生效' : '已保存日志平台 client_secret', false) !== undefined}
              onClearCredential={(tokenEnv) => { void run(() => clearToken(tokenEnv), '已清除面板保存的值', false) }}
              onRetry={(id) => { void run(() => retryReport(id), '已开始重新回传', false) }}
            />
          : null}
        {tab === 'advanced' ? <AdvancedTab draft={draft} setDraft={setDraft} overridden={state.overridden} busy={busy} onReset={() => { void run(resetSettings, '已恢复为 cordis.yml 中的配置', true) }} /> : null}
      </div>
      {notice === undefined ? null : <div className={`lz__notice lz__notice--${notice.kind}`}>{notice.text}</div>}
      <div className="lz__saveBar">
        <span className="lz__saveMsg">{dirty ? '有未保存的修改' : '设置已保存'}</span>
        <button type="button" className="lz__btn lz__btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(state.settings)); setNotice(undefined) }}>放弃修改</button>
        <button type="button" className="lz__btn lz__btn--primary" disabled={!dirty || busy} onClick={save}>保存</button>
      </div>
    </div>
  )
}

interface TabProps {
  draft: Draft
  setDraft: (next: Draft) => void
}

function ReposTab({ state, openRepoSettings }: LogalyzePageProps & { state: StateWire }): JSX.Element {
  return (
    <section className="lz__sec">
      <h2 className="lz__secTitle">应用仓库</h2>
      <div className="lz__list">
        {state.repos.length === 0 ? <div className="lz__emptyRow">还没有应用仓库。请管理员在 dsh-repo 的「代码仓库 → 仓库」中添加仓库并打开「日志分析」。</div> : null}
        {state.repos.map(repo => (
          <div key={repo.url} className="lz__row lz__row--top">
            <div className="lz__rowText">
              <div className="lz__rowLabel">
                <span className="lz__mono">{repo.url}</span>
                {repo.branch === undefined ? null : <span className="lz__tag" title="日志分析读取的分支">{repo.branch}</span>}
                {appPill(repo)}
                {repo.writable ? null : <span className="lz__pill" title="dsh-repo 中权限为只读：只分析，不起草接入、不改进 SKILL">只读</span>}
              </div>
              {repo.app !== undefined
                ? <div className="lz__rowSummary">{repo.app.name}（<span className="lz__mono">{repo.app.id}</span>）· SKILL <span className="lz__mono">/{repo.app.skill}</span>{repo.activeRuns > 0 ? ` · ${repo.activeRuns} 个分析进行中` : ''}</div>
                : null}
              {repo.app !== undefined ? <div className="lz__rowSummary">{repo.app.description}</div> : null}
              {repo.commit !== undefined
                ? <div className="lz__rowSummary">读取的提交 <span className="lz__mono">{repo.commit.slice(0, 8)}</span> · {formatTime(repo.syncedAt)}</div>
                : null}
              {repo.error !== undefined ? <div className="lz__rowError">{repo.error}</div> : null}
            </div>
          </div>
        ))}
      </div>
      {state.dshRepo.availability === 'ready' ? null : <div className="lz__notice lz__notice--error">{state.dshRepo.availability === 'missing' ? '没有加载 dsh-repo 插件，应用仓库来自它的仓库清单。请安装 dsh-repo。' : 'dsh-repo 版本与观象不兼容，无法读取仓库清单。'}</div>}
      {state.dshRepo.availability === 'ready' && state.dshRepo.mirrorDir === undefined ? <div className="lz__notice lz__notice--error">{state.dshRepo.mirrorProblem ?? 'dsh-repo 的镜像目录未设置，仓库无法读取。'}请到 dsh-repo 的设置页「高级」里设置镜像目录。</div> : null}
      <p className="lz__secFoot">应用仓库是 dsh-repo 仓库清单中打开了「日志分析」功能的仓库，只能在 dsh-repo 中添加；地址、分支和权限也都在那里修改，镜像的拉取状态和「重新拉取」也在那里。分析读取「日志分析」开关旁选的分支（留空用基线分支），起草接入和改进 SKILL 从基线分支开始，合并请求合回基线分支，仓库权限需为「可改代码」。每个仓库的日志分析分支上需包含 <span className="lz__mono">.agents/logalyze.yaml</span> 与其中声明的日志分析 SKILL。</p>
      <div className="lz__headRow">
        {openRepoSettings === undefined || state.dshRepo.availability === 'missing' ? null : <button type="button" className="lz__btn lz__btn--ghost" onClick={openRepoSettings}>{state.dshRepo.availability === 'ready' && state.dshRepo.mirrorDir === undefined ? '去设置镜像目录' : '在 dsh-repo 中管理仓库'}</button>}
      </div>
    </section>
  )
}

/** Credential store layers of `@deepseek-ai/dsh-credentials-local` other than its own file. */
const TOKEN_SOURCES: Readonly<Record<string, string>> = { 'env': '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

function tokenPill(token: TokenStatusWire | undefined): JSX.Element {
  if (token === undefined) return <span className="lz__pill"><span className="lz__dot" />保存后设置令牌</span>
  if (token.error !== undefined) return <span className="lz__pill lz__pill--bad"><span className="lz__dot" />无法读取</span>
  if (!token.configured) return <span className="lz__pill lz__pill--warn"><span className="lz__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="lz__pill lz__pill--ok"><span className="lz__dot" />已设置{source === undefined ? '' : `（来自${source}）`}</span>
}

function DownloadTab({ draft, setDraft, overridden }: TabProps & { overridden: readonly EditableKey[] }): JSX.Element {
  const [host, setHost] = useState('')
  const add = (): void => {
    const trimmed = host.trim().toLowerCase()
    if (trimmed === '' || draft.allowedHosts.includes(trimmed)) return
    setDraft({ ...draft, allowedHosts: [...draft.allowedHosts, trimmed] })
    setHost('')
  }
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">允许下载的域名 <Overridden keys={overridden} name="download" /></h2>
        <div className="lz__list">
          {draft.allowedHosts.length === 0 ? <div className="lz__emptyRow">未配置域名，消息中的日志下载链接不会被下载。</div> : null}
          {draft.allowedHosts.map(item => (
            <div key={item} className="lz__row">
              <div className="lz__rowText"><span className="lz__mono">{item}</span></div>
              <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" onClick={() => { setDraft({ ...draft, allowedHosts: draft.allowedHosts.filter(entry => entry !== item) }) }}>删除</button></div>
            </div>
          ))}
          <div className="lz__addRow">
            <input className="lz__input" placeholder="主机名，例如 oss.example.com" value={host} onChange={(event) => { setHost(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') add() }} />
            <button type="button" className="lz__btn" disabled={host.trim() === ''} onClick={add}>添加</button>
          </div>
        </div>
        <p className="lz__secFoot">只填主机名，同时允许它的子域名。下载不携带任何鉴权信息，每次重定向都会重新校验域名。</p>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">限制</h2>
        <div className="lz__list">
          <NumberRow label="单文件大小上限" unit="MB" value={draft.maxMb} onChange={(value) => { setDraft({ ...draft, maxMb: value }) }} />
          <NumberRow label="单文件下载超时" unit="秒" value={draft.timeoutSec} onChange={(value) => { setDraft({ ...draft, timeoutSec: value }) }} />
        </div>
      </section>
    </>
  )
}

const TOPICS_STATUS: Readonly<Record<AnalyzeWire['topics'], { pill: string; text: string }>> = {
  ready: { pill: 'lz__pill--ok', text: '飞书渠道就绪' },
  missing: { pill: 'lz__pill--bad', text: '未找到飞书渠道' },
  incompatible: { pill: 'lz__pill--bad', text: '飞书渠道版本不兼容' },
}

const REPORT_STATUS: Readonly<Record<ReportStatus, { pill: string; text: string }>> = {
  done: { pill: 'lz__pill--ok', text: '已完成' },
  stopped: { pill: '', text: '已停止' },
  error: { pill: 'lz__pill--bad', text: '失败' },
  failed: { pill: 'lz__pill--bad', text: '未能开始' },
  interrupted: { pill: 'lz__pill--warn', text: '已中断' },
}

const UPLOAD_PHASE: Readonly<Record<UploadPhase, { pill: string; text: string }>> = {
  pending: { pill: '', text: '等待上传' },
  running: { pill: 'lz__pill--warn', text: '上传中' },
  waiting: { pill: 'lz__pill--warn', text: '等待重试' },
  done: { pill: 'lz__pill--ok', text: '已上传' },
  failed: { pill: 'lz__pill--bad', text: '上传失败' },
}

function AnalysisRow({ report, busy, onRetry }: { report: AnalysisWire; busy: boolean; onRetry: (id: string) => void }): JSX.Element {
  const status = report.status === undefined ? { pill: 'lz__pill--warn', text: '分析中' } : REPORT_STATUS[report.status]
  const uploading = report.logs.some(log => log.phase === 'running')
  return (
    <div className="lz__row lz__row--top">
      <div className="lz__rowText">
        <div className="lz__rowLabel">
          <span className="lz__tag">{report.appName} · {report.errorCode ?? '未标注'}</span>
          <span className={`lz__pill ${status.pill}`}><span className="lz__dot" />{status.text}</span>
          {report.followups > 0 ? <span className="lz__tag">追问 {report.followups}</span> : null}
          <span className="lz__rowSummary">{report.triggeredAt} · 受理于 {formatTime(report.acceptedAt)}</span>
        </div>
        {report.logs.map((log) => {
          const phase = report.status === undefined && log.phase === 'pending' ? undefined : UPLOAD_PHASE[log.phase]
          return (
            <div key={log.ref} className="lz__rowSummary">
              <span className="lz__mono">{log.ref}</span> {log.fileName}
              {phase === undefined ? null : <> <span className={`lz__pill ${phase.pill}`}><span className="lz__dot" />{phase.text}</span></>}
              {log.detailUrl === undefined ? null : <> · <a href={log.detailUrl} target="_blank" rel="noreferrer">详情页</a></>}
              {log.reportUrl === undefined ? null : <> · <a href={log.reportUrl} target="_blank" rel="noreferrer">分析报告</a></>}
              {log.uploadedAt === undefined ? null : <> · 上传于 {formatTime(log.uploadedAt)}</>}
              {log.error === undefined || log.phase === 'done' ? null : <div className="lz__rowError">{log.error}</div>}
            </div>
          )
        })}
        {report.skipped.length === 0 ? null : <div className="lz__rowSummary">未上传的文件：{report.skipped.join('；')}</div>}
        {report.warnings.length === 0 ? null : <div className="lz__rowSummary">链接提示：{report.warnings.join('；')}</div>}
      </div>
      <div className="lz__rowCtl"><button type="button" className="lz__btn" disabled={busy || uploading} title={report.dir} onClick={() => { onRetry(report.id) }}>重新回传</button></div>
    </div>
  )
}

function LegacyRow({ report }: { report: LegacyReportWire }): JSX.Element {
  return (
    <div className="lz__row">
      <div className="lz__rowText">
        <div className="lz__rowLabel">
          <span className="lz__mono">{report.logId}</span>
          <span className="lz__tag">{report.app} · {report.errorCode}</span>
          <span className="lz__rowSummary">{formatTime(report.uploadedAt ?? report.acceptedAt)}</span>
        </div>
        {report.error === undefined ? null : <div className="lz__rowError">{report.error}</div>}
      </div>
    </div>
  )
}

function CredentialRow({ label, summary, tokenEnv, status, credentialsAvailable, busy, placeholder, onSave, onClear }: {
  label: string
  summary: JSX.Element
  tokenEnv: string
  status: TokenStatusWire | undefined
  credentialsAvailable: boolean
  busy: boolean
  placeholder: string
  onSave: (value: string) => Promise<boolean>
  onClear: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const save = (): void => {
    const trimmed = value.trim()
    if (trimmed === '' || busy) return
    void onSave(trimmed).then((ok) => { if (ok) setValue('') })
  }
  return (
    <div className="lz__row lz__row--top">
      <div className="lz__rowText">
        <div className="lz__rowLabel">{label} <span className="lz__tag lz__mono">{tokenEnv}</span>{credentialsAvailable ? tokenPill(status) : null}</div>
        <div className="lz__rowSummary">{summary}</div>
        {credentialsAvailable ? null : <div className="lz__rowError">当前 DSH 组合没有加载凭据服务（@deepseek-ai/dsh-credentials-local），无法保存或读取。</div>}
        {status?.error === undefined ? null : <div className="lz__rowError">{status.error}</div>}
        {status !== undefined && status.writable
          ? (
              <div className="lz__addRow lz__addRow--flush">
                <input className="lz__input lz__mono" type="password" autoComplete="new-password" spellCheck={false} aria-label={label} placeholder={status.configured ? '输入新值以替换' : placeholder} value={value} onChange={(event) => { setValue(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') save() }} />
                <button type="button" className="lz__btn" disabled={busy || value.trim() === ''} onClick={save}>保存</button>
                {status.configured && status.source === 'file' ? <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={onClear}>清除</button> : null}
              </div>
            )
          : null}
      </div>
    </div>
  )
}

function TextRow({ label, summary, value, placeholder, onChange }: { label: string; summary?: string; value: string; placeholder?: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="lz__row lz__row--top">
      <div className="lz__rowText">
        <div className="lz__rowLabel">{label}</div>
        {summary === undefined ? null : <div className="lz__rowSummary">{summary}</div>}
        <div className="lz__addRow lz__addRow--flush">
          <input className="lz__input lz__mono" spellCheck={false} aria-label={label} placeholder={placeholder} value={value} onChange={(event) => { onChange(event.target.value) }} />
        </div>
      </div>
    </div>
  )
}

function AnalyzeTab({ draft, setDraft, analyze, credentialsAvailable, overridden, busy, onSaveCredential, onClearCredential, onRetry }: TabProps & {
  analyze: AnalyzeWire
  credentialsAvailable: boolean
  overridden: readonly EditableKey[]
  busy: boolean
  onSaveCredential: (tokenEnv: string, value: string) => Promise<boolean>
  onClearCredential: (tokenEnv: string) => void
  onRetry: (id: string) => void
}): JSX.Element {
  const topics = TOPICS_STATUS[analyze.topics]
  const endpoint = new URL(analyze.route.slice(1), document.baseURI).href
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">日志平台分析接口</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">开启接口 <Overridden keys={overridden} name="analyze" /><span className={`lz__pill ${topics.pill}`}><span className="lz__dot" />{topics.text}</span></div>
              <div className="lz__rowSummary">日志平台传来一批日志的 log_id 后，观象向日志平台查出这批日志，经飞书渠道（dsh-channels）在目标群发出分析卡片，并在卡片下的话题里开始分析；群内成员都可以在话题里继续追问。关闭时接口回复 404。</div>
              {analyze.topics === 'ready' ? null : <div className="lz__rowError">{analyze.topics === 'missing' ? '接口需要加载 dsh-channels。' : '请把观象与 dsh-channels 升级到相互兼容的版本（需要支持更新根卡片链接表的 dsh-channels）。'}</div>}
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="开启分析接口" checked={draft.analyzeEnabled} onChange={(event) => { setDraft({ ...draft, analyzeEnabled: event.target.checked }) }} /></div>
          </div>
          <CredentialRow
            label="访问令牌"
            summary={<>日志平台以 <span className="lz__mono">Authorization: Bearer &lt;令牌&gt;</span> 调用接口。令牌未设置时接口回复 503。</>}
            tokenEnv={analyze.tokenEnv}
            status={analyze.token}
            credentialsAvailable={credentialsAvailable}
            busy={busy}
            placeholder="粘贴令牌"
            onSave={async value => await onSaveCredential(analyze.tokenEnv, value)}
            onClear={() => { onClearCredential(analyze.tokenEnv) }}
          />
          <TextRow label="默认群" summary="请求体不带 chatId 时，分析卡片发到这个群；机器人需在群内。留空时 chatId 必填。" placeholder="oc_xxx" value={draft.analyzeDefaultChatId} onChange={(value) => { setDraft({ ...draft, analyzeDefaultChatId: value }) }} />
          <NumberRow label="单次日志数上限" summary="一次请求最多传的 logIds 个数（最多 50）。" unit="份" value={draft.maxLogs} onChange={(value) => { setDraft({ ...draft, maxLogs: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">日志平台 <Overridden keys={overridden} name="analyze" /></h2>
        <div className="lz__list">
          {analyze.platformProblem === undefined ? null : <div className="lz__notice lz__notice--error">{analyze.platformProblem}</div>}
          <TextRow label="接口地址" summary="开放 API 的地址，观象在它后面拼 /open-api/v1/…" placeholder="https://logs.example.com" value={draft.platformBaseUrl} onChange={(value) => { setDraft({ ...draft, platformBaseUrl: value }) }} />
          <TextRow label="令牌地址" summary="OAuth2 client_credentials 的令牌端点。" placeholder="https://auth.example.com/oauth/token" value={draft.platformTokenUrl} onChange={(value) => { setDraft({ ...draft, platformTokenUrl: value }) }} />
          <TextRow label="client_id" value={draft.platformClientId} onChange={(value) => { setDraft({ ...draft, platformClientId: value }) }} />
          <CredentialRow
            label="client_secret"
            summary={<>保存在 DSH 凭据库，换取访问令牌时读取；令牌缓存在内存里，快过期或被拒绝时重新换取。</>}
            tokenEnv={analyze.secretEnv}
            status={analyze.secret}
            credentialsAvailable={credentialsAvailable}
            busy={busy}
            placeholder="粘贴 client_secret"
            onSave={async value => await onSaveCredential(analyze.secretEnv, value)}
            onClear={() => { onClearCredential(analyze.secretEnv) }}
          />
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">客户端认证方式</div>
              <div className="lz__rowSummary">表单字段：client_id / client_secret 放在请求体；HTTP Basic：放在 Authorization 头。</div>
            </div>
            <div className="lz__rowCtl">
              <select className="lz__input" aria-label="客户端认证方式" value={draft.platformClientAuth} onChange={(event) => { setDraft({ ...draft, platformClientAuth: event.target.value === 'basic' ? 'basic' : 'body' }) }}>
                <option value="body">表单字段</option>
                <option value="basic">HTTP Basic</option>
              </select>
            </div>
          </div>
          <TextRow label="授权范围" summary="scope，空格分隔；需要 log:search、log:download、log:upload。" value={draft.platformScope} onChange={(value) => { setDraft({ ...draft, platformScope: value }) }} />
          <NumberRow label="接口超时" unit="秒" value={draft.platformTimeoutSec} onChange={(value) => { setDraft({ ...draft, platformTimeoutSec: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">报告回传 <Overridden keys={overridden} name="analyze" /></h2>
        <div className="lz__list">
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowSummary">分析话题每一轮结束后，观象为每份日志生成报告入口 report.md，连同话题工作目录 report/ 下平台接受的文件，作为一个新的分析修订传到这份日志（创建修订 → 直传文件 → 完成），平台详情页显示最新的修订。网络错误、429 和 5xx 按下面的间隔重试，其他失败要在回传记录里手动重传。上限默认与日志平台一致。</div></div></div>
          <NumberRow label="单个文件上传超时" unit="秒" value={draft.uploadTimeoutSec} onChange={(value) => { setDraft({ ...draft, uploadTimeoutSec: value }) }} />
          <NumberRow label="失败重试次数" summary="第一次重试前等待下面的间隔，之后每次加倍。" unit="次" value={draft.uploadRetries} onChange={(value) => { setDraft({ ...draft, uploadRetries: value }) }} />
          <NumberRow label="重试间隔" unit="秒" value={draft.uploadRetryDelaySec} onChange={(value) => { setDraft({ ...draft, uploadRetryDelaySec: value }) }} />
          <NumberRow label="同时上传文件数" unit="个" value={draft.uploadConcurrency} onChange={(value) => { setDraft({ ...draft, uploadConcurrency: value }) }} />
          <NumberRow label="报告文件数上限" summary="含 report.md；超出的文件不上传，列在报告末尾。" unit="个" value={draft.uploadMaxFiles} onChange={(value) => { setDraft({ ...draft, uploadMaxFiles: value }) }} />
          <NumberRow label="报告总大小上限" unit="MB" value={draft.uploadMaxMb} onChange={(value) => { setDraft({ ...draft, uploadMaxMb: value }) }} />
          <NumberRow label="单文件大小上限" unit="MB" value={draft.uploadMaxFileMb} onChange={(value) => { setDraft({ ...draft, uploadMaxFileMb: value }) }} />
          <NumberRow label="Markdown 文件大小上限" unit="MB" value={draft.uploadMaxMarkdownMb} onChange={(value) => { setDraft({ ...draft, uploadMaxMarkdownMb: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">回传记录</h2>
        <div className="lz__list">
          {analyze.reports.length === 0 ? <div className="lz__emptyRow">还没有分析请求。</div> : null}
          {analyze.reports.map(report => <AnalysisRow key={report.id} report={report} busy={busy} onRetry={onRetry} />)}
        </div>
        {analyze.legacyReports.length === 0
          ? null
          : (
              <>
                <p className="lz__secFoot">以下是旧版回传命令留下的记录，只做展示，不再上传，30 天无活动后删除。</p>
                <div className="lz__list">
                  {analyze.legacyReports.map(report => <LegacyRow key={report.id} report={report} />)}
                </div>
              </>
            )}
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">调用方式</h2>
        <div className="lz__list">
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">地址</div><div className="lz__rowSummary lz__mono">POST {endpoint}</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">请求头</div><div className="lz__rowSummary lz__mono">Authorization: Bearer &lt;令牌&gt; · Idempotency-Key: &lt;1-200 个可见 ASCII 字符&gt; · Content-Type: application/json</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">请求体</div><div className="lz__rowSummary lz__mono">triggerType（digital | machine）, triggerId, triggeredAt, logIds（同一应用、同一错误码的日志 UUID，1 到上面的上限个）, instructions（可选，调用方说明）, chatId（可选，默认用上面的默认群）</div></div></div>
          <div className="lz__row"><div className="lz__rowText"><div className="lz__rowLabel">响应</div><div className="lz__rowSummary">202 已发出分析卡片（同一 Idempotency-Key 重试返回同一张卡片）；400/401/404/405/409/413/415 请求问题；403 发起人没有对话权限（只针对 digital）；422 日志不能分析（找不到、未归档、应用或错误码不一致、component_code 没有对应的应用，invalidLogs 列出原因）；502 日志平台拒绝或卡片发送失败；503 飞书未连接、令牌或日志平台未配置、日志平台暂时不可用。字段说明见观象 README。</div></div></div>
        </div>
      </section>
    </>
  )
}

function AdvancedTab({ draft, setDraft, overridden, busy, onReset }: TabProps & { overridden: readonly EditableKey[]; busy: boolean; onReset: () => void }): JSX.Element {
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">仓库</h2>
        <div className="lz__list">
          <NumberRow label="更新间隔" summary="输入 /logalyze 时，距上次读取超过该时间的仓库会先重新读取应用描述；0 表示每次都读取。" unit="分钟" value={draft.fetchIntervalMin} overridden={overridden.includes('fetchIntervalMs')} onChange={(value) => { setDraft({ ...draft, fetchIntervalMin: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">派发</h2>
        <div className="lz__list">
          <NumberRow label="单次应用数上限" summary="一次派发最多同时分析的应用数，不应超过 DSH 的活动子 Agent 上限（默认 8）。" unit="个" value={draft.maxAppsPerRequest} overridden={overridden.includes('maxAppsPerRequest')} onChange={(value) => { setDraft({ ...draft, maxAppsPerRequest: value }) }} />
          <NumberRow label="派发超时" summary="等待全部子 Agent 的最长时间，超时后停止仍在运行的子 Agent。" unit="分钟" value={draft.dispatchTimeoutMin} overridden={overridden.includes('dispatchTimeoutMs')} onChange={(value) => { setDraft({ ...draft, dispatchTimeoutMin: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">SKILL 改进</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">分析后建议改进 SKILL <Overridden keys={overridden} name="skillUpdates" /></div>
              <div className="lz__rowSummary">子 Agent 发现应用的日志分析 SKILL 写错或缺内容时记下不足，父 Agent 在分析结论之后附上改进建议；用户在对话中同意后，每个应用由一个改进子 Agent 把所有改进点整理为案例并修改 SKILL，观象经 dsh-repo 提交到新分支并创建合并请求（GitLab 或 GitHub，需要安装 dsh-repo 并配置该仓库主机的令牌）。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="分析后建议改进 SKILL" checked={draft.skillUpdatesEnabled} onChange={(event) => { setDraft({ ...draft, skillUpdatesEnabled: event.target.checked }) }} /></div>
          </div>
          <NumberRow label="改进文件数上限" unit="个" value={draft.skillMaxFiles} onChange={(value) => { setDraft({ ...draft, skillMaxFiles: value }) }} />
          <NumberRow label="改进单文件大小上限" unit="KB" value={draft.skillMaxKb} onChange={(value) => { setDraft({ ...draft, skillMaxKb: value }) }} />
        </div>
      </section>
      <section className="lz__sec">
        <h2 className="lz__secTitle">面板设置</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">恢复 cordis.yml 配置</div>
              <div className="lz__rowSummary">删除面板保存的全部设置（$DSH_HOME/logalyze/settings.json 中的覆盖值）。</div>
            </div>
            <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" disabled={busy || overridden.length === 0} onClick={onReset}>恢复</button></div>
          </div>
        </div>
      </section>
    </>
  )
}

function NumberRow({ label, summary, unit, value, overridden = false, onChange }: { label: string; summary?: string; unit: string; value: string; overridden?: boolean; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="lz__row">
      <div className="lz__rowText">
        <div className="lz__rowLabel">{label}{overridden ? <span className="lz__tag lz__tag--accent">面板设置</span> : null}</div>
        {summary === undefined ? null : <div className="lz__rowSummary">{summary}</div>}
      </div>
      <div className="lz__rowCtl">
        <input className="lz__input lz__input--num" inputMode="decimal" value={value} onChange={(event) => { onChange(event.target.value) }} />
        <span className="lz__unit">{unit}</span>
      </div>
    </div>
  )
}
