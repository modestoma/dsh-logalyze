import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, SubagentActivation, SubagentResult, SubagentService } from '../src/host.ts'
import { RepoRegistry } from '../src/apps/registry.ts'
import type { EditableSettings } from '../src/settings/contract.ts'
import type { WorkspaceFileChange, WorkspaceStatus } from '../src/deps/repos-contract.ts'
import { replaceFile } from '../src/util/files.ts'
import { checkChanges, DIFF_FILE } from '../src/runs/changes.ts'
import { renderShowSkillValue, SkillViewer } from '../src/improve/show.ts'
import { renderImproveValue, SkillImprover } from '../src/improve/tool.ts'
import type { AnalyzedTask } from '../src/improve/tool.ts'
import { declinedError, FakeRepos, repoError } from './fake-repos.ts'
import { createAppRepo, git, tempDir } from './helpers.ts'
import { ReposClient } from '../src/deps/repos.ts'

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
async function workspace(files: Record<string, string>, changes: Partial<WorkspaceFileChange>[]): Promise<{ root: string; changes: WorkspaceStatus }> {
  const root = await dir()
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return {
    root,
    changes: {
      workspace: { repo: 'https://code.example.com/team/app.git', path: root, base: 'main', baseCommit: 'b'.repeat(40), branch: 'logalyze/x' },
      files: changes.map(change => ({ path: '', status: 'added', binary: false, additions: 1, deletions: 0, ...change })),
      diff: 'diff --git a/x b/x\n',
      truncated: false,
    },
  }
}

const SCOPE = { root: '.agents/skills/log-analysis', allows: () => true, description: '.agents/skills/log-analysis/' }

describe('checkChanges', () => {
  it('reads the added and modified files of the scope in path order', async () => {
    const { changes } = await workspace({ [SKILL]: '# new\n', '.agents/skills/log-analysis/cases/a.md': 'a' }, [
      { path: SKILL, status: 'modified', additions: 2, deletions: 1 },
      { path: '.agents/skills/log-analysis/cases/a.md' },
    ])
    const checked = await checkChanges(changes, SCOPE, LIMITS)
    expect(checked).toMatchObject({
      base: 'b'.repeat(40),
      files: [{ path: SKILL, added: 2, removed: 1 }, { path: '.agents/skills/log-analysis/cases/a.md', added: 1, removed: 0 }],
      contents: expect.arrayContaining([{ path: SKILL, relative: 'SKILL.md', content: '# new\n' }]),
      diff: 'diff --git a/x b/x\n',
    })
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
  const openMr = vi.fn(async (_input: Parameters<NonNullable<FakeRepos['openMr']>>[0]) => {
    if (state.changeError !== undefined) throw state.changeError
    return { number: 7, webUrl: MR_URL }
  })
  service.openMr = openMr
  const workspacePush = vi.spyOn(service, 'workspacePush')
  return { state, service, openMr, workspacePush }
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
  repos: ReturnType<typeof fakeRepos>
  started: Started[]
  skill: string
  root: string
}

/**
 * An improver that remembers one finished analysis of the order service with a gap record.
 * @param endTurn - whether the turn that dispatched the analysis has ended.
 */
async function setup(endTurn = true): Promise<Setup> {
  const root = await dir()
  const origin = await createAppRepo(join(root, 'order-service'))
  const settings: EditableSettings = {
    ...defaultsOf(resolveConfig({})),
    skillUpdates: { enabled: true, maxFiles: 4, maxFileBytes: 65536 },
  }
  const repos = fakeRepos(join(root, 'mirrors'))
  const registry = new RepoRegistry({ repos: new ReposClient(() => repos.service), onChange: () => {} })
  registry.configure([{ url: origin, writable: true }])
  await registry.syncAll()
  const [ready] = registry.readyApps()
  const { service, started } = fakeSubagents()
  const improver = new SkillImprover({
    registry,
    subagents: service,
    provider: 'spawn',
    settings: () => settings,
    workingDirectory: () => undefined,
    repos: new ReposClient(() => repos.service),
    now: () => new Date(2026, 9, 31, 22, 0, 0),
  })
  const workDir = join(root, 'project', '.logalyze', 'runs', 'r1', '1-order-service')
  await mkdir(workDir, { recursive: true })
  await writeFile(join(workDir, 'skill-gap.md'), GAP)
  const task: AnalyzedTask = { workDir, sessionId: 'parent', app: ready!.app, url: origin, commit: ready!.commit, question: '21 点下单报 500', output: '根因：促销商品没有 SKU', logs: ['/logs/order.log'] }
  expect(await improver.inspect(task)).toEqual({ ok: true, path: join(workDir, 'skill-gap.md'), preview: 'SKILL 没写日志第四列是 traceId，靠 grep 才串起请求。 关键日志：<ts> ERROR [<trace>] OrderController' })
  if (endTurn) improver.turnEnded('parent')
  const agent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: join(root, 'project') } } }
  const skill = await readFile(join(origin, SKILL), 'utf8')
  return { origin, registry, task, improver, settings, agent, repos, started, skill, root }
}

