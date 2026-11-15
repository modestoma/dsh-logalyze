import { access, mkdir, readFile, symlink, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBatch } from '../src/analyze/batch.ts'
import { analyzeRequestHash } from '../src/analyze/contract.ts'
import type { AnalyzeRequest } from '../src/analyze/contract.ts'
import { newAnalysisRecord } from '../src/analyze/record.ts'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { FeishuTopicService, TopicCardLinks, TopicLaunchState } from '../src/deps/topics-contract.ts'
import type { SessionEventEnvelope } from '../src/host.ts'
import { PlatformClient, PlatformError } from '../src/platform/client.ts'
import type { PlatformLog } from '../src/platform/client.ts'
import { listReport } from '../src/report/files.ts'
import { LegacyReports } from '../src/report/legacy.ts'
import { buildManifest, pathProblem } from '../src/report/manifest.ts'
import { questionOf, renderLogReport, rewriteReply } from '../src/report/render.ts'
import { analysisIdOf, AnalysisStore, MAX_REPORT_RECORDS, REPORT_RETENTION_MS } from '../src/report/store.ts'
import type { AnalysisRecord } from '../src/report/store.ts'
import { INTERRUPTED_REASON, ReportTracker, statusOfTurnEnd } from '../src/report/tracker.ts'
import { uploadRevision } from '../src/report/upload.ts'
import type { AppManifest, UploadSettings } from '../src/settings/contract.ts'
import { FakePlatform, logUuid, orderLog } from './fake-platform.ts'
import type { FakeLog } from './fake-platform.ts'
import { tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const DAY = 24 * 60 * 60 * 1000
const ORDER: AppManifest = { id: 'order-service', name: '订单服务', description: '', aliases: ['order'], logHints: [], skill: 'log-analysis' }

const REQUEST: AnalyzeRequest = {
  triggerType: 'digital',
  triggerId: 'u_alice',
  triggeredAt: '2026-10-28 09:30',
  chatId: 'oc_group1',
  logIds: [logUuid(1), logUuid(2)],
}

function platformLog(log: FakeLog): PlatformLog {
  return { product_code: null, product_sn: null, hw_version: null, sw_version: null, component_version: null, log_type: null, file_size_bytes: null, created_at: null, archived_at: null, detail_url: null, ...log }
}

/** A new analysis of the given logs under one key. */
function analysis(key: string, count = 2, acceptedAt = Date.now()): AnalysisRecord {
  const logs = Array.from({ length: count }, (_, index) => orderLog(index + 1))
  const request = { ...REQUEST, logIds: logs.map(log => log.log_id) }
  const batch = resolveBatch(request.logIds, logs.map(platformLog), [ORDER])
  if (!batch.ok) throw new Error(batch.error)
  return newAnalysisRecord(request, key, analyzeRequestHash(request), batch.value, acceptedAt)
}

describe('report rendering', () => {
  it('makes report/ links relative to the report directory and reports links the caller cannot open', () => {
    const files = new Set(['a.png', 'sub/b c.md'])
    const result = rewriteReply([
      '结论见 ![图](report/a.png) 和 [细节](<./report/sub/b c.md>)。',
      '[本机](/tmp/x.log) [外面](notes/x.md) [缺失](report/none.md) [网页](https://example.com/x) [锚点](#top)',
      '[ref]: report/a.png',
    ].join('\n'), path => files.has(path))
    expect(result.text).toContain('![图](a.png)')
    expect(result.text).toContain('[细节](<sub/b c.md>)')
    expect(result.text).toContain('[ref]: a.png')
    expect([...result.linked].sort()).toEqual(['a.png', 'sub/b c.md'])
    expect(result.warnings).toEqual(['引用了本机路径 /tmp/x.log', '引用了 report/ 以外的路径 notes/x.md', '引用的文件不存在：report/none.md'])
    expect(rewriteReply('[x](report/../secret)', () => true).warnings).toEqual(['引用了 report/ 以外的路径 report/../secret'])
  })

  it('writes one log of a batch with its own conclusion, the batch conclusion, follow-ups, and skipped files', () => {
    const record: AnalysisRecord = {
      ...analysis('req-1'),
      sections: [
        { kind: 'analysis', status: 'done', reply: '## 结论\n内存溢出', files: ['chart.png'], at: 1 },
        { kind: 'followup', status: 'error', reason: 'model down', question: '为什么？\n具体点', reply: '', files: ['log 1.txt'], at: 2 },
      ],
    }
    const log = { ...record.logs[0]!, conclusion: '属于根因 A' }
    const text = renderLogReport(record, log, ['x.exe：扩展名只能是 md/png'])
    expect(text).toContain(`| L1 · device-1.tar.gz | 订单服务 | E1001 | 2026-10-28 09:30 | 已完成 |\n\n日志 id \`${logUuid(1)}\`；设备 SN SN1；软件版本 2.0.1；组件版本 1.4.0`)
    expect(text).toContain('本次与另外 1 份日志（L2）集中分析')
    expect(text).toContain('## 本日志结论\n\n属于根因 A\n\n## 整批结论\n\n## 结论\n内存溢出\n\n**本轮文件**\n\n- ![chart.png](chart.png)')
    expect(text).toContain('## 追问 1\n\n> 为什么？\n> 具体点\n\n> ⚠️ 本轮失败：model down\n\n（本轮没有回复）\n\n**本轮文件**\n\n- [log 1.txt](log%201.txt)')
    expect(text).toMatch(/## 未上传的文件\n\n- x\.exe：扩展名只能是 md\/png\n$/u)
    expect(renderLogReport(record, record.logs[1]!, [])).toContain('## 本日志结论\n\n本次没有这份日志单独的结论，见「整批结论」。')
  })

  it('writes a single log with one conclusion and an unlabeled error code', () => {
    const record = { ...analysis('req-1', 1), errorCode: null }
    const text = renderLogReport(record, record.logs[0]!, [])
    expect(text).toContain('| 未标注 | 2026-10-28 09:30 | 分析中 |')
    expect(text).toContain('## 分析结论\n\n分析进行中')
    expect(text).not.toContain('本日志结论')
  })

  it('reads follow-up questions without the Feishu channel context blocks', () => {
    expect(questionOf(['<feishu_quote>引用</feishu_quote>\n还有别的原因吗？', '<feishu_context a="1">x</feishu_context>'])).toBe('还有别的原因吗？')
    expect(statusOfTurnEnd('aborted')).toBe('stopped')
    expect(statusOfTurnEnd('something-new')).toBe('done')
  })
})

const LIMITS: UploadSettings = { ...defaultsOf(resolveConfig({})).analyze.upload, retries: 1, retryDelayMs: 1 }

describe('report manifest', () => {
  it('names why the platform would refuse a path', () => {
    expect(pathProblem('a/b/c/d.png')).toBeUndefined()
    expect(pathProblem('a/b/c/d/e.png')).toContain('层级')
    expect(pathProblem('.hidden.md')).toContain('不能以点开头')
    expect(pathProblem('图.png')).toContain('英文字母')
    expect(pathProblem('a.exe')).toContain('扩展名')
    expect(pathProblem('LOG.TXT')).toBeUndefined()
    expect(pathProblem(`${'a'.repeat(253)}.md`)).toContain('255')
  })

  it('chooses files within the limits and lists the rest with the reason', () => {
    const limits = { ...LIMITS, maxFiles: 3, maxFileBytes: 100, maxMarkdownBytes: 50, maxBytes: 1150 }
    const manifest = buildManifest({
      files: {},
      sizes: { 'a.png': 90, 'b.md': 60, 'c.txt': 0, 'd.log': 101, 'e.json': 70, 'f.csv': 10, 'g.exe': 1 },
      count: 7,
      bytes: 0,
      refused: ['link.png'],
    }, limits, 1000)
    expect(manifest.files).toEqual([{ path: 'a.png', size: 90 }, { path: 'f.csv', size: 10 }])
    expect(manifest.skipped).toEqual([
      'b.md：超过 Markdown 文件上限 50 字节',
      'c.txt：空文件',
      'd.log：超过单文件上限 100 字节',
      'e.json：超过总大小上限 1150 字节',
      'g.exe：扩展名只能是 md/png/jpg/jpeg/gif/webp/csv/txt/json/log',
      'link.png：符号链接或特殊文件',
    ])
    const counted = buildManifest({ files: {}, sizes: { 'a.txt': 1, 'b.txt': 1, 'c.txt': 1 }, count: 3, bytes: 3, refused: [] }, { ...LIMITS, maxFiles: 3 }, 0)
    expect(counted.skipped).toEqual(['c.txt：超过文件数上限 3'])
  })
})

describe('revision upload', () => {
  it('fails retryably when a file changed size or the platform asks for a file outside the manifest', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await writeFile(join(dir, 'a.txt'), 'abc')
    const put = vi.fn(async () => {})
    const platform = {
      createAnalysis: async () => ({ analysis_id: 'an-1', status: 'pending', uploads: [{ path: 'report.md', upload_url: 'u0' }, { path: 'a.txt', upload_url: 'u1' }] }),
      completeAnalysis: async () => 'https://logs.example.com/analysis',
      put,
    }
    const upload = { logId: logUuid(1), key: 'k', entry: Buffer.from('# r'), dir, files: [{ path: 'a.txt', size: 3 }], timeoutMs: 1000, concurrency: 1 }
    expect(await uploadRevision(platform, upload)).toBe('https://logs.example.com/analysis')
    expect(put.mock.calls.map(call => (call as unknown[])[0])).toEqual(['u0', 'u1'])
    await truncate(join(dir, 'a.txt'), 1)
    await expect(uploadRevision(platform, upload)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('在上传期间被改动') })
    await expect(uploadRevision({ ...platform, createAnalysis: async () => ({ analysis_id: 'an-1', status: 'pending', uploads: [{ path: 'x.txt', upload_url: 'u' }] }) }, upload))
      .rejects.toMatchObject({ retryable: false, message: expect.stringContaining('清单外的文件 x.txt') })
    expect(await uploadRevision({ ...platform, createAnalysis: async () => ({ analysis_id: 'an-1', status: 'completed', uploads: [] }) }, upload)).toBe('https://logs.example.com/analysis')
  })
})

