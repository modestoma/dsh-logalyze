import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, ApprovalOutcome, ApprovalRequest, HostApproval, SubagentActivation, SubagentResult, SubagentService } from '../src/host.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import type { ChangeCreate, WorkspaceChanges, WorkspaceFileChange } from '../src/repos/contract.ts'
import { replaceFile } from '../src/skill-update/files.ts'
import { checkChanges, DIFF_FILE } from '../src/skill-update/workspace.ts'
import { renderShowSkillValue, SkillViewer } from '../src/skill-update/show.ts'
import { renderImproveValue, SkillImprover } from '../src/skill-update/tool.ts'
import type { AnalyzedTask } from '../src/skill-update/tool.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, git, tempDir } from './helpers.ts'

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

/** A workspace at `root` with base files and a stand-in for what `dshRepos` reports. */
async function workspace(files: Record<string, string>, changes: Partial<WorkspaceFileChange>[], branch?: string): Promise<{ root: string; changes: WorkspaceChanges }> {
  const root = await dir()
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return {
    root,
    changes: {
      workspace: { dir: root, baseCommit: 'b'.repeat(40), ...branch === undefined ? {} : { branch } },
      files: changes.map(change => ({ path: '', status: 'added', binary: false, additions: 1, deletions: 0, ...change })),
      diff: 'diff --git a/x b/x\n',
    },
  }
}

const SCOPE = { root: '.agents/skills/log-analysis', allows: () => true, description: '.agents/skills/log-analysis/' }

