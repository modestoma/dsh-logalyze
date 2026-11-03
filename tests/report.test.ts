import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalyzeRequest } from '../src/analyze/contract.ts'
import type { TopicLaunchState } from '../src/analyze/feishu-topics.ts'
import { resolveConfig } from '../src/config.ts'
import type { SessionEventEnvelope } from '../src/host.ts'
import { runCommand, uploadArgv } from '../src/report/command.ts'
import type { CommandRunner } from '../src/report/command.ts'
import { questionOf, renderReport, rewriteReply } from '../src/report/render.ts'
import { reportIdOf, ReportStore } from '../src/report/store.ts'
import { INTERRUPTED_REASON, ReportTracker, statusOfTurnEnd } from '../src/report/tracker.ts'
import type { UploadSettings } from '../src/settings/contract.ts'
import { tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const REQUEST: AnalyzeRequest & { logId: string } = {
  requesterUserId: 'u_alice',
  triggeredAt: '2026-10-28 09:30',
  app: 'order-service',
  errorCode: 'E1001',
  logDetails: [{ name: '日志 1', url: 'https://logs.example.com/d/1' }],
  chatId: 'oc_group1',
  prompt: '/logalyze 分析这些日志',
  logId: 'L-1',
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
    expect(result.text).toContain('[网页](https://example.com/x) [锚点](#top)')
    expect([...result.linked].sort()).toEqual(['a.png', 'sub/b c.md'])
    expect(result.warnings).toEqual(['引用了本机路径 /tmp/x.log', '引用了 report/ 以外的路径 notes/x.md', '引用的文件不存在：report/none.md'])
    expect(rewriteReply('[x](report/../secret)', () => true).warnings).toEqual(['引用了 report/ 以外的路径 report/../secret'])
  })

  it('writes the first turn as the conclusion and later turns as follow-ups with their files', () => {
    const text = renderReport(REQUEST, [
      { kind: 'analysis', status: 'done', reply: '## 结论\n内存溢出', files: ['chart.png'], at: 1 },
      { kind: 'followup', status: 'error', reason: 'model down', question: '为什么？\n具体点', reply: '', files: ['log 1.txt'], at: 2 },
    ])
    expect(text).toContain('| order-service | E1001 | 2026-10-28 09:30 | 已完成 |')
    expect(text).toContain('## 分析结论\n\n## 结论\n内存溢出\n\n**本轮文件**\n\n- ![chart.png](chart.png)')
    expect(text).toContain('## 追问 1\n\n> 为什么？\n> 具体点\n\n> ⚠️ 本轮失败：model down\n\n（本轮没有回复）\n\n**本轮文件**\n\n- [log 1.txt](log%201.txt)\n')
    expect(renderReport(REQUEST, [])).toContain('分析进行中')
  })

  it('reads follow-up questions without the Feishu channel context blocks', () => {
    expect(questionOf(['<feishu_quote>引用</feishu_quote>\n还有别的原因吗？', '<feishu_context a="1">x</feishu_context>'])).toBe('还有别的原因吗？')
    expect(statusOfTurnEnd('aborted')).toBe('stopped')
    expect(statusOfTurnEnd('something-new')).toBe('done')
  })
})

describe('upload settings and command', () => {
  it('defaults to the log platform CLI and validates the placeholders', () => {
    expect(resolveConfig({}).analyze.upload.command).toEqual(['cli', 'log-analysis', 'upload', '--log-id', '{logId}', '--dir', '{dir}', '--entry', '{entry}'])
    expect(() => resolveConfig({ analyze: { upload: { command: ['cli', '--log-id', '{logId}', '--dir', '{dir}', '{other}'] } } })).toThrow('未知占位符 {other}')
    expect(() => resolveConfig({ analyze: { upload: { command: ['cli', '--dir', '{dir}'] } } })).toThrow('{logId}')
    expect(() => resolveConfig({ analyze: { upload: { command: ['{dir}', '{logId}'] } } })).toThrow('可执行文件不能包含占位符')
    expect(uploadArgv(['up', '--id={logId}', '{dir}', '{entry}'], { logId: 'L-1', dir: '/w/report' })).toEqual(['up', '--id=L-1', '/w/report', 'report.md'])
  })

  it('runs the command without a shell and reports failures with their output', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    expect(await runCommand([process.execPath, '-e', 'process.exit(0)', '$(touch x)'], { timeoutMs: 10_000, cwd: dir })).toEqual({ ok: true })
    const failed = await runCommand([process.execPath, '-e', 'console.error("denied"); process.exit(3)'], { timeoutMs: 10_000, cwd: dir })
    expect(failed).toEqual({ ok: false, error: '回传命令失败（退出码 3）：denied' })
    expect(await runCommand(['logalyze-missing-command'], { timeoutMs: 10_000, cwd: dir })).toEqual({ ok: false, error: '找不到回传命令 logalyze-missing-command' })
  })
})