type TrackerTopics = FeishuTopicService & { links: { key: string; links: TopicCardLinks | undefined }[]; linkResult: { ok: true } | { ok: false; code: 'not-connected'; message: string } }

interface Harness {
  tracker: ReportTracker
  store: AnalysisStore
  platform: FakePlatform
  topics: TrackerTopics
  topic: { state?: TopicLaunchState; sessionId: string }
  workDir: string
  storeDir: string
  settings: UploadSettings
  warn: ReturnType<typeof vi.fn>
  turn(turn: number, input: { question?: string; reply?: string; kind?: string; error?: string }): void
  /** Wait until the platform holds this many completed revisions. */
  completed(count: number): Promise<void>
  /** Accept an analysis whose topic runs in {@link workDir}. */
  start(record?: AnalysisRecord): Promise<AnalysisRecord>
}

async function harness(options: { storeDir?: string; platform?: FakePlatform } = {}): Promise<Harness> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  let platform = options.platform
  if (platform === undefined) {
    const started = new FakePlatform()
    await started.start()
    cleanups.push(async () => { await started.stop() })
    platform = started
  }
  const fake = platform
  fake.addLog(orderLog(1))
  fake.addLog(orderLog(2))
  const workDir = join(dir, 'topics', 't1')
  await mkdir(join(workDir, 'report'), { recursive: true })
  const settings = { ...LIMITS }
  const topic: Harness['topic'] = { sessionId: 'session-1' }
  const warn = vi.fn()
  const topics: TrackerTopics = {
    version: 3,
    links: [],
    linkResult: { ok: true },
    launch: async () => ({ ok: true, replayed: false, chatId: 'oc_group1', messageId: 'om_root' }),
    state: key => topic.state?.key === key ? topic.state : undefined,
    launchKeyOf: sessionId => sessionId === topic.sessionId ? topic.state?.key : undefined,
    updateLinks: async (key, links) => { topics.links.push({ key, links }); return topics.linkResult },
  }
  const store = new AnalysisStore(options.storeDir ?? join(dir, 'store'), warn)
  const client = new PlatformClient({ settings: () => fake.settings(), secret: async () => fake.secret })
  const tracker = new ReportTracker({ store, topics: () => topics, platform: client, upload: () => settings, warn })
  cleanups.push(async () => { tracker.shutdown() })
  const header = { id: topic.sessionId }
  const send = (type: string, data: unknown): void => { tracker.sessionEvent({ header }, { type, data } satisfies SessionEventEnvelope) }
  return {
    tracker, store, platform: fake, topics, topic, workDir, storeDir: store.dir, settings, warn,
    turn: (turn, input) => {
      send('turn/start', { turn })
      if (input.question !== undefined) send('user/message', { role: 'user', content: [{ type: 'text', text: input.question }], source: { kind: 'user' } })
      send('user/message', { role: 'user', content: [{ type: 'text', text: 'skill body' }], source: { kind: 'skill' } })
      if (input.reply !== undefined) {
        send('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: '我先看看日志' }, { type: 'tool-call', id: 'c1' }] } })
        send('assistant/message', { turn, step: 2, message: { content: [{ type: 'text', text: input.reply }] } })
      }
      send('turn/end', { turn, reason: input.kind === 'error' ? { kind: 'error', error: { message: input.error } } : { kind: input.kind ?? 'completed' } })
    },
    completed: async (count) => {
      await vi.waitFor(() => { expect(fake.revisions.filter(revision => revision.completed)).toHaveLength(count) }, { timeout: 3000, interval: 5 })
    },
    start: async (record = analysis('req-1')) => {
      topic.state ??= { key: record.key, status: 'running', sessionId: topic.sessionId, workDir }
      await tracker.accept(record)
      await tracker.launched(record.id)
      return record
    },
  }
}

