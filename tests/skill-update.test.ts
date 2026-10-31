import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, ApprovalOutcome, ApprovalRequest, HostApproval, SubagentActivation, SubagentResult, SubagentService } from '../src/host.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import { DIFF_FILE, readProposal, replaceFile } from '../src/skill-update/proposal.ts'
import { renderImproveValue, SkillImprover } from '../src/skill-update/tool.ts'
import type { AnalyzedTask } from '../src/skill-update/tool.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const LIMITS = { maxFiles: 4, maxFileBytes: 4096 }
const SKILL = '.agents/skills/log-analysis/SKILL.md'
const MR_URL = 'https://gitlab.example.com/group/order-service/-/merge_requests/7'

async function dir(): Promise<string> {
  const { dir: path, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return path
}

async function writeProposal(workDir: string, files: Record<string, string>, reason = '日志格式里漏了 traceId 字段'): Promise<void> {
  await mkdir(join(workDir, 'skill-proposal', 'files'), { recursive: true })
  await writeFile(join(workDir, 'skill-proposal', 'reason.md'), reason)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workDir, 'skill-proposal', 'files', path)), { recursive: true })
    await writeFile(join(workDir, 'skill-proposal', 'files', path), content)
  }
}

describe('readProposal', () => {
  it('returns nothing when the task wrote no proposal', async () => {
    expect(await readProposal(await dir(), LIMITS)).toBeUndefined()
  })

  it('reads the reason and every file by its path under the skill directory', async () => {
    const workDir = await dir()
    await writeProposal(workDir, { 'SKILL.md': '# new', 'references/formats.md': 'a' }, '  理由  \n')
    expect(await readProposal(workDir, LIMITS)).toEqual({
      reason: '理由',
      files: [{ path: 'SKILL.md', content: '# new' }, { path: 'references/formats.md', content: 'a' }],
    })
  })

  it('rejects proposals that cannot be submitted', async () => {
    const cases: [string, (workDir: string) => Promise<void>, RegExp][] = [
      ['no reason', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': 'x' }, '  ') }, /reason.md 不能为空/],
      ['no files', async (workDir) => { await writeProposal(workDir, {}) }, /没有文件/],
      ['symbolic link', async (workDir) => {
        await writeProposal(workDir, {})
        await symlink('/etc/passwd', join(workDir, 'skill-proposal', 'files', 'SKILL.md'))
      }, /不是普通文件/],
      ['hidden name', async (workDir) => { await writeProposal(workDir, { '.env': 'x' }) }, /文件名不合法/],
      ['too many files', async (workDir) => { await writeProposal(workDir, { a: '1', b: '2', c: '3', d: '4', e: '5' }) }, /文件数超过上限 4/],
      ['too large', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': 'x'.repeat(5000) }) }, /超过上限 4096/],
      ['binary', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': '\u0000' }) }, /NUL/],
      ['not user-invocable', async (workDir) => { await writeProposal(workDir, { 'SKILL.md': '---\nname: log-analysis\nuser-invocable: false\n---\n' }) }, /user-invocable/],
    ]
    for (const [, arrange, message] of cases) {
      const workDir = await dir()
      await arrange(workDir)
      await expect(readProposal(workDir, LIMITS)).rejects.toThrow(message)
    }
    const invalid = await dir()
    await writeProposal(invalid, {})
    await writeFile(join(invalid, 'skill-proposal', 'files', 'SKILL.md'), Buffer.from([0xff, 0xfe]))
    await expect(readProposal(invalid, LIMITS)).rejects.toThrow(/不是 UTF-8/)
  })
})

describe('replaceFile', () => {
  it('replaces a symbolic link left at the path instead of writing through it', async () => {
    const root = await dir()
    const victim = join(root, 'victim.md')
    await writeFile(victim, 'before')
    await symlink(victim, join(root, DIFF_FILE))
    await replaceFile(join(root, DIFF_FILE), 'diff')
    expect(await readFile(victim, 'utf8')).toBe('before')
    expect((await lstat(join(root, DIFF_FILE))).isFile()).toBe(true)
    expect(await readFile(join(root, DIFF_FILE), 'utf8')).toBe('diff')
  })
})

/**
 * A local `dshRepos` stand-in whose commit, branch, and merge request calls
 * record their arguments and track which branches exist.
 */
function fakeRepos(root: string) {
  const state = { branches: new Set<string>(), changeError: undefined as Error | undefined }
  const conflict = (branch: string) => Object.assign(new Error(`分支 ${branch} 已存在`), { name: 'RepoError', code: 'conflict' })
  const service = Object.assign(Object.create(new FakeRepos(root)) as FakeRepos, {
    getBranch: vi.fn(async (_repo: string, name: string) => state.branches.has(name) ? { name, commit: 'f'.repeat(40), protected: false, default: false } : undefined),
    commitFiles: vi.fn(async (_repo: string, request: Record<string, unknown> & { branch: string }) => {
      if (state.branches.has(request.branch)) throw conflict(request.branch)
      state.branches.add(request.branch)
      return { sha: 'c'.repeat(40), branch: request.branch, createdBranch: true }
    }),
    createChange: vi.fn(async () => {
      if (state.changeError !== undefined) throw state.changeError
      return { number: 7, webUrl: MR_URL }
    }),
  })
  return { state, service }
}

interface Started {
  spec: Parameters<SubagentService['startActivation']>[0]
  settle: (result: SubagentResult) => void
  dispose: Mock<() => Promise<void>>
}

function fakeSubagents(): { service: SubagentService; started: Started[] } {
  const started: Started[] = []
  const service: SubagentService = {
    getProvider: () => ({}),
    resolveMaxDepth: () => 1,
    startActivation: async (spec) => {
      let settle!: (result: SubagentResult) => void
      const result = new Promise<SubagentResult>((resolve) => { settle = resolve })
      const dispose = vi.fn(async () => {})
      started.push({ spec, settle, dispose })
      const activation: SubagentActivation = { childId: `child-${started.length}`, result, dispose }
      return activation
    },
  }
  return { service, started }
}

async function waitForStarts(started: Started[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 500 && started.length < count; attempt += 1) await new Promise(resolve => setTimeout(resolve, 10))
  expect(started).toHaveLength(count)
}

const GAP = 'SKILL 没写日志第四列是 traceId，靠 grep 才串起请求。\n\n关键日志：<ts> ERROR [<trace>] OrderController'
const CASE = 'cases/2026-10-31-trace-id.md'
const REASON = '# 补充 traceId 字段说明与案例\n\n- SKILL.md：日志格式加 traceId；案例索引加一行\n- cases/2026-10-31-trace-id.md：新增案例'

interface Setup {
  origin: string
  registry: RepoRegistry
  task: AnalyzedTask
  improver: SkillImprover
  settings: EditableSettings
  agent: Agent
  approval: { requests: ApprovalRequest[]; request: Mock<HostApproval['request']> }
  answer: { value: ApprovalOutcome }
  repos: ReturnType<typeof fakeRepos>
  started: Started[]
  skill: string
}

async function setup(): Promise<Setup> {
  const root = await dir()
  const origin = await createAppRepo(join(root, 'order-service'))
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({})),
    repos: [{ url: origin }],
    skillUpdates: { enabled: true, maxFiles: 4, maxFileBytes: 65536 },
  }
  const repos = fakeRepos(join(root, 'mirrors'))
  const registry = new RepoRegistry({ repos: () => repos.service, onChange: () => {} })
  registry.configure(settings.repos)
  await registry.syncAll()
  const [ready] = registry.readyApps()
  const answer: Setup['answer'] = { value: 'allowed-once' }
  const requests: ApprovalRequest[] = []
  const approval = { requests, request: vi.fn(async (req: ApprovalRequest) => { requests.push(req); return answer.value }) }
  const { service, started } = fakeSubagents()
  const improver = new SkillImprover({
    registry,
    subagents: service,
    provider: 'spawn',
    settings: () => settings,
    author: { name: '观象', email: 'logalyze@example.com' },
    approval: () => approval,
    repos: () => repos.service,
    now: () => new Date(2026, 9, 31, 22, 0, 0),
  })
  const workDir = join(root, 'project', '.logalyze', 'runs', 'r1', '1-order-service')
  await mkdir(workDir, { recursive: true })
  await writeFile(join(workDir, 'skill-gap.md'), GAP)
  const task: AnalyzedTask = { workDir, sessionId: 'parent', app: ready!.app, url: origin, commit: ready!.commit, question: '21 点下单报 500', output: '根因：促销商品没有 SKU', logs: ['/logs/order.log'] }
  expect(await improver.inspect(task)).toEqual({ ok: true, path: join(workDir, 'skill-gap.md'), preview: 'SKILL 没写日志第四列是 traceId，靠 grep 才串起请求。 关键日志：<ts> ERROR [<trace>] OrderController' })
  const agent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: join(root, 'project') } } }
  const skill = await readFile(join(origin, SKILL), 'utf8')
  return { origin, registry, task, improver, settings, agent, approval, answer, repos, started, skill }
}

