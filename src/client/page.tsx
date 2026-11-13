/**
 * 左侧栏「智能监管」主区页面：应用仓库（观象日志监管 + 审微 MR 监管仓库概览）、
 * 日志下载、分析接口、高级四个分页，后三个共用一份草稿和底部保存条。
 * 应用仓库逐项保存应用描述与触发别名；仓库在 dsh-repo 的仓库清单中添加并打开
 * 「日志分析」或「MR 自动评审」功能，镜像拉取归 dsh-repo 管理。
 *
 * @module dsh-logalyze/client/page
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AnalysisWire, AnalyzeWire, ApplicationMetadata, BreakerStatusWire, EditableKey, EditableSettings, LegacyReportWire, LogDeliveryMode, LogSupervisionWire, MrSupervisionWire, PlatformClientAuth, ReportStatus, RepoStatusWire, StateWire, SupervisedMrWire, TokenStatusWire, UploadPhase } from '../settings/contract.ts'
import { clearToken, fetchState, messageOf, resetBreaker, resetSettings, retryOutboxDead, retryReport, saveApplication, saveSettings, saveToken, updateLogWatermark } from './api.ts'
import { CHAT_ID_PATTERN } from '../settings/contract.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '智能监管'

const KB = 1024
const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'repos' | 'log' | 'mr' | 'download' | 'analyze' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'repos', label: '应用仓库' },
  { id: 'log', label: '日志监管' },
  { id: 'mr', label: 'MR 评审' },
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
  mrEnabled: boolean
  mrPollIntervalSec: string
  mrDebounceSec: string
  mrMaxConcurrent: string
  mrSkipDraft: boolean
  mrIgnoreLabels: string[]
  mrMaxAutoFix: string
  mrDailyTurnLimit: string
  mrRepoHourlyLimit: string
  logEnabled: boolean
  logPollIntervalSec: string
  logBatchSizeThreshold: string
  logMaxBatchSize: string
  logBatchWindowMin: string
  logMaxConcurrentBatches: string
  logAppHourlyBatchLimit: string
  logFeishuChatId: string
  logDeliveryMode: LogDeliveryMode
  logMaxUnpackMb: string
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
    mrEnabled: settings.mrReview.enabled,
    mrPollIntervalSec: trimNumber(settings.mrReview.pollIntervalMs / 1000),
    mrDebounceSec: trimNumber(settings.mrReview.debounceMs / 1000),
    mrMaxConcurrent: String(settings.mrReview.maxConcurrentSessions),
    mrSkipDraft: settings.mrReview.skipDraft,
    mrIgnoreLabels: [...settings.mrReview.ignoreLabels],
    mrMaxAutoFix: String(settings.mrReview.maxAutoFixAttempts),
    mrDailyTurnLimit: String(settings.mrReview.dailyMrTurnLimit),
    mrRepoHourlyLimit: String(settings.mrReview.repoHourlyTurnLimit),
    logEnabled: settings.logSupervision.enabled,
    logPollIntervalSec: trimNumber(settings.logSupervision.pollIntervalMs / 1000),
    logBatchSizeThreshold: String(settings.logSupervision.batchSizeThreshold),
    logMaxBatchSize: String(settings.logSupervision.maxBatchSize),
    logBatchWindowMin: trimNumber(settings.logSupervision.batchWindowMs / MINUTE),
    logMaxConcurrentBatches: String(settings.logSupervision.maxConcurrentBatches),
    logAppHourlyBatchLimit: String(settings.logSupervision.appHourlyBatchLimit),
    logFeishuChatId: settings.logSupervision.feishuChatId ?? '',
    logDeliveryMode: settings.logSupervision.deliveryMode,
    logMaxUnpackMb: trimNumber(settings.logSupervision.maxUnpackBytes / MB),
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
  const logFeishuChatId = draft.logFeishuChatId.trim()
  if (logFeishuChatId !== '' && !CHAT_ID_PATTERN.test(logFeishuChatId)) throw new Error('日志监管目标群必须是飞书群的 chat_id（oc_ 开头）')
  const logBatchSizeThreshold = integer(draft.logBatchSizeThreshold, '攒批触发条数')
  const logMaxBatchSize = integer(draft.logMaxBatchSize, '单批日志上限')
  if (logBatchSizeThreshold > logMaxBatchSize) throw new Error('攒批触发条数不能大于单批日志上限')
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
    mrReview: {
      enabled: draft.mrEnabled,
      pollIntervalMs: Math.round(positive(draft.mrPollIntervalSec, 'MR 轮询间隔') * 1000),
      debounceMs: Math.round(positive(draft.mrDebounceSec, 'MR 信号防抖窗口', true) * 1000),
      maxConcurrentSessions: integer(draft.mrMaxConcurrent, 'MR 评审并发上限'),
      skipDraft: draft.mrSkipDraft,
      ignoreLabels: draft.mrIgnoreLabels.map(label => label.trim()).filter(label => label !== ''),
      maxAutoFixAttempts: integer(draft.mrMaxAutoFix, 'CI 自动修复上限', true),
      dailyMrTurnLimit: integer(draft.mrDailyTurnLimit, '单 MR 日唤醒上限'),
      repoHourlyTurnLimit: integer(draft.mrRepoHourlyLimit, '单仓库小时唤醒上限'),
    },
    logSupervision: {
      enabled: draft.logEnabled,
      pollIntervalMs: Math.round(positive(draft.logPollIntervalSec, '日志轮询间隔') * 1000),
      batchSizeThreshold: logBatchSizeThreshold,
      maxBatchSize: logMaxBatchSize,
      batchWindowMs: Math.round(positive(draft.logBatchWindowMin, '攒批等待窗口', true) * MINUTE),
      maxConcurrentBatches: integer(draft.logMaxConcurrentBatches, '日志并发上限'),
      appHourlyBatchLimit: integer(draft.logAppHourlyBatchLimit, '单应用小时批次数上限'),
      ...logFeishuChatId === '' ? {} : { feishuChatId: logFeishuChatId },
      deliveryMode: draft.logDeliveryMode,
      maxUnpackBytes: Math.round(positive(draft.logMaxUnpackMb, '单日志解压上限') * MB),
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
    if (tab !== 'analyze' && tab !== 'mr' && tab !== 'log') return
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

  const saveApp = async (url: string, metadata: ApplicationMetadata): Promise<ApplicationMetadata> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const next = await saveApplication(url, metadata)
      adopt(next, false)
      setNotice({ kind: 'ok', text: '已保存应用描述与触发别名' })
      return next.repos.find(repo => repo.url === url)?.app ?? metadata
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
  const mrCount = state.mrRepos.length
  return (
    <div className="lz">
      <header className="lz__head">
        <div className="lz__headRow">
          <h1 className="lz__title">{PANEL_TITLE}</h1>
          <span className={`lz__pill ${available > 0 ? 'lz__pill--ok' : 'lz__pill--warn'}`}><span className="lz__dot" />{available} 个日志应用可用</span>
          <span className={`lz__pill ${mrCount > 0 && state.dshRepo.mrReviewReady !== false ? 'lz__pill--ok' : ''}`}><span className="lz__dot" />{mrCount} 个 MR 评审仓库</span>
          {syncing ? <span className="lz__pill lz__pill--warn"><span className="lz__dot" />读取中</span> : null}
        </div>
        <div className="lz__meta">观象察志，审微知著：统一管理观象应用日志诊断（/logalyze）与审微合并请求自动评审。</div>
        <div className="lz__tabs" role="tablist">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="lz__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
          ))}
        </div>
      </header>
      {state.overlayError === undefined ? null : <div className="lz__notice lz__notice--error">面板设置文件未生效：{state.overlayError}。保存一次会用当前内容覆盖它。</div>}
      <div className="lz__body" role="tabpanel">
        <div hidden={tab !== 'repos'}><ReposTab state={state} openRepoSettings={openRepoSettings} busy={busy} onSave={saveApp} /></div>
        {tab === 'log'
          ? <LogSupervisionTab
              draft={draft}
              setDraft={setDraft}
              supervision={state.logSupervision}
              overridden={state.overridden}
              busy={busy}
              onResetBreaker={(scope, key) => { void run(() => resetBreaker(scope, key), '已解除熔断并恢复等待任务', false) }}
              onUpdateWatermark={(payload) => { void run(() => updateLogWatermark(payload), '已更新日志轮询水位线', false) }}
              onRetryOutbox={(key) => { void run(() => retryOutboxDead(key), '已重新入队死信报告', false) }}
            />
          : null}
        {tab === 'mr'
          ? <MrReviewTab
              draft={draft}
              setDraft={setDraft}
              supervision={state.mrSupervision}
              overridden={state.overridden}
              busy={busy}
              onResetBreaker={(scope, key) => { void run(() => resetBreaker(scope, key), '已解除熔断并恢复等待任务', false) }}
            />
          : null}
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
      {tab === 'repos' ? null : <div className="lz__saveBar">
        <span className="lz__saveMsg">{dirty ? '有未保存的修改' : '设置已保存'}</span>
        <button type="button" className="lz__btn lz__btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(state.settings)); setNotice(undefined) }}>放弃修改</button>
        <button type="button" className="lz__btn lz__btn--primary" disabled={!dirty || busy} onClick={save}>保存</button>
      </div>}
    </div>
  )
}

interface TabProps {
  draft: Draft
  setDraft: (next: Draft) => void
}

function ReposTab({ state, openRepoSettings, busy, onSave }: LogalyzePageProps & { state: StateWire; busy: boolean; onSave: (url: string, metadata: ApplicationMetadata) => Promise<ApplicationMetadata> }): JSX.Element {
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">应用仓库（观象 · 日志分析）</h2>
        <div className="lz__list">
          {state.repos.length === 0 ? <div className="lz__emptyRow">还没有应用仓库。请管理员在 dsh-repo 的「代码仓库 → 仓库」中添加仓库并打开「日志分析」。</div> : null}
          {state.repos.map(repo => (
            <div key={repo.url} className="lz__row lz__row--top">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__mono">{repo.url}</span>
                  {repo.branch === undefined ? null : <span className="lz__tag" title="日志分析读取的分支">{repo.branch}</span>}
                  {appPill(repo)}
                  {repo.writable ? null : <span className="lz__pill" title="dsh-repo 中权限为只读：代码只读，不能推送 SKILL 修改">只读</span>}
                </div>
                {repo.app !== undefined
                  ? <div className="lz__rowSummary">{repo.app.name}（<span className="lz__mono">{repo.app.id}</span>）{repo.activeRuns > 0 ? ` · ${repo.activeRuns} 个分析进行中` : ''}</div>
                  : null}
                {repo.app !== undefined ? <ApplicationEditor repo={repo} busy={busy} onSave={onSave} /> : null}
                {repo.commit !== undefined
                  ? <div className="lz__rowSummary">读取的提交 <span className="lz__mono">{repo.commit.slice(0, 8)}</span> · {formatTime(repo.syncedAt)}</div>
                  : null}
                {repo.error !== undefined ? <div className="lz__rowError">{repo.error}</div> : null}
              </div>
            </div>
          ))}
        </div>
        {state.dshRepo.availability === 'ready' ? null : <div className="lz__notice lz__notice--error">{state.dshRepo.availability === 'missing' ? '没有加载 dsh-repo 插件，应用仓库来自它的仓库清单。请安装 dsh-repo。' : 'dsh-repo 版本与智能监管不兼容，无法读取仓库清单。'}</div>}
        {state.dshRepo.availability === 'ready' && state.dshRepo.mirrorDir === undefined ? <div className="lz__notice lz__notice--error">{state.dshRepo.mirrorProblem ?? 'dsh-repo 的镜像目录未设置，仓库无法读取。'}请到 dsh-repo 的设置页「高级」里设置镜像目录。</div> : null}
        <p className="lz__secFoot">应用仓库是 dsh-repo 仓库清单中打开了「日志分析」功能的仓库，只能在 dsh-repo 中添加；地址、分支和权限也都在那里修改，镜像的拉取状态和「重新拉取」也在那里。分析读取「日志分析」开关旁选的分支（留空用基线分支），改进现有 SKILL 从基线分支开始，合并请求合回基线分支，仓库权限需为「可改代码」。只在这里配置描述和触发别名；飞书名称与平台 component_code 使用同一份别名。SKILL 由 DSH 按需发现，没有 SKILL 也可分析。</p>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">MR 自动评审仓库（审微）</h2>
        <div className="lz__list">
          {state.mrRepos.length === 0 ? <div className="lz__emptyRow">还没有启用 MR 自动评审的仓库。可在 dsh-repo 的「代码仓库 → 仓库」中为目标仓库打开「MR 自动评审」。</div> : null}
          {state.mrRepos.map(repo => (
            <div key={repo.url} className="lz__row lz__row--top">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__mono">{repo.url}</span>
                  {repo.branch === undefined ? null : <span className="lz__tag" title="MR 自动评审跟踪的目标分支">{repo.branch}</span>}
                  <span className={`lz__pill ${state.dshRepo.mrReviewReady !== false ? 'lz__pill--ok' : 'lz__pill--warn'}`}>
                    <span className="lz__dot" />
                    {state.dshRepo.mrReviewReady !== false ? '已启用' : '待升级 dsh-repo'}
                  </span>
                  {repo.writable ? null : <span className="lz__pill" title="dsh-repo 中权限为只读：评审写回评论需在 dsh-repo 开启写入权限">只读</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        {state.dshRepo.availability === 'ready' && state.dshRepo.mrReviewReady === false && state.mrRepos.length > 0
          ? <div className="lz__notice lz__notice--error">{state.dshRepo.mrReviewProblem}</div>
          : null}
        <p className="lz__secFoot">MR 自动评审仓库来自 dsh-repo 仓库清单中打开了「MR 自动评审」功能的仓库。审微依托 dshRepos v8 行级评审与讨论线程接口对新合并请求及后续增量提交持续评审。</p>
        <div className="lz__headRow">
          {openRepoSettings === undefined || state.dshRepo.availability === 'missing' ? null : <button type="button" className="lz__btn lz__btn--ghost" onClick={openRepoSettings}>{state.dshRepo.availability === 'ready' && state.dshRepo.mirrorDir === undefined ? '去设置镜像目录' : '在 dsh-repo 中管理仓库'}</button>}
        </div>
      </section>
    </>
  )
}

function ApplicationEditor({ repo, busy, onSave }: { repo: RepoStatusWire; busy: boolean; onSave: (url: string, metadata: ApplicationMetadata) => Promise<ApplicationMetadata> }): JSX.Element {
  const app = repo.app!
  const [description, setDescription] = useState(app.description)
  const [aliases, setAliases] = useState(app.aliases)
  const [aliasInput, setAliasInput] = useState('')
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const previous = useRef({ description: app.description, aliases: JSON.stringify(app.aliases) })
  const aliasText = JSON.stringify(app.aliases)
  const dirty = description !== app.description || JSON.stringify(aliases) !== aliasText || aliasInput.trim() !== ''
  useEffect(() => {
    if (description === previous.current.description && JSON.stringify(aliases) === previous.current.aliases) {
      setDescription(app.description)
      setAliases(app.aliases)
    }
    previous.current = { description: app.description, aliases: aliasText }
  }, [app.description, aliasText])
  const restore = (): void => { setDescription(app.description); setAliases(app.aliases); setAliasInput(''); setError(undefined) }
  const withPending = (): string[] | undefined => {
    const value = aliasInput.trim()
    if (value === '') return aliases
    const key = value.normalize('NFKC').toLowerCase()
    if (aliases.some(alias => alias.normalize('NFKC').trim().toLowerCase() === key)) { setError('该别名已存在（忽略大小写及全角差异）'); return }
    if (value.length > 256) { setError('别名不能超过 256 个字符'); return }
    if (aliases.length >= 100) { setError('每个应用最多添加 100 个别名'); return }
    return [...aliases, value]
  }
  const add = (): void => {
    const values = withPending()
    if (values === undefined) return
    setAliases(values)
    setAliasInput('')
    setError(undefined)
    input.current?.focus()
  }
  const save = async (): Promise<void> => {
    const values = withPending()
    if (values === undefined) return
    setError(undefined)
    try {
      const saved = await onSave(repo.url, { description, aliases: values })
      setDescription(saved.description)
      setAliases(saved.aliases)
      setAliasInput('')
    } catch (err) {
      setError(messageOf(err))
    }
  }
  return <div className="lz__appForm">
    <label className="lz__field">应用描述<textarea aria-label={`${app.name} 应用描述`} disabled={busy} className="lz__input lz__textarea" rows={3} maxLength={8000} value={description} onChange={event => { setDescription(event.target.value) }} /></label>
    <div className="lz__field"><label htmlFor={inputId}>触发别名</label>
      <div className="lz__aliasInput">
        <input id={inputId} ref={input} aria-label={`${app.name} 触发别名`} disabled={busy} className="lz__input" placeholder="输入别名，按 Enter 添加" value={aliasInput} onChange={event => { setAliasInput(event.target.value); setError(undefined) }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); add() } }} />
        <button type="button" className="lz__btn" disabled={busy || aliasInput.trim() === ''} onClick={add}>添加</button>
      </div>
    </div>
    {aliases.length === 0 ? null : <ul className="lz__aliases" aria-label={`${app.name} 已添加别名`}>
      {aliases.map((alias, index) => <li key={`${index}:${alias}`} className="lz__alias">
        <span className="lz__aliasLabel">{alias}</span>
        <button type="button" className="lz__aliasRemove" disabled={busy} aria-label={`${app.name} 删除别名 ${alias}`} title={`删除别名 ${alias}`} onClick={() => { setAliases(aliases.filter((_, position) => position !== index)); setError(undefined); input.current?.focus() }}>×</button>
      </li>)}
    </ul>}
    <div className="lz__rowSummary">可填写中文名称、简称或平台 component_code；空描述和无 SKILL 均可分析。</div>
    {error === undefined ? null : <div role="alert" className="lz__rowError">{error}</div>}
    <div className="lz__headRow">
      <button type="button" className="lz__btn lz__btn--primary" disabled={busy || !dirty} onClick={() => { void save() }}>保存应用设置</button>
      <button type="button" className="lz__btn lz__btn--ghost" disabled={busy || !dirty} onClick={restore}>放弃应用修改</button>
    </div>
  </div>
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

const MR_STATE_LABEL: Readonly<Record<SupervisedMrWire['state'], { pill: string; text: string }>> = {
  open: { pill: 'lz__pill--ok', text: '监管中' },
  merged: { pill: 'lz__pill', text: '已合并' },
  closed: { pill: 'lz__pill', text: '已关闭' },
  draft_skipped: { pill: 'lz__pill--warn', text: '草稿跳过' },
}

const BREAKER_SCOPE_LABEL: Readonly<Record<BreakerStatusWire['scope'], string>> = {
  mr: '单 MR 日限',
  'mr-repo': '单仓库时限',
  'mr-fix': 'CI 自修上限',
  'log-app': '日志应用时限',
}

function MrReviewTab({
  draft,
  setDraft,
  supervision,
  overridden,
  busy,
  onResetBreaker,
}: TabProps & {
  supervision: MrSupervisionWire | undefined
  overridden: readonly EditableKey[]
  busy: boolean
  onResetBreaker: (scope: BreakerStatusWire['scope'], key: string) => void
}): JSX.Element {
  const [labelInput, setLabelInput] = useState('')
  const addLabel = (): void => {
    const trimmed = labelInput.trim()
    if (trimmed === '' || draft.mrIgnoreLabels.some(item => item.toLowerCase() === trimmed.toLowerCase())) return
    setDraft({ ...draft, mrIgnoreLabels: [...draft.mrIgnoreLabels, trimmed] })
    setLabelInput('')
  }
  const mrs = supervision?.mrs ?? []
  const breakers = supervision?.breakers ?? []
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">审微运行状态与熔断器</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">
                <span className={`lz__pill ${supervision?.enabled ? 'lz__pill--ok' : ''}`}><span className="lz__dot" />{supervision?.enabled ? '自动轮询运行中' : '已暂停'}</span>
                <span className="lz__tag">活跃会话 {supervision?.running ?? 0}</span>
                <span className="lz__tag">防抖等待 {supervision?.debouncing ?? 0}</span>
              </div>
              <div className="lz__rowSummary">
                {supervision?.lastPollAt === undefined ? '尚未执行首轮 MR 轮询。' : `上次轮询：${formatTime(supervision.lastPollAt)}`}
                {supervision?.lastError === undefined ? '' : ` · 最近异常：${supervision.lastError}`}
              </div>
            </div>
          </div>
          {breakers.length === 0 ? <div className="lz__emptyRow">当前没有活跃计数或已触发的熔断器。</div> : null}
          {breakers.map(item => (
            <div key={`${item.scope}:${item.key}`} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">{BREAKER_SCOPE_LABEL[item.scope]}</span>
                  <span className="lz__mono">{item.key}</span>
                  <span className={`lz__pill ${item.tripped ? 'lz__pill--bad' : 'lz__pill--ok'}`}>
                    <span className="lz__dot" />
                    {item.tripped ? '已熔断' : '计数中'}（{item.count}/{item.limit}）
                  </span>
                </div>
                {item.reason === undefined ? null : <div className="lz__rowSummary">{item.reason}</div>}
              </div>
              <div className="lz__rowCtl">
                <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onResetBreaker(item.scope, item.key) }}>解除熔断</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">受监管 MR 列表</h2>
        <div className="lz__list">
          {mrs.length === 0 ? <div className="lz__emptyRow">暂无已纳管的合并请求。请在「应用仓库」对应项目的 dsh-repo 中开启「MR 自动评审」。</div> : null}
          {mrs.map((mr) => {
            const st = MR_STATE_LABEL[mr.state]
            return (
              <div key={`${mr.repo}#${mr.mrNumber}`} className="lz__row lz__row--top">
                <div className="lz__rowText">
                  <div className="lz__rowLabel">
                    {mr.url === undefined
                      ? <span className="lz__mono">#{mr.mrNumber}</span>
                      : <a href={mr.url} target="_blank" rel="noreferrer" className="lz__mono">#{mr.mrNumber}</a>}
                    <span>{mr.title ?? mr.repo}</span>
                    <span className={`lz__pill ${st.pill}`}><span className="lz__dot" />{st.text}</span>
                    <span className="lz__tag">{mr.origin}</span>
                  </div>
                  <div className="lz__rowSummary">
                    <span className="lz__mono">{mr.repo}</span>
                    {mr.sourceBranch !== undefined && mr.targetBranch !== undefined ? ` · ${mr.sourceBranch} → ${mr.targetBranch}` : ''}
                    {mr.headSha !== undefined ? ` · HEAD ${mr.headSha.slice(0, 8)}` : ''}
                    {mr.lastReviewedSha !== undefined ? ` · 已审 ${mr.lastReviewedSha.slice(0, 8)}` : ''}
                    {mr.pendingCount > 0 ? ` · 待处理 ${mr.pendingCount} (${mr.pendingKinds.join(', ')})` : ''}
                    {mr.autoFixAttempts > 0 ? ` · CI 自修 ${mr.autoFixAttempts} 次` : ''}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">MR 自动评审策略与安全限流 <Overridden keys={overridden} name="mrReview" /></h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">启用有状态 MR 自动评审（审微）</div>
              <div className="lz__rowSummary">开启后按轮询间隔扫描开启「MR 自动评审」的仓库，持续追踪新提交、新评论与己方 MR CI 状态。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="启用 MR 自动评审" checked={draft.mrEnabled} onChange={(event) => { setDraft({ ...draft, mrEnabled: event.target.checked }) }} /></div>
          </div>
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">跳过草稿（Draft）MR</div>
              <div className="lz__rowSummary">草稿期间不触发评审，转为正式（Ready for review）后自动触发首次评审。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="跳过草稿 MR" checked={draft.mrSkipDraft} onChange={(event) => { setDraft({ ...draft, mrSkipDraft: event.target.checked }) }} /></div>
          </div>
          <NumberRow label="轮询间隔" summary="增量轮询远端 MR 更新的时间间隔。" unit="秒" value={draft.mrPollIntervalSec} onChange={(value) => { setDraft({ ...draft, mrPollIntervalSec: value }) }} />
          <NumberRow label="信号防抖窗口" summary="收到 push 或新评论后的静默合并窗口，0 表示立即唤醒。" unit="秒" value={draft.mrDebounceSec} onChange={(value) => { setDraft({ ...draft, mrDebounceSec: value }) }} />
          <NumberRow label="MR 评审并发上限" summary="同时运行的 MR 评审/修复会话最大数量（mrPool）。" unit="个" value={draft.mrMaxConcurrent} onChange={(value) => { setDraft({ ...draft, mrMaxConcurrent: value }) }} />
          <NumberRow label="CI 自动修复上限" summary="每个己方 MR 触发 CI 失败自修的最大次数，超出后触发熔断并人工提醒。" unit="次" value={draft.mrMaxAutoFix} onChange={(value) => { setDraft({ ...draft, mrMaxAutoFix: value }) }} />
          <NumberRow label="单 MR 24h 唤醒上限" summary="单个 MR 每天最多唤醒会话次数。" unit="次" value={draft.mrDailyTurnLimit} onChange={(value) => { setDraft({ ...draft, mrDailyTurnLimit: value }) }} />
          <NumberRow label="单仓库 1h 唤醒上限" summary="单个仓库每小时最多唤醒 MR 会话次数。" unit="次" value={draft.mrRepoHourlyLimit} onChange={(value) => { setDraft({ ...draft, mrRepoHourlyLimit: value }) }} />
          {draft.mrIgnoreLabels.map(label => (
            <div key={label} className="lz__row">
              <div className="lz__rowText"><span className="lz__mono">忽略标签：{label}</span></div>
              <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" onClick={() => { setDraft({ ...draft, mrIgnoreLabels: draft.mrIgnoreLabels.filter(item => item !== label) }) }}>移除</button></div>
            </div>
          ))}
          <div className="lz__addRow">
            <input className="lz__input" placeholder="忽略标签名，例如 no-ai-review" value={labelInput} onChange={(event) => { setLabelInput(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') addLabel() }} />
            <button type="button" className="lz__btn" disabled={labelInput.trim() === ''} onClick={addLabel}>添加忽略标签</button>
          </div>
        </div>
      </section>
    </>
  )
}

const LOG_TASK_STATUS_LABEL: Readonly<Record<'running' | 'completed' | 'failed' | 'interrupted', { pill: string; text: string }>> = {
  running: { pill: 'lz__pill--warn', text: '分析中' },
  completed: { pill: 'lz__pill--ok', text: '已完成' },
  failed: { pill: 'lz__pill--bad', text: '失败' },
  interrupted: { pill: 'lz__pill--warn', text: '已中断' },
}

function LogSupervisionTab({
  draft,
  setDraft,
  supervision,
  overridden,
  busy,
  onResetBreaker,
  onUpdateWatermark,
  onRetryOutbox,
}: TabProps & {
  supervision: LogSupervisionWire | undefined
  overridden: readonly EditableKey[]
  busy: boolean
  onResetBreaker: (scope: BreakerStatusWire['scope'], key: string) => void
  onUpdateWatermark: (payload: { action: 'pause' | 'resume' | 'rewind'; cursorTime?: string }) => void
  onRetryOutbox: (key?: string) => void
}): JSX.Element {
  const [rewindTime, setRewindTime] = useState('')
  const wm = supervision?.watermark
  const batches = supervision?.pendingBatches ?? []
  const tasks = supervision?.tasks ?? []
  const dead = supervision?.outboxDead ?? []
  const breakers = supervision?.breakers ?? []
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">观象轮询水位线与运行状态</h2>
        <div className="lz__list">
          <div className="lz__row lz__row--top">
            <div className="lz__rowText">
              <div className="lz__rowLabel">
                <span className={`lz__pill ${supervision?.enabled && !wm?.paused ? 'lz__pill--ok' : 'lz__pill--warn'}`}>
                  <span className="lz__dot" />
                  {!supervision?.enabled ? '自动轮询未开启' : wm?.paused ? '水位线已暂停' : '自动轮询运行中'}
                </span>
                <span className="lz__tag">运行中批次 {supervision?.running ?? 0}</span>
                <span className="lz__tag">待发车组 {batches.length}</span>
                <span className="lz__tag">回传队列 {supervision?.outboxPendingCount ?? 0}</span>
              </div>
              <div className="lz__rowSummary">
                {wm?.cursorTime === undefined ? '尚未初始化 archived_at 水位线（首次开启轮询时从当前时刻开始）。' : `当前水位线：${wm.cursorTime}`}
                {wm?.lastPollAt === undefined ? '' : ` · 上次轮询：${formatTime(wm.lastPollAt)}`}
                {wm?.lastError === undefined ? '' : ` · 异常（连续 ${wm.consecutiveFailures} 次）：${wm.lastError}`}
              </div>
              <div className="lz__addRow lz__addRow--flush">
                <input
                  className="lz__input lz__mono"
                  placeholder="回拨 ISO 时间，例如 2026-11-10T00:00:00Z"
                  value={rewindTime}
                  onChange={(event) => { setRewindTime(event.target.value) }}
                />
                <button
                  type="button"
                  className="lz__btn"
                  disabled={busy || rewindTime.trim() === ''}
                  onClick={() => { onUpdateWatermark({ action: 'rewind', cursorTime: rewindTime.trim() }) }}
                >
                  回拨补跑
                </button>
                <button
                  type="button"
                  className="lz__btn lz__btn--ghost"
                  disabled={busy}
                  onClick={() => { onUpdateWatermark({ action: wm?.paused ? 'resume' : 'pause' }) }}
                >
                  {wm?.paused ? '恢复轮询' : '暂停轮询'}
                </button>
              </div>
            </div>
          </div>
          {breakers.map(item => (
            <div key={`${item.scope}:${item.key}`} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">{BREAKER_SCOPE_LABEL[item.scope]}</span>
                  <span className="lz__mono">{item.key}</span>
                  <span className={`lz__pill ${item.tripped ? 'lz__pill--bad' : 'lz__pill--ok'}`}>
                    <span className="lz__dot" />
                    {item.tripped ? '已熔断' : '计数中'}（{item.count}/{item.limit}）
                  </span>
                </div>
                {item.reason === undefined ? null : <div className="lz__rowSummary">{item.reason}</div>}
              </div>
              <div className="lz__rowCtl">
                <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onResetBreaker(item.scope, item.key) }}>解除熔断</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">平台报告死信队列（{dead.length}）</h2>
        <div className="lz__list">
          {dead.length === 0
            ? <div className="lz__emptyRow">当前没有进入死信状态的平台报告回传任务。</div>
            : (
                <>
                  <div className="lz__row">
                    <div className="lz__rowText">
                      <div className="lz__rowLabel">批量重试死信回传</div>
                      <div className="lz__rowSummary">将所有处于 dead 状态的报告修订重置为 pending 并立即尝试回传。</div>
                    </div>
                    <div className="lz__rowCtl">
                      <button type="button" className="lz__btn" disabled={busy} onClick={() => { onRetryOutbox(undefined) }}>全部重试</button>
                    </div>
                  </div>
                  {dead.map(item => (
                    <div key={item.key} className="lz__row">
                      <div className="lz__rowText">
                        <div className="lz__rowLabel">
                          <span className="lz__mono">{item.logId}</span>
                          <span className="lz__tag">task {item.taskId.slice(0, 8)} · rev {item.revision}</span>
                          <span className="lz__tag">尝试 {item.attempts} 次</span>
                        </div>
                        {item.lastError === undefined ? null : <div className="lz__rowError">{item.lastError}</div>}
                      </div>
                      <div className="lz__rowCtl">
                        <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onRetryOutbox(item.key) }}>重试</button>
                      </div>
                    </div>
                  ))}
                </>
              )}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">近期日志监管任务（{tasks.length}）</h2>
        <div className="lz__list">
          {tasks.length === 0 ? <div className="lz__emptyRow">暂无日志监管任务记录。</div> : null}
          {tasks.map((task) => {
            const st = LOG_TASK_STATUS_LABEL[task.status]
            return (
              <div key={task.taskId} className="lz__row lz__row--top">
                <div className="lz__rowText">
                  <div className="lz__rowLabel">
                    <span className="lz__mono">{task.appName ?? task.appId}</span>
                    <span className={`lz__pill ${st.pill}`}><span className="lz__dot" />{st.text}</span>
                    <span className="lz__tag">{task.source}</span>
                    <span className="lz__tag">{task.inputCount} 份日志</span>
                    <span className="lz__tag">{task.revisionCount} 个修订</span>
                  </div>
                  <div className="lz__rowSummary">
                    <span className="lz__mono">{task.taskId}</span>
                    {task.errorCode === undefined ? '' : ` · 错误码 ${task.errorCode}`}
                    {task.latestSummary === undefined ? '' : ` · ${task.latestSummary}`}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">日志自动监管与攒批策略 <Overridden keys={overridden} name="logSupervision" /></h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">启用日志平台自动轮询监管（观象）</div>
              <div className="lz__rowSummary">按 archived_at 水位线增量拉取已归档 FDS 日志，按 (product, component, error_code) 攒批触发诊断与可选修复建议。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="启用日志平台自动轮询" checked={draft.logEnabled} onChange={(event) => { setDraft({ ...draft, logEnabled: event.target.checked }) }} /></div>
          </div>
          <TextRow label="飞书投递目标群" summary="自动批次结果卡与话题发到此群（oc_ 开头）；留空则无头运行。" placeholder="oc_xxx" value={draft.logFeishuChatId} onChange={(value) => { setDraft({ ...draft, logFeishuChatId: value }) }} />
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">飞书投递模式</div>
              <div className="lz__rowSummary">静默分析（推荐）：分析与回传完成后发一张结论卡并绑定话题；开局建话题：发车即建话题流式可见。</div>
            </div>
            <div className="lz__rowCtl">
              <select className="lz__input" aria-label="飞书投递模式" value={draft.logDeliveryMode} onChange={(event) => { setDraft({ ...draft, logDeliveryMode: event.target.value === 'topic-on-start' ? 'topic-on-start' : 'quiet-until-done' }) }}>
                <option value="quiet-until-done">静默分析、产出即建话题</option>
                <option value="topic-on-start">开局建话题流式可见</option>
              </select>
            </div>
          </div>
          <NumberRow label="平台轮询间隔" unit="秒" value={draft.logPollIntervalSec} onChange={(value) => { setDraft({ ...draft, logPollIntervalSec: value }) }} />
          <NumberRow label="攒批触发条数" summary="同组日志累计达到该条数时立即发车（不超过单批上限）。" unit="份" value={draft.logBatchSizeThreshold} onChange={(value) => { setDraft({ ...draft, logBatchSizeThreshold: value }) }} />
          <NumberRow label="单批日志上限" unit="份" value={draft.logMaxBatchSize} onChange={(value) => { setDraft({ ...draft, logMaxBatchSize: value }) }} />
          <NumberRow label="攒批等待窗口" summary="首条日志进入窗口后的最长等待时间（0 表示立即发车）。" unit="分钟" value={draft.logBatchWindowMin} onChange={(value) => { setDraft({ ...draft, logBatchWindowMin: value }) }} />
          <NumberRow label="日志并发上限" summary="同时运行的日志监管任务最大数量（logPool）。" unit="个" value={draft.logMaxConcurrentBatches} onChange={(value) => { setDraft({ ...draft, logMaxConcurrentBatches: value }) }} />
          <NumberRow label="单应用小时批次数上限" summary="超过后该应用进入 throttled 熔断，不影响其他应用。" unit="批" value={draft.logAppHourlyBatchLimit} onChange={(value) => { setDraft({ ...draft, logAppHourlyBatchLimit: value }) }} />
          <NumberRow label="单日志安全解压上限" unit="MB" value={draft.logMaxUnpackMb} onChange={(value) => { setDraft({ ...draft, logMaxUnpackMb: value }) }} />
        </div>
      </section>
    </>
  )
}