const SETTINGS: UploadSettings = {
  command: ['cli', 'log-analysis', 'upload', '--log-id', '{logId}', '--dir', '{dir}', '--entry', '{entry}'],
  timeoutMs: 10_000,
  retries: 1,
  retryDelayMs: 1,
  maxFiles: 10,
  maxBytes: 1024 * 1024,
}

interface Harness {
  tracker: ReportTracker
  store: ReportStore
  runs: { argv: readonly string[]; report: string }[]
  topic: { state?: TopicLaunchState; sessionId: string }
  workDir: string
  storeDir: string
  settings: UploadSettings
  outcome: { next: Awaited<ReturnType<CommandRunner>> }
  turn(turn: number, input: { question?: string; reply?: string; kind?: string; error?: string }): void
  uploads(count: number): Promise<void>
}

async function harness(storeDir?: string): Promise<Harness> {
  const { dir, cleanup } = await tempDir()
  cleanups.push(cleanup)
  const workDir = join(dir, 'topics', 't1')
  await mkdir(join(workDir, 'report'), { recursive: true })
  const settings = { ...SETTINGS }
  const topic: Harness['topic'] = { sessionId: 'session-1' }
  const runs: Harness['runs'] = []
  const outcome: Harness['outcome'] = { next: { ok: true } }
  const store = new ReportStore(storeDir ?? join(dir, 'store'), () => {})
  const tracker = new ReportTracker({
    store,
    topics: () => ({
      state: key => topic.state?.key === key ? topic.state : undefined,
      launchKeyOf: sessionId => sessionId === topic.sessionId ? topic.state?.key : undefined,
    }),
    upload: () => settings,
    warn: () => {},
    run: async (argv, options) => {
      runs.push({ argv, report: await readFile(join(options.cwd, 'report.md'), 'utf8') })
      return outcome.next
    },
  })
  const header = { id: topic.sessionId }
  const send = (type: string, data: unknown): void => { tracker.sessionEvent({ header }, { type, data } satisfies SessionEventEnvelope) }
  return {
    tracker, store, runs, topic, workDir, storeDir: store.dir, settings, outcome,
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
    uploads: async (count) => { await vi.waitFor(() => { expect(runs).toHaveLength(count) }, { timeout: 3000, interval: 5 }) },
  }
}