describe('report tracking', () => {
  it('uploads a revision to every log after the first turn and after every follow-up, and links the card once', async () => {
    const h = await harness()
    const record = await h.start()
    expect(h.platform.revisions).toEqual([])

    const reportDir = join(h.workDir, 'report')
    await writeFile(join(reportDir, 'chart.png'), 'png')
    await mkdir(join(reportDir, 'logs'))
    await writeFile(join(reportDir, 'logs', 'L1.md'), '根因 A，见 ![图](report/chart.png)')
    const outside = join(h.workDir, 'outside.md')
    await writeFile(outside, 'outside the report directory')
    await symlink(outside, join(reportDir, 'report.md'))
    h.turn(1, { question: '/logalyze 分析', reply: '整批根因：内存溢出 ![图](report/chart.png) [日志](/var/log/app.log)' })
    await h.completed(2)

    const [first, second] = h.platform.revisions
    expect([first?.logId, second?.logId]).toEqual([logUuid(1), logUuid(2)])
    expect(first?.key).toBe(`logalyze:${record.id}:L1:r1:g0`)
    expect([...first!.sizes.keys()].sort()).toEqual(['chart.png', 'logs/L1.md', 'report.md'])
    const entry = h.platform.entryOf(first!)
    expect(entry).toContain('## 本日志结论\n\n根因 A，见 ![图](chart.png)')
    expect(entry).toContain('## 整批结论\n\n整批根因：内存溢出 ![图](chart.png)')
    expect(entry).not.toContain('我先看看日志')
    expect(entry).not.toContain('本轮文件')
    expect(entry).toContain('report.md：符号链接或特殊文件')
    expect(h.platform.entryOf(second!)).toContain('本次没有这份日志单独的结论')
    expect(await readFile(outside, 'utf8')).toBe('outside the report directory')

    await vi.waitFor(() => { expect(h.store.get(record.id)?.logs.every(log => log.linked === true)).toBe(true) })
    const lastLinks = h.topics.links.at(-1)?.links
    expect(lastLinks?.rows.map(row => row.extraUrl)).toEqual([`${h.platform.base}/logs/${logUuid(1)}/analysis`, `${h.platform.base}/logs/${logUuid(2)}/analysis`])
    const linkCalls = h.topics.links.length

    await writeFile(join(reportDir, 'detail.md'), '# 细节')
    h.turn(2, { question: '<feishu_quote>x</feishu_quote>为什么会溢出？', reply: '因为缓存没有上限。' })
    await h.completed(4)
    expect(h.platform.revisions[2]?.key).toBe(`logalyze:${record.id}:L1:r2:g0`)
    expect(h.platform.entryOf(h.platform.revisions[2]!)).toContain('## 追问 1\n\n> 为什么会溢出？\n\n因为缓存没有上限。\n\n**本轮文件**\n\n- [detail.md](detail.md)')
    expect(h.topics.links).toHaveLength(linkCalls)

    // A repeated turn number and the closer of a resumed turn add nothing.
    h.turn(2, { question: '重复', reply: '重复' })
    h.turn(3, { kind: 'interrupted' })
    await vi.waitFor(() => { expect(h.tracker.list()[0]?.logs.map(log => log.phase)).toEqual(['done', 'done']) })
    expect(h.tracker.list()[0]).toMatchObject({ id: analysisIdOf('req-1'), status: 'done', followups: 1, dir: reportDir, warnings: ['引用了本机路径 /var/log/app.log'], skipped: ['report.md：符号链接或特殊文件'] })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.platform.revisions).toHaveLength(4)
  })

  it('reports a launch that failed to start or was interrupted, and continues with the follow-up', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'running' }
    await h.start(analysis('req-1', 1))
    h.tracker.statusChanged({ key: 'req-1', status: 'failed', reason: '机器人不在群里' })
    await h.completed(1)
    const entry = h.platform.entryOf(h.platform.revisions[0]!)
    expect(entry).toContain('| 未能开始 |')
    expect(entry).toContain('> ⚠️ 本轮未能开始：机器人不在群里')
    expect(h.tracker.list()[0]?.dir).toBe(join(h.storeDir, analysisIdOf('req-1'), 'report'))

    const other = await harness()
    await other.start(analysis('req-2', 1))
    other.tracker.statusChanged({ key: 'req-2', status: 'interrupted', sessionId: 'session-1', workDir: other.workDir })
    await other.completed(1)
    expect(other.platform.entryOf(other.platform.revisions[0]!)).toContain(INTERRUPTED_REASON)
    other.turn(1, { kind: 'interrupted' })
    other.turn(2, { question: '继续', reply: '分析完成：配置错误。' })
    await other.completed(2)
    expect(other.platform.entryOf(other.platform.revisions[1]!)).toContain('## 追问 1\n\n> 继续\n\n分析完成：配置错误。')
  })

  it('records a settled first turn it missed when the launch is picked up', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'done', sessionId: 'session-1', workDir: h.workDir }
    await h.start(analysis('req-1', 1))
    await h.completed(1)
    expect(h.platform.entryOf(h.platform.revisions[0]!)).toContain('观象没有记录到首轮回复')
  })

  it('retries retryable failures, stops on the others, and uploads again on demand', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    h.platform.fail('create', 503)
    h.turn(1, { reply: '结论' })
    await h.completed(1)
    expect(h.platform.calls('create')).toHaveLength(2)

    h.platform.fail('complete', 400)
    h.turn(2, { question: '再看看', reply: '好的' })
    await vi.waitFor(() => { expect(h.tracker.list()[0]?.logs[0]).toMatchObject({ phase: 'failed', error: expect.stringContaining('完成分析修订失败：HTTP 400') }) })
    expect(h.store.get(record.id)?.logs[0]?.blocked).toBe(true)

    expect(h.tracker.retry(record.id)).toBe(true)
    await h.completed(2)
    await vi.waitFor(() => { expect(h.tracker.list()[0]?.logs[0]).toMatchObject({ phase: 'done' }) })
    expect(h.tracker.list()[0]?.logs[0]?.error).toBeUndefined()
    expect(h.tracker.retry('0'.repeat(24))).toBe(false)
  })

  it('signs new upload links when one expired, and uploads under the next key when retried by hand', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    await writeFile(join(h.workDir, 'report', 'a.txt'), 'old')
    h.platform.fail('put', 403)
    h.turn(1, { reply: '结论' })
    await h.completed(1)
    expect(h.platform.revisions).toHaveLength(1)
    expect(h.platform.calls('create')).toHaveLength(2)

    await writeFile(join(h.workDir, 'report', 'a.txt'), 'new')
    expect(h.tracker.retry(record.id)).toBe(true)
    await h.completed(2)
    expect(h.platform.revisions[1]?.key).toBe(`logalyze:${record.id}:L1:r1:g1`)
    expect(h.platform.revisions[1]?.files.get('a.txt')?.toString('utf8')).toBe('new')
  })

  it('leaves out attachments that do not fit beside the rendered entry instead of refusing the report', async () => {
    const h = await harness()
    h.settings.maxBytes = 3000
    const record = await h.start(analysis('req-1', 1))
    await writeFile(join(h.workDir, 'report', 'big.txt'), 'x'.repeat(2800))
    await writeFile(join(h.workDir, 'report', 'small.txt'), 'y')
    h.turn(1, { reply: '结论' })
    await h.completed(1)
    const revision = h.platform.revisions[0]!
    expect([...revision.sizes.keys()].sort()).toEqual(['report.md', 'small.txt'])
    expect(h.platform.entryOf(revision)).toContain('big.txt：超过总大小上限 3000 字节')
    expect(h.store.get(record.id)?.skipped).toEqual(['big.txt：超过总大小上限 3000 字节'])
  })

  it('keeps leaving out attachments until the report with its growing skipped list fits', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    for (let index = 0; index < 6; index += 1) await writeFile(join(h.workDir, 'report', `0${index}.txt`), 'z'.repeat(50))
    h.tracker.shutdown()
    h.turn(1, { reply: '结论' })
    await vi.waitFor(() => { expect(h.store.get(record.id)?.revision).toBe(1) })
    const stored = h.store.get(record.id)!
    const maxBytes = Buffer.byteLength(renderLogReport(stored, stored.logs[0]!, [])) + 299

    const next = await harness({ storeDir: h.storeDir, platform: h.platform })
    next.topic.state = h.topic.state
    next.settings.maxBytes = maxBytes
    await next.tracker.boot()
    await next.completed(1)
    const revision = next.platform.revisions[0]!
    expect([...revision.sizes.values()].reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(maxBytes)
    expect(next.store.get(record.id)?.logs[0]?.error).toBeUndefined()
  })

  it('moves to the next key when the platform refuses a key reused with other files', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    h.platform.fail('create', 409)
    h.turn(1, { reply: '结论' })
    await h.completed(1)
    expect(h.platform.revisions[0]?.key).toBe(`logalyze:${record.id}:L1:r1:g1`)
    expect(h.store.get(record.id)?.logs[0]?.generation).toBe(1)
  })

  it('refuses a report directory that is a symbolic link and an entry over the Markdown or single-file limit', async () => {
    const h = await harness()
    h.settings.maxMarkdownBytes = 10
    await h.start(analysis('req-1', 1))
    h.turn(1, { reply: '一段超过十个字节的结论' })
    await vi.waitFor(() => { expect(h.tracker.list()[0]?.logs[0]?.error).toContain('超过 Markdown 文件上限 10') })
    expect(h.platform.revisions).toEqual([])

    const single = await harness()
    single.settings.maxFileBytes = 10
    await single.start(analysis('req-3', 1))
    single.turn(1, { reply: '一段超过十个字节的结论' })
    await vi.waitFor(() => { expect(single.tracker.list()[0]?.logs[0]?.error).toContain('超过单文件上限 10') })
    expect(single.platform.revisions).toEqual([])

    const other = await harness()
    const target = join(other.workDir, 'elsewhere')
    await mkdir(target)
    await import('node:fs/promises').then(fs => fs.rm(join(other.workDir, 'report'), { recursive: true }))
    await symlink(target, join(other.workDir, 'report'))
    await other.start(analysis('req-2', 1))
    other.turn(1, { reply: '结论' })
    await vi.waitFor(() => { expect(other.tracker.list()[0]?.logs[0]?.error).toContain('符号链接') })
    expect(other.platform.revisions).toEqual([])
  })

  it('warns and keeps the card when the link update fails, and links again when topics reconcile', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    h.topics.linkResult = { ok: false, code: 'not-connected', message: '飞书未连接' }
    h.turn(1, { reply: '结论' })
    await h.completed(1)
    await vi.waitFor(() => { expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('飞书未连接')) })
    expect(h.store.get(record.id)?.logs[0]?.linked).toBeUndefined()
    h.topics.linkResult = { ok: true }
    await h.tracker.reconcile()
    expect(h.store.get(record.id)?.logs[0]?.linked).toBe(true)
  })

  it('resumes unfinished uploads from the stored records', async () => {
    const h = await harness()
    const record = await h.start(analysis('req-1', 1))
    h.tracker.shutdown()
    h.turn(1, { reply: '结论' })
    await vi.waitFor(() => { expect(h.store.get(record.id)?.revision).toBe(1) })
    expect(h.platform.revisions).toEqual([])

    const next = await harness({ storeDir: h.storeDir, platform: h.platform })
    next.topic.state = h.topic.state
    await next.tracker.boot()
    await next.completed(1)
    expect(next.tracker.list()).toHaveLength(1)
  })
})

