/**
 * 左侧栏「智能监管」统一 5 标签页主区面板：
 * 1. 运行总览（overview）
 * 2. 应用与日志监管（log）
 * 3. MR 自动评审（mr）
 * 4. 已知问题库（issues）
 * 5. 模型与高级（advanced）
 *
 * 顶部状态条与底部保存条统一联动一份面板草稿，仓库启停归 dsh-repo 管理，
 * 应用描述与触发别名按仓库独立保存，已知问题库支持一键与飞书多维表格双向同步及映射自检。
 *
 * @module dsh-supervisor/client/page
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { parseBitableUrl } from '../deps/bitable.ts'
import type {
  AnalysisWire,
  AnalyzeWire,
  ApplicationMetadata,
  BitableAvailability,
  BreakerStatusWire,
  EditableKey,
  EditableSettings,
  IssueItemWire,
  IssueOverviewWire,
  LegacyReportWire,
  LogDeliveryMode,
  LogSupervisionWire,
  MrSupervisionWire,
  PlatformClientAuth,
  ReportStatus,
  RepoStatusWire,
  StateWire,
  SupervisedMrWire,
  TokenStatusWire,
  UploadPhase,
} from '../settings/contract.ts'
import { CHAT_ID_PATTERN } from '../settings/contract.ts'
import {
  checkIssuesBitable,
  clearToken,
  fetchState,
  messageOf,
  resetBreaker,
  resetSettings,
  retryOutboxDead,
  retryReport,
  saveApplication,
  saveSettings,
  saveToken,
  syncIssues,
  updateLogWatermark,
} from './api.ts'

/** Sidebar label and page title. */
export const PANEL_TITLE = '智能监管'

const KB = 1024
const MB = 1024 * 1024
const MINUTE = 60 * 1000

type TabId = 'overview' | 'log' | 'mr' | 'issues' | 'advanced'

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'overview', label: '运行总览' },
  { id: 'log', label: '应用与日志监管' },
  { id: 'mr', label: 'MR 自动评审' },
  { id: 'issues', label: '已知问题库' },
  { id: 'advanced', label: '模型与高级' },
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
  mrCustomInstructions: string
  mrFeishuChatId: string
  logEnabled: boolean
  logPollIntervalSec: string
  logPollLagSec: string
  logBatchSizeThreshold: string
  logMaxBatchSize: string
  logBatchWindowMin: string
  logMaxConcurrentBatches: string
  logAppHourlyBatchLimit: string
  logFeishuChatId: string
  logDeliveryMode: LogDeliveryMode
  logMaxUnpackMb: string
  issueSyncEnabled: boolean
  issueBitableUrl: string
  issueTable: string
  issueSyncIntervalSec: string
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
    mrCustomInstructions: settings.mrReview.customInstructions ?? '',
    mrFeishuChatId: settings.mrReview.feishuChatId ?? '',
    logEnabled: settings.logSupervision.enabled,
    logPollIntervalSec: trimNumber(settings.logSupervision.pollIntervalMs / 1000),
    logPollLagSec: trimNumber(settings.logSupervision.pollLagMs / 1000),
    logBatchSizeThreshold: String(settings.logSupervision.batchSizeThreshold),
    logMaxBatchSize: String(settings.logSupervision.maxBatchSize),
    logBatchWindowMin: trimNumber(settings.logSupervision.batchWindowMs / MINUTE),
    logMaxConcurrentBatches: String(settings.logSupervision.maxConcurrentBatches),
    logAppHourlyBatchLimit: String(settings.logSupervision.appHourlyBatchLimit),
    logFeishuChatId: settings.logSupervision.feishuChatId ?? '',
    logDeliveryMode: settings.logSupervision.deliveryMode,
    logMaxUnpackMb: trimNumber(settings.logSupervision.maxUnpackBytes / MB),
    issueSyncEnabled: settings.issueSync.enabled,
    issueBitableUrl: settings.issueSync.bitableUrl ?? '',
    issueTable: settings.issueSync.table ?? '',
    issueSyncIntervalSec: trimNumber(settings.issueSync.syncIntervalMs / 1000),
  }
}

function integer(text: string, label: string, allowZero = false): number {
  const value = positive(text, label, allowZero)
  if (!Number.isInteger(value)) throw new Error(`${label}必须是整数`)
  return value
}