/** The improvement run directory holding a child's workspace. */
function improveDirOf(started: Started): string {
  return dirname(started.spec.cwd)
}

/**
 * Let the next improvement child edit its workspace and finish.
 * @param files - contents by repository path; undefined deletes the file.
 */
async function finishChild(started: Started[], index: number, files: Record<string, string | undefined>, reason: string | null = REASON, output = '- SKILL.md：补充 traceId\n- cases/2026-10-31-trace-id.md：新增案例'): Promise<string> {
  await waitForStarts(started, index + 1)
  const child = started[index]!
  const repo = child.spec.cwd
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

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('logalyze_improve_skill', () => {
  it('drafts a case with the improvement child and pushes it with a merge request through dsh-repo', async () => {
    const { origin, registry, task, improver, agent, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent, callId: 'call-1' }
    const running = improver.execute({ app: 'order-service' }, exec)
    await waitForStarts(started, 1)

    const [child] = started
    const status = registry.status()[0]!
    expect(child?.spec).toMatchObject({ provider: 'spawn', label: '订单服务 SKILL 改进', delivery: 'caller', parent: agent, maxDepth: 1 })
    const improveDir = improveDirOf(child!)
    expect(improveDir).toMatch(new RegExp(`^${escape(join(agent.session.header.cwd as string, '.logalyze', 'runs'))}/20261031-220000-[0-9a-f]{6}/improve-[0-9a-f]{6}$`))
    expect(child?.spec.cwd).toBe(join(improveDir, 'repo'))
    // The workspace is a clone of the baseline head.
    expect(await readFile(join(improveDir, 'repo', SKILL), 'utf8')).toBe(skill)
    expect(await stat(join(improveDir, 'repo', '.git')).then(() => true, () => false)).toBe(true)
    // dsh-repo starts from the baseline head and names the branch from its template.
    expect(repos.service.creates).toEqual([{ repo: origin, path: join(improveDir, 'repo'), agent, callId: 'call-1', signal: exec.signal }])
    const prompt = child?.spec.prompt[0]?.text as string
    expect(prompt.split('\n')[0]).toBe('/logalyze-improve')
    expect(prompt).toContain('本会话的一次日志分析之后，分析子 Agent 认为这个 SKILL 没能很好地覆盖遇到的问题，用户同意改进。下面列出的所有改进点都在这一次修改中完成。')
    expect(prompt).toContain(`## 分析 1\n\n运行目录：\`${task.workDir}\``)
    expect(prompt).toContain('### 问题\n\n21 点下单报 500')
    expect(prompt).toContain('### 结论\n\n根因：促销商品没有 SKU')
    expect(prompt).toContain(`记录写在 \`${join(task.workDir, 'skill-gap.md')}\`，先读它。`)
    expect(prompt).not.toContain('## 分析 2')
    expect(prompt).toContain('- `/logs/order.log`')
    expect(prompt).toContain('当前工作目录是该应用代码仓库在提交')
    expect(prompt).toContain('不写 `feat:`、`fix:` 等类型前缀，观象提交时统一加上 `chore: `')
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
      workDirs: [task.workDir],
      improveDir,
      target: 'main',
      mergeRequestUrl: MR_URL,
      diffPath: join(improveDir, DIFF_FILE),
      files: [{ path: SKILL, added: 4, removed: 0 }, { path: `.agents/skills/log-analysis/${CASE}`, added: 1, removed: 0 }],
      output: '- SKILL.md：补充 traceId\n- cases/2026-10-31-trace-id.md：新增案例',
    })
    expect(value.branch).toBe('dsh/parent')
    expect(await readFile(value.diffPath!, 'utf8')).toContain('+# traceId 串联')
    expect(child?.dispose).toHaveBeenCalledTimes(1)
    expect(registry.status()[0]?.activeRuns).toBe(0)
    expect(repos.workspacePush).toHaveBeenCalledWith({
      path: join(improveDir, 'repo'),
      message: expect.any(String),
      mr: { title: 'chore: 补充 traceId 字段说明与案例', body: expect.stringMatching(/^由观象在日志分析后经用户同意提出（应用 order-service，分析提交 [0-9a-f]{12}，会话 parent）。请评审案例和 SKILL 修改。\n\n# 补充 traceId/) },
      agent,
      callId: 'call-1',
      signal: exec.signal,
    })
    const [push] = repos.service.pushes
    expect(Object.keys(push!.files)).toEqual([SKILL, IN_SKILL(CASE)])
    expect(git(origin, 'rev-parse', `${value.branch}^`).trim()).toBe(status.commit)
    expect(push?.message).toMatch(new RegExp(`^chore: 补充 traceId 字段说明与案例\\n\\n# 补充 traceId[\\s\\S]*\\n\\nProposed-by: 观象 Logalyze\\nAnalyzed-commit: ${task.commit}\\n$`))
    expect(push?.session).toBe('parent')
    expect(repos.openMr).toHaveBeenCalledWith({ repo: origin, branch: value.branch, base: 'main', title: 'chore: 补充 traceId 字段说明与案例', body: expect.stringContaining('请评审案例和 SKILL 修改') })
    const text = renderImproveValue(value)[0]?.text
    expect(text).toContain(`SKILL 已改进，提交到 ${origin} 的分支 ${value.branch}（目标 main）并创建合并请求：${MR_URL}`)
    expect(text).toContain('改进子 Agent 的说明：\n- SKILL.md：补充 traceId')
  })

  it('keeps code-only applications analyzable and refuses legacy improvement before opening a workspace', async () => {
    const { root, origin, registry, improver, agent, repos, started } = await setup()
    const code = await createAppRepo(join(root, 'code-only'), { '.agents/logalyze.yaml': 'id: code-only\nname: 代码应用\ndescription: 代码直读\n' })
    git(code, 'rm', '-qr', '.agents/skills')
    git(code, 'commit', '-qm', 'no skill')
    registry.configure([{ url: origin, writable: true }, { url: code, writable: true }])
    await registry.syncAll()
    expect(registry.readyApp('code-only').app.skill).toBeUndefined()
    await expect(improver.execute({ app: 'code-only', feedback: '创建排查知识' }, { signal: new AbortController().signal, agent })).rejects.toThrow('创建初版 SKILL 待知识改进功能接入')
    expect(repos.service.creates).toEqual([])
    expect(started).toEqual([])
  })

  it('merges every improvement point of an application into one child', async () => {
    const { root, origin, task, improver, agent, repos, started, skill } = await setup(false)
    const second = join(root, 'project', '.logalyze', 'runs', 'r2', '1-order-service')
    const quiet = join(root, 'project', '.logalyze', 'runs', 'r3', '1-order-service')
    for (const path of [second, quiet]) await mkdir(path, { recursive: true })
    await writeFile(join(second, 'skill-gap.md'), 'SKILL 没写库存服务的超时阈值')
    await improver.inspect({ ...task, workDir: second, question: '库存扣减超时', output: '根因：库存服务慢', logs: ['/logs/order.log', '/logs/stock.log'] })
    // An analysis without a gap record is not an improvement point by itself.
    await improver.inspect({ ...task, workDir: quiet, question: '无关问题', output: '正常' })
    // An unusable gap record drops only its own analysis.
    const broken = join(root, 'project', '.logalyze', 'runs', 'r4', '1-order-service')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'skill-gap.md'), '')
    expect(await improver.inspect({ ...task, workDir: broken, question: '记录损坏', output: '?' })).toEqual({ ok: false, error: 'skill-gap.md 是空的' })
    improver.turnEnded('parent')
    const feedback = '另外日志时间是 UTC'
    const running = improver.execute({ app: 'order-service', feedback }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    const prompt = started[0]?.spec.prompt[0]?.text as string
    expect(prompt).toContain('本会话的 2 次日志分析之后')
    expect(prompt).toContain(`## 分析 1\n\n运行目录：\`${task.workDir}\``)
    expect(prompt).toContain(`## 分析 2\n\n运行目录：\`${second}\``)
    expect(prompt).toContain(`记录写在 \`${join(second, 'skill-gap.md')}\``)
    expect(prompt).not.toContain(quiet)
    expect(prompt).not.toContain(broken)
    expect(prompt).toContain(`## 用户反馈\n\n${feedback}`)
    expect(prompt).toContain('- `/logs/order.log`\n- `/logs/stock.log`\n')
    expect(prompt).toContain('每个不同的问题一个案例，几次分析是同一个问题时只写一个')

    await finishChild(started, 0, { [SKILL]: `${skill}\n超时阈值 3s。\n`, [IN_SKILL(CASE)]: '# c\n' })
    const value = await running
    expect(value).toMatchObject({ status: 'opened', workDirs: [task.workDir, second] })
    expect(started).toHaveLength(1)
    expect(repos.service.pushes[0]?.message).toContain(`Analyzed-commit: ${task.commit}\n`)
    expect(repos.service.pushes[0]?.message).not.toMatch(/Analyzed-commit[^\n]*\nAnalyzed-commit/)
    expect(repos.openMr).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringMatching(/分析提交 [0-9a-f]{12}，会话 parent/) }))
  })

  it('waits for the turn that dispatched the analysis to end and starts one improvement per application and turn', async () => {
    const { task, improver, agent, started } = await setup(false)
    const exec = { signal: new AbortController().signal, agent }
    await expect(improver.execute({ app: 'order-service' }, exec)).rejects.toThrow('应用「order-service」的分析是本回合派发的：先把分析结论回复给用户')
    await expect(improver.execute({ app: 'order-service', feedback: 'x' }, exec)).rejects.toThrow('是本回合派发的')
    // Another session's turn does not end this one.
    improver.turnEnded('other')
    await expect(improver.execute({ app: 'order-service' }, exec)).rejects.toThrow('是本回合派发的')
    expect(started).toHaveLength(0)

    improver.turnEnded('parent')
    const first = improver.execute({ app: 'order-service' }, exec)
    await waitForStarts(started, 1)
    await expect(improver.execute({ app: 'order-service', feedback: 'x' }, exec)).rejects.toThrow('应用「order-service」的 SKILL 改进正在进行')
    started[0]!.settle({ stopReason: 'error', output: [], diagnostic: '模型出错' })
    expect((await first).status).toBe('failed')
    await expect(improver.execute({ app: 'order-service', feedback: 'x' }, exec)).rejects.toThrow('本回合已经为应用「order-service」发起过一次 SKILL 改进')

    // A used analysis, even a failed one, is not picked again unless named.
    improver.turnEnded('parent')
    await expect(improver.execute({ app: 'order-service' }, exec)).rejects.toThrow('本会话中应用「order-service」没有待改进的 skill-gap.md 记录')
    const retry = improver.execute({ app: 'order-service', workDirs: [task.workDir] }, exec)
    await waitForStarts(started, 2)
    expect(started[1]?.spec.prompt[0]?.text).toContain(`## 分析 1\n\n运行目录：\`${task.workDir}\``)
    started[1]!.settle({ stopReason: 'completed', output: [] })
    expect((await retry).status).toBe('failed')
  })

  it('reports an improvement that produced nothing submittable', async () => {
    const { task, improver, agent, repos, started, skill } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const attempt = async (index: number, arrange: () => Promise<unknown>) => {
      const running = improver.execute({ app: 'order-service', workDirs: [task.workDir] }, exec)
      await arrange()
      const value = await running
      expect(value.status).toBe('failed')
      expect(started[index]?.dispose).toHaveBeenCalledTimes(1)
      improver.turnEnded('parent')
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
    expect(repos.workspacePush).not.toHaveBeenCalled()
  })

  it('reports a pushed branch when the merge request fails, a moved remote branch, and a declined push', async () => {
    const { task, improver, agent, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    repos.state.changeError = new Error('令牌没有权限')
    const running = improver.execute({ app: 'order-service' }, exec)
    await finishChild(started, 0, { [IN_SKILL(CASE)]: '# c\n' })
    const pushed = await running
    expect(pushed).toMatchObject({ status: 'pushed', mergeRequestError: '令牌没有权限' })
    expect(renderImproveValue(pushed)[0]?.text).toContain('创建合并请求失败（令牌没有权限）')

    const attempt = async (index: number, error: Error) => {
      improver.turnEnded('parent')
      repos.service.pushError = error
      const again = improver.execute({ app: 'order-service', workDirs: [task.workDir] }, exec)
      // Later improvements of the Session continue its branch, so each one changes the case again.
      await finishChild(started, index, { [IN_SKILL(CASE)]: `# c${index}\n` })
      return await again
    }
    const exists = await attempt(1, repoError('conflict', '远端分支已经变化'))
    expect(exists.status).toBe('exists')
    expect(exists.branch).toBe(pushed.branch)
    expect(renderImproveValue(exists)[0]?.text).toContain('在远端已有其他提交')
    const rejected = await attempt(2, declinedError('rejected'))
    expect(rejected.status).toBe('rejected')
    expect(renderImproveValue(rejected)[0]?.text).toContain(`推送授权被拒绝，没有提交`)
    expect((await attempt(3, declinedError('unavailable'))).status).toBe('unavailable')
    expect(repos.workspacePush).toHaveBeenCalledTimes(4)
    expect(repos.service.pushes).toHaveLength(1)
    expect(repos.openMr).toHaveBeenCalledTimes(1)
  })

  it('refuses calls it cannot serve before starting a child', async () => {
    const { registry, task, improver, agent, settings, repos, started } = await setup()
    const exec = { signal: new AbortController().signal, agent }
    const args = { app: 'order-service' }
    await expect(improver.execute({ app: 'order-service', workDirs: ['/elsewhere'] }, exec)).rejects.toThrow('不是本次 DSH 运行中已完成的观象派发任务')
    await expect(improver.execute({}, exec)).rejects.toThrow('参数不合法')
    await expect(improver.execute({ app: 'order-service', workDirs: [] }, exec)).rejects.toThrow('workDirs 给出时不能为空')
    await expect(improver.execute({ app: 'missing', feedback: 'x' }, exec)).rejects.toThrow('missing')
    await expect(improver.execute({ app: 'order-service', feedback: 'x', logs: [{ path: '/nonexistent.log' }] }, exec)).rejects.toThrow('日志路径不可读')
    await expect(improver.execute({ ...args, workDirs: [task.workDir] }, { ...exec, agent: { id: 'other', session: { header: { id: 'other' } } } })).rejects.toThrow('不是当前会话派发的任务')
    await expect(improver.execute(args, { ...exec, agent: { id: 'child', session: { header: { id: 'parent', delegationDepth: 1 } } } })).rejects.toThrow('不能在子 Agent 中调用')
    await expect(improver.execute({ ...args, extra: 1 }, exec)).rejects.toThrow('参数不合法')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: false }
    await expect(improver.execute(args, exec)).rejects.toThrow('未开启')
    settings.skillUpdates = { ...settings.skillUpdates, enabled: true }

    const other = join(dirname(task.workDir), '2-billing')
    await mkdir(other, { recursive: true })
    await improver.inspect({ ...task, workDir: other, app: { ...task.app, id: 'billing' } })
    improver.turnEnded('parent')
    await expect(improver.execute({ ...args, workDirs: [other] }, exec)).rejects.toThrow(`${other} 分析的是应用「billing」，不是「order-service」`)
    const broken = join(dirname(task.workDir), '3-order-service')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'skill-gap.md'), '')
    await improver.inspect({ ...task, workDir: broken })
    improver.turnEnded('parent')
    await expect(improver.execute({ ...args, workDirs: [broken], feedback: 'x' }, exec)).rejects.toThrow('skill-gap.md 是空的')

    const withoutRepos = new SkillImprover({ registry, subagents: fakeSubagents().service, provider: 'spawn', settings: () => settings, workingDirectory: () => undefined, repos: new ReposClient(() => undefined) })
    await withoutRepos.inspect(task)
    withoutRepos.turnEnded('parent')
    await expect(withoutRepos.execute(args, exec)).rejects.toThrow('需要 dsh-repo 插件提供的 dshRepos 服务')
    await rm(join(task.workDir, 'skill-gap.md'))
    await expect(improver.execute(args, exec)).rejects.toThrow('本会话中应用「order-service」没有待改进的 skill-gap.md 记录，需要在 feedback 中写明')
    await expect(improver.execute({ ...args, workDirs: [task.workDir] }, exec)).rejects.toThrow('没有待改进的 skill-gap.md 记录')
    // A repository the catalog lists as read-only takes no improvement.
    registry.configure([{ url: task.url, writable: false }])
    await expect(improver.execute({ ...args, feedback: 'x' }, exec)).rejects.toThrow('权限是「只读」')
    expect(started).toHaveLength(0)
    expect(repos.workspacePush).not.toHaveBeenCalled()
  })

  /** Give the origin a `dev` branch whose description is changed by `edit`, and make it the catalog's baseline while the analysis reads `main`. */
  async function baselineBranch({ origin, repos }: Setup, edit: (manifest: string) => string, renameSkill: boolean): Promise<void> {
    git(origin, 'checkout', '-q', '-b', 'dev')
    if (renameSkill) {
      git(origin, 'mv', '.agents/skills/log-analysis', '.agents/skills/logs-v2')
      const skillPath = join(origin, '.agents/skills/logs-v2/SKILL.md')
      await writeFile(skillPath, (await readFile(skillPath, 'utf8')).replace('name: log-analysis', 'name: logs-v2'))
    }
    const manifestPath = join(origin, '.agents/logalyze.yaml')
    await writeFile(manifestPath, edit(await readFile(manifestPath, 'utf8')))
    git(origin, 'add', '-A')
    git(origin, 'commit', '-qm', 'baseline change')
    git(origin, 'checkout', '-q', 'main')
    repos.service.catalog = [{ id: '000000000001', url: origin, base: 'dev', access: 'write', features: [{ id: 'log-analysis', branch: 'main' }] }]
  }

  it('improves the SKILL the baseline branch names when it differs from the analysed branch', async () => {
    const context = await setup()
    const { improver, agent, started } = context
    await baselineBranch(context, manifest => manifest.replace('skill: log-analysis', 'skill: logs-v2'), true)
    const running = improver.execute({ app: 'order-service' }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    expect(started[0]?.spec.prompt[0]?.text).toContain('.agents/skills/logs-v2/')
    await finishChild(started, 0, { '.agents/skills/logs-v2/cases/2026-10-31-trace-id.md': '# c\n' })
    expect(await running).toMatchObject({ status: 'opened', target: 'dev', files: [{ path: '.agents/skills/logs-v2/cases/2026-10-31-trace-id.md' }] })
  })

  it('stops before starting a child when the baseline branch describes another application', async () => {
    const context = await setup()
    const { improver, agent, started } = context
    await baselineBranch(context, manifest => manifest.replace('id: order-service', 'id: other-service'), false)
    await expect(improver.execute({ app: 'order-service' }, { signal: new AbortController().signal, agent })).rejects.toThrow('声明的是应用「other-service」')
    expect(started).toHaveLength(0)
  })

  it('tells the child when the repository moved on since the analysis', async () => {
    const { task, improver, agent, started } = await setup()
    await improver.inspect({ ...task, commit: 'a'.repeat(40) })
    improver.turnEnded('parent')
    const running = improver.execute({ app: 'order-service' }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    expect(started[0]?.spec.prompt[0]?.text).toContain(`这次分析时的提交是 \`${'a'.repeat(12)}\`，和工作区的提交不同`)
    started[0]?.settle({ stopReason: 'completed', output: [] })
    expect((await running).status).toBe('failed')
  })

  it('corrects a SKILL record the analysis followed when the user points out it is wrong', async () => {
    const { task, improver, agent, repos, started, skill } = await setup()
    await rm(join(task.workDir, 'skill-gap.md'))
    const feedback = 'SKILL 里说 503 是库存服务的问题，其实是网关限流，看 X-RateLimit 头'
    const running = improver.execute({ app: 'order-service', workDirs: [task.workDir], feedback }, { signal: new AbortController().signal, agent })
    await waitForStarts(started, 1)
    const prompt = started[0]?.spec.prompt[0]?.text as string
    expect(prompt).toContain('本会话的一次日志分析之后，用户指出 SKILL 的记录有问题，用户同意改进。')
    expect(prompt).toContain('分析子 Agent 当时没有发现 SKILL 的不足，是按 SKILL 现有的记录分析的；改进的依据是下面的用户反馈。')
    expect(prompt).toContain(`## 用户反馈\n\n${feedback}`)
    expect(prompt).toContain('已有案例描述的是同一个问题时更新它')

    // A correction after an analysis still has to record the case.
    await finishChild(started, 0, { [SKILL]: `${skill}\n503 来自网关限流。\n` })
    const value = await running
    expect(value).toMatchObject({ status: 'failed', workDirs: [task.workDir], error: '改动中没有新增或修改案例文件 cases/<日期>-<slug>.md' })
    expect(repos.workspacePush).not.toHaveBeenCalled()
  })

  it('improves a SKILL from user feedback alone, with sample logs and no case required', async () => {
    const { origin, task, improver, agent, repos, started, skill } = await setup()
    // Without a gap record the earlier analysis is not picked up.
    await rm(join(task.workDir, 'skill-gap.md'))
    const project = agent.session.header.cwd as string
    await writeFile(join(project, 'sample.log'), 'line')
    const exec = { signal: new AbortController().signal, agent }
    const running = improver.execute({ app: 'order-service', feedback: '日志时间是 UTC，不是北京时间', logs: [{ path: 'sample.log' }] }, exec)
    await waitForStarts(started, 1)
    const prompt = started[0]?.spec.prompt[0]?.text as string
    expect(prompt).toContain('用户要求改进这个 SKILL，用户的反馈见下文。')
    expect(prompt).not.toContain('## 分析 1')
    expect(prompt).toContain(`- \`${join(project, 'sample.log')}\``)
    expect(prompt).toContain('只是修正或补充 SKILL 的说明时，可以不写案例。')

    await finishChild(started, 0, { [SKILL]: `${skill}\n时间是 UTC。\n` }, 'fix(skill)!: 修正日志时区说明\n\n- SKILL.md：时间是 UTC')
    const value = await running
    expect(value).toMatchObject({ status: 'opened', files: [{ path: SKILL, added: 2, removed: 0 }] })
    expect(value.workDirs).toBeUndefined()
    const [push] = repos.service.pushes
    expect(push?.message).toBe('chore: 修正日志时区说明\n\nfix(skill)!: 修正日志时区说明\n\n- SKILL.md：时间是 UTC\n\nProposed-by: 观象 Logalyze\n')
    expect(push?.session).toBe('parent')
    expect(repos.openMr).toHaveBeenCalledWith(expect.objectContaining({ repo: origin, title: 'chore: 修正日志时区说明', body: expect.stringMatching(/^由观象按用户反馈提出（应用 order-service，会话 parent）。请评审 SKILL 修改。/) }))
  })
})

describe('logalyze_show_skill', () => {
  it('shows the SKILL file list and a file from the latest synced commit', async () => {
    const { origin, registry, repos } = await setup()
    const viewer = new SkillViewer({ registry, repos: new ReposClient(() => repos.service) })
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
