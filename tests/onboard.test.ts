import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultsOf, resolveConfig } from '../src/config.ts'
import type { Agent, ApprovalOutcome, ApprovalRequest, SubagentActivation, SubagentResult, SubagentService } from '../src/host.ts'
import { renderAddRepoValue, RepoAdder } from '../src/onboard/add.ts'
import { checkInitDraft, INIT_DIFF_FILE, readInitDraft } from '../src/onboard/draft.ts'
import { renderInitRepoValue, renderSubmitInitValue, RepoInitializer } from '../src/onboard/init.ts'
import { renderInitPrompt } from '../src/onboard/prompt.ts'
import { RepoRegistry } from '../src/repos/registry.ts'
import type { EditableSettings, RepoSpec } from '../src/settings/contract.ts'
import { FakeRepos } from './fake-repos.ts'
import { createAppRepo, EXAMPLE_APP, git, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

const LIMITS = { maxFiles: 8, maxFileBytes: 65536 }
const MR_URL = 'https://gitlab.example.com/shop/order/-/merge_requests/3'
const MANIFEST = 'id: billing-service\nname: 订单服务\ndescription: 下单与支付回调\nlogHints: [OrderController]\nskill: order-logs\n'
const SKILL = '---\nname: order-logs\ndescription: 订单服务日志分析\n---\n\n# 订单服务日志分析\n\n先读 references/payment.md。\n'

async function dir(): Promise<string> {
  const { dir: path, cleanup } = await tempDir()
  cleanups.push(cleanup)
  return path
}

/** An application repository with code but no `.agents/` directory. */
async function bareRepo(path: string): Promise<string> {
  await cp(EXAMPLE_APP, path, { recursive: true })
  await rm(join(path, '.agents'), { recursive: true, force: true })
  git(path, 'init', '-q', '-b', 'main')
  git(path, 'add', '-A')
  git(path, 'commit', '-qm', 'init')
  return path
}

async function writeDraft(workDir: string, files: Record<string, string>, reason = '按 Controller 与 Service 划分领域；traceId 字段待确认'): Promise<void> {
  await mkdir(join(workDir, 'repo-init', 'files'), { recursive: true })
  await writeFile(join(workDir, 'repo-init', 'reason.md'), reason)
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(workDir, 'repo-init', 'files', path)), { recursive: true })
    await writeFile(join(workDir, 'repo-init', 'files', path), content)
  }
}

function approvalWith(answer: { value: ApprovalOutcome }) {
  const requests: ApprovalRequest[] = []
  return { requests, request: vi.fn(async (req: ApprovalRequest) => { requests.push(req); return answer.value }) }
}

const parent: Agent = { id: 'parent', session: { header: { id: 'parent' } } }
const child: Agent = { id: 'child', session: { header: { id: 'parent', delegationDepth: 1 } } }
const run = (agent: Agent = parent) => ({ signal: new AbortController().signal, agent, callId: 'call-1' })

