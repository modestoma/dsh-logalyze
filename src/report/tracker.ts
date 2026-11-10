/**
 * 分析报告回传：分析接口接受请求后，观象记录这次分析，并在分析话题的每一轮
 * 结束时更新记录，再把报告作为一个新修订传到这批日志的每一份（日志平台的
 * 详情页显示最新完成的修订）。
 *
 * - 轮次来自 DSH 的 `session/event`：经 `feishuTopics.launchKeyOf` 把 Session
 *   对应到请求，`/renew` 之后的新 Session 也能对上。首轮的最终回复写成整批
 *   结论，之后每一轮写成「追问 N」（用户消息加最终回复），只追加不改写；每份
 *   日志的结论取自本轮结束时的 `report/logs/<编号>.md`。
 * - 首轮之前就失败（话题或 Session 没能建立）或在首轮进行中 DSH 重启时，
 *   `feishu-topics/status` 事件（或加载时的核对）补一节说明原因的首轮结论。
 * - 每份日志的 `report.md` 只由观象按记录生成，不写进报告目录；目录里平台
 *   接受的文件作为共同的附件，不接受的列在报告末尾。
 * - 同一次分析的上传串行执行，日志逐份上传；上传进行中又有新的轮次时，结束后
 *   再上传一次最新内容。网络错误、429 与 5xx 按退避重试；其他失败（凭据无效、
 *   4xx、报告超过上限）标记在这份日志上，等内容变化或在面板手动重传。
 * - 一份日志第一次完成修订后，根卡片表格的「分析报告」列补上它的分析页链接
 *   （每份日志固定，只补一次）。
 * - 启动时和每接受一次新分析时按存储的保留规则清理旧记录；正在上传或更新的
 *   记录这次不清理。
 *
 * @module dsh-logalyze/report/tracker
 */

import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { analysisCardLinks } from '../analyze/topics.ts'
import type { FeishuTopicService, TopicLaunchState } from '../deps/topics-contract.ts'
import type { SessionEventEnvelope, SessionHeader } from '../host.ts'
import { PlatformError } from '../platform/client.ts'
import { REPORT_DIR, REPORT_LOGS_DIR } from '../settings/contract.ts'
import type { AnalysisWire, ReportStatus, UploadPhase, UploadSettings } from '../settings/contract.ts'
import { messageOf } from '../util/errors.ts'
import { changedFiles, listReport } from './files.ts'
import type { ReportListing } from './files.ts'
import { buildManifest } from './manifest.ts'
import type { Manifest } from './manifest.ts'
import { questionOf, renderLogReport, rewriteReply } from './render.ts'
import type { ReportSection } from './render.ts'
import { analysisIdOf } from './store.ts'
import type { AnalysisLog, AnalysisRecord, AnalysisStore } from './store.ts'
import { uploadRevision } from './upload.ts'
import type { RevisionPlatform } from './upload.ts'

/** Collaborators of the tracker. */
export interface ReportTrackerDeps {
  readonly store: AnalysisStore
  /** The loaded, compatible `feishuTopics`, or undefined while unavailable. */
  topics(): FeishuTopicService | undefined
  /** The log platform's revision calls. */
  readonly platform: RevisionPlatform
  /** Current upload settings. */
  upload(): UploadSettings
  readonly warn: (message: string) => void
  readonly now?: () => number
}

/** Reported in the analysis section when DSH restarted during the first turn. */
export const INTERRUPTED_REASON = 'DSH 在首轮分析进行中重启，分析中断；在飞书话题内回复即可继续。'

/** Reported when the first turn ended while the tracker was not listening. */
export const MISSED_REASON = '观象没有记录到首轮回复，请到飞书话题中查看。'

/** Most analyses the panel lists. */
export const MAX_LISTED_REPORTS = 50

/** Most characters of one log's conclusion file kept in its report. */
export const MAX_CONCLUSION_CHARS = 20_000

/** User messages and final reply collected during one turn. */
interface TurnBuffer {
  readonly questions: string[]
  reply: string
}

interface ContentBlockLike {
  readonly type: string
  readonly text?: unknown
}

interface TurnEndData {
  readonly turn: number
  readonly reason: { readonly kind: string; readonly error?: { readonly message?: string } }
}

type UploadOutcome = { readonly ok: true; readonly reportUrl: string } | { readonly ok: false; readonly error: string; readonly retryable: boolean }