function positive(text: string, label: string, allowZero = false): number {
  const value = Number(text.trim())
  if (text.trim() === '' || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label}必须是${allowZero ? '非负' : '正'}数`)
  }
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
  const logFeishuChatId = draft.logFeishuChatId.trim()
  if (logFeishuChatId !== '' && !CHAT_ID_PATTERN.test(logFeishuChatId)) {
    throw new Error('日志监管目标群必须是飞书群的 chat_id（oc_ 开头）')
  }
  const mrFeishuChatId = draft.mrFeishuChatId.trim()
  if (mrFeishuChatId !== '' && !CHAT_ID_PATTERN.test(mrFeishuChatId)) {
    throw new Error('MR 告警通知群必须是飞书群的 chat_id（oc_ 开头）')
  }
  const logBatchSizeThreshold = integer(draft.logBatchSizeThreshold, '攒批触发条数')
  const logMaxBatchSize = integer(draft.logMaxBatchSize, '单批日志上限')
  if (logBatchSizeThreshold > logMaxBatchSize) throw new Error('攒批触发条数不能大于单批日志上限')

  const issueBitableUrl = draft.issueBitableUrl.trim()
  if (issueBitableUrl !== '' && parseBitableUrl(issueBitableUrl) === undefined) {
    throw new Error('飞书多维表格地址不合法：请填写 https://…/base/<token> 或 https://…/wiki/<token>')
  }
  const issueSyncIntervalMs = Math.round(positive(draft.issueSyncIntervalSec, '多维表格同步周期') * 1000)
  if (issueSyncIntervalMs < 5000) {
    throw new Error('多维表格同步周期至少 5 秒')
  }

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
      ...optionalText(draft.mrCustomInstructions, 'customInstructions'),
      ...mrFeishuChatId === '' ? {} : { feishuChatId: mrFeishuChatId },
    },
    logSupervision: {
      enabled: draft.logEnabled,
      pollIntervalMs: Math.round(positive(draft.logPollIntervalSec, '日志轮询间隔') * 1000),
      pollLagMs: Math.round(positive(draft.logPollLagSec, '轮询安全滞后', true) * 1000),
      batchSizeThreshold: logBatchSizeThreshold,
      maxBatchSize: logMaxBatchSize,
      batchWindowMs: Math.round(positive(draft.logBatchWindowMin, '攒批等待窗口', true) * MINUTE),
      maxConcurrentBatches: integer(draft.logMaxConcurrentBatches, '日志并发上限'),
      appHourlyBatchLimit: integer(draft.logAppHourlyBatchLimit, '单应用小时批次数上限'),
      ...logFeishuChatId === '' ? {} : { feishuChatId: logFeishuChatId },
      deliveryMode: draft.logDeliveryMode,
      maxUnpackBytes: Math.round(positive(draft.logMaxUnpackMb, '单日志解压上限') * MB),
    },
    issueSync: {
      enabled: draft.issueSyncEnabled,
      ...issueBitableUrl === '' ? {} : { bitableUrl: issueBitableUrl },
      ...optionalText(draft.issueTable, 'table'),
      syncIntervalMs: issueSyncIntervalMs,
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
export interface SupervisorPageProps {
  /** Opens dsh-repo's page on the Plugins panel; absent hides the link. */
  readonly openRepoSettings?: (() => void) | undefined
}

/**
 * Main-column page for the `main` slot.
 * @param props - navigation supplied by the client entry.
 * @returns the page.
 */
export function SupervisorPage({ openRepoSettings }: SupervisorPageProps): JSX.Element {
  return (
    <section className="lz-page" aria-label={PANEL_TITLE}>
      <div className="lz-page__content">
        <SupervisorPanel openRepoSettings={openRepoSettings} />
      </div>
    </section>
  )
}

/**
 * The `main` slot component, bound to a way of opening dsh-repo's settings.
 * @param openRepoSettings - opens dsh-repo's page on the Plugins panel, or undefined while that panel is unavailable.
 * @returns component rendering {@link SupervisorPage}.
 */
export function boundSupervisorPage(openRepoSettings: () => (() => void) | undefined): () => JSX.Element {
  return () => <SupervisorPage openRepoSettings={openRepoSettings()} />
}

type Notice = { kind: 'ok' | 'error'; text: string } | undefined

const BREAKER_SCOPE_LABEL: Readonly<Record<BreakerStatusWire['scope'], string>> = {
  mr: '单 MR 日限',
  'mr-repo': '单仓库时限',
  'mr-fix': 'CI 自修上限',
  'log-app': '日志应用时限',
}

const LOG_TASK_STATUS_LABEL: Readonly<Record<'running' | 'completed' | 'failed' | 'interrupted', { pill: string; text: string }>> = {
  running: { pill: 'lz__pill--warn', text: '分析中' },
  completed: { pill: 'lz__pill--ok', text: '已完成' },
  failed: { pill: 'lz__pill--bad', text: '失败' },
  interrupted: { pill: 'lz__pill--warn', text: '已中断' },
}

const MR_STATE_LABEL: Readonly<Record<SupervisedMrWire['state'], { pill: string; text: string }>> = {
  open: { pill: 'lz__pill--ok', text: '监管中' },
  merged: { pill: 'lz__pill', text: '已合并' },
  closed: { pill: 'lz__pill', text: '已关闭' },
  draft_skipped: { pill: 'lz__pill--warn', text: '草稿跳过' },
}

const BITABLE_STATUS_LABEL: Readonly<Record<BitableAvailability, { pill: string; text: string }>> = {
  ready: { pill: 'lz__pill--ok', text: '多维表格能力就绪' },
  missing: { pill: 'lz__pill--warn', text: '未检测到 dsh-channels 多维表格能力' },
  incompatible: { pill: 'lz__pill--bad', text: '多维表格服务版本不兼容' },
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

/**
 * Panel body: loads state, edits a unified draft, saves across 5 tabs.
 * @param props - navigation supplied by the client entry.
 * @returns the panel.
 */
export function SupervisorPanel({ openRepoSettings }: SupervisorPageProps): JSX.Element {
  const [state, setState] = useState<StateWire | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [draft, setDraft] = useState<Draft | undefined>()
  const [tab, setTab] = useState<TabId>('overview')
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

  const syncingRepos = state?.repos.some(repo => repo.phase === 'syncing') === true
  const syncingBitable = state?.issues?.syncing === true
  useEffect(() => {
    if (!syncingRepos && !syncingBitable) return
    const timer = setInterval(() => { void reload(false) }, 2000)
    return () => { clearInterval(timer) }
  }, [syncingRepos, syncingBitable, reload])

  useEffect(() => {
    if (tab !== 'overview' && tab !== 'log' && tab !== 'mr' && tab !== 'issues') return
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
  const issueCount = state.issues?.totalCount ?? 0
  const issueDirty = state.issues?.dirtyCount ?? 0
  const trippedCount = [
    ...(state.logSupervision?.breakers ?? []),
    ...(state.mrSupervision?.breakers ?? []),
  ].filter(item => item.tripped).length

  return (
    <div className="lz">
      <header className="lz__head">
        <div className="lz__headRow">
          <h1 className="lz__title">{PANEL_TITLE}</h1>
          <span className={`lz__pill ${available > 0 ? 'lz__pill--ok' : 'lz__pill--warn'}`}><span className="lz__dot" />{available} 个日志应用</span>
          <span className={`lz__pill ${mrCount > 0 && state.dshRepo.mrReviewReady !== false ? 'lz__pill--ok' : ''}`}><span className="lz__dot" />{mrCount} 个 MR 仓库</span>
          <span className={`lz__pill ${issueDirty > 0 ? 'lz__pill--warn' : issueCount > 0 ? 'lz__pill--ok' : ''}`}>
            <span className="lz__dot" />
            问题库 {issueCount} 条{issueDirty > 0 ? `（待同步 ${issueDirty}）` : ''}
          </span>
          {trippedCount > 0 ? <span className="lz__pill lz__pill--bad"><span className="lz__dot" />{trippedCount} 项熔断</span> : null}
          {syncingRepos || syncingBitable ? <span className="lz__pill lz__pill--warn"><span className="lz__dot" />{syncingBitable ? '表格同步中' : '读取中'}</span> : null}
        </div>
        <div className="lz__meta">观象察志，审微知著：统一管理应用日志诊断、MR 自动评审、已知问题库双向同步与模型策略。</div>
        <div className="lz__tabs" role="tablist">
          {TABS.map(item => (
            <button key={item.id} type="button" role="tab" className="lz__tab" aria-selected={tab === item.id} onClick={() => { setTab(item.id) }}>{item.label}</button>
          ))}
        </div>
      </header>
      {state.overlayError === undefined ? null : <div className="lz__notice lz__notice--error">面板设置文件未生效：{state.overlayError}。保存一次会用当前内容覆盖它。</div>}
      <div className="lz__body" role="tabpanel">
        {tab === 'overview'
          ? <OverviewTab
              state={state}
              busy={busy}
              onSwitchTab={setTab}
              onResetBreaker={(scope, key) => { void run(() => resetBreaker(scope, key), '已解除熔断并恢复等待任务', false) }}
              onRetryOutbox={(key) => { void run(() => retryOutboxDead(key), '已重新入队死信报告', false) }}
            />
          : null}
        <div hidden={tab !== 'log'}>
          <LogReposSection state={state} openRepoSettings={openRepoSettings} busy={busy} onSave={saveApp} />
        </div>
        {tab === 'log'
          ? <LogSupervisionAndConfigTab
              draft={draft}
              setDraft={setDraft}
              supervision={state.logSupervision}
              analyze={state.analyze}
              credentialsAvailable={state.credentialsAvailable}
              overridden={state.overridden}
              busy={busy}
              onResetBreaker={(scope, key) => { void run(() => resetBreaker(scope, key), '已解除熔断并恢复等待任务', false) }}
              onUpdateWatermark={(payload) => { void run(() => updateLogWatermark(payload), '已更新日志轮询水位线', false) }}
              onRetryOutbox={(key) => { void run(() => retryOutboxDead(key), '已重新入队死信报告', false) }}
              onSaveCredential={async (tokenEnv, value) => await run(() => saveToken(tokenEnv, value), '已保存日志平台 client_secret', false) !== undefined}
              onClearCredential={(tokenEnv) => { void run(() => clearToken(tokenEnv), '已清除面板保存的值', false) }}
              onRetry={(id) => { void run(() => retryReport(id), '已开始重新回传', false) }}
            />
          : null}
        {tab === 'mr'
          ? <MrReviewTab
              state={state}
              draft={draft}
              setDraft={setDraft}
              openRepoSettings={openRepoSettings}
              busy={busy}
              onResetBreaker={(scope, key) => { void run(() => resetBreaker(scope, key), '已解除熔断并恢复等待任务', false) }}
            />
          : null}
        {tab === 'issues'
          ? <IssuesTab
              draft={draft}
              setDraft={setDraft}
              overview={state.issues}
              savedSettings={state.settings.issueSync}
              overridden={state.overridden}
              dirty={dirty}
              busy={busy}
              onSyncNow={() => { void run(() => syncIssues(), '已完成已知问题库与飞书多维表格双向同步', false) }}
              onCheckMapping={() => {
                void run(
                  () => checkIssuesBitable({
                    bitableUrl: draft.issueBitableUrl.trim(),
                    table: draft.issueTable.trim(),
                  }),
                  '已完成多维表格字段映射自检',
                  false,
                )
              }}
            />
          : null}
        {tab === 'advanced'
          ? <AdvancedTab
              draft={draft}
              setDraft={setDraft}
              state={state}
              busy={busy}
              onReset={() => { void run(resetSettings, '已恢复为 cordis.yml 中的配置', true) }}
            />
          : null}
      </div>
      {notice === undefined ? null : <div className={`lz__notice lz__notice--${notice.kind}`}>{notice.text}</div>}
      {!dirty && tab === 'overview'
        ? null
        : (
            <div className="lz__saveBar">
              <span className="lz__saveMsg">{dirty ? '有未保存的修改（跨分页统一保存）' : '设置已保存'}</span>
              <button type="button" className="lz__btn lz__btn--ghost" disabled={!dirty || busy} onClick={() => { setDraft(toDraft(state.settings)); setNotice(undefined) }}>放弃修改</button>
              <button type="button" className="lz__btn lz__btn--primary" disabled={!dirty || busy} onClick={save}>保存</button>
            </div>
          )}
    </div>
  )
}

interface TabProps {
  draft: Draft
  setDraft: (next: Draft) => void
}

// ---------------------------------------------------------------------------
// Tab 1: 运行总览
// ---------------------------------------------------------------------------

function OverviewTab({
  state,
  busy,
  onSwitchTab,
  onResetBreaker,
  onRetryOutbox,
}: {
  state: StateWire
  busy: boolean
  onSwitchTab: (tab: TabId) => void
  onResetBreaker: (scope: BreakerStatusWire['scope'], key: string) => void
  onRetryOutbox: (key?: string) => void
}): JSX.Element {
  const availableApps = state.repos.filter(r => r.available).length
  const logSup = state.logSupervision
  const mrSup = state.mrSupervision
  const issues = state.issues
  const openMrs = (mrSup?.mrs ?? []).filter(m => m.state === 'open')
  const logTasks = logSup?.tasks ?? []
  const dead = logSup?.outboxDead ?? []
  const trippedBreakers = [
    ...(logSup?.breakers ?? []),
    ...(mrSup?.breakers ?? []),
  ].filter(b => b.tripped)

  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">监管域健康总览</h2>
        <div className="lz__grid">
          <div className="lz__card">
            <div className="lz__cardTitle">
              <span>观象 · 日志监管</span>
              <span className={`lz__pill ${logSup?.enabled ? 'lz__pill--ok' : ''}`}>
                <span className="lz__dot" />
                {logSup?.enabled ? '自动轮询' : '手动/接口'}
              </span>
            </div>
            <div className="lz__cardVal">{availableApps} 个应用</div>
            <div className="lz__cardMeta">
              运行中 {logSup?.running ?? 0} · 待发 {logSup?.pendingBatches.length ?? 0} · 回传队列 {logSup?.outboxPendingCount ?? 0}
            </div>
            <div>
              <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { onSwitchTab('log') }}>查看详情</button>
            </div>
          </div>

          <div className="lz__card">
            <div className="lz__cardTitle">
              <span>审微 · MR 评审</span>
              <span className={`lz__pill ${mrSup?.enabled ? 'lz__pill--ok' : ''}`}>
                <span className="lz__dot" />
                {mrSup?.enabled ? '自动评审' : '已暂停'}
              </span>
            </div>
            <div className="lz__cardVal">{openMrs.length} 个开放 MR</div>
            <div className="lz__cardMeta">
              托管 {state.mrRepos.length} 仓库 · 活跃 {mrSup?.running ?? 0} · 防抖 {mrSup?.debouncing ?? 0}
            </div>
            <div>
              <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { onSwitchTab('mr') }}>查看详情</button>
            </div>
          </div>

          <div className="lz__card">
            <div className="lz__cardTitle">
              <span>已知问题库</span>
              <span className={`lz__pill ${issues?.bitableAvailable === 'ready' ? 'lz__pill--ok' : 'lz__pill--warn'}`}>
                <span className="lz__dot" />
                {issues?.enabled ? (state.settings.issueSync.bitableUrl === undefined ? '未填表' : issues.bitableAvailable === 'ready' ? '就绪' : '离线') : '已关'}
              </span>
            </div>
            <div className="lz__cardVal">{issues?.totalCount ?? 0} 条</div>
            <div className="lz__cardMeta">
              已关联 {issues?.linkedCount ?? 0} · 人工确认 {issues?.humanConfirmedCount ?? 0} · 待推送 {issues?.dirtyCount ?? 0}
            </div>
            <div>
              <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { onSwitchTab('issues') }}>查看问题库</button>
            </div>
          </div>

          <div className="lz__card">
            <div className="lz__cardTitle">
              <span>宿主与模型</span>
              <span className={`lz__pill ${state.analyze.topics === 'ready' && state.dshRepo.availability === 'ready' ? 'lz__pill--ok' : 'lz__pill--warn'}`}>
                <span className="lz__dot" />
                {state.runtime?.subagentProvider ?? 'spawn'}
              </span>
            </div>
            <div className="lz__cardVal">{state.settings.logSupervision.enabled ? '自动轮询开启' : '自动轮询关闭'}</div>
            <div className="lz__cardMeta">
              dsh-repo: {state.dshRepo.availability} · 飞书话题: {state.analyze.topics}
            </div>
            <div>
              <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { onSwitchTab('advanced') }}>模型与高级</button>
            </div>
          </div>
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">待关注异常与熔断恢复（{trippedBreakers.length + dead.length}）</h2>
        <div className="lz__list">
          {trippedBreakers.length === 0 && dead.length === 0 && issues?.lastError === undefined
            ? <div className="lz__emptyRow">当前无已触发的熔断器、死信任务或同步错误。</div>
            : null}
          {issues?.lastError === undefined
            ? null
            : (
                <div className="lz__row">
                  <div className="lz__rowText">
                    <div className="lz__rowLabel">
                      <span className="lz__tag">多维表格同步异常</span>
                      <span className="lz__pill lz__pill--bad"><span className="lz__dot" />失败</span>
                    </div>
                    <div className="lz__rowError">{issues.lastError}</div>
                  </div>
                  <div className="lz__rowCtl">
                    <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { onSwitchTab('issues') }}>前往排查</button>
                  </div>
                </div>
              )}
          {trippedBreakers.map(item => (
            <div key={`${item.scope}:${item.key}`} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">{BREAKER_SCOPE_LABEL[item.scope]}</span>
                  <span className="lz__mono">{item.key}</span>
                  <span className="lz__pill lz__pill--bad"><span className="lz__dot" />已熔断（{item.count}/{item.limit}）</span>
                </div>
                {item.reason === undefined ? null : <div className="lz__rowSummary">{item.reason}</div>}
              </div>
              <div className="lz__rowCtl">
                <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onResetBreaker(item.scope, item.key) }}>解除熔断</button>
              </div>
            </div>
          ))}
          {dead.map(item => (
            <div key={item.key} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">平台死信</span>
                  <span className="lz__mono">{item.logId}</span>
                  <span className="lz__tag">rev {item.revision}</span>
                </div>
                {item.lastError === undefined ? null : <div className="lz__rowError">{item.lastError}</div>}
              </div>
              <div className="lz__rowCtl">
                <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onRetryOutbox(item.key) }}>立即重试</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">近期活动</h2>
        <div className="lz__list">
          {logTasks.length === 0 && openMrs.length === 0
            ? <div className="lz__emptyRow">暂无近期的日志诊断或 MR 评审记录。</div>
            : null}
          {logTasks.slice(0, 4).map((task) => {
            const st = LOG_TASK_STATUS_LABEL[task.status]
            return (
              <div key={task.taskId} className="lz__row">
                <div className="lz__rowText">
                  <div className="lz__rowLabel">
                    <span className="lz__tag">日志任务</span>
                    <span className="lz__mono">{task.appName ?? task.appId}</span>
                    <span className={`lz__pill ${st.pill}`}><span className="lz__dot" />{st.text}</span>
                    <span className="lz__tag">{task.inputCount} 份日志</span>
                  </div>
                  {task.latestSummary === undefined ? null : <div className="lz__rowSummary">{task.latestSummary}</div>}
                </div>
              </div>
            )
          })}
          {openMrs.slice(0, 4).map(mr => (
            <div key={`${mr.repo}#${mr.mrNumber}`} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">MR 评审</span>
                  {mr.url === undefined
                    ? <span className="lz__mono">#{mr.mrNumber}</span>
                    : <a href={mr.url} target="_blank" rel="noreferrer" className="lz__mono">#{mr.mrNumber}</a>}
                  <span>{mr.title ?? mr.repo}</span>
                  <span className="lz__tag">{mr.origin}</span>
                </div>
                <div className="lz__rowSummary">
                  <span className="lz__mono">{mr.repo}</span>
                  {mr.pendingCount > 0 ? ` · 待处理信号 ${mr.pendingCount} (${mr.pendingKinds.join(', ')})` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Tab 2: 应用与日志监管
// ---------------------------------------------------------------------------

function LogReposSection({
  state,
  openRepoSettings,
  busy,
  onSave,
}: SupervisorPageProps & {
  state: StateWire
  busy: boolean
  onSave: (url: string, metadata: ApplicationMetadata) => Promise<ApplicationMetadata>
}): JSX.Element {
  return (
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
      <div className="lz__headRow">
        {openRepoSettings === undefined || state.dshRepo.availability === 'missing' ? null : <button type="button" className="lz__btn lz__btn--ghost" onClick={openRepoSettings}>{state.dshRepo.availability === 'ready' && state.dshRepo.mirrorDir === undefined ? '去设置镜像目录' : '在 dsh-repo 中管理仓库'}</button>}
      </div>
      <p className="lz__secFoot">只在这里配置描述和触发别名；飞书名称与平台 component_code 共用同一份别名。仓库地址、分支、只读/可写权限归 dsh-repo 管理。</p>
    </section>
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

function LogSupervisionAndConfigTab({
  draft,
  setDraft,
  supervision,
  analyze,
  credentialsAvailable,
  overridden,
  busy,
  onResetBreaker,
  onUpdateWatermark,
  onRetryOutbox,
  onSaveCredential,
  onClearCredential,
  onRetry,
}: TabProps & {
  supervision: LogSupervisionWire | undefined
  analyze: AnalyzeWire
  credentialsAvailable: boolean
  overridden: readonly EditableKey[]
  busy: boolean
  onResetBreaker: (scope: BreakerStatusWire['scope'], key: string) => void
  onUpdateWatermark: (payload: { action: 'pause' | 'resume' | 'rewind'; cursorTime?: string }) => void
  onRetryOutbox: (key?: string) => void
  onSaveCredential: (tokenEnv: string, value: string) => Promise<boolean>
  onClearCredential: (tokenEnv: string) => void
  onRetry: (id: string) => void
}): JSX.Element {
  const [rewindTime, setRewindTime] = useState('')
  const [host, setHost] = useState('')
  const wm = supervision?.watermark
  const batches = supervision?.pendingBatches ?? []
  const tasks = supervision?.tasks ?? []
  const dead = supervision?.outboxDead ?? []
  const breakers = supervision?.breakers ?? []

  const addHost = (): void => {
    const trimmed = host.trim().toLowerCase()
    if (trimmed === '' || draft.allowedHosts.includes(trimmed)) return
    setDraft({ ...draft, allowedHosts: [...draft.allowedHosts, trimmed] })
    setHost('')
  }

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
                <button type="button" className="lz__btn" disabled={busy || rewindTime.trim() === ''} onClick={() => { onUpdateWatermark({ action: 'rewind', cursorTime: rewindTime.trim() }) }}>回拨补跑</button>
                <button type="button" className="lz__btn lz__btn--ghost" disabled={busy} onClick={() => { onUpdateWatermark({ action: wm?.paused ? 'resume' : 'pause' }) }}>
                  {wm?.paused ? '恢复轮询' : '暂停轮询'}
                </button>
              </div>
            </div>
          </div>
          {batches.map(batch => (
            <div key={batch.key} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__tag">攒批中</span>
                  <span className="lz__mono">{batch.appId} / {batch.componentCode}</span>
                  {batch.errorCode === undefined ? null : <span className="lz__tag">{batch.errorCode}</span>}
                </div>
                <div className="lz__rowSummary">已收集 {batch.count} 份日志 · 开窗时间：{formatTime(batch.windowOpenedAt)}</div>
              </div>
            </div>
          ))}
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
              <div className="lz__rowSummary">按 archived_at 水位线增量拉取已归档日志，按 (product, component, error_code) 攒批触发诊断与可选修复建议。</div>
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
          <NumberRow label="轮询安全滞后" summary="每轮只拉取归档时间早于「当前时间减该值」的日志，避开平台晚提交与两边时钟偏差。" unit="秒" value={draft.logPollLagSec} onChange={(value) => { setDraft({ ...draft, logPollLagSec: value }) }} />
          <NumberRow label="攒批触发条数" summary="同组日志累计达到该条数时立即发车（不超过单批上限）。" unit="份" value={draft.logBatchSizeThreshold} onChange={(value) => { setDraft({ ...draft, logBatchSizeThreshold: value }) }} />
          <NumberRow label="单批日志上限" unit="份" value={draft.logMaxBatchSize} onChange={(value) => { setDraft({ ...draft, logMaxBatchSize: value }) }} />
          <NumberRow label="攒批等待窗口" summary="首条日志进入窗口后的最长等待时间（0 表示立即发车）。" unit="分钟" value={draft.logBatchWindowMin} onChange={(value) => { setDraft({ ...draft, logBatchWindowMin: value }) }} />
          <NumberRow label="日志并发上限" summary="同时运行的日志监管任务最大数量（logPool）。" unit="个" value={draft.logMaxConcurrentBatches} onChange={(value) => { setDraft({ ...draft, logMaxConcurrentBatches: value }) }} />
          <NumberRow label="单应用小时批次数上限" summary="超过后该应用进入 throttled 熔断，不影响其他应用。" unit="批" value={draft.logAppHourlyBatchLimit} onChange={(value) => { setDraft({ ...draft, logAppHourlyBatchLimit: value }) }} />
          <NumberRow label="单日志安全解压上限" unit="MB" value={draft.logMaxUnpackMb} onChange={(value) => { setDraft({ ...draft, logMaxUnpackMb: value }) }} />
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">日志平台连接 <Overridden keys={overridden} name="analyze" /></h2>
        <div className="lz__list">
          {analyze.platformProblem === undefined ? null : <div className="lz__notice lz__notice--error">{analyze.platformProblem}</div>}
          <TextRow label="日志平台接口地址" summary="开放 API 的地址，观象在它后面拼 /open-api/v1/…；自动轮询与报告回传都走这里。" placeholder="https://logs.example.com" value={draft.platformBaseUrl} onChange={(value) => { setDraft({ ...draft, platformBaseUrl: value }) }} />
          <TextRow label="令牌地址" summary="OAuth2 client_credentials 的令牌端点。" placeholder="https://auth.example.com/oauth/token" value={draft.platformTokenUrl} onChange={(value) => { setDraft({ ...draft, platformTokenUrl: value }) }} />
          <TextRow label="client_id" value={draft.platformClientId} onChange={(value) => { setDraft({ ...draft, platformClientId: value }) }} />
          <CredentialRow
            label="client_secret"
            summary={<>保存在 DSH 凭据库，用于换取访问日志平台开放 API 的 Bearer 令牌。</>}
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
              <div className="lz__rowSummary">HTTP Basic（默认）或表单字段，按日志平台的令牌端点要求选。</div>
            </div>
            <div className="lz__rowCtl">
              <select className="lz__input" aria-label="客户端认证方式" value={draft.platformClientAuth} onChange={(event) => { setDraft({ ...draft, platformClientAuth: event.target.value === 'basic' ? 'basic' : 'body' }) }}>
                <option value="basic">HTTP Basic</option>
                <option value="body">表单字段</option>
              </select>
            </div>
          </div>
          <TextRow label="授权范围" summary="scope，空格分隔；需要 log:search、log:download、log:upload。" value={draft.platformScope} onChange={(value) => { setDraft({ ...draft, platformScope: value }) }} />
          <NumberRow label="接口超时" unit="秒" value={draft.platformTimeoutSec} onChange={(value) => { setDraft({ ...draft, platformTimeoutSec: value }) }} />
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">报告回传与日志下载限制 <Overridden keys={overridden} name="download" /></h2>
        <div className="lz__list">
          <NumberRow label="单个文件上传超时" unit="秒" value={draft.uploadTimeoutSec} onChange={(value) => { setDraft({ ...draft, uploadTimeoutSec: value }) }} />
          <NumberRow label="上传失败重试次数" unit="次" value={draft.uploadRetries} onChange={(value) => { setDraft({ ...draft, uploadRetries: value }) }} />
          <NumberRow label="上传重试间隔" unit="秒" value={draft.uploadRetryDelaySec} onChange={(value) => { setDraft({ ...draft, uploadRetryDelaySec: value }) }} />
          <NumberRow label="同时上传文件数" unit="个" value={draft.uploadConcurrency} onChange={(value) => { setDraft({ ...draft, uploadConcurrency: value }) }} />
          <NumberRow label="报告文件数上限" unit="个" value={draft.uploadMaxFiles} onChange={(value) => { setDraft({ ...draft, uploadMaxFiles: value }) }} />
          <NumberRow label="报告总大小上限" unit="MB" value={draft.uploadMaxMb} onChange={(value) => { setDraft({ ...draft, uploadMaxMb: value }) }} />
          <NumberRow label="单个上传文件上限" unit="MB" value={draft.uploadMaxFileMb} onChange={(value) => { setDraft({ ...draft, uploadMaxFileMb: value }) }} />
          <NumberRow label="Markdown 文件大小上限" unit="MB" value={draft.uploadMaxMarkdownMb} onChange={(value) => { setDraft({ ...draft, uploadMaxMarkdownMb: value }) }} />
          {draft.allowedHosts.map(item => (
            <div key={item} className="lz__row">
              <div className="lz__rowText"><span className="lz__mono">下载允许域名：{item}</span></div>
              <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" onClick={() => { setDraft({ ...draft, allowedHosts: draft.allowedHosts.filter(entry => entry !== item) }) }}>删除</button></div>
            </div>
          ))}
          <div className="lz__addRow">
            <input className="lz__input" placeholder="下载允许主机名，例如 oss.example.com" value={host} onChange={(event) => { setHost(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') addHost() }} />
            <button type="button" className="lz__btn" disabled={host.trim() === ''} onClick={addHost}>添加允许域名</button>
          </div>
          <NumberRow label="单日志下载大小上限" unit="MB" value={draft.maxMb} onChange={(value) => { setDraft({ ...draft, maxMb: value }) }} />
          <NumberRow label="单日志下载超时" unit="秒" value={draft.timeoutSec} onChange={(value) => { setDraft({ ...draft, timeoutSec: value }) }} />
        </div>
      </section>

      {analyze.reports.length === 0 && analyze.legacyReports.length === 0
        ? null
        : (
            <section className="lz__sec">
              <h2 className="lz__secTitle">历史接口分析回传记录（{analyze.reports.length}）</h2>
              <div className="lz__list">
                {analyze.reports.map(report => <AnalysisRow key={report.id} report={report} busy={busy} onRetry={onRetry} />)}
              </div>
              {analyze.legacyReports.length === 0
                ? null
                : (
                    <div className="lz__list">
                      {analyze.legacyReports.map(report => <LegacyRow key={report.id} report={report} />)}
                    </div>
                  )}
            </section>
          )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Tab 3: MR 自动评审
// ---------------------------------------------------------------------------

function MrReviewTab({
  state,
  draft,
  setDraft,
  openRepoSettings,
  busy,
  onResetBreaker,
}: TabProps & {
  state: StateWire
  openRepoSettings?: (() => void) | undefined
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
  const supervision = state.mrSupervision
  const mrs = supervision?.mrs ?? []
  const breakers = supervision?.breakers ?? []
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">MR 自动评审仓库（审微）</h2>
        <div className="lz__list">
          {state.mrRepos.length === 0 ? <div className="lz__emptyRow">还没有启用 MR 自动评审的仓库。请在 dsh-repo 的「代码仓库 → 仓库」中打开「MR 自动评审」。</div> : null}
          {state.mrRepos.map(repo => (
            <div key={repo.url} className="lz__row">
              <div className="lz__rowText">
                <div className="lz__rowLabel">
                  <span className="lz__mono">{repo.url}</span>
                  {repo.branch === undefined ? null : <span className="lz__tag" title="目标分支">{repo.branch}</span>}
                  <span className={`lz__pill ${state.dshRepo.mrReviewReady !== false ? 'lz__pill--ok' : 'lz__pill--warn'}`}>
                    <span className="lz__dot" />
                    {state.dshRepo.mrReviewReady !== false ? '已启用' : '待升级 dsh-repo'}
                  </span>
                  {repo.writable ? null : <span className="lz__pill" title="dsh-repo 中权限为只读">只读</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        {state.dshRepo.availability === 'ready' && state.dshRepo.mrReviewReady === false && state.mrRepos.length > 0
          ? <div className="lz__notice lz__notice--error">{state.dshRepo.mrReviewProblem}</div>
          : null}
        <div className="lz__headRow">
          {openRepoSettings === undefined || state.dshRepo.availability === 'missing' ? null : <button type="button" className="lz__btn lz__btn--ghost" onClick={openRepoSettings}>在 dsh-repo 中管理 MR 仓库</button>}
        </div>
      </section>

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
          {breakers.length === 0 ? <div className="lz__emptyRow">当前没有活跃计数或已触发的 MR 熔断器。</div> : null}
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
        <h2 className="lz__secTitle">受监管 MR 列表（{mrs.length}）</h2>
        <div className="lz__list">
          {mrs.length === 0 ? <div className="lz__emptyRow">暂无已纳管的合并请求。</div> : null}
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
        <h2 className="lz__secTitle">MR 自动评审策略、通知群与团队规范 <Overridden keys={state.overridden} name="mrReview" /></h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">启用有状态 MR 自动评审（审微）</div>
              <div className="lz__rowSummary">开启后按轮询间隔扫描启用了「MR 自动评审」的仓库，持续追踪新提交、人类讨论与己方 CI 状态。</div>
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
          <TextRow label="MR 告警通知群" summary="触发熔断或达到 CI 自修上限时，通知该飞书群（oc_ 开头）；留空则仅在面板展示状态。" placeholder="oc_xxx" value={draft.mrFeishuChatId} onChange={(value) => { setDraft({ ...draft, mrFeishuChatId: value }) }} />
          <div className="lz__row lz__row--top">
            <div className="lz__rowText">
              <label className="lz__field">
                团队附加评审要求（customInstructions）
                <textarea
                  aria-label="团队附加评审要求"
                  className="lz__input lz__textarea"
                  rows={4}
                  maxLength={4000}
                  placeholder="可选，例如：重点关注鉴权边界、事务原子性、幂等键设计与并发锁安全；最多 4000 字。"
                  value={draft.mrCustomInstructions}
                  onChange={(event) => { setDraft({ ...draft, mrCustomInstructions: event.target.value }) }}
                />
              </label>
              <div className="lz__rowSummary">将追加注入每次审微 MR 唤醒提示词末尾，与代码规范协同生效。</div>
            </div>
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

// ---------------------------------------------------------------------------
// Tab 4: 已知问题库（双向同步 + 映射检查 + 问题检索）
// ---------------------------------------------------------------------------

const COL_STATUS_LABEL: Readonly<Record<'matched' | 'missing' | 'type_mismatch' | 'readonly', { pill: string; text: string }>> = {
  matched: { pill: 'lz__pill--ok', text: '已匹配' },
  missing: { pill: 'lz__pill--warn', text: '缺少列' },
  type_mismatch: { pill: 'lz__pill--warn', text: '类型差异' },
  readonly: { pill: 'lz__pill', text: '只读跳过' },
}

function IssuesTab({
  draft,
  setDraft,
  overview,
  savedSettings,
  overridden,
  dirty,
  busy,
  onSyncNow,
  onCheckMapping,
}: TabProps & {
  overview: IssueOverviewWire | undefined
  savedSettings: EditableSettings['issueSync']
  overridden: readonly EditableKey[]
  dirty: boolean
  busy: boolean
  onSyncNow: () => void
  onCheckMapping: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [onlyDirty, setOnlyDirty] = useState(false)
  const [expandedId, setExpandedId] = useState<string | undefined>()

  const avail = BITABLE_STATUS_LABEL[overview?.bitableAvailable ?? 'missing']
  const canSyncSaved = !dirty && savedSettings.enabled && savedSettings.bitableUrl !== undefined && overview?.bitableAvailable === 'ready'
  const items = (overview?.items ?? []).filter((item) => {
    if (onlyDirty && !item.syncDirty) return false
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    return [
      item.issueId,
      item.appId,
      item.title,
      item.matchCriteria,
      item.aiDiagnosis,
      item.humanConclusion ?? '',
      item.humanStatus ?? '',
      item.assignee ?? '',
    ].some(field => field.toLowerCase().includes(needle))
  })

  const check = overview?.lastCheck

  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">飞书多维表格同步状态</h2>
        <div className="lz__list">
          <div className="lz__row lz__row--top">
            <div className="lz__rowText">
              <div className="lz__rowLabel">
                <span className={`lz__pill ${avail.pill}`}><span className="lz__dot" />{avail.text}</span>
                <span className="lz__tag">共 {overview?.totalCount ?? 0} 条</span>
                <span className="lz__tag">已关联 {overview?.linkedCount ?? 0}</span>
                <span className="lz__tag">人工已确认 {overview?.humanConfirmedCount ?? 0}</span>
                <span className="lz__tag">待推送 {overview?.dirtyCount ?? 0}</span>
              </div>
              <div className="lz__rowSummary">
                {overview?.lastSyncAt === undefined ? '尚未完成过双向同步。' : `上次同步成功：${formatTime(overview.lastSyncAt)}`}
                {overview?.bitableDetail === undefined ? '' : ` · ${overview.bitableDetail}`}
              </div>
              {overview?.lastError === undefined ? null : <div className="lz__rowError">{overview.lastError}</div>}
              {dirty ? <div className="lz__rowSummary">多维表格配置有未保存修改；请先在底部点击「保存」，或先点右侧「检查字段映射」预览新链接。</div> : null}
            </div>
            <div className="lz__rowCtl">
              <button type="button" className="lz__btn" disabled={busy || draft.issueBitableUrl.trim() === ''} onClick={onCheckMapping}>检查字段映射</button>
              <button
                type="button"
                className="lz__btn lz__btn--primary"
                disabled={busy || !canSyncSaved || overview?.syncing === true}
                onClick={onSyncNow}
                title={dirty ? '请先保存修改后再同步' : undefined}
              >
                {overview?.syncing ? '同步中…' : '立即双向同步'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">多维表格连接设置 <Overridden keys={overridden} name="issueSync" /></h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">启用已知问题库 ↔ 飞书多维表格自动双向同步</div>
              <div className="lz__rowSummary">AI 列（问题ID、标题、诊断、报告/MR 链接）自动幂等写入飞书；人工列（人工确认结论、人工状态、负责人）定期拉回本地供后续日志分析检索。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="启用多维表格双向同步" checked={draft.issueSyncEnabled} onChange={(event) => { setDraft({ ...draft, issueSyncEnabled: event.target.checked }) }} /></div>
          </div>
          <TextRow label="飞书多维表格链接" summary="支持 Base 链接（https://.../base/<token>?table=tbl...）或知识库内嵌表链接（https://.../wiki/<node_token>）。" placeholder="https://tenant.feishu.cn/base/app..." value={draft.issueBitableUrl} onChange={(value) => { setDraft({ ...draft, issueBitableUrl: value }) }} />
          <TextRow label="目标数据表 ID / 名称（可选）" summary="多张数据表时指定 tbl... ID 或精确表名（将覆盖 URL 中的 ?table=）；单表时可留空。" placeholder="tbl... 或 问题库" value={draft.issueTable} onChange={(value) => { setDraft({ ...draft, issueTable: value }) }} />
          <NumberRow label="定时同步间隔" summary="除 AI 写入后自动增量推送外，按该间隔周期拉取飞书表中的人工回填状态（至少 5 秒）。" unit="秒" value={draft.issueSyncIntervalSec} onChange={(value) => { setDraft({ ...draft, issueSyncIntervalSec: value }) }} />
        </div>
      </section>

      {check === undefined
        ? null
        : (
            <section className="lz__sec">
              <h2 className="lz__secTitle">最近字段映射自检结果（{formatTime(check.checkedAt)}）</h2>
              <div className="lz__list">
                <div className="lz__row">
                  <div className="lz__rowText">
                    <div className="lz__rowLabel">
                      <span className={`lz__pill ${check.ok ? 'lz__pill--ok' : 'lz__pill--bad'}`}>
                        <span className="lz__dot" />
                        {check.ok ? '主键列校验通过' : '校验未通过'}
                      </span>
                      {check.resolvedTableName === undefined ? null : <span className="lz__tag">表名：{check.resolvedTableName}</span>}
                      {check.resolvedTableId === undefined ? null : <span className="lz__tag lz__mono">{check.resolvedTableId}</span>}
                    </div>
                    {check.error === undefined ? null : <div className="lz__rowError">{check.error}</div>}
                    {check.warnings.length === 0 ? null : <div className="lz__rowSummary">{check.warnings.join('；')}</div>}
                  </div>
                </div>
                {check.columns.map((col) => {
                  const st = col.required && col.status === 'missing'
                    ? { pill: 'lz__pill--bad', text: '缺少必填列' }
                    : COL_STATUS_LABEL[col.status]
                  return (
                    <div key={col.name} className="lz__row">
                      <div className="lz__rowText">
                        <div className="lz__rowLabel">
                          <span>{col.name}</span>
                          <span className="lz__tag">{col.role === 'human' ? '人工只拉取' : 'AI 推送'}</span>
                          <span className="lz__tag">{col.expectedType}</span>
                          {col.actualType === undefined ? null : <span className="lz__tag lz__mono">实际 {col.actualType}</span>}
                          <span className={`lz__pill ${st.pill}`}><span className="lz__dot" />{st.text}</span>
                        </div>
                        {col.detail === undefined ? null : <div className="lz__rowSummary">{col.detail}</div>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

      <section className="lz__sec">
        <h2 className="lz__secTitle">已知问题记录（{items.length}/{overview?.totalCount ?? 0}）</h2>
        <div className="lz__filterBar">
          <input className="lz__input" placeholder="搜索问题ID、应用、标题、匹配特征、人工结论或负责人" value={query} onChange={(event) => { setQuery(event.target.value) }} />
          <label className="lz__tag">
            <input type="checkbox" className="lz__check" checked={onlyDirty} onChange={(event) => { setOnlyDirty(event.target.checked) }} />
            <span>仅看未推送</span>
          </label>
        </div>
        <div className="lz__list">
          {items.length === 0 ? <div className="lz__emptyRow">{overview === undefined ? '监管存储域未就绪。' : '当前条件下没有匹配的已知问题记录。'}</div> : null}
          {items.map((item: IssueItemWire) => {
            const expanded = expandedId === item.issueId
            return (
              <div key={item.issueId} className="lz__row lz__row--top">
                <div className="lz__rowText">
                  <div className="lz__rowLabel">
                    <span className="lz__mono">{item.issueId}</span>
                    <span className="lz__tag">{item.appId}</span>
                    <span className="lz__tag">AI: {item.aiStatus}</span>
                    {item.humanStatus === undefined ? null : <span className="lz__pill lz__pill--ok"><span className="lz__dot" />人工: {item.humanStatus}</span>}
                    {item.assignee === undefined ? null : <span className="lz__tag">负责人: {item.assignee}</span>}
                    <span className={`lz__pill ${item.syncDirty ? 'lz__pill--warn' : item.bitableRecordId !== undefined ? 'lz__pill--ok' : ''}`}>
                      <span className="lz__dot" />
                      {item.syncDirty ? '待同步' : item.bitableRecordId !== undefined ? '已同步' : '仅本地'}
                    </span>
                  </div>
                  <div className="lz__rowLabel">{item.title}</div>
                  <div className="lz__rowSummary">
                    最近出现：{formatTime(item.lastSeenAt)} · 首次：{formatTime(item.firstSeenAt)}
                    {item.sampleReportUrl === undefined ? null : <> · <a href={item.sampleReportUrl} target="_blank" rel="noreferrer">示例报告</a></>}
                    {item.latestReportUrl === undefined ? null : <> · <a href={item.latestReportUrl} target="_blank" rel="noreferrer">最新报告</a></>}
                    {item.fixMrUrl === undefined ? null : <> · <a href={item.fixMrUrl} target="_blank" rel="noreferrer">修复 MR</a></>}
                  </div>
                  {item.humanConclusion === undefined ? null : <div className="lz__rowSummary">人工确认结论：{item.humanConclusion}</div>}
                  {expanded
                    ? (
                        <div className="lz__detail">
                          <div><strong>匹配特征：</strong>{item.matchCriteria}</div>
                          {item.exclusionCriteria === undefined ? null : <div><strong>排除特征：</strong>{item.exclusionCriteria}</div>}
                          <div><strong>AI 诊断结论：</strong>{item.aiDiagnosis}</div>
                          <div><strong>解决建议：</strong>{item.resolutionAdvice}</div>
                          {item.bitableRecordId === undefined ? null : <div><strong>多维表格行 ID：</strong><span className="lz__mono">{item.bitableRecordId}</span></div>}
                        </div>
                      )
                    : null}
                </div>
                <div className="lz__rowCtl">
                  <button type="button" className="lz__btn lz__btn--ghost" onClick={() => { setExpandedId(expanded ? undefined : item.issueId) }}>{expanded ? '收起' : '详情'}</button>
                </div>
              </div>
            )
          })}
        </div>
        <p className="lz__secFoot">推荐多维表格表头：「问题ID」（必填文本主键）以及「应用」「标题」「匹配特征」「排除特征」「AI 诊断结论」「AI 状态」「解决建议」「首次发现」「最近出现」「示例报告」「最新报告」「修复 MR」「人工确认结论」「人工状态」「负责人」。未建的可选列会自动跳过。</p>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Tab 5: 模型与高级
// ---------------------------------------------------------------------------

function AdvancedTab({
  draft,
  setDraft,
  state,
  busy,
  onReset,
}: TabProps & {
  state: StateWire
  busy: boolean
  onReset: () => void
}): JSX.Element {
  const runtime = state.runtime
  const overridden = state.overridden
  return (
    <>
      <section className="lz__sec">
        <h2 className="lz__secTitle">模型与宿主运行时配置（cordis.yml）</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">子 Agent 提供方（subagentProvider）</div>
              <div className="lz__rowSummary">日志分析、MR 评审及 SKILL 改进子 Agent 使用的宿主提供方名称。</div>
            </div>
            <div className="lz__rowCtl"><span className="lz__tag lz__mono">{runtime?.subagentProvider ?? 'spawn'}</span></div>
          </div>
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">子 Agent 委派深度上限（subagentMaxDepth）</div>
              <div className="lz__rowSummary">每次启动子 Agent 时传给宿主的深度上限；provider-managed 表示不传，由提供方自己控制。</div>
            </div>
            <div className="lz__rowCtl"><span className="lz__tag lz__mono">{String(runtime?.subagentMaxDepth ?? 1)}</span></div>
          </div>
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">允许自然语言自动触发 /supervisor（autoInvoke）</div>
              <div className="lz__rowSummary">由 cordis.yml 控制；启用时相关分析请求可自动激活入口 SKILL。</div>
            </div>
            <div className="lz__rowCtl"><span className="lz__tag">{runtime?.autoInvoke === false ? '关闭' : '开启'}</span></div>
          </div>
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">凭据环境变量引用</div>
              <div className="lz__rowSummary">日志平台 OAuth2 client_secret 的凭据名。</div>
            </div>
            <div className="lz__rowCtl">
              <span className="lz__tag lz__mono">{runtime?.platformSecretRef ?? state.analyze.secretEnv}</span>
            </div>
          </div>
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">加载等待上限（refreshWaitMs）</div>
            </div>
            <div className="lz__rowCtl"><span className="lz__tag lz__mono">{runtime?.refreshWaitMs ?? 15000} ms</span></div>
          </div>
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">仓库同步与派发控制</h2>
        <div className="lz__list">
          <NumberRow label="更新间隔" summary="输入 /supervisor 时，距上次读取超过该时间的仓库会先重新读取应用描述；0 表示每次都读取。" unit="分钟" value={draft.fetchIntervalMin} overridden={overridden.includes('fetchIntervalMs')} onChange={(value) => { setDraft({ ...draft, fetchIntervalMin: value }) }} />
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
              <div className="lz__rowSummary">子 Agent 发现应用的日志分析 SKILL 写错或缺内容时记下不足，用户同意后沉淀案例并经 dsh-repo 提交 MR。</div>
            </div>
            <div className="lz__rowCtl"><input type="checkbox" className="lz__check" aria-label="分析后建议改进 SKILL" checked={draft.skillUpdatesEnabled} onChange={(event) => { setDraft({ ...draft, skillUpdatesEnabled: event.target.checked }) }} /></div>
          </div>
          <NumberRow label="改进文件数上限" unit="个" value={draft.skillMaxFiles} onChange={(value) => { setDraft({ ...draft, skillMaxFiles: value }) }} />
          <NumberRow label="改进单文件大小上限" unit="KB" value={draft.skillMaxKb} onChange={(value) => { setDraft({ ...draft, skillMaxKb: value }) }} />
        </div>
      </section>

      <section className="lz__sec">
        <h2 className="lz__secTitle">面板设置重置</h2>
        <div className="lz__list">
          <div className="lz__row">
            <div className="lz__rowText">
              <div className="lz__rowLabel">恢复 cordis.yml 配置</div>
              <div className="lz__rowSummary">删除面板保存的全部设置（$DSH_HOME/supervisor/settings.json 中的覆盖值）。</div>
            </div>
            <div className="lz__rowCtl"><button type="button" className="lz__btn lz__btn--danger" disabled={busy || overridden.length === 0} onClick={onReset}>恢复</button></div>
          </div>
        </div>
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Shared Row Controls
// ---------------------------------------------------------------------------

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

const TOKEN_SOURCES: Readonly<Record<string, string>> = { env: '启动环境变量', 'project-env': '项目 .env', 'user-env': '$DSH_HOME/.env' }

function tokenPill(token: TokenStatusWire | undefined): JSX.Element {
  if (token === undefined) return <span className="lz__pill"><span className="lz__dot" />保存后设置令牌</span>
  if (token.error !== undefined) return <span className="lz__pill lz__pill--bad"><span className="lz__dot" />无法读取</span>
  if (!token.configured) return <span className="lz__pill lz__pill--warn"><span className="lz__dot" />未设置令牌</span>
  const source = token.source === undefined || token.source === 'file' ? undefined : TOKEN_SOURCES[token.source] ?? token.source
  return <span className="lz__pill lz__pill--ok"><span className="lz__dot" />已设置{source === undefined ? '' : `（来自${source}）`}</span>
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