describe('report retention', () => {
  const exists = async (path: string): Promise<boolean> => await access(path).then(() => true, () => false)
  function record(key: string, acceptedAt: number, sectionAt?: number): AnalysisRecord {
    return { ...analysis(key, 1, acceptedAt), sections: sectionAt === undefined ? [] : [{ kind: 'analysis', status: 'done', reply: '结论', files: [], at: sectionAt }] }
  }

  it('drops records inactive past the retention period with their store-local report directories, and keeps busy ones', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const store = new AnalysisStore(dir, () => {})
    const now = 100 * DAY
    await store.put(record('old', now - REPORT_RETENTION_MS - DAY))
    await store.put(record('followed-up', now - REPORT_RETENTION_MS - DAY, now - DAY))
    await store.put(record('busy', now - REPORT_RETENTION_MS - DAY))
    await mkdir(join(dir, analysisIdOf('old'), 'report'), { recursive: true })
    expect(await store.prune(now, id => id === analysisIdOf('busy'))).toEqual([analysisIdOf('old')])
    expect(store.all().map(item => item.key).sort()).toEqual(['busy', 'followed-up'])
    expect(await exists(join(dir, `${analysisIdOf('old')}.json`))).toBe(false)
    expect(await exists(join(dir, analysisIdOf('old')))).toBe(false)
    const reloaded = new AnalysisStore(dir, () => {})
    await reloaded.load()
    expect(reloaded.all()).toHaveLength(2)
  })

  it('keeps the most recently active records up to the limit', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const store = new AnalysisStore(dir, () => {})
    for (let index = 0; index <= MAX_REPORT_RECORDS; index += 1) await store.put(record(`r${index}`, DAY + index))
    expect(await store.prune(2 * DAY, () => false)).toEqual([analysisIdOf('r0')])
    expect(store.all()).toHaveLength(MAX_REPORT_RECORDS)
  })

  it('prunes when the tracker boots and when it accepts a new analysis', async () => {
    const h = await harness()
    await h.store.put(record('stale', Date.now() - REPORT_RETENTION_MS - DAY))
    await h.tracker.boot()
    expect(h.store.get(analysisIdOf('stale'))).toBeUndefined()
    await h.store.put(record('stale', Date.now() - REPORT_RETENTION_MS - DAY))
    await h.start(analysis('req-1', 1))
    expect(h.store.all().map(item => item.key)).toEqual(['req-1'])
  })

  it('shows the former command uploads until they expire, and skips unreadable files', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const now = 100 * DAY
    const old = (id: string, acceptedAt: number): string => JSON.stringify({ id, key: id, logId: 'L-1', app: 'order-service', errorCode: 'E1', triggeredAt: 't', acceptedAt, sections: [], uploadedAt: acceptedAt })
    await writeFile(join(dir, `${'a'.repeat(24)}.json`), old('a'.repeat(24), now - DAY))
    await writeFile(join(dir, `${'b'.repeat(24)}.json`), old('b'.repeat(24), now - 2 * DAY))
    await writeFile(join(dir, `${'c'.repeat(24)}.json`), old('c'.repeat(24), now - REPORT_RETENTION_MS - DAY))
    await mkdir(join(dir, 'c'.repeat(24)))
    await writeFile(join(dir, 'broken.json'), '{')
    const warn = vi.fn()
    const legacy = new LegacyReports(dir, warn)
    await legacy.load(now)
    expect(legacy.list().map(item => item.id)).toEqual(['a'.repeat(24), 'b'.repeat(24)])
    expect(legacy.list()[0]).toEqual({ id: 'a'.repeat(24), logId: 'L-1', app: 'order-service', errorCode: 'E1', triggeredAt: 't', acceptedAt: now - DAY, uploadedAt: now - DAY })
    expect(await exists(join(dir, `${'c'.repeat(24)}.json`))).toBe(false)
    expect(await exists(join(dir, 'c'.repeat(24)))).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken.json'))
    const missing = new LegacyReports(join(dir, 'none'), warn)
    await missing.load(now)
    expect(missing.list()).toEqual([])
  })
})

describe('report listing', () => {
  it('lists sizes without following symbolic links', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await mkdir(join(dir, 'sub'))
    await writeFile(join(dir, 'sub', 'a.txt'), 'abc')
    await writeFile(join(dir, 'report.md'), 'entry')
    await symlink('/etc/hosts', join(dir, 'hosts'))
    const listing = await listReport(dir)
    expect(listing.sizes).toEqual({ 'sub/a.txt': 3 })
    expect(listing.refused).toEqual(['hosts'])
    expect(listing.count).toBe(2)
  })
})

describe('platform errors', () => {
  it('carries whether a retry can help', () => {
    expect(new PlatformError('x', true, 503)).toMatchObject({ retryable: true, status: 503, message: 'x' })
  })
})