/** The improvement directory named in a child prompt. */
function improveDirOf(started: Started): string {
  return /修改目录是 `([^`]+)\/skill-proposal\/files\/`/.exec(started.spec.request.prompt[0]?.text as string)?.[1] as string
}

/** Let the next improvement child write a proposal and finish. */
async function finishChild(started: Started[], index: number, files: Record<string, string>, reason = REASON, output = '- SKILL.md：补充 traceId\n- cases/2026-10-31-trace-id.md：新增案例'): Promise<string> {
  await waitForStarts(started, index + 1)
  const child = started[index]!
  const improveDir = improveDirOf(child)
  if (Object.keys(files).length > 0) await writeProposal(improveDir, files, reason)
  child.settle({ stopReason: 'completed', output: [{ type: 'text', text: output }] })
  return improveDir
}

describe('logalyze_improve_skill', () => {
  it('asks first, then drafts a case with the improvement child and opens a merge request without asking again', async () => {
    const { origin, registry, task, improver, agent, approval, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }
    const running = improver.execute({ workDir: task.workDir }, exec)
    await waitForStarts(started, 1)
    const [request] = approval.requests
    expect(request).toMatchObject({ agent, toolName: 'logalyze_improve_skill', callId: 'call-1', signal: exec.signal })
    expect(request?.displayReason?.zh).toContain('观象分析「订单服务」的日志时发现 SKILL 有不足：SKILL 没写日志第四列是 traceId')
    expect(request?.displayReason?.zh).toContain(`是否改进 SKILL？同意后，观象会把这次问题整理为案例写入 .agents/skills/log-analysis/cases/ 并修改 SKILL，然后提交到 ${origin} 的新分支、创建合并请求合入 main`)

    const [child] = started
    const status = registry.status()[0]!
    expect(child?.spec).toMatchObject({ provider: 'spawn', label: '订单服务 SKILL 改进', delivery: 'caller', request: { parent: agent, maxDepth: 1 } })
    expect(child?.spec.request.cwd).toBe(join(repos.service.root, '.snapshots', basename(repos.service.mirrorDir(status.url)), status.commit!.slice(0, 12)))
    expect(status.activeRuns).toBe(1)
    const prompt = child?.spec.request.prompt[0]?.text as string
    expect(prompt.split('\n')[0]).toBe('/logalyze-improve')
    expect(prompt).toContain('## 分析时的问题\n\n21 点下单报 500')
    expect(prompt).toContain('## 分析结论\n\n根因：促销商品没有 SKU')
    expect(prompt).toContain(`分析子 Agent 写在 \`${join(task.workDir, 'skill-gap.md')}\``)
    expect(prompt).toContain('- `/logs/order.log`')
    const improveDir = improveDirOf(child!)
    expect(improveDir).toMatch(new RegExp(`^${task.workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/improve-[0-9a-f]{6}$`))
    expect(prompt).toContain(`案例写到 \`${improveDir}/skill-proposal/files/cases/2026-10-31-<slug>.md\``)
    expect(prompt).not.toContain('分析时的提交是')

    await finishChild(started, 0, { 'SKILL.md': `${skill}\n## 案例索引\n\n| ${CASE} | traceId | 下单 |\n`, [CASE]: '# traceId 串联\n' })
    const value = await running
    expect(value).toMatchObject({
      status: 'opened',
      app: 'order-service',
      repo: origin,
      workDir: task.workDir,
      improveDir,
      target: 'main',
      mergeRequestUrl: MR_URL,
      diffPath: join(improveDir, DIFF_FILE),
      files: [{ path: SKILL, added: 4, removed: 0 }, { path: `.agents/skills/log-analysis/${CASE}`, added: 1, removed: 0 }],
      output: '- SKILL.md：补充 traceId\n- cases/2026-10-31-trace-id.md：新增案例',
    })
    expect(value.branch).toMatch(/^logalyze\/skill-order-service-[0-9a-f]{10}$/)
    expect(await readFile(value.diffPath!, 'utf8')).toContain('+# traceId 串联')
    expect(approval.request).toHaveBeenCalledTimes(1)
    expect(child?.dispose).toHaveBeenCalledTimes(1)
    expect(registry.status()[0]?.activeRuns).toBe(0)
    const [repo, commit] = repos.service.commitFiles.mock.calls[0]!
    expect(repo).toBe(origin)
    expect(commit).toMatchObject({
      branch: value.branch,
      baseSha: status.commit,
      newBranch: true,
      author: { name: '观象', email: 'logalyze@example.com' },
      signal: exec.signal,
    })
    expect((commit.files as { path: string }[]).map(file => file.path)).toEqual([SKILL, `.agents/skills/log-analysis/${CASE}`])
    expect(commit.message).toMatch(new RegExp(`^补充 traceId 字段说明与案例\\n\\n# 补充 traceId[\\s\\S]*\\n\\nProposed-by: 观象 Logalyze\\nAnalyzed-commit: ${task.commit}\\nSession: parent\\n$`))
    expect(repos.service.createChange).toHaveBeenCalledWith(origin, {
      title: '补充 traceId 字段说明与案例',
      body: expect.stringMatching(/^由观象在日志分析后经用户同意提出（应用 order-service，分析提交 [0-9a-f]{12}，会话 parent）。请评审案例和 SKILL 修改。\n\n# 补充 traceId/),
      sourceBranch: value.branch,
      targetBranch: 'main',
      signal: exec.signal,
    })
    const text = renderImproveValue(value)[0]?.text
    expect(text).toContain(`SKILL 已改进，提交到 ${origin} 的分支 ${value.branch}（目标 main）并创建合并请求：${MR_URL}`)
    expect(text).toContain('改进子 Agent 的说明：\n- SKILL.md：补充 traceId')
    // The gap is consumed once the improvement is submitted.
    expect(improver.hasGap('parent')).toBe(false)
    await expect(improver.execute({ workDir: task.workDir }, exec)).rejects.toThrow('不是本次 DSH 运行中记录了 SKILL 不足的观象派发任务')
  })

  it('starts nothing unless the user agrees, and forgets the gap once the user declines', async () => {
    const { task, improver, agent, answer, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    answer.value = 'unavailable'
    expect(await improver.execute({ workDir: task.workDir }, exec)).toEqual({ status: 'unavailable', app: 'order-service', repo: task.url, workDir: task.workDir })
    expect(improver.hasGap('parent')).toBe(true)
    answer.value = 'rejected'
    const rejected = await improver.execute({ workDir: task.workDir }, exec)
    expect(rejected.status).toBe('rejected')
    expect(renderImproveValue(rejected)[0]?.text).toContain('用户不改进这次的 SKILL，没有起草也没有提交')
    expect(improver.hasGap('parent')).toBe(false)
    expect(started).toHaveLength(0)
    expect(repos.service.commitFiles).not.toHaveBeenCalled()
  })

  it('reports an improvement that produced nothing submittable and keeps the gap for another try', async () => {
    const { task, improver, agent, approval, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const attempt = async (index: number, arrange: () => Promise<unknown>) => {
      const running = improver.execute({ workDir: task.workDir }, exec)
      await arrange()
      const value = await running
      expect(value.status).toBe('failed')
      expect(improver.hasGap('parent')).toBe(true)
      expect(started[index]?.dispose).toHaveBeenCalledTimes(1)
      return value
    }
    const nothing = await attempt(0, () => finishChild(started, 0, {}, REASON, ''))
    expect(nothing.error).toBe('子 Agent 没有写出修改（skill-proposal/）')
    expect(renderImproveValue(nothing)[0]?.text).toContain(`运行目录：${nothing.improveDir}`)
    expect((await attempt(1, () => finishChild(started, 1, { 'SKILL.md': `${skill}\n更多\n` }))).error).toContain('修改中没有案例文件 cases/<日期>-<slug>.md')
    expect((await attempt(2, () => finishChild(started, 2, { 'SKILL.md': '---\nname: other\ndescription: x\n---\n', [CASE]: '# c\n' }))).error).toBe('SKILL.md 的 frontmatter name 是「other」，必须保持为「log-analysis」')
    const stopped = await attempt(3, async () => {
      await waitForStarts(started, 4)
      started[3]!.settle({ stopReason: 'error', output: [], diagnostic: '模型出错' })
    })
    expect(stopped.error).toBe('改进子 Agent 没有完成（error：模型出错）')
    expect(approval.request).toHaveBeenCalledTimes(4)
    expect(repos.service.commitFiles).not.toHaveBeenCalled()
  })

  it('reports a pushed branch when the merge request fails, and an existing branch for the same change', async () => {
    const { task, improver, agent, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    repos.state.changeError = Object.assign(new Error('令牌没有权限'), { name: 'RepoError', code: 'forbidden' })
    const running = improver.execute({ workDir: task.workDir }, exec)
    await finishChild(started, 0, { [CASE]: '# c\n' })
    const pushed = await running
    expect(pushed).toMatchObject({ status: 'pushed', mergeRequestError: '令牌没有权限' })
    expect(renderImproveValue(pushed)[0]?.text).toContain('创建合并请求失败（令牌没有权限）')

    await improver.inspect(task)
    const again = improver.execute({ workDir: task.workDir }, exec)
    await finishChild(started, 1, { [CASE]: '# c\n' })
    const exists = await again
    expect(exists).toMatchObject({ status: 'exists', branch: pushed.branch })
    expect(renderImproveValue(exists)[0]?.text).toContain('已存在，同一改动可能已经提交过')
  })

  it('refuses calls it cannot serve before asking', async () => {
    const { registry, task, improver, agent, settings, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const args = { workDir: task.workDir }
    await expect(improver.execute({ workDir: '/elsewhere' }, exec)).rejects.toThrow('不是本次 DSH 运行中记录了 SKILL 不足的观象派发任务')
    await expect(improver.execute(args, { ...exec, agent: { id: 'other', session: { header: { id: 'other' } } } })).rejects.toThrow('不是当前会话派发的任务')
    await expect(improver.execute(args, { ...exec, agent: { id: 'child', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    await expect(improver.execute({ ...args, extra: 1 }, exec)).rejects.toThrow('参数不合法')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: false }
    await expect(improver.execute(args, exec)).rejects.toThrow('未开启')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: true }

    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const deps = { registry, subagents: fakeSubagents().service, provider: 'spawn', settings: () => settings }
    const withoutApproval = new SkillImprover({ ...deps, approval: () => undefined, repos: () => repos.service })
    await withoutApproval.inspect(task)
    await expect(withoutApproval.execute(args, exec)).rejects.toThrow('没有审批服务')
    const withoutRepos = new SkillImprover({ ...deps, approval: () => approval, repos: () => undefined })
    await withoutRepos.inspect(task)
    await expect(withoutRepos.execute(args, exec)).rejects.toThrow('需要 dsh-repo 插件提供的 dshRepos 服务')
    await rm(join(task.workDir, 'skill-gap.md'))
    await expect(improver.execute(args, exec)).rejects.toThrow('中没有 skill-gap.md')
    expect(approval.request).not.toHaveBeenCalled()
    expect(started).toHaveLength(0)
  })

  it('stops when the question is withdrawn by cancellation and lets the gap be offered again', async () => {
    const { task, improver, agent, answer, started } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    answer.value = 'cancelled'
    await expect(improver.execute({ workDir: task.workDir }, { signal: controller.signal, agent })).rejects.toThrow('turn cancelled')
    expect(started).toHaveLength(0)
    expect(improver.hasGap('parent')).toBe(true)
    answer.value = 'unavailable'
    expect((await improver.execute({ workDir: task.workDir }, { signal: new AbortController().signal, agent })).status).toBe('unavailable')
  })

  it('tells the child when the repository moved on since the analysis', async () => {
    const { task, improver, agent, started } = await setup()
    const moved = { ...task, commit: 'a'.repeat(40) }
    await improver.inspect(moved)
    const running = improver.execute({ workDir: task.workDir }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    expect(started[0]?.spec.request.prompt[0]?.text).toContain(`分析时的提交是 \`${'a'.repeat(12)}\`，之后仓库有更新`)
    started[0]?.settle({ stopReason: 'completed', output: [] })
    expect((await running).status).toBe('failed')
  })
})