/** A report directory checked for one upload pass. */
type Prepared = { readonly ok: true; readonly dir: string; readonly listing: ReportListing } | { readonly ok: false; readonly error: string; readonly retryable: boolean }

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return (content as readonly ContentBlockLike[])
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

/**
 * First-turn outcome of a turn end reason. Unknown kinds (the reason map is
 * merge-extensible) count as completed.
 * @param kind - `TurnEndReason.kind`.
 * @returns the recorded status.
 */
export function statusOfTurnEnd(kind: string): ReportStatus {
  switch (kind) {
    case 'aborted':
    case 'blocked':
      return 'stopped'
    case 'error':
      return 'error'
    case 'interrupted':
    case 'forked':
      return 'interrupted'
    case 'completed':
    case 'max-tokens':
    default:
      return 'done'
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Records analysis turns and uploads each log's report after each one. */
export class ReportTracker {
  private readonly buffers = new Map<string, TurnBuffer>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly workers = new Map<string, Promise<void>>()
  private readonly forced = new Set<string>()
  private readonly running = new Set<string>()
  private readonly waiting = new Set<string>()
  private readonly stop = new AbortController()
  private readonly now: () => number

  /** @param deps - collaborators. */
  constructor(private readonly deps: ReportTrackerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Load stored records, resume uploads that had not finished, and add missing card links. */
  async boot(): Promise<void> {
    await this.deps.store.load()
    await this.prune()
    for (const record of this.deps.store.all()) {
      if (record.logs.some(log => log.uploadedRevision < record.revision && log.blocked !== true)) this.schedule(record.id)
    }
    await this.reconcile()
  }

  /** Stop retry waits; uploads already running finish. */
  shutdown(): void {
    this.stop.abort()
  }

  /**
   * The analysis accepted under a key.
   * @param key - the request's `Idempotency-Key`.
   * @returns the record, or undefined.
   */
  byKey(key: string): AnalysisRecord | undefined {
    return this.deps.store.get(analysisIdOf(key))
  }

  /**
   * Store a new analysis before its topic is launched, so log numbers resolve
   * as soon as the first turn runs.
   * @param record - the new record.
   */
  async accept(record: AnalysisRecord): Promise<void> {
    await this.deps.store.put(record)
    await this.prune()
  }

  /**
   * Drop an analysis whose topic was not launched.
   * @param id - analysis id.
   */
  async forget(id: string): Promise<void> {
    await this.deps.store.remove(id)
  }

  /**
   * Pick up the launch state of a launched analysis.
   * @param id - analysis id.
   */
  async launched(id: string): Promise<void> {
    await this.reconcileOne(id)
  }

  /** Drop expired and excess records that no upload or update is using. */
  private async prune(): Promise<void> {
    await this.deps.store.prune(this.now(), id => this.workers.has(id) || this.locks.has(id))
  }

  /**
   * Check every analysis still waiting for its first turn against the launch
   * state, and add card links that could not be added before: called at boot
   * and whenever `feishuTopics` appears.
   */
  async reconcile(): Promise<void> {
    for (const record of this.deps.store.all()) {
      if (!record.sections.some(section => section.kind === 'analysis')) await this.reconcileOne(record.id)
      if (!this.workers.has(record.id) && record.logs.some(log => log.reportUrl !== undefined && log.linked !== true)) await this.link(record.id)
    }
  }

  private async reconcileOne(id: string): Promise<void> {
    const record = this.deps.store.get(id)
    const state = record === undefined ? undefined : this.deps.topics()?.state(record.key)
    if (state === undefined) return
    if (state.status === 'running') {
      if (state.workDir !== undefined && record?.workDir !== state.workDir) await this.mutate(id, current => ({ ...current, workDir: state.workDir }))
      return
    }
    // A settled first turn without a recorded section ended while this
    // plugin was not listening; failures and interruptions carry their own reason.
    const reason = state.status === 'failed' ? state.reason : state.status === 'interrupted' ? INTERRUPTED_REASON : MISSED_REASON
    await this.addAnalysis(id, state, reason)
  }

  /**
   * React to the Feishu channel plugin's `feishu-topics/status` event: a launch that failed
   * to start or was interrupted gets a first-turn section explaining why.
   * Settled first turns are recorded from their `turn/end`.
   * @param state - the new launch state.
   */
  statusChanged(state: TopicLaunchState): void {
    const id = analysisIdOf(state.key)
    if (this.deps.store.get(id) === undefined) return
    if (state.status !== 'failed' && state.status !== 'interrupted') return
    void this.addAnalysis(id, state, state.status === 'failed' ? state.reason : INTERRUPTED_REASON)
  }

  private async addAnalysis(id: string, state: TopicLaunchState, reason: string | undefined): Promise<void> {
    let changed = false
    await this.mutate(id, (record) => {
      if (record.sections.some(section => section.kind === 'analysis')) return undefined
      const status: ReportStatus = state.status === 'running' ? 'done' : state.status
      changed = true
      return {
        ...record,
        ...state.workDir === undefined ? {} : { workDir: state.workDir },
        sections: [{ kind: 'analysis', status, ...reason === undefined ? {} : { reason }, reply: '', files: [], at: this.now() }, ...record.sections],
        revision: record.revision + 1,
        logs: record.logs.map(unblocked),
      }
    })
    if (changed) this.schedule(id)
  }

  /**
   * Feed one appended Session event (`session/event`). Only top-level
   * Sessions whose topic is a tracked launch are recorded.
   * @param session - the Session's header.
   * @param event - the appended event.
   */
  sessionEvent(session: { readonly header: SessionHeader }, event: SessionEventEnvelope): void {
    const { header } = session
    if ((header.delegationDepth ?? 0) > 0) return
    switch (event.type) {
      case 'turn/start':
        this.buffers.set(header.id, { questions: [], reply: '' })
        return
      case 'user/message': {
        const message = event.data as { readonly content?: unknown; readonly source?: { readonly kind?: string } } | undefined
        if (message?.source?.kind !== 'user') return
        const text = textOf(message.content)
        if (text !== '') this.bufferOf(header.id).questions.push(text)
        return
      }
      case 'assistant/message': {
        const data = event.data as { readonly message?: { readonly content?: unknown } } | undefined
        const text = textOf(data?.message?.content).trim()
        if (text !== '') this.bufferOf(header.id).reply = text
        return
      }
      case 'turn/end': {
        const buffer = this.buffers.get(header.id) ?? { questions: [], reply: '' }
        this.buffers.delete(header.id)
        void this.turnEnded(header.id, event.data as TurnEndData, buffer).catch((error: unknown) => {
          this.deps.warn(`logalyze: 记录分析轮次失败：${messageOf(error)}`)
        })
        return
      }
      // Other Session events carry nothing the report records.
      default:
        return
    }
  }

  private bufferOf(sessionId: string): TurnBuffer {
    let buffer = this.buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { questions: [], reply: '' }
      this.buffers.set(sessionId, buffer)
    }
    return buffer
  }

  private async turnEnded(sessionId: string, data: TurnEndData, buffer: TurnBuffer): Promise<void> {
    const topics = this.deps.topics()
    const key = topics?.launchKeyOf(sessionId)
    if (topics === undefined || key === undefined) return
    const id = analysisIdOf(key)
    if (this.deps.store.get(id) === undefined) return
    let changed = false
    await this.mutate(id, async (record) => {
      if ((record.turns[sessionId] ?? 0) >= data.turn) return undefined
      const turns = { ...record.turns, [sessionId]: data.turn }
      const hasAnalysis = record.sections.some(section => section.kind === 'analysis')
      const question = questionOf(buffer.questions)
      // A turn with neither input nor reply (the closer DSH appends when it
      // resumes an interrupted turn) adds no section.
      if (hasAnalysis && question === '' && buffer.reply === '') return { ...record, turns }
      const workDir = topics.state(key)?.workDir ?? record.workDir
      const dir = this.dirOf({ ...record, ...workDir === undefined ? {} : { workDir } })
      const listing = await this.listing(dir)
      const exists = (path: string): boolean => listing.files[path] !== undefined
      const rewritten = rewriteReply(buffer.reply, exists)
      const conclusions = await this.conclusions(record, dir, listing, exists)
      const linked = new Set([...rewritten.linked, ...conclusions.linked, ...record.logs.map(log => `${REPORT_LOGS_DIR}/${log.ref}.md`)])
      const files = changedFiles(record.snapshot, listing.files).filter(file => !linked.has(file))
      const status = statusOfTurnEnd(data.reason.kind)
      const reason = data.reason.kind === 'error' ? data.reason.error?.message : status === 'interrupted' ? INTERRUPTED_REASON : undefined
      const section: ReportSection = {
        kind: hasAnalysis ? 'followup' : 'analysis',
        status,
        ...reason === undefined ? {} : { reason },
        ...hasAnalysis ? { question } : {},
        reply: rewritten.text,
        files,
        at: this.now(),
      }
      changed = true
      return {
        ...record,
        ...workDir === undefined ? {} : { workDir },
        turns,
        snapshot: { ...listing.files },
        sections: [...record.sections, section],
        warnings: unique([...record.warnings, ...rewritten.warnings, ...conclusions.warnings]),
        revision: record.revision + 1,
        logs: record.logs.map(log => unblocked(conclusions.texts.has(log.ref) ? { ...log, conclusion: conclusions.texts.get(log.ref) } : log)),
      }
    })
    if (changed) this.schedule(id)
  }

  /** Read each log's conclusion file of a batch, with links rewritten like replies. */
  private async conclusions(record: AnalysisRecord, dir: string, listing: ReportListing, exists: (path: string) => boolean): Promise<{ texts: Map<string, string>; linked: Set<string>; warnings: string[] }> {
    const texts = new Map<string, string>()
    const linked = new Set<string>()
    const warnings: string[] = []
    if (record.logs.length < 2) return { texts, linked, warnings }
    for (const log of record.logs) {
      const path = `${REPORT_LOGS_DIR}/${log.ref}.md`
      if (listing.files[path] === undefined) continue
      let text: string
      try {
        text = await readFile(join(dir, path), 'utf8')
      } catch (error) {
        this.deps.warn(`logalyze: 读取日志结论 ${join(dir, path)} 失败：${messageOf(error)}`)
        continue
      }
      const cut = text.length <= MAX_CONCLUSION_CHARS ? text : `${text.slice(0, MAX_CONCLUSION_CHARS - 1)}…`
      const rewritten = rewriteReply(cut.trim(), exists)
      texts.set(log.ref, rewritten.text)
      for (const file of rewritten.linked) linked.add(file)
      warnings.push(...rewritten.warnings.map(warning => `${log.ref}：${warning}`))
    }
    return { texts, linked, warnings }
  }

  private async listing(dir: string): Promise<ReportListing> {
    try {
      return await listReport(dir)
    } catch (error) {
      this.deps.warn(`logalyze: 读取报告目录 ${dir} 失败：${messageOf(error)}`)
      return { files: {}, sizes: {}, count: 0, bytes: 0, refused: [] }
    }
  }

  /**
   * Upload one analysis's report to every log now, whether or not the last upload succeeded.
   * @param id - analysis id.
   * @returns false when no such analysis exists.
   */
  retry(id: string): boolean {
    if (this.deps.store.get(id) === undefined) return false
    this.schedule(id, true)
    return true
  }

  /** @returns the most recently accepted analyses, newest first. */
  list(): AnalysisWire[] {
    return this.deps.store.all()
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
      .slice(0, MAX_LISTED_REPORTS)
      .map(record => this.wire(record))
  }

  private wire(record: AnalysisRecord): AnalysisWire {
    const analysis = record.sections.find(section => section.kind === 'analysis')
    return {
      id: record.id,
      app: record.app,
      appName: record.appName,
      ...record.errorCode === null ? {} : { errorCode: record.errorCode },
      triggeredAt: record.triggeredAt,
      acceptedAt: record.acceptedAt,
      ...analysis === undefined ? {} : { status: analysis.status },
      followups: record.sections.filter(section => section.kind === 'followup').length,
      ...record.workDir === undefined && analysis === undefined ? {} : { dir: this.dirOf(record) },
      logs: record.logs.map(log => ({
        ref: log.ref,
        logId: log.logId,
        fileName: log.fileName,
        ...log.detailUrl === undefined ? {} : { detailUrl: log.detailUrl },
        ...log.reportUrl === undefined ? {} : { reportUrl: log.reportUrl },
        phase: this.phaseOf(record, log),
        ...log.uploadedAt === undefined ? {} : { uploadedAt: log.uploadedAt },
        ...log.error === undefined ? {} : { error: log.error },
      })),
      warnings: record.warnings,
      skipped: record.skipped,
    }
  }

  private phaseOf(record: AnalysisRecord, log: AnalysisLog): UploadPhase {
    const behind = log.uploadedRevision < record.revision
    if (behind && this.running.has(record.id)) return 'running'
    if (behind && this.waiting.has(record.id)) return 'waiting'
    if (record.revision > 0 && !behind) return 'done'
    if (log.error !== undefined && !this.workers.has(record.id)) return 'failed'
    return 'pending'
  }

  /** Report directory: below the topic's working directory, or below the store for a launch that never got one. */
  private dirOf(record: Pick<AnalysisRecord, 'id' | 'workDir'>): string {
    return record.workDir === undefined ? join(this.deps.store.dir, record.id, REPORT_DIR) : join(record.workDir, REPORT_DIR)
  }

  /** Apply one read-modify-write to a record, serialized per record; `undefined` keeps it unchanged. */
  private async mutate(id: string, change: (record: AnalysisRecord) => AnalysisRecord | undefined | Promise<AnalysisRecord | undefined>): Promise<void> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const record = this.deps.store.get(id)
      if (record === undefined) return
      const updated = await change(record)
      if (updated !== undefined) await this.deps.store.put(updated)
    })
    const settled = next.catch((error: unknown) => {
      this.deps.warn(`logalyze: 更新分析记录失败：${messageOf(error)}`)
    })
    this.locks.set(id, settled)
    await settled
    if (this.locks.get(id) === settled) this.locks.delete(id)
  }

  /** Change one log of a record. */
  private async mutateLog(id: string, ref: string, change: (log: AnalysisLog) => AnalysisLog): Promise<void> {
    await this.mutate(id, record => ({ ...record, logs: record.logs.map(log => (log.ref === ref ? change(log) : log)) }))
  }

  private schedule(id: string, force = false): void {
    if (force) this.forced.add(id)
    if (this.workers.has(id)) return
    const work = this.work(id).catch((error: unknown) => {
      this.deps.warn(`logalyze: 上传报告失败：${messageOf(error)}`)
    }).finally(() => { this.workers.delete(id) })
    this.workers.set(id, work)
  }

  /** Upload until every log covers the stored revision, retrying retryable failures with backoff. */
  private async work(id: string): Promise<void> {
    let failures = 0
    while (!this.stop.signal.aborted) {
      const record = this.deps.store.get(id)
      if (record === undefined) return
      const forced = this.forced.delete(id)
      const due = record.logs.filter(log => forced || (log.uploadedRevision < record.revision && log.blocked !== true))
      if (due.length === 0) return
      if (forced) {
        // The current key of a log already uploaded at this revision replays
        // the completed revision without uploading anything; a manual retry
        // (attachments may have changed at equal size) needs the next key.
        const current = new Set(due.filter(log => log.uploadedRevision >= record.revision).map(log => log.ref))
        if (current.size > 0) await this.mutate(id, latest => ({ ...latest, logs: latest.logs.map(log => (current.has(log.ref) ? { ...log, generation: log.generation + 1 } : log)) }))
      }
      this.running.add(id)
      let retry = false
      try {
        const prepared = await this.prepare(record)
        for (const log of due) {
          if (this.stop.signal.aborted) return
          const outcome = prepared.ok ? await this.uploadLog(id, record, log.ref, prepared) : prepared
          const at = this.now()
          await this.mutateLog(id, log.ref, current => (outcome.ok
            ? { ...current, uploadedRevision: Math.max(current.uploadedRevision, record.revision), reportUrl: outcome.reportUrl, uploadedAt: at, lastAttemptAt: at, error: undefined, blocked: false }
            : { ...current, lastAttemptAt: at, error: outcome.error, blocked: !outcome.retryable }))
          if (outcome.ok) await this.link(id)
          else if (outcome.retryable) retry = true
        }
      } finally {
        this.running.delete(id)
      }
      if (!retry) {
        failures = 0
        continue
      }
      failures += 1
      const settings = this.deps.upload()
      if (failures > settings.retries) return
      this.waiting.add(id)
      try {
        await this.sleep(settings.retryDelayMs * 2 ** (failures - 1))
      } finally {
        this.waiting.delete(id)
      }
    }
  }

  private async sleep(ms: number): Promise<void> {
    const signal = this.stop.signal
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(ms, 2_147_483_647))
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /** Check and list the report directory once for this upload pass. */
  private async prepare(record: AnalysisRecord): Promise<Prepared> {
    const dir = this.dirOf(record)
    try {
      await mkdir(dir, { recursive: true })
      if (!(await lstat(dir)).isDirectory()) return { ok: false, retryable: false, error: `报告目录 ${dir} 不是普通目录（可能是符号链接），没有上传` }
      return { ok: true, dir, listing: await listReport(dir) }
    } catch (error) {
      return { ok: false, retryable: true, error: `读取报告目录失败：${messageOf(error)}` }
    }
  }

  /**
   * Choose one log's files against its rendered entry: the entry lists the
   * left-out files, so a larger entry can leave out more; a few rounds settle it.
   */
  private fit(record: AnalysisRecord, log: AnalysisLog, listing: ReportListing, settings: UploadSettings): { manifest: Manifest; entry: Buffer } {
    let reserve = Buffer.byteLength(renderLogReport(record, log, []))
    for (let round = 0; ; round += 1) {
      const manifest = buildManifest(listing, settings, reserve)
      const entry = Buffer.from(renderLogReport(record, log, manifest.skipped))
      if (entry.byteLength <= reserve || round >= 3) return { manifest, entry }
      reserve = entry.byteLength
    }
  }

  /** Upload the report of one log as a revision of the record's current content. */
  private async uploadLog(id: string, record: AnalysisRecord, ref: string, prepared: Extract<Prepared, { ok: true }>): Promise<UploadOutcome> {
    const settings = this.deps.upload()
    for (let attempt = 0; ; attempt += 1) {
      const log = this.deps.store.get(id)?.logs.find(item => item.ref === ref)
      if (log === undefined) return { ok: false, retryable: false, error: `分析记录里没有日志 ${ref}` }
      const { manifest, entry } = this.fit(record, log, prepared.listing, settings)
      const skipped = [...manifest.skipped]
      await this.mutate(id, current => (sameList(current.skipped, skipped) ? undefined : { ...current, skipped }))
      if (entry.byteLength > settings.maxMarkdownBytes) return { ok: false, retryable: false, error: `报告入口 ${entry.byteLength} 字节，超过 Markdown 文件上限 ${settings.maxMarkdownBytes}，没有上传` }
      const total = entry.byteLength + manifest.files.reduce((sum, file) => sum + file.size, 0)
      if (total > settings.maxBytes) return { ok: false, retryable: false, error: `报告共 ${total} 字节，超过总大小上限 ${settings.maxBytes}，没有上传` }
      try {
        const reportUrl = await uploadRevision(this.deps.platform, {
          logId: log.logId,
          key: `logalyze:${record.id}:${ref}:r${record.revision}:g${log.generation}`,
          entry,
          dir: prepared.dir,
          files: manifest.files,
          timeoutMs: settings.timeoutMs,
          concurrency: settings.concurrency,
        })
        return { ok: true, reportUrl }
      } catch (error) {
        // The key was used with other files (the directory changed between
        // attempts): retry once under the next key.
        if (error instanceof PlatformError && error.status === 409 && attempt === 0) {
          await this.mutateLog(id, ref, current => ({ ...current, generation: current.generation + 1 }))
          continue
        }
        if (error instanceof PlatformError) return { ok: false, retryable: error.retryable, error: error.message }
        return { ok: false, retryable: true, error: `上传报告失败：${messageOf(error)}` }
      }
    }
  }

  /** Add the analysis pages known so far to the root card, once per log. */
  private async link(id: string): Promise<void> {
    const record = this.deps.store.get(id)
    if (record === undefined || !record.logs.some(log => log.reportUrl !== undefined && log.linked !== true)) return
    const topics = this.deps.topics()
    if (topics === undefined) return
    let result
    try {
      result = await topics.updateLinks(record.key, analysisCardLinks(record))
    } catch (error) {
      result = { ok: false as const, code: 'update-failed' as const, message: messageOf(error) }
    }
    if (!result.ok) {
      this.deps.warn(`logalyze: 根卡片补充分析报告链接失败：${result.message}`)
      return
    }
    const shown = new Set(record.logs.filter(log => log.reportUrl !== undefined).map(log => log.ref))
    await this.mutate(id, current => ({ ...current, logs: current.logs.map(log => (shown.has(log.ref) ? { ...log, linked: true } : log)) }))
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/** A log whose next upload is due again because the content changed. */
function unblocked(log: AnalysisLog): AnalysisLog {
  return log.blocked === true ? { ...log, blocked: false } : log
}