describe('logalyze_add_repo', () => {
  async function setup() {
    const root = await dir()
    const ready = await createAppRepo(join(root, 'order-service'))
    const bare = await bareRepo(join(root, 'billing'))
    const repos = new FakeRepos(join(root, 'mirrors'))
    const registry = new RepoRegistry({ repos: () => repos, onChange: () => {} })
    const configured: RepoSpec[] = []
    const addRepo = vi.fn(async (spec: RepoSpec) => {
      configured.push(spec)
      void registry.syncUrls(registry.configure(configured))
      return 'added' as const
    })
    const answer = { value: 'allowed-once' as ApprovalOutcome }
    const approval = approvalWith(answer)
    const adder = new RepoAdder({ registry, approval: () => approval, addRepo })
    return { ready, bare, registry, addRepo, answer, approval, adder }
  }

  it('adds a repository only after the user allows it and reports the usable application', async () => {
    const { ready, addRepo, answer, approval, adder } = await setup()
    answer.value = 'rejected'
    expect(await adder.execute({ url: ready }, run())).toEqual({ status: 'rejected', url: ready })
    expect(addRepo).not.toHaveBeenCalled()
    expect(approval.requests[0]).toMatchObject({ agent: parent, toolName: 'logalyze_add_repo', callId: 'call-1' })
    expect(approval.requests[0]?.displayReason?.zh).toContain(`把 ${ready}（远端默认分支）加入应用仓库列表`)

    answer.value = 'allowed-once'
    const added = await adder.execute({ url: ready }, run())
    expect(addRepo).toHaveBeenCalledWith({ url: ready })
    expect(added).toMatchObject({ status: 'added', setup: 'ready', repo: { phase: 'ready', app: { id: 'order-service' } } })
    expect(renderAddRepoValue(added)[0]?.text).toContain('应用「订单服务」（id: order-service）可用')

    // Asking again re-syncs without another approval.
    const again = await adder.execute({ url: ready }, run())
    expect(again).toMatchObject({ status: 'exists', setup: 'ready' })
    expect(approval.request).toHaveBeenCalledTimes(2)
    expect(renderAddRepoValue(again)[0]?.text).toContain('已在观象的应用仓库列表中')
  })

  it('points to drafting when the repository synced without a description, and to tokens when the sync failed', async () => {
    const { bare, adder } = await setup()
    const value = await adder.execute({ url: bare }, run())
    expect(value).toMatchObject({ status: 'added', setup: 'needs-setup', repo: { phase: 'failed', error: '仓库缺少应用描述 .agents/logalyze.yaml' } })
    expect(renderAddRepoValue(value)[0]?.text).toContain('调用 logalyze_init_repo 起草')

    const missing = await adder.execute({ url: '/nonexistent/repo' }, run())
    expect(missing).toMatchObject({ status: 'added', setup: 'failed' })
    expect(renderAddRepoValue(missing)[0]?.text).toContain('dsh-repo 插件页为该主机配置令牌')
  })

  it('refuses invalid calls before asking', async () => {
    const { ready, adder, approval } = await setup()
    await adder.execute({ url: ready }, run())
    await expect(adder.execute({ url: ready, branch: 'release' }, run())).rejects.toThrow('改分支请在设置面板')
    await expect(adder.execute({ url: 'ext::sh -c id' }, run())).rejects.toThrow('不支持的 git 地址')
    await expect(adder.execute({ url: '/a', extra: 1 }, run())).rejects.toThrow('参数不合法')
    await expect(adder.execute({ url: '/a' }, run(child))).rejects.toThrow('不能在子 Agent 中调用')
    const withoutApproval = new RepoAdder({ registry: new RepoRegistry({ repos: () => undefined, onChange: () => {} }), approval: () => undefined, addRepo: vi.fn() })
    await expect(withoutApproval.execute({ url: '/a' }, run())).rejects.toThrow('没有审批服务')
    expect(approval.request).toHaveBeenCalledTimes(1)
  })

  it('renders declined outcomes without claiming the repository was added', () => {
    expect(renderAddRepoValue({ status: 'unavailable', url: '/a' })[0]?.text).toContain('没有添加')
    expect(renderAddRepoValue({ status: 'cancelled', url: '/a' })[0]?.text).toContain('撤回')
  })
})

describe('init drafts', () => {
  it('reads the manifest and the files of its SKILL directory', async () => {
    const workDir = await dir()
    await writeDraft(workDir, { 'logalyze.yaml': MANIFEST, 'skills/order-logs/SKILL.md': SKILL, 'skills/order-logs/references/payment.md': '支付回调' })
    const draft = await readInitDraft(workDir, LIMITS)
    expect(draft.app).toMatchObject({ id: 'billing-service', skill: 'order-logs' })
    expect(draft.files.map(file => file.path)).toEqual(['logalyze.yaml', 'skills/order-logs/SKILL.md', 'skills/order-logs/references/payment.md'])
  })

  it('rejects drafts that are missing, stray outside the SKILL, or invalid', async () => {
    const cases: [Record<string, string> | undefined, RegExp][] = [
      [undefined, /没有写出初稿目录/],
      [{ 'skills/order-logs/SKILL.md': SKILL }, /缺少 repo-init\/files\/logalyze.yaml/],
      [{ 'logalyze.yaml': 'id: Bad' }, /logalyze.yaml 不合法/],
      [{ 'logalyze.yaml': MANIFEST, 'skills/other/SKILL.md': SKILL }, /skills\/other\/SKILL.md 不在其中/],
      [{ 'logalyze.yaml': MANIFEST, 'hooks.json': '{}' }, /hooks.json 不在其中/],
    ]
    for (const [files, message] of cases) {
      const workDir = await dir()
      if (files !== undefined) await writeDraft(workDir, files)
      await expect(readInitDraft(workDir, LIMITS)).rejects.toThrow(message)
    }
    const noReason = await dir()
    await writeDraft(noReason, { 'logalyze.yaml': MANIFEST }, ' ')
    await expect(readInitDraft(noReason, LIMITS)).rejects.toThrow('reason.md 不能为空')
  })

  it('checks the draft over the base commit, including the SKILL name', async () => {
    const workDir = await dir()
    await writeDraft(workDir, { 'logalyze.yaml': MANIFEST })
    const draft = await readInitDraft(workDir, LIMITS)
    const base = new Map<string, string>()
    const read = async (path: string) => base.get(path)
    await expect(checkInitDraft(draft, read)).rejects.toThrow('仓库缺少日志分析 SKILL .agents/skills/order-logs/SKILL.md')
    base.set('.agents/skills/order-logs/SKILL.md', SKILL.replace('name: order-logs', 'name: logs'))
    await expect(checkInitDraft(draft, read)).rejects.toThrow('frontmatter name 是「logs」，必须等于 skill 字段「order-logs」')
    base.set('.agents/skills/order-logs/SKILL.md', SKILL)
    await expect(checkInitDraft(draft, read)).resolves.toBeUndefined()
  })
})