describe('checkChanges', () => {
  it('reads the added and modified files of the scope in path order and digests them', async () => {
    const { changes } = await workspace({ [SKILL]: '# new\n', '.agents/skills/log-analysis/cases/a.md': 'a' }, [
      { path: SKILL, status: 'modified', additions: 2, deletions: 1 },
      { path: '.agents/skills/log-analysis/cases/a.md' },
    ], 'logalyze/x')
    const checked = await checkChanges(changes, SCOPE, LIMITS)
    expect(checked).toMatchObject({
      base: 'b'.repeat(40),
      pushedBranch: 'logalyze/x',
      files: [{ path: SKILL, added: 2, removed: 1 }, { path: '.agents/skills/log-analysis/cases/a.md', added: 1, removed: 0 }],
      contents: expect.arrayContaining([{ path: SKILL, relative: 'SKILL.md', content: '# new\n' }]),
      diff: 'diff --git a/x b/x\n',
    })
    expect(checked.digest).toMatch(/^[0-9a-f]{64}$/)
    const same = await workspace({ [SKILL]: '# new\n', '.agents/skills/log-analysis/cases/a.md': 'a' }, [{ path: '.agents/skills/log-analysis/cases/a.md' }, { path: SKILL, status: 'modified' }])
    expect((await checkChanges(same.changes, SCOPE, LIMITS)).digest).toBe(checked.digest)
  })

  it('rejects the whole change when anything is out of scope or not an added or modified text file', async () => {
    const cases: [Record<string, string>, Partial<WorkspaceFileChange>[], RegExp][] = [
      [{}, [], /没有改动/],
      [{ [SKILL]: 'x', 'src/Main.java': 'x' }, [{ path: SKILL }, { path: 'src/Main.java' }], /工作区改动了 src\/Main.java，只允许新增或修改 .agents\/skills\/log-analysis\/ 下的文件/],
      [{ '.agents/skills/log-analysis/.env': 'x' }, [{ path: '.agents/skills/log-analysis/.env' }], /工作区改动了 .agents\/skills\/log-analysis\/.env/],
      [{}, [{ path: SKILL, status: 'deleted' }], /不能删除 .agents\/skills\/log-analysis\/SKILL.md/],
      [{ [SKILL]: 'x' }, [{ path: SKILL, status: 'renamed', previousPath: '.agents/skills/log-analysis/old.md' }], /不能重命名/],
      [{ [SKILL]: 'x' }, [{ path: SKILL, status: 'renamed', previousPath: 'README.md' }], /工作区改动了 README.md/],
      [{ [SKILL]: 'x' }, [{ path: SKILL, status: 'type-changed' }], /改变了文件类型/],
      [{ [SKILL]: 'x' }, [{ path: SKILL, binary: true }], /二进制文件/],
      [{ a: '' }, ['a', 'b', 'c', 'd', 'e'].map(name => ({ path: `.agents/skills/log-analysis/${name}` })), /改动了 5 个文件，超过上限 4/],
      [{ [SKILL]: 'x'.repeat(5000) }, [{ path: SKILL }], /超过上限 4096/],
      [{ [SKILL]: '\u0000' }, [{ path: SKILL }], /NUL/],
    ]
    for (const [files, changes, message] of cases) {
      const arranged = await workspace(files, changes)
      await expect(checkChanges(arranged.changes, SCOPE, LIMITS)).rejects.toThrow(message)
    }
    const link = await workspace({}, [{ path: SKILL }])
    await mkdir(join(link.root, '.agents/skills/log-analysis'), { recursive: true })
    await symlink('/etc/passwd', join(link.root, SKILL))
    await expect(checkChanges(link.changes, SCOPE, LIMITS)).rejects.toThrow('不是普通文件')
    const invalid = await workspace({ [SKILL]: '' }, [{ path: SKILL }])
    await writeFile(join(invalid.root, SKILL), Buffer.from([0xff, 0xfe]))
    await expect(checkChanges(invalid.changes, SCOPE, LIMITS)).rejects.toThrow(/不是 UTF-8/)
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

/** The fake `dshRepos` service with a recording merge request call and a spy on pushes. */
function fakeRepos(root: string) {
  const state = { changeError: undefined as Error | undefined }
  const service = new FakeRepos(root)
  const createChange = vi.fn(async (_repo: string, _change: ChangeCreate) => {
    if (state.changeError !== undefined) throw state.changeError
    return { webUrl: MR_URL }
  })
  Object.assign(service, { createChange })
  const pushWorkspace = vi.spyOn(service, 'pushWorkspace')
  return { state, service, createChange, pushWorkspace }
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
    workingDirectory: () => undefined,
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

/** The improvement run directory holding a child's workspace. */
function improveDirOf(started: Started): string {
  return dirname(started.spec.request.cwd)
}

/**
 * Let the next improvement child edit its workspace and finish.
 * @param files - contents by repository path; undefined deletes the file.
 */
async function finishChild(started: Started[], index: number, files: Record<string, string | undefined>, reason: string | null = REASON, output = '- SKILL.md：补充 traceId\n- cases/2026-10-31-trace-id.md：新增案例'): Promise<string> {
  await waitForStarts(started, index + 1)
  const child = started[index]!
  const repo = child.spec.request.cwd
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) {
      await rm(join(repo, path))
      continue
    }
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  if (reason !== null) await writeFile(join(improveDirOf(child), 'reason.md'), reason)
  child.settle({ stopReason: 'completed', output: [{ type: 'text', text: output }] })
  return improveDirOf(child)
}

const IN_SKILL = (path: string) => `.agents/skills/log-analysis/${path}`

describe('logalyze_improve_skill', () => {
  it('asks first, then drafts a case with the improvement child and opens a merge request without asking again', async () => {
    const { origin, registry, task, improver, agent, approval, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }
    const running = improver.execute({ workDir: task.workDir }, exec)
    await waitForStarts(started, 1)
    const [request] = approval.requests
    expect(request).toMatchObject({ agent, toolName: 'logalyze_improve_skill', callId: 'call-1', signal: exec.signal })
    expect(request?.displayReason?.zh).toContain('观象分析「订单服务」的日志时发现 SKILL 有不足：SKILL 没写日志第四列是 traceId')
    expect(request?.displayReason?.zh).toContain(`是否改进 SKILL？同意后，观象会把这次问题整理为案例写入 .agents/skills/log-analysis/cases/ 并修改 SKILL，然后推送到 ${origin} 的新分支、创建合并请求合入 main`)

    const [child] = started
    const status = registry.status()[0]!
    expect(child?.spec).toMatchObject({ provider: 'spawn', label: '订单服务 SKILL 改进', delivery: 'caller', request: { parent: agent, maxDepth: 1 } })
    const improveDir = improveDirOf(child!)
    expect(improveDir).toMatch(new RegExp(`^${task.workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/improve-[0-9a-f]{6}$`))
    expect(child?.spec.request.cwd).toBe(join(improveDir, 'repo'))
    // The workspace is a checkout of the latest synced commit, without git metadata inside it.
    expect(await readFile(join(improveDir, 'repo', SKILL), 'utf8')).toBe(skill)
    expect(await stat(join(improveDir, 'repo', '.git')).then(() => true, () => false)).toBe(false)
    const prompt = child?.spec.request.prompt[0]?.text as string
    expect(prompt.split('\n')[0]).toBe('/logalyze-improve')
    expect(prompt).toContain('## 分析时的问题\n\n21 点下单报 500')
    expect(prompt).toContain('## 分析结论\n\n根因：促销商品没有 SKU')
    expect(prompt).toContain(`记录写在 \`${join(task.workDir, 'skill-gap.md')}\`，先读它。`)
    expect(prompt).toContain('- `/logs/order.log`')
    expect(prompt).toContain('当前工作目录是该应用代码仓库在提交')
    expect(prompt).toContain('的可写工作区')
    expect(prompt).toContain('否则新建 `.agents/skills/log-analysis/cases/2026-10-31-<slug>.md`')
    expect(prompt).toContain(`在工作区之外的 \`${improveDir}/reason.md\` 写改动说明`)
    expect(prompt).toContain('不要执行任何 git 写操作')
    expect(prompt).not.toContain('分析时的提交是')

    await finishChild(started, 0, { [SKILL]: `${skill}\n## 案例索引\n\n| ${CASE} | traceId | 下单 |\n`, [IN_SKILL(CASE)]: '# traceId 串联\n' })
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
    expect(value.diffPath).toBe(join(improveDir, 'changes.diff'))
    expect(await readFile(value.diffPath!, 'utf8')).toContain('+# traceId 串联')
    expect(approval.request).toHaveBeenCalledTimes(1)
    expect(child?.dispose).toHaveBeenCalledTimes(1)
    expect(registry.status()[0]?.activeRuns).toBe(0)
    expect(repos.pushWorkspace).toHaveBeenCalledWith(join(improveDir, 'repo'), {
      branch: value.branch,
      message: expect.any(String),
      author: { name: '观象', email: 'logalyze@example.com' },
      session: 'parent',
      signal: exec.signal,
    })
    const [push] = repos.service.pushes
    expect(Object.keys(push!.files)).toEqual([SKILL, IN_SKILL(CASE)])
    expect(push?.author).toEqual({ name: '观象', email: 'logalyze@example.com' })
    expect(git(origin, 'rev-parse', `${value.branch}^`).trim()).toBe(status.commit)
    expect(push?.message).toMatch(new RegExp(`^补充 traceId 字段说明与案例\\n\\n# 补充 traceId[\\s\\S]*\\n\\nProposed-by: 观象 Logalyze\\nAnalyzed-commit: ${task.commit}\\n$`))
    expect(repos.createChange).toHaveBeenCalledWith(origin, {
      title: '补充 traceId 字段说明与案例',
      body: expect.stringMatching(/^由观象在日志分析后经用户同意提出（应用 order-service，分析提交 [0-9a-f]{12}，会话 parent）。请评审案例和 SKILL 修改。\n\n# 补充 traceId/),
      sourceBranch: value.branch,
      targetBranch: 'main',
      signal: exec.signal,
    })
    const text = renderImproveValue(value)[0]?.text
    expect(text).toContain(`SKILL 已改进，提交到 ${origin} 的分支 ${value.branch}（目标 main）并创建合并请求：${MR_URL}`)
    expect(text).toContain('改进子 Agent 的说明：\n- SKILL.md：补充 traceId')
  })

  it('starts nothing unless the user agrees', async () => {
    const { task, improver, agent, answer, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    answer.value = 'unavailable'
    expect(await improver.execute({ workDir: task.workDir }, exec)).toEqual({ status: 'unavailable', app: 'order-service', repo: task.url, workDir: task.workDir })
    answer.value = 'rejected'
    const rejected = await improver.execute({ workDir: task.workDir }, exec)
    expect(rejected.status).toBe('rejected')
    expect(renderImproveValue(rejected)[0]?.text).toContain('用户不改进这次的 SKILL，没有起草也没有提交')
    expect(started).toHaveLength(0)
    expect(repos.pushWorkspace).not.toHaveBeenCalled()
  })

  it('reports an improvement that produced nothing submittable', async () => {
    const { task, improver, agent, approval, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const attempt = async (index: number, arrange: () => Promise<unknown>) => {
      const running = improver.execute({ workDir: task.workDir }, exec)
      await arrange()
      const value = await running
      expect(value.status).toBe('failed')
      expect(started[index]?.dispose).toHaveBeenCalledTimes(1)
      return value
    }
    const nothing = await attempt(0, () => finishChild(started, 0, {}, REASON, ''))
    expect(nothing.error).toMatch(/^工作区与提交 [0-9a-f]{12} 相比没有改动$/)
    expect(renderImproveValue(nothing)[0]?.text).toContain(`运行目录：${nothing.improveDir}`)
    const failures: [Record<string, string | undefined>, string | null, string][] = [
      [{ [SKILL]: `${skill}\n更多\n` }, REASON, '改动中没有新增或修改案例文件 cases/<日期>-<slug>.md'],
      [{ [SKILL]: '---\nname: other\ndescription: x\n---\n', [IN_SKILL(CASE)]: '# c\n' }, REASON, 'SKILL.md 的 frontmatter name 是「other」，必须保持为「log-analysis」'],
      [{ [SKILL]: '---\nname: log-analysis\nuser-invocable: false\n---\n', [IN_SKILL(CASE)]: '# c\n' }, REASON, 'SKILL.md 不能设置 user-invocable: false，否则派发时无法用 /<skill> 加载'],
      [{ [IN_SKILL(CASE)]: '# c\n', 'src/main/java/com/example/order/OrderService.java': '// fixed\n' }, REASON, '工作区改动了 src/main/java/com/example/order/OrderService.java，只允许新增或修改 .agents/skills/log-analysis/ 下的文件'],
      [{ [IN_SKILL(CASE)]: '# c\n', 'scratch.log': 'x' }, REASON, '工作区改动了 scratch.log'],
      [{ [IN_SKILL(CASE)]: '# c\n', [SKILL]: undefined }, REASON, `不能删除 ${SKILL}`],
      [{ [IN_SKILL(CASE)]: '# c\n' }, null, '缺少 reason.md（改动说明）'],
    ]
    for (const [index, [files, reason, error]] of failures.entries()) {
      expect((await attempt(index + 1, () => finishChild(started, index + 1, files, reason))).error).toContain(error)
    }
    const last = failures.length + 1
    const stopped = await attempt(last, async () => {
      await waitForStarts(started, last + 1)
      started[last]!.settle({ stopReason: 'error', output: [], diagnostic: '模型出错' })
    })
    expect(stopped.error).toBe('改进子 Agent 没有完成（error：模型出错）')
    expect(approval.request).toHaveBeenCalledTimes(last + 1)
    expect(repos.pushWorkspace).not.toHaveBeenCalled()
  })

  it('reports a pushed branch when the merge request fails, and an existing branch for the same change', async () => {
    const { task, improver, agent, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    repos.state.changeError = Object.assign(new Error('令牌没有权限'), { name: 'RepoError', code: 'forbidden' })
    const running = improver.execute({ workDir: task.workDir }, exec)
    await finishChild(started, 0, { [IN_SKILL(CASE)]: '# c\n' })
    const pushed = await running
    expect(pushed).toMatchObject({ status: 'pushed', mergeRequestError: '令牌没有权限' })
    expect(renderImproveValue(pushed)[0]?.text).toContain('创建合并请求失败（令牌没有权限）')

    await improver.inspect(task)
    const again = improver.execute({ workDir: task.workDir }, exec)
    await finishChild(started, 1, { [IN_SKILL(CASE)]: '# c\n' })
    const exists = await again
    expect(exists).toMatchObject({ status: 'exists', branch: pushed.branch })
    expect(repos.pushWorkspace).toHaveBeenCalledTimes(2)
    expect(repos.service.pushes).toHaveLength(1)
    expect(repos.createChange).toHaveBeenCalledTimes(1)
    expect(renderImproveValue(exists)[0]?.text).toContain('已存在，同一改动可能已经提交过')
  })

  it('refuses calls it cannot serve before asking', async () => {
    const { registry, task, improver, agent, settings, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const args = { workDir: task.workDir }
    await expect(improver.execute({ workDir: '/elsewhere' }, exec)).rejects.toThrow('不是本次 DSH 运行中已完成的观象派发任务')
    await expect(improver.execute({ workDir: task.workDir, app: 'order-service' }, exec)).rejects.toThrow('workDir 和 app 必须给出且只能给出一个')
    await expect(improver.execute({}, exec)).rejects.toThrow('workDir 和 app 必须给出且只能给出一个')
    await expect(improver.execute({ app: 'order-service' }, exec)).rejects.toThrow('按 app 改进时需要 feedback')
    await expect(improver.execute({ app: 'missing', feedback: 'x' }, exec)).rejects.toThrow('missing')
    await expect(improver.execute({ app: 'order-service', feedback: 'x', logs: [{ path: '/nonexistent.log' }] }, exec)).rejects.toThrow('日志路径不可读')
    await expect(improver.execute(args, { ...exec, agent: { id: 'other', session: { header: { id: 'other' } } } })).rejects.toThrow('不是当前会话派发的任务')
    await expect(improver.execute(args, { ...exec, agent: { id: 'child', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    await expect(improver.execute({ ...args, extra: 1 }, exec)).rejects.toThrow('参数不合法')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: false }
    await expect(improver.execute(args, exec)).rejects.toThrow('未开启')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: true }

    const approval = { request: vi.fn(async () => 'allowed-once' as const) }
    const deps = { registry, subagents: fakeSubagents().service, provider: 'spawn', settings: () => settings, workingDirectory: () => undefined }
    const withoutApproval = new SkillImprover({ ...deps, approval: () => undefined, repos: () => repos.service })
    await withoutApproval.inspect(task)
    await expect(withoutApproval.execute(args, exec)).rejects.toThrow('没有审批服务')
    const withoutRepos = new SkillImprover({ ...deps, approval: () => approval, repos: () => undefined })
    await withoutRepos.inspect(task)
    await expect(withoutRepos.execute(args, exec)).rejects.toThrow('需要 dsh-repo 插件提供的 dshRepos 服务')
    await rm(join(task.workDir, 'skill-gap.md'))
    await expect(improver.execute(args, exec)).rejects.toThrow('这次分析没有 skill-gap.md，需要在 feedback 中写明')
    expect(approval.request).not.toHaveBeenCalled()
    expect(started).toHaveLength(0)
  })

  it('stops when the question is withdrawn by cancellation', async () => {
    const { task, improver, agent, answer, started } = await setup()
    const controller = new AbortController()
    controller.abort(new Error('turn cancelled'))
    answer.value = 'cancelled'
    await expect(improver.execute({ workDir: task.workDir }, { signal: controller.signal, agent })).rejects.toThrow('turn cancelled')
    expect(started).toHaveLength(0)
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

  it('corrects a SKILL record the analysis followed when the user points out it is wrong', async () => {
    const { task, improver, agent, approval, repos, started, skill } = await setup()
    await rm(join(task.workDir, 'skill-gap.md'))
    const feedback = 'SKILL 里说 503 是库存服务的问题，其实是网关限流，看 X-RateLimit 头'
    const running = improver.execute({ workDir: task.workDir, feedback }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    expect(approval.requests[0]?.displayReason?.zh).toContain(`用户要求改进「订单服务」的日志分析 SKILL：${feedback}`)
    expect(approval.requests[0]?.displayReason?.zh).not.toContain('发现 SKILL 有不足')
    const prompt = started[0]?.spec.request.prompt[0]?.text as string
    expect(prompt).toContain('用户指出 SKILL 的记录有问题，用户同意改进。')
    expect(prompt).toContain('分析子 Agent 当时没有发现 SKILL 的不足，是按 SKILL 现有的记录分析的；改进的依据是下面的用户反馈。')
    expect(prompt).toContain(`## 用户反馈\n\n${feedback}`)
    expect(prompt).toContain('已有案例描述的是同一个问题时更新它')

    // A correction after an analysis still has to record the case.
    await finishChild(started, 0, { [SKILL]: `${skill}\n503 来自网关限流。\n` })
    const value = await running
    expect(value).toMatchObject({ status: 'failed', error: '改动中没有新增或修改案例文件 cases/<日期>-<slug>.md' })
    expect(repos.pushWorkspace).not.toHaveBeenCalled()
  })

  it('improves a SKILL from user feedback alone, with sample logs and no case required', async () => {
    const { origin, task, improver, agent, approval, repos, started, skill } = await setup()
    const project = agent.session.header.cwd as string
    await writeFile(join(project, 'sample.log'), 'line')
    const exec = { signal: new AbortController().signal, agent }
    const running = improver.execute({ app: 'order-service', feedback: '日志时间是 UTC，不是北京时间', logs: [{ path: 'sample.log' }] }, exec)
    await waitForStarts(started, 1)
    expect(approval.requests[0]?.displayReason?.zh).toContain(`是否改进 SKILL？同意后，观象会按反馈修改 SKILL，然后推送到 ${origin} 的新分支`)
    const prompt = started[0]?.spec.request.prompt[0]?.text as string
    expect(prompt).toContain('用户要求改进这个 SKILL，用户的反馈见下文。')
    expect(prompt).not.toContain('## 分析时的问题')
    expect(prompt).toContain(`- \`${join(project, 'sample.log')}\``)
    expect(prompt).toContain('只是修正或补充 SKILL 的说明时，可以不写案例。')
    const improveDir = improveDirOf(started[0]!)
    expect(improveDir).toMatch(new RegExp(`^${join(project, '.logalyze', 'runs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/20261031-220000-[0-9a-f]{6}/improve-[0-9a-f]{6}$`))

    await finishChild(started, 0, { [SKILL]: `${skill}\n时间是 UTC。\n` }, '修正日志时区说明\n\n- SKILL.md：时间是 UTC')
    const value = await running
    expect(value).toMatchObject({ status: 'opened', files: [{ path: SKILL, added: 2, removed: 0 }] })
    expect(value.workDir).toBeUndefined()
    const [push] = repos.service.pushes
    expect(push?.message).toBe('修正日志时区说明\n\n修正日志时区说明\n\n- SKILL.md：时间是 UTC\n\nProposed-by: 观象 Logalyze\n')
    expect(push?.session).toBe('parent')
    expect(repos.createChange).toHaveBeenCalledWith(origin, expect.objectContaining({ body: expect.stringMatching(/^由观象按用户反馈提出（应用 order-service，会话 parent）。请评审 SKILL 修改。/) }))
    expect(task.workDir).not.toBe(improveDir)
  })
})

describe('logalyze_show_skill', () => {
  it('shows the SKILL file list and a file from the latest synced commit', async () => {
    const { origin, registry, repos } = await setup()
    const viewer = new SkillViewer({ registry, repos: () => repos.service })
    const exec = { signal: new AbortController().signal, agent: { id: 'parent', session: { header: { id: 'parent' } } } }
    const value = await viewer.execute({ app: 'order-service' }, exec)
    const commit = registry.status()[0]!.commit!
    expect(value).toMatchObject({ app: 'order-service', repo: origin, commit, dir: '.agents/skills/log-analysis', path: 'SKILL.md', truncated: false })
    expect(value.files).toContain('SKILL.md')
    expect(value.content).toBe(await readFile(join(origin, SKILL), 'utf8'))
    expect(renderShowSkillValue(value)[0]?.text).toContain(`应用 order-service 的日志分析 SKILL .agents/skills/log-analysis/（${origin} 提交 ${commit.slice(0, 12)}）`)

    await expect(viewer.execute({ app: 'order-service', path: 'references/none.md' }, exec)).rejects.toThrow('.agents/skills/log-analysis/references/none.md 不存在')
    await expect(viewer.execute({ app: 'order-service', path: '../logalyze.yaml' }, exec)).rejects.toThrow('path 只能是 SKILL 目录内的相对路径')
    await expect(viewer.execute({ app: 'missing' }, exec)).rejects.toThrow('missing')
    await expect(viewer.execute({ app: 'order-service' }, { ...exec, agent: { id: 'c', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
  })
})
