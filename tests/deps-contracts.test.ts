import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FEISHU_ACTIONS_SERVICE, FEISHU_ACTIONS_VERSION, lookupActions } from '../src/deps/actions.ts'
import type { FeishuActionsService } from '../src/deps/actions-contract.ts'
import {
  declinedOutcome,
  DSH_REPOS_COMPATIBLE_VERSIONS,
  DSH_REPOS_REVIEW_VERSION,
  DSH_REPOS_SERVICE,
  DSH_REPOS_VERSION,
  LOG_ANALYSIS_FEATURE,
  lookupRepos,
  lookupReposV8,
  MR_REVIEW_FEATURE,
  repoErrorCode,
  ReposClient,
  unavailableMessage,
  unavailableV8Message,
} from '../src/deps/repos.ts'
import type { DshReposV8 } from '../src/deps/repos-contract.ts'
import { declinedError, FakeRepos, repoError } from './fake-repos.ts'
import { createAppRepo, tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

function createFakeReposV8(base: FakeRepos): DshReposV8 {
  return Object.assign(Object.create(base) as FakeRepos, {
    version: 8 as const,
    mrList: vi.fn(async () => []),
    mrGet: vi.fn(async () => { throw new Error('not called') }),
    mrDiff: vi.fn(async () => ({ baseSha: 'a', headSha: 'b', files: [], diff: '', truncated: false })),
    mrStatus: vi.fn(async () => ({ state: 'open' as const, draft: false, headSha: 'b', checks: { status: 'success' as const, items: [] }, unresolvedDiscussions: 0, approvals: 1 })),
    mrCompare: vi.fn(async () => ({ fromSha: 'a', toSha: 'b', commits: [], files: [], diff: '', truncated: false })),
    mrDiscussions: vi.fn(async () => ({ discussions: [], nextCursor: undefined })),
    mrReview: vi.fn(async () => ({ postedComments: 1, failedComments: [] })),
    mrDiscussionReply: vi.fn(async () => ({ noteId: 'n1' })),
    mrDiscussionResolve: vi.fn(async () => {}),
    currentBotUser: vi.fn(async () => ({ id: 'bot-1', username: 'dsh-bot', name: 'DSH Bot' })),
  })
}

describe('dshRepos v7/v8 narrow contract & ReposClient', () => {
  it('accepts v7 and v8 for base repository operations and requires complete v8 for MR review', async () => {
    const { dir, cleanup } = await tempDir('deps-repos-')
    cleanups.push(cleanup)

    expect(DSH_REPOS_SERVICE).toBe('dshRepos')
    expect(DSH_REPOS_COMPATIBLE_VERSIONS).toEqual([7, 8])
    expect(DSH_REPOS_VERSION).toBe(8)
    expect(DSH_REPOS_REVIEW_VERSION).toBe(8)
    expect(LOG_ANALYSIS_FEATURE.id).toBe('log-analysis')
    expect(MR_REVIEW_FEATURE.id).toBe('mr-review')

    // Missing & incompatible
    expect(lookupRepos(undefined)).toEqual({ availability: 'missing' })
    expect(lookupRepos(null)).toEqual({ availability: 'missing' })
    expect(lookupRepos({ version: 6 })).toEqual({ availability: 'incompatible' })
    expect(lookupReposV8(undefined)).toEqual({ availability: 'missing' })
    expect(lookupReposV8({ version: 6 })).toEqual({ availability: 'incompatible' })

    // v7: base ready, v8 reports upgrade-required
    const v7 = new FakeRepos(join(dir, 'mirrors'))
    expect(lookupRepos(v7)).toEqual({ availability: 'ready', service: v7, version: 7 })
    expect(lookupReposV8(v7)).toEqual({ availability: 'upgrade-required', currentVersion: 7 })
    expect(unavailableV8Message('upgrade-required')).toContain('当前服务版本为 7')

    // Incomplete v8 (missing inline review methods) -> incompatible for v8
    expect(lookupReposV8({ version: 8, mrList: () => [] })).toEqual({ availability: 'incompatible' })

    // Complete v8 -> ready for both base and v8 MR review
    const v8 = createFakeReposV8(v7)
    expect(lookupRepos(v8)).toEqual({ availability: 'ready', service: v8, version: 8 })
    expect(lookupReposV8(v8)).toEqual({ availability: 'ready', service: v8 })

    // ReposClient switches seamlessly when service upgrades from missing -> v7 -> v8
    let current: unknown
    const client = new ReposClient(() => current)
    expect(client.panelState()).toEqual({ availability: 'missing' })
    expect(() => client.require()).toThrow(unavailableMessage('missing'))
    expect(() => client.requireV8()).toThrow(unavailableV8Message('missing'))
    expect(await client.appRepos()).toEqual([])
    expect(await client.mrReviewRepos()).toEqual([])

    const repoUrl = await createAppRepo(join(dir, 'order-service'))
    v7.catalog = [{
      id: '000000000001',
      url: repoUrl,
      base: 'main',
      access: 'merge',
      features: [{ id: 'log-analysis', branch: 'prod' }, { id: 'mr-review' }],
    }]

    current = v7
    expect(client.require()).toBe(v7)
    expect(() => client.requireV8()).toThrow('当前服务版本为 7')
    expect(client.panelState()).toEqual({
      availability: 'ready',
      version: 7,
      mrReviewReady: false,
      mrReviewProblem: unavailableV8Message('upgrade-required'),
      mirrorDir: v7.root,
    })
    expect(await client.appRepos()).toEqual([{ url: repoUrl, branch: 'prod', writable: true }])
    expect(await client.mrReviewRepos()).toEqual([{
      id: '000000000001',
      url: repoUrl,
      branch: 'main',
      base: 'main',
      access: 'merge',
      writable: true,
    }])

    current = v8
    expect(client.requireV8()).toBe(v8)
    expect(client.panelState()).toEqual({
      availability: 'ready',
      version: 8,
      mrReviewReady: true,
      mirrorDir: v7.root,
    })

    // withSnapshot always releases lease even on error
    await expect(client.withSnapshot(repoUrl, 'main', undefined, async () => {
      expect(v7.heldSnapshots()).toBe(1)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(v7.heldSnapshots()).toBe(0)

    // Error classification helpers
    expect(repoErrorCode(repoError('conflict', 'moved'))).toBe('conflict')
    expect(repoErrorCode(new Error('plain'))).toBeUndefined()
    expect(declinedOutcome(declinedError('cancelled'))).toBe('cancelled')
    expect(declinedOutcome(declinedError('unavailable'))).toBe('unavailable')
    expect(declinedOutcome(declinedError('rejected'))).toBe('rejected')
    expect(declinedOutcome(repoError('invalid', 'x'))).toBeUndefined()
  })
})

describe('feishuActions v1 narrow contract', () => {
  it('validates version 1 with propose and supersede methods', async () => {
    expect(FEISHU_ACTIONS_SERVICE).toBe('feishuActions')
    expect(FEISHU_ACTIONS_VERSION).toBe(1)

    expect(lookupActions(undefined)).toEqual({ availability: 'missing' })
    expect(lookupActions(null)).toEqual({ availability: 'missing' })
    expect(lookupActions({ version: 2, propose: () => {}, supersede: () => {} })).toEqual({ availability: 'incompatible' })
    expect(lookupActions({ version: 1, propose: () => {} })).toEqual({ availability: 'incompatible' })

    const superseded: [string, string | undefined][] = []
    const actions: FeishuActionsService = {
      version: 1,
      propose: vi.fn(async spec => ({
        ok: true as const,
        replayed: false,
        cardMessageId: `om_card_${spec.key}`,
      })),
      supersede: vi.fn(async (key, reason) => { superseded.push([key, reason]) }),
    }

    const lookup = lookupActions(actions)
    expect(lookup).toEqual({ availability: 'ready', service: actions })
    if (lookup.availability !== 'ready') return

    const proposed = await lookup.service.propose({
      key: 'mr:42:autofix:1',
      sessionId: 'sess-42',
      prompt: '发现空指针风险，请选择后续处理动作：',
      actions: [
        {
          id: 'fix_code',
          label: '🔧 修复代码并提 MR',
          style: 'primary',
          requiredAccess: 'code-write',
          followUpPrompt: '请修复空指针问题并创建 MR',
        },
        {
          id: 'improve_skill',
          label: '📚 改进 SKILL',
          style: 'default',
          followUpPrompt: '请将该案例沉淀到应用 SKILL',
          independent: true,
        },
      ],
    })
    expect(proposed).toEqual({
      ok: true,
      replayed: false,
      cardMessageId: 'om_card_mr:42:autofix:1',
    })
    await lookup.service.supersede('mr:42:autofix:1', 'MR 已合并')
    expect(superseded).toEqual([['mr:42:autofix:1', 'MR 已合并']])
  })
})