describe('report tracking', () => {
  it('uploads the report directory after the first turn and after every follow-up', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'running', sessionId: 'session-1', workDir: h.workDir }
    await h.tracker.track(REQUEST, 'req-1')
    expect(h.runs).toEqual([])

    await writeFile(join(h.workDir, 'report', 'chart.png'), 'png')
    const outside = join(h.workDir, 'outside.md')
    await writeFile(outside, 'outside the report directory')
    await symlink(outside, join(h.workDir, 'report', 'report.md'))
    h.turn(1, { question: `${REQUEST.prompt}\n\n## 报告文件`, reply: '根因：内存溢出 ![图](report/chart.png) [日志](/var/log/app.log)' })
    await h.uploads(1)
    const reportDir = join(h.workDir, 'report')
    expect(h.runs[0]!.argv).toEqual(['cli', 'log-analysis', 'upload', '--log-id', 'L-1', '--dir', reportDir, '--entry', 'report.md'])
    expect(h.runs[0]!.report).toContain('## 分析结论\n\n根因：内存溢出 ![图](chart.png)')
    expect(h.runs[0]!.report).not.toContain('我先看看日志')
    expect(h.runs[0]!.report).not.toContain('本轮文件')
    expect(await readFile(outside, 'utf8')).toBe('outside the report directory')

    await writeFile(join(h.workDir, 'report', 'detail.md'), '# 细节')
    h.turn(2, { question: '<feishu_quote>x</feishu_quote>为什么会溢出？', reply: '因为缓存没有上限。' })
    await h.uploads(2)
    expect(h.runs[1]!.argv).toEqual(h.runs[0]!.argv)
    expect(h.runs[1]!.report).toContain('## 追问 1\n\n> 为什么会溢出？\n\n因为缓存没有上限。\n\n**本轮文件**\n\n- [detail.md](detail.md)')
    expect(await readFile(join(reportDir, 'report.md'), 'utf8')).toBe(h.runs[1]!.report)

    // A repeated turn number and the closer of a resumed turn add nothing.
    h.turn(2, { question: '重复', reply: '重复' })
    h.turn(3, { kind: 'interrupted' })
    const [wire] = h.tracker.list()
    expect(wire).toMatchObject({ id: reportIdOf('req-1'), status: 'done', followups: 1, dir: reportDir, phase: 'done', warnings: ['引用了本机路径 /var/log/app.log'] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.runs).toHaveLength(2)
  })

  it('reports a launch that failed to start or was interrupted, and continues with the follow-up', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'running' }
    await h.tracker.track(REQUEST, 'req-1')
    h.tracker.statusChanged({ key: 'req-1', status: 'failed', reason: '机器人不在群里' })
    await h.uploads(1)
    expect(h.runs[0]!.argv[6]).toBe(join(h.storeDir, reportIdOf('req-1'), 'report'))
    expect(h.runs[0]!.report).toContain('| 未能开始 |')
    expect(h.runs[0]!.report).toContain('> ⚠️ 本轮未能开始：机器人不在群里')

    const other = await harness()
    other.topic.state = { key: 'req-2', status: 'running', sessionId: 'session-1', workDir: other.workDir }
    await other.tracker.track(REQUEST, 'req-2')
    other.tracker.statusChanged({ key: 'req-2', status: 'interrupted', sessionId: 'session-1', workDir: other.workDir })
    await other.uploads(1)
    expect(other.runs[0]!.report).toContain(INTERRUPTED_REASON)
    other.turn(1, { kind: 'interrupted' })
    other.turn(2, { question: '继续', reply: '分析完成：配置错误。' })
    await other.uploads(2)
    expect(other.runs[1]!.report).toContain('## 追问 1\n\n> 继续\n\n分析完成：配置错误。')
  })

  it('records a settled first turn it missed when it reconciles', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'done', sessionId: 'session-1', workDir: h.workDir }
    await h.tracker.track(REQUEST, 'req-1')
    await h.uploads(1)
    expect(h.runs[0]!.report).toContain('观象没有记录到首轮回复')
  })

  it('retries failed runs, refuses symbolic links, and uploads on demand', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'running', sessionId: 'session-1', workDir: h.workDir }
    await h.tracker.track(REQUEST, 'req-1')
    h.outcome.next = { ok: false, error: '网络错误' }
    h.turn(1, { reply: '结论' })
    await h.uploads(2)
    await vi.waitFor(() => { expect(h.tracker.list()[0]).toMatchObject({ phase: 'failed', error: '网络错误' }) })

    h.outcome.next = { ok: true }
    expect(h.tracker.retry(reportIdOf('req-1'))).toBe(true)
    await h.uploads(3)
    await vi.waitFor(() => { expect(h.tracker.list()[0]).toMatchObject({ phase: 'done' }) })
    expect(h.tracker.list()[0]!.error).toBeUndefined()
    expect(h.tracker.retry('0'.repeat(24))).toBe(false)

    await symlink('/etc/hosts', join(h.workDir, 'report', 'hosts'))
    h.turn(2, { question: '再看看', reply: '好的' })
    await vi.waitFor(() => { expect(h.tracker.list()[0]!.error).toContain('符号链接') })
    expect(h.tracker.list()[0]!.phase).toBe('failed')
    expect(h.runs).toHaveLength(3)
  })

  it('refuses a report directory over the file limit', async () => {
    const h = await harness()
    h.settings.maxFiles = 2
    h.topic.state = { key: 'req-1', status: 'running', sessionId: 'session-1', workDir: h.workDir }
    await h.tracker.track(REQUEST, 'req-1')
    await writeFile(join(h.workDir, 'report', 'a.txt'), 'a')
    await writeFile(join(h.workDir, 'report', 'b.txt'), 'b')
    h.turn(1, { reply: '结论' })
    await vi.waitFor(() => { expect(h.tracker.list()[0]!.error).toBe('报告目录有 3 个文件，超过上限 2，没有上传') })
    expect(h.runs).toEqual([])
  })

  it('resumes unfinished uploads from the stored records', async () => {
    const h = await harness()
    h.topic.state = { key: 'req-1', status: 'running', sessionId: 'session-1', workDir: h.workDir }
    await h.tracker.track(REQUEST, 'req-1')
    h.tracker.shutdown()
    h.turn(1, { reply: '结论' })
    await vi.waitFor(() => { expect(h.store.get(reportIdOf('req-1'))?.revision).toBe(1) })
    expect(h.runs).toEqual([])

    const next = await harness(h.storeDir)
    await next.tracker.boot()
    await next.uploads(1)
    expect(next.runs[0]!.argv[6]).toBe(join(h.workDir, 'report'))
    expect(next.tracker.list()).toHaveLength(1)
  })
})