describe('logalyze_init_repo and logalyze_submit_init', () => {
  interface Started { spec: Parameters<SubagentService['startActivation']>[0]; dispose: ReturnType<typeof vi.fn> }

  /** Subagents whose child runs `work` on its prompt's run directory, then completes with `output`. */
  function subagents(work: (workDir: string) => Promise<void>, outcome: Partial<SubagentResult> = {}) {
    const started: Started[] = []
    const service: SubagentService = {
      getProvider: () => ({}),
      resolveMaxDepth: () => 1,
      startActivation: async (spec) => {
        const dispose = vi.fn(async () => {})
        started.push({ spec, dispose })
        const prompt = spec.request.prompt[0]?.text ?? ''
        const workDir = /所有文件只写在运行目录 `([^`]+)`/.exec(prompt)?.[1] as string
        const result = work(workDir).then((): SubagentResult => ({ stopReason: 'completed', output: [{ type: 'text', text: '应用 order-service，SKILL order-logs' }], ...outcome }))
        const activation: SubagentActivation = { childId: 'child-1', result, dispose }
        return activation
      },
    }
    return { service, started }
  }

  async function setup(work: (workDir: string) => Promise<void>, outcome?: Partial<SubagentResult>, copies = 1) {
    const root = await dir()
    const origin = await bareRepo(join(root, 'order'))
    const other = await createAppRepo(join(root, 'other'))
    const duplicates = await Promise.all(Array.from({ length: copies - 1 }, async (_, index) => ({ url: await createAppRepo(join(root, `copy-${index}`)) })))
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    const state = { branches: new Set<string>() }
    const repos = Object.assign(Object.create(new FakeRepos(join(root, 'mirrors'))) as FakeRepos, {
      getBranch: vi.fn(async (_repo: string, name: string) => state.branches.has(name) ? { name } : undefined),
      commitFiles: vi.fn(async (_repo: string, request: Record<string, unknown> & { branch: string }) => { state.branches.add(request.branch); return {} }),
      createChange: vi.fn(async () => ({ webUrl: MR_URL })),
    })
    const settings: EditableSettings = { ...defaultsOf(resolveConfig({})), repos: [{ url: origin }, { url: other }, ...duplicates], skillUpdates: { enabled: false, maxFiles: 8, maxFileBytes: 65536 } }
    const registry = new RepoRegistry({ repos: () => repos, onChange: () => {} })
    registry.configure(settings.repos)
    await registry.syncAll()
    const answer = { value: 'allowed-once' as ApprovalOutcome }
    const approval = approvalWith(answer)
    const children = subagents(work, outcome)
    const initializer = new RepoInitializer({
      registry,
      subagents: children.service,
      provider: 'spawn',
      settings: () => settings,
      workingDirectory: () => undefined,
      approval: () => approval,
      repos: () => repos,
      author: { name: '观象', email: 'logalyze@example.com' },
      now: () => new Date(2026, 9, 31, 21, 0, 0),
    })
    const agent: Agent = { id: 'parent', session: { header: { id: 'parent', cwd: project } } }
    return { origin, other, project, repos, registry, answer, approval, children, initializer, agent }
  }

  const goodDraft = (workDir: string) => writeDraft(workDir, { 'logalyze.yaml': MANIFEST, 'skills/order-logs/SKILL.md': SKILL, 'skills/order-logs/references/payment.md': '# 支付回调\n' })

  it('drafts in a snapshot, checks the draft, then commits it to a new branch and opens a merge request after approval', async () => {
    const { origin, project, repos, registry, answer, approval, children, initializer, agent } = await setup(goodDraft)
    const exec = { signal: new AbortController().signal, agent, callId: 'call-2' }
    expect(registry.setupPending()).toEqual([origin])
    expect(initializer.hasDraft('parent')).toBe(false)

    const value = await initializer.draft({ url: origin, guidance: '支付回调最常出问题' }, exec)
    const { workDir } = value
    expect(workDir.startsWith(join(project, '.logalyze', 'runs', '20261031-210000-'))).toBe(true)
    expect(workDir.endsWith('/init')).toBe(true)
    expect(value).toMatchObject({ url: origin, status: 'completed', workDir, output: '应用 order-service，SKILL order-logs' })
    expect(value.draft).toEqual({
      ok: true,
      app: expect.objectContaining({ id: 'billing-service', skill: 'order-logs' }),
      files: [
        { path: '.agents/logalyze.yaml', added: 5, removed: 0 },
        { path: '.agents/skills/order-logs/SKILL.md', added: 8, removed: 0 },
        { path: '.agents/skills/order-logs/references/payment.md', added: 1, removed: 0 },
      ],
      diffPath: join(workDir, INIT_DIFF_FILE),
    })
    expect(await readFile(join(workDir, INIT_DIFF_FILE), 'utf8')).toContain('+skill: order-logs')
    const [started] = children.started
    expect(started?.spec).toMatchObject({ provider: 'spawn', label: '观象接入起草', delivery: 'caller', request: { parent: agent, maxDepth: 1 } })
    expect(started?.spec.request.cwd).toContain('.snapshots')
    expect(started?.spec.request.prompt[0]?.text).toContain('支付回调最常出问题')
    expect(started?.dispose).toHaveBeenCalled()
    expect(repos.heldSnapshots()).toBe(0)
    expect(renderInitRepoValue(value)[0]?.text).toContain(`调用 logalyze_submit_init（workDir 为 ${workDir}）`)
    expect(initializer.hasDraft('parent')).toBe(true)

    answer.value = 'rejected'
    const rejected = await initializer.submit({ workDir }, exec)
    expect(rejected).toMatchObject({ status: 'rejected', app: 'billing-service', target: 'main' })
    expect(rejected.branch).toMatch(/^logalyze\/init-billing-service-[0-9a-f]{10}$/)
    expect(approval.requests[0]?.displayReason?.zh).toContain('接入应用「订单服务」（billing-service）')
    expect(repos.commitFiles).not.toHaveBeenCalled()
    expect(renderSubmitInitValue(rejected)[0]?.text).toContain('可以手动提交')

    answer.value = 'allowed-once'
    const opened = await initializer.submit({ workDir }, exec)
    expect(opened).toMatchObject({ status: 'opened', mergeRequestUrl: MR_URL, branch: rejected.branch })
    const [repo, commit] = repos.commitFiles.mock.calls[0]!
    expect(repo).toBe(origin)
    expect(commit).toMatchObject({
      branch: opened.branch,
      baseSha: value.commit,
      newBranch: true,
      author: { name: '观象', email: 'logalyze@example.com' },
      files: [
        { action: 'write', path: '.agents/logalyze.yaml', content: MANIFEST },
        { action: 'write', path: '.agents/skills/order-logs/SKILL.md', content: SKILL },
        { action: 'write', path: '.agents/skills/order-logs/references/payment.md', content: '# 支付回调\n' },
      ],
    })
    expect(commit.message).toMatch(/^接入观象日志分析：订单服务（billing-service）\n\n按 Controller/)
    expect(repos.createChange).toHaveBeenCalledWith(origin, expect.objectContaining({ title: '接入观象日志分析：订单服务（billing-service）', sourceBranch: opened.branch, targetBranch: 'main' }))
    expect(renderSubmitInitValue(opened)[0]?.text).toContain('合并后观象下一次加载 /logalyze 时启用应用 billing-service')

    expect((await initializer.submit({ workDir }, exec)).status).toBe('exists')
    await expect(initializer.submit({ workDir }, { ...exec, agent: { id: 'x', session: { header: { id: 'other' } } } })).rejects.toThrow('不是当前会话起草的任务')
    await expect(initializer.submit({ workDir: join(project, 'nope') }, exec)).rejects.toThrow('不是本次 DSH 运行中观象起草任务的运行目录')
  })

  it('reports a draft that cannot be submitted', async () => {
    const { origin, other, initializer, agent } = await setup(async workDir => await writeDraft(workDir, { 'logalyze.yaml': MANIFEST }))
    const exec = { signal: new AbortController().signal, agent }
    const missingSkill = await initializer.draft({ url: origin }, exec)
    expect(missingSkill.draft).toEqual({ ok: false, error: '仓库缺少日志分析 SKILL .agents/skills/order-logs/SKILL.md' })
    expect(renderInitRepoValue(missingSkill)[0]?.text).toContain('初稿不可提交')
    await expect(initializer.draft({ url: other }, exec)).rejects.toThrow('已经可用')
  })

  it('refuses an application id another repository already uses', async () => {
    const { origin, initializer, agent } = await setup(async workDir => await writeDraft(workDir, {
      'logalyze.yaml': MANIFEST.replace('id: billing-service', 'id: order-service'),
      'skills/order-logs/SKILL.md': SKILL,
    }))
    const value = await initializer.draft({ url: origin }, { signal: new AbortController().signal, agent })
    // The example repository already registers `order-service`.
    expect(value.draft).toMatchObject({ ok: false, error: expect.stringContaining('已被') })
  })

  it('refuses an id that two other repositories already claim, though neither is usable', async () => {
    const { origin, registry, initializer, agent } = await setup(async workDir => await writeDraft(workDir, {
      'logalyze.yaml': MANIFEST.replace('id: billing-service', 'id: order-service'),
      'skills/order-logs/SKILL.md': SKILL,
    }), undefined, 2)
    expect(registry.readyApps()).toEqual([])
    const value = await initializer.draft({ url: origin }, { signal: new AbortController().signal, agent })
    expect(value.draft).toMatchObject({ ok: false, error: expect.stringContaining('已被') })
  })

  it('reports a child that did not complete without checking a draft', async () => {
    const { origin, initializer, agent, repos } = await setup(goodDraft, { stopReason: 'max-tokens', diagnostic: '输出过长' })
    const value = await initializer.draft({ url: origin }, { signal: new AbortController().signal, agent })
    expect(value).toMatchObject({ status: 'max-tokens', diagnostic: '输出过长' })
    expect(value.draft).toBeUndefined()
    expect(renderInitRepoValue(value)[0]?.text).toContain('起草没有完成（max-tokens）')
    expect(initializer.hasDraft('parent')).toBe(false)
    expect(repos.heldSnapshots()).toBe(0)
  })

  it('stops the child and releases the snapshot when the call is cancelled', async () => {
    const controller = new AbortController()
    const { origin, initializer, agent, children, repos } = await setup(async () => {
      controller.abort(new Error('turn cancelled'))
      await new Promise(() => {})
    })
    await expect(initializer.draft({ url: origin }, { signal: controller.signal, agent })).rejects.toThrow('turn cancelled')
    expect(children.started[0]?.dispose).toHaveBeenCalled()
    expect(repos.heldSnapshots()).toBe(0)
  })

  it('refuses repositories that are not configured or not synced, child agents, and missing services', async () => {
    const { initializer, agent } = await setup(goodDraft)
    const exec = { signal: new AbortController().signal, agent }
    await expect(initializer.draft({ url: '/nowhere' }, exec)).rejects.toThrow('先用 logalyze_add_repo 添加')
    await expect(initializer.draft({ url: '/a' }, { ...exec, agent: child })).rejects.toThrow('不能在子 Agent 中调用')
    await expect(initializer.draft({ url: '/a', logs: [{ file: 'x' }] }, exec)).rejects.toThrow('参数不合法')
    await expect(initializer.submit({ workDir: '/a' }, { ...exec, agent: child })).rejects.toThrow('不能在子 Agent 中调用')
  })
})

describe('renderInitPrompt', () => {
  it('names the draft paths, the user guidance, and the sample logs', () => {
    const text = renderInitPrompt({ url: 'git@host:shop/order.git', commit: 'a'.repeat(40), problem: '仓库缺少应用描述', logs: [{ path: '/tmp/app.log', url: 'https://oss/app.log' }], workDir: '/run/init', maxFiles: 16 })
    expect(text.startsWith('/logalyze-kit\n')).toBe(true)
    expect(text).toContain('仓库还不能用：仓库缺少应用描述')
    expect(text).toContain('`/run/init/repo-init/files/logalyze.yaml`')
    expect(text).toContain('- `/tmp/app.log`（下载自 https://oss/app.log）')
    expect(text).toContain('全部文件不超过 16 个')
    expect(text).toContain('## 用户说明\n\n（无）')
  })
})
