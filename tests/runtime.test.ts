import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  CircuitBreakerRegistry,
  createFileStorageFacility,
  createMemoryStorageFacility,
  createSupervisionPools,
  DEFAULT_LOG_APP_HOURLY_LIMIT,
  DEFAULT_LOG_POOL_CONCURRENCY,
  DEFAULT_MR_POOL_CONCURRENCY,
  DEFAULT_MR_REPO_HOURLY_LIMIT,
  KeyedDebouncer,
  openStorageDomain,
  openSupervisorDomain,
  outboxPlatformKey,
  OutboxRunner,
  StorageDomainError,
  supervisedMrKey,
  SUPERVISOR_STORAGE_DOMAIN,
  SUPERVISOR_STORAGE_VERSION,
  supervisorDomainSpec,
  TaskPool,
} from '../src/runtime/index.ts'
import type {
  AiIssueUpsertInput,
  CircuitBreakerTripEvent,
  DebounceFlushMeta,
  DomainSpec,
  OutboxPlatformRecord,
} from '../src/runtime/index.ts'
import { tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('runtime storage & dsh_supervisor domain', () => {
  it('prefers host ctx.storageDomain (object facility, function facility, or ctx.get) and falls back cleanly', async () => {
    expect(supervisorDomainSpec.name).toBe('dsh_supervisor')
    expect(SUPERVISOR_STORAGE_DOMAIN).toBe('dsh_supervisor')
    expect(SUPERVISOR_STORAGE_VERSION).toBe(1)

    // 1. Host `{ open(spec) }` facility
    const hostMemory = createMemoryStorageFacility()
    const openSpy = vi.spyOn(hostMemory, 'open')
    const viaObject = await openSupervisorDomain({ ctx: { storageDomain: hostMemory } })
    expect(openSpy).toHaveBeenCalledWith(supervisorDomainSpec)
    await viaObject.watermarks.put('platform-logs', { paused: false, consecutiveFailures: 0, cursorTime: '2026-11-13T10:00:00Z' })
    expect(viaObject.watermarks.get('platform-logs')?.cursorTime).toBe('2026-11-13T10:00:00Z')
    await viaObject.close()

    // 2. Host callable `ctx.storageDomain('dsh_supervisor')` facility
    const callableArgs: unknown[] = []
    const backingHandle = await createMemoryStorageFacility().open(supervisorDomainSpec)
    const viaFunction = await openSupervisorDomain({
      ctx: {
        storageDomain: (arg: unknown) => {
          callableArgs.push(arg)
          return backingHandle
        },
      },
    })
    expect(callableArgs).toEqual(['dsh_supervisor'])
    await viaFunction.watermarks.put('mr-poller', { paused: true, consecutiveFailures: 2, lastError: 'timeout' })
    expect(viaFunction.watermarks.get('mr-poller')).toEqual({ paused: true, consecutiveFailures: 2, lastError: 'timeout' })
    await viaFunction.close()

    // 3. Host `ctx.get('storageDomain')` requiring full spec
    const specBacking = createMemoryStorageFacility()
    const viaGet = await openSupervisorDomain({
      ctx: {
        get: name => name === 'storageDomain'
          ? (specOrName: string | DomainSpec) => {
              if (typeof specOrName === 'string') throw new StorageDomainError('invalid-spec', 'requires spec object')
              return specBacking.open(specOrName)
            }
          : undefined,
      },
    })
    await viaGet.watermarks.put('gitlab', { paused: false, consecutiveFailures: 0 })
    expect(viaGet.watermarks.has('gitlab')).toBe(true)
    await viaGet.close()
  })

  it('persists all 7 strongly-typed tables atomically via file fallback and validates schemas and errors', async () => {
    const { dir, cleanup } = await tempDir('supervisor-domain-')
    cleanups.push(cleanup)

    let clock = 1_700_000_000_000
    const domain = await openSupervisorDomain({ fallbackDir: dir, now: () => clock })

    // 1. watermarks
    await domain.watermarks.put('platform', {
      cursorTime: '2026-11-13T12:00:00Z',
      cursorId: 'log-100',
      paused: false,
      lastPollAt: clock,
      consecutiveFailures: 0,
    })
    await domain.watermarks.update('platform', cur => ({ ...cur, consecutiveFailures: cur.consecutiveFailures + 1 }))

    // 2. pending_batches
    await domain.pendingBatches.put('P1:order:E1001', {
      productCode: 'P1',
      componentCode: 'order',
      errorCode: 'E1001',
      appId: 'order-service',
      logIds: ['log-1', 'log-2'],
      windowOpenedAt: clock,
    })

    // 3. log_tasks
    await domain.logTasks.put('task-1', {
      source: 'platform',
      appId: 'order-service',
      sessionId: 'sess-1',
      workDir: '/tmp/runs/task-1',
      feishuLaunchKey: 'launch-1',
      inputs: [{ ref: 'L1', logId: 'log-1', fileName: 'a.log' }],
      status: 'completed',
      revisions: [{
        revision: 1,
        summary: 'NPE in OrderService',
        rootCause: 'SKU is null',
        confidence: 'high',
        issueId: 'issue-1',
        evidence: ['OrderService.java:42'],
        createdAt: clock,
      }],
      createdAt: clock,
      updatedAt: clock,
    })

    // 4. outbox_platform
    const outboxKey = outboxPlatformKey('task-1', 1, 'log-1')
    expect(outboxKey).toBe('task-1:rev1:log-1')
    await domain.outboxPlatform.put(outboxKey, {
      taskId: 'task-1',
      revision: 1,
      logId: 'log-1',
      status: 'done',
      analysisId: 'ana-1',
      attempts: 1,
      nextRetryAt: clock,
    })

    // 5. issues
    await domain.issues.upsertByAi({
      issueId: 'issue-1',
      appId: 'order-service',
      title: '促销商品缺 SKU 导致空指针',
      matchCriteria: 'NullPointerException at OrderService.createOrder',
      aiDiagnosis: 'SKU 未校验非空',
      aiStatus: 'located',
      resolutionAdvice: '下单前校验 SKU 必填',
      sampleReportUrl: 'https://logs.example.com/r/1',
    })

    // 6. supervised_mrs
    const mrKey = supervisedMrKey('https://gitlab.example.com/shop/order.git', 42)
    expect(mrKey).toBe('https://gitlab.example.com/shop/order.git#42')
    await domain.supervisedMrs.put(mrKey, {
      repo: 'https://gitlab.example.com/shop/order.git',
      mrNumber: 42,
      origin: 'external',
      sessionId: 'sess-mr-42',
      state: 'open',
      lastReviewedSha: 'a'.repeat(40),
      ownPushedShas: [],
      autoFixAttempts: 0,
      pendingSignals: [{ kind: 'push', observedAt: clock, headSha: 'b'.repeat(40) }],
      dueAt: clock + 60_000,
    })

    // 7. circuit_breakers
    await domain.circuitBreakers.put('log:order-service', {
      windowStartAt: clock,
      triggeredCount: 3,
      events: [clock - 2000, clock - 1000, clock],
    })

    // Schema validation rejects malformed data and unknown keys
    await expect(domain.watermarks.put('bad', { paused: false, consecutiveFailures: -1 })).rejects.toThrow()
    await expect(domain.watermarks.put('', { paused: false, consecutiveFailures: 0 })).rejects.toThrow(TypeError)
    await expect(domain.watermarks.update('nonexistent', v => v)).rejects.toMatchObject({ code: 'missing-key' })
    expect(() => domain.raw.table('unknown_table')).toThrowError(StorageDomainError)

    await domain.close()
    await expect(domain.watermarks.put('after-close', { paused: false, consecutiveFailures: 0 })).rejects.toMatchObject({ code: 'closed' })

    // Reopen from disk and verify durable state across all 7 tables
    const persistedPath = join(dir, 'dsh_supervisor.json')
    expect(JSON.parse(await readFile(persistedPath, 'utf8'))).toMatchObject({ version: 1 })

    const reopened = await openSupervisorDomain({ fallbackDir: dir })
    expect(reopened.watermarks.get('platform')?.consecutiveFailures).toBe(1)
    expect(reopened.pendingBatches.get('P1:order:E1001')?.logIds).toEqual(['log-1', 'log-2'])
    expect(reopened.logTasks.get('task-1')?.revisions[0]?.issueId).toBe('issue-1')
    expect(reopened.outboxPlatform.get(outboxKey)?.analysisId).toBe('ana-1')
    expect(reopened.issues.get('issue-1')?.title).toBe('促销商品缺 SKU 导致空指针')
    expect(reopened.supervisedMrs.get(mrKey)?.mrNumber).toBe(42)
    expect(reopened.circuitBreakers.get('log:order-service')?.triggeredCount).toBe(3)
    await reopened.close()

    // Corrupt store detection without silent data loss
    await writeFile(persistedPath, '{not-json')
    await expect(openSupervisorDomain({ fallbackDir: dir })).rejects.toMatchObject({ code: 'corrupt-store' })

    // Spec validation errors
    const invalidSpecs: DomainSpec[] = [
      { name: 'BadName', version: 1, tables: { t: { valueSchema: z.string() } } },
      { name: 'good_name', version: 0, tables: { t: { valueSchema: z.string() } } },
      { name: 'good_name', version: 1, tables: {} },
      { name: 'good_name', version: 1, tables: { 'bad-table': { valueSchema: z.string() } } },
    ]
    for (const bad of invalidSpecs) {
      await expect(openStorageDomain(bad)).rejects.toMatchObject({ code: 'invalid-spec' })
    }
    expect(createFileStorageFacility).toBeTypeOf('function')
  })

  it('enforces at compile time and runtime that AI issue writes NEVER overwrite humanConclusion, humanStatus, or assignee', async () => {
    let now = 1_000
    const domain = await openSupervisorDomain({ now: () => now })

    // Compile-time type checks (`ForbiddenHumanIssueFields` types human columns as `never`):
    const validInput: AiIssueUpsertInput = {
      issueId: 'iss-100',
      appId: 'order-service',
      title: '数据库连接池耗尽',
      matchCriteria: 'HikariPool-1 - Connection is not available',
      aiDiagnosis: '慢查询阻塞连接归还',
      aiStatus: 'located',
      resolutionAdvice: '为 order_items(order_id) 添加索引',
    }
    void validInput

    const forbiddenConclusion: AiIssueUpsertInput = {
      ...validInput,
      // @ts-expect-error AI upsert input must forbid humanConclusion at compile time
      humanConclusion: '误报',
    }
    const forbiddenStatus: AiIssueUpsertInput = {
      ...validInput,
      // @ts-expect-error AI upsert input must forbid humanStatus at compile time
      humanStatus: 'wontfix',
    }
    const forbiddenAssignee: AiIssueUpsertInput = {
      ...validInput,
      // @ts-expect-error AI upsert input must forbid assignee at compile time
      assignee: 'alice',
    }
    void forbiddenConclusion
    void forbiddenStatus
    void forbiddenAssignee

    // Runtime check #1: Even if an untyped caller smuggles human fields on initial insert, they are stripped!
    const smuggledInsert = {
      ...validInput,
      humanConclusion: 'AI 伪造人工结论',
      humanStatus: 'closed',
      assignee: 'mallory',
    } as unknown as AiIssueUpsertInput

    const inserted = await domain.issues.upsertByAi(smuggledInsert)
    expect(inserted.humanConclusion).toBeUndefined()
    expect(inserted.humanStatus).toBeUndefined()
    expect(inserted.assignee).toBeUndefined()
    expect(inserted.firstSeenAt).toBe(1_000)
    expect(inserted.lastSeenAt).toBe(1_000)
    expect(inserted.syncDirty).toBe(true)

    // Human review populates humanConclusion / humanStatus / assignee and marks synced with Bitable
    const humanReviewed = await domain.issues.syncHumanFields('iss-100', {
      humanConclusion: '  确认为大促慢 SQL，排期 v2.4 修复  ',
      humanStatus: 'confirmed',
      assignee: 'zhangsan',
      bitableRecordId: 'rec_abc123',
      syncDirty: false,
    })
    expect(humanReviewed).toMatchObject({
      humanConclusion: '确认为大促慢 SQL，排期 v2.4 修复',
      humanStatus: 'confirmed',
      assignee: 'zhangsan',
      bitableRecordId: 'rec_abc123',
      syncDirty: false,
    })
    expect(domain.issues.listDirty()).toHaveLength(0)

    // Runtime check #2: Subsequent AI upsert updates AI fields & lastSeenAt, sets syncDirty=true,
    // and NEVER overwrites or clears humanConclusion / humanStatus / assignee / bitableRecordId!
    now = 5_000
    const smuggledUpdate = {
      issueId: 'iss-100',
      appId: 'order-service',
      title: '数据库连接池耗尽（新增调用栈）',
      matchCriteria: 'HikariPool-1 - Connection is not available',
      exclusionCriteria: 'ShutdownHook',
      aiDiagnosis: '慢查询 + 事务未设超时',
      aiStatus: 'located' as const,
      resolutionAdvice: '加索引并设置 statement_timeout=3s',
      latestReportUrl: 'https://logs.example.com/r/99',
      fixMrUrl: 'https://gitlab.example.com/shop/order/-/merge_requests/88',
      humanConclusion: '试图覆盖人工结论',
      humanStatus: 'overwritten',
      assignee: 'attacker',
    } as unknown as AiIssueUpsertInput

    const afterAiUpdate = await domain.issues.upsertByAi(smuggledUpdate)
    expect(afterAiUpdate).toMatchObject({
      title: '数据库连接池耗尽（新增调用栈）',
      exclusionCriteria: 'ShutdownHook',
      aiDiagnosis: '慢查询 + 事务未设超时',
      resolutionAdvice: '加索引并设置 statement_timeout=3s',
      firstSeenAt: 1_000,
      lastSeenAt: 5_000,
      latestReportUrl: 'https://logs.example.com/r/99',
      fixMrUrl: 'https://gitlab.example.com/shop/order/-/merge_requests/88',
      humanConclusion: '确认为大促慢 SQL，排期 v2.4 修复',
      humanStatus: 'confirmed',
      assignee: 'zhangsan',
      bitableRecordId: 'rec_abc123',
      syncDirty: true,
    })

    // Runtime check #3: Concurrent `upsertByAi` and `syncHumanFields` on the same issue serialize safely
    now = 9_000
    await Promise.all([
      domain.issues.upsertByAi({
        ...validInput,
        aiDiagnosis: '并发 AI 更新诊断',
      }),
      domain.issues.syncHumanFields('iss-100', {
        humanStatus: 'in_progress',
        assignee: 'lisi',
      }),
    ])
    const merged = domain.issues.get('iss-100')!
    expect(merged.aiDiagnosis).toBe('并发 AI 更新诊断')
    expect(merged.humanConclusion).toBe('确认为大促慢 SQL，排期 v2.4 修复')
    expect(merged.humanStatus).toBe('in_progress')
    expect(merged.assignee).toBe('lisi')

    // Clearing a single human field via `null` leaves other human fields intact
    await domain.issues.syncHumanFields('iss-100', { assignee: null })
    expect(domain.issues.get('iss-100')?.assignee).toBeUndefined()
    expect(domain.issues.get('iss-100')?.humanConclusion).toBe('确认为大促慢 SQL，排期 v2.4 修复')

    await domain.issues.markSynced('iss-100', 'rec_xyz')
    expect(domain.issues.get('iss-100')).toMatchObject({ syncDirty: false, bitableRecordId: 'rec_xyz' })
    expect(domain.issues.listByApp('order-service')).toHaveLength(1)
    expect(domain.issues.listByApp('other-app')).toHaveLength(0)

    await expect(domain.issues.syncHumanFields('missing-id', { humanStatus: 'open' })).rejects.toMatchObject({ code: 'missing-key' })
    expect(await domain.issues.delete('iss-100')).toBe(true)
    expect(domain.issues.size).toBe(0)
    await domain.close()
  })
})

describe('TaskPool & SupervisionPools', () => {
  it('isolates logPool (4) and mrPool (3) so log floods never block MR reviews', async () => {
    const pools = createSupervisionPools()
    expect(pools.logPool.concurrency).toBe(DEFAULT_LOG_POOL_CONCURRENCY)
    expect(pools.mrPool.concurrency).toBe(DEFAULT_MR_POOL_CONCURRENCY)
    expect(DEFAULT_LOG_POOL_CONCURRENCY).toBe(4)
    expect(DEFAULT_MR_POOL_CONCURRENCY).toBe(3)

    const blockers = Array.from({ length: 8 }, () => Promise.withResolvers<void>())
    const logRuns = blockers.map(gate => pools.logPool.run(async () => { await gate.promise; return 'log-done' }))

    expect(pools.logPool.stats()).toMatchObject({
      name: 'logPool',
      concurrency: 4,
      active: 4,
      queued: 4,
      completed: 0,
    })

    // Even with logPool completely saturated and queued, mrPool executes immediately!
    const mrResult = await pools.mrPool.run(async () => 'mr-fast-lane')
    expect(mrResult).toBe('mr-fast-lane')
    expect(pools.mrPool.stats().completed).toBe(1)

    for (const gate of blockers) gate.resolve()
    expect(await Promise.all(logRuns)).toHaveLength(8)
    expect(pools.logPool.stats()).toMatchObject({ active: 0, queued: 0, completed: 8 })
    await pools.drainAndClose()
  })

  it('supports pre-abort, queued eviction, in-flight cancellation, dynamic concurrency, and drainAndClose barrier', async () => {
    expect(() => new TaskPool({ concurrency: 0 })).toThrow(RangeError)
    const pool = new TaskPool({ name: 'testPool', concurrency: 1 })

    // 1. Pre-aborted signal rejects before running
    const preAborted = AbortSignal.abort(new Error('already-cancelled'))
    const neverCalled = vi.fn(async () => 'nope')
    await expect(pool.run(neverCalled, { signal: preAborted })).rejects.toThrow('already-cancelled')
    expect(neverCalled).not.toHaveBeenCalled()

    // 2. Hold the single slot, queue two tasks, abort the first queued task
    const slot1 = Promise.withResolvers<string>()
    const first = pool.run(() => slot1.promise)

    const queuedAbort = new AbortController()
    const evictedFn = vi.fn(async () => 'should-not-run')
    const evicted = pool.run(evictedFn, { signal: queuedAbort.signal })
    const third = pool.run(async () => 'third-ok')

    expect(pool.queuedCount).toBe(2)
    queuedAbort.abort(new Error('drop-from-queue'))
    await expect(evicted).rejects.toThrow('drop-from-queue')
    expect(evictedFn).not.toHaveBeenCalled()
    expect(pool.queuedCount).toBe(1)

    // Dynamically raising concurrency dispatches the remaining queued task immediately!
    pool.setConcurrency(2)
    expect(await third).toBe('third-ok')
    slot1.resolve('first-ok')
    expect(await first).toBe('first-ok')

    // 3. In-flight task receives combined AbortSignal and drainAndClose waits for active work
    pool.setConcurrency(1)
    const inflightStarted = Promise.withResolvers<void>()
    let observedAbort = false
    const inflight = pool.run(async (signal) => {
      inflightStarted.resolve()
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          observedAbort = true
          resolve()
        }, { once: true })
      })
      return 'drained-after-abort'
    })
    await inflightStarted.promise
    const queuedDuringDrain = pool.run(async () => 'evicted-on-drain')
    const rejectedQueued = expect(queuedDuringDrain).rejects.toThrow('正在卸载关闭')

    // First start draining with cancelQueued, then abortActive
    const draining = pool.drainAndClose({ cancelQueued: true, abortActive: true })
    await expect(pool.run(async () => 'after-close')).rejects.toThrow('已关闭')
    await rejectedQueued
    expect(await inflight).toBe('drained-after-abort')
    await draining
    expect(observedAbort).toBe(true)
    expect(pool.isClosed).toBe(true)
    // Idempotent second call
    await pool.drainAndClose()
  })
})

describe('KeyedDebouncer', () => {
  it('anchors fixed windows at the first item (or recovered openedAt) and flushes immediately on maxItems', async () => {
    let now = 10_000
    const flushed: { key: string; items: readonly string[]; meta: DebounceFlushMeta }[] = []
    const debouncer = new KeyedDebouncer<string>({
      windowMs: 5_000,
      mode: 'fixed',
      maxItems: 3,
      autoTimer: false,
      now: () => now,
      onFlush: (key, items, meta) => {
        flushed.push({ key, items, meta })
      },
    })

    const r1 = debouncer.push('batch-A', 'log-1')
    expect(r1.flushedImmediately).toBe(false)
    expect(r1.snapshot).toMatchObject({ firstAt: 10_000, dueAt: 15_000, items: ['log-1'] })

    // Advancing clock in fixed mode keeps dueAt anchored at 15_000
    now = 13_000
    const r2 = debouncer.push('batch-A', 'log-2')
    expect(r2.snapshot).toMatchObject({ firstAt: 10_000, lastAt: 13_000, dueAt: 15_000, items: ['log-1', 'log-2'] })

    expect(await debouncer.flushDue(14_999)).toBe(0)
    expect(await debouncer.flushDue(15_000)).toBe(1)
    expect(flushed).toEqual([{
      key: 'batch-A',
      items: ['log-1', 'log-2'],
      meta: { firstAt: 10_000, lastAt: 13_000, dueAt: 15_000, flushedAt: 15_000, reason: 'timer' },
    }])

    // Reaching maxItems (3) flushes immediately
    now = 20_000
    debouncer.push('batch-B', 'x1')
    debouncer.push('batch-B', 'x2')
    const r3 = debouncer.push('batch-B', 'x3')
    expect(r3.flushedImmediately).toBe(true)
    await r3.flushPromise
    expect(flushed[1]).toMatchObject({
      key: 'batch-B',
      items: ['x1', 'x2', 'x3'],
      meta: { reason: 'max-items', flushedAt: 20_000 },
    })

    // Recovered openedAt already past windowMs flushes immediately on push
    now = 30_000
    const recovered = debouncer.push('batch-C', 'old-1', { openedAt: 20_000 })
    expect(recovered.flushedImmediately).toBe(true)
    await recovered.flushPromise
    expect(flushed[2]).toMatchObject({ key: 'batch-C', items: ['old-1'], meta: { firstAt: 20_000, dueAt: 25_000, reason: 'timer' } })

    await debouncer.drainAndClose()
  })

  it('merges sliding signals up to maxWaitMs, supports manual flush/cancel, and drains async flushes', async () => {
    let now = 1_000
    const flushed: { key: string; items: readonly string[]; reason: string }[] = []
    const flushGate = Promise.withResolvers<void>()
    let blockNextFlush = false

    const debouncer = new KeyedDebouncer<string>({
      windowMs: 3_000,
      mode: 'sliding',
      maxWaitMs: 7_000,
      autoTimer: false,
      now: () => now,
      merge: (existing, incoming) => existing.includes(incoming) ? [...existing] : [...existing, incoming],
      onFlush: async (key, items, meta) => {
        if (blockNextFlush) await flushGate.promise
        flushed.push({ key, items, reason: meta.reason })
      },
    })

    debouncer.push('mr-1', 'push:sha1')
    expect(debouncer.peek('mr-1')?.dueAt).toBe(4_000)

    // Sliding signal extends dueAt to 3_000 + 3_000 = 6_000, deduplicating 'push:sha1'
    now = 3_000
    debouncer.push('mr-1', 'push:sha1')
    debouncer.push('mr-1', 'discussion:d1')
    expect(debouncer.peek('mr-1')).toMatchObject({ dueAt: 6_000, items: ['push:sha1', 'discussion:d1'] })

    // Further sliding signal at 6_000 is capped at firstAt (1_000) + maxWaitMs (7_000) = 8_000!
    now = 5_900
    debouncer.push('mr-1', 'ci-failed')
    expect(debouncer.peek('mr-1')?.dueAt).toBe(8_000)

    // Manual flush & cancel
    debouncer.push('mr-cancel', 'dropped')
    expect(debouncer.cancel('mr-cancel')).toBe(true)
    expect(debouncer.cancel('mr-cancel')).toBe(false)

    now = 6_500
    const manualItems = await debouncer.flush('mr-1')
    expect(manualItems).toEqual(['push:sha1', 'discussion:d1', 'ci-failed'])
    expect(flushed[0]).toEqual({ key: 'mr-1', items: ['push:sha1', 'discussion:d1', 'ci-failed'], reason: 'manual' })

    // drainAndClose({ flushPending: true }) waits for in-flight async onFlush
    debouncer.push('mr-2', 'opened')
    blockNextFlush = true
    let closed = false
    const closing = debouncer.drainAndClose({ flushPending: true }).then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(closed).toBe(false)
    expect(() => debouncer.push('mr-3', 'after-close')).toThrow('已关闭')
    flushGate.resolve()
    await closing
    expect(closed).toBe(true)
    expect(flushed[1]).toEqual({ key: 'mr-2', items: ['opened'], reason: 'manual' })
  })

  it('fires real timers when autoTimer is enabled', async () => {
    const flushed = Promise.withResolvers<readonly number[]>()
    const debouncer = new KeyedDebouncer<number>({
      windowMs: 25,
      mode: 'fixed',
      onFlush: (_key, items) => { flushed.resolve(items) },
    })
    debouncer.push('k', 1)
    debouncer.push('k', 2)
    expect(await flushed.promise).toEqual([1, 2])
    await debouncer.drainAndClose()
  })
})

describe('CircuitBreakerRegistry', () => {
  it('slides the event window, trips on > limit with notification, recovers after cooldown, and resets manually', async () => {
    expect(DEFAULT_LOG_APP_HOURLY_LIMIT).toBe(15)
    expect(DEFAULT_MR_REPO_HOURLY_LIMIT).toBe(30)

    let now = 100_000
    const domain = await openSupervisorDomain({ now: () => now })
    const trips: CircuitBreakerTripEvent[] = []
    const breakers = new CircuitBreakerRegistry({
      table: domain.circuitBreakers,
      defaultPolicy: { windowMs: 10_000, limit: 3, cooldownMs: 20_000 },
      onTrip: (event) => { trips.push(event) },
      now: () => now,
    })

    // Default policy resolver check for `mr:` when custom limit isn't set
    const defaultBreakers = new CircuitBreakerRegistry({ table: domain.circuitBreakers, now: () => now })
    expect(defaultBreakers.inspect('log:order').limit).toBe(15)
    expect(defaultBreakers.inspect('mr:repo').limit).toBe(30)

    // Record 3 events at t=100_000, 102_000, 104_000 (within limit=3)
    expect((await breakers.record('log:order')).allowed).toBe(true)
    now = 102_000
    expect((await breakers.record('log:order')).allowed).toBe(true)
    now = 104_000
    const third = await breakers.record('log:order')
    expect(third).toMatchObject({ allowed: true, tripped: false, newlyTripped: false, status: { triggeredCount: 3 } })

    // Advance to t=111_000 -> first event (100_000) falls outside (101_000..111_000] sliding window!
    now = 111_000
    const fourthAfterSlide = await breakers.record('log:order')
    expect(fourthAfterSlide).toMatchObject({
      allowed: true,
      tripped: false,
      status: { triggeredCount: 3, windowStartAt: 102_000 },
    })
    expect(trips).toHaveLength(0)

    // One more at t=111_500 exceeds limit (4 > 3) -> TRIPS!
    now = 111_500
    const tripped = await breakers.record('log:order')
    expect(tripped).toMatchObject({
      allowed: false,
      tripped: true,
      newlyTripped: true,
      status: {
        tripped: true,
        triggeredCount: 4,
        trippedUntil: 131_500,
      },
    })
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({
      key: 'log:order',
      triggeredCount: 4,
      limit: 3,
      trippedAt: 111_500,
      trippedUntil: 131_500,
    })
    expect(breakers.listTripped().map(item => item.key)).toEqual(['log:order'])

    // Subsequent attempts during cooldown are blocked without re-firing `onTrip`
    now = 120_000
    expect((await breakers.canProceed('log:order')).allowed).toBe(false)
    const blocked = await breakers.record('log:order')
    expect(blocked).toMatchObject({ allowed: false, tripped: true, newlyTripped: false })
    expect(trips).toHaveLength(1)

    // Advance past `trippedUntil` (131_500) -> automatic cooldown recovery!
    now = 131_500
    expect(breakers.listTripped()).toEqual([])
    const recoveredCheck = await breakers.canProceed('log:order')
    expect(recoveredCheck).toMatchObject({ allowed: true, status: { tripped: false, triggeredCount: 0 } })
    const afterRecovery = await breakers.record('log:order')
    expect(afterRecovery).toMatchObject({ allowed: true, tripped: false, status: { triggeredCount: 1 } })

    // Explicit `trip()` + manual `reset()` and `resetAll()`
    await breakers.trip('mr:shop/order', '人工紧急熔断', 60_000)
    expect(breakers.inspect('mr:shop/order')).toMatchObject({ tripped: true, reason: '人工紧急熔断', trippedUntil: 191_500 })
    expect(await breakers.reset('mr:shop/order')).toBe(true)
    expect(breakers.inspect('mr:shop/order').tripped).toBe(false)
    expect(await breakers.resetAll()).toBe(1)

    await domain.close()
  })
})

describe('OutboxRunner', () => {
  it('performs exponential backoff, moves exhausted or permanent failures to dead, and supports retryDead / retryAllDead', async () => {
    let now = 50_000
    const domain = await openSupervisorDomain({ now: () => now })
    const deadEvents: [string, OutboxPlatformRecord][] = []
    let mode: 'transient-fail' | 'permanent-fail' | 'succeed' = 'transient-fail'

    const runner = new OutboxRunner({
      table: domain.outboxPlatform,
      maxAttempts: 3,
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      now: () => now,
      onDead: (key, record) => { deadEvents.push([key, record]) },
      deliver: async (record) => {
        if (mode === 'transient-fail') throw new Error(`HTTP 503 for ${record.logId}`)
        if (mode === 'permanent-fail') throw Object.assign(new Error('HTTP 400 invalid log'), { permanent: true })
        return { analysisId: `ana-${record.revision}`, detailUrl: `https://logs.example.com/a/${record.revision}` }
      },
    })

    // Recover stranded 'uploading' entries on startup
    await domain.outboxPlatform.put(outboxPlatformKey('t0', 1, 'log-stranded'), {
      taskId: 't0',
      revision: 1,
      logId: 'log-stranded',
      status: 'uploading',
      attempts: 1,
      nextRetryAt: 10_000,
    })
    expect(await runner.recoverInterrupted()).toBe(1)
    expect(domain.outboxPlatform.get(outboxPlatformKey('t0', 1, 'log-stranded'))?.status).toBe('pending')
    await domain.outboxPlatform.delete(outboxPlatformKey('t0', 1, 'log-stranded'))

    const enq = await runner.enqueue({ taskId: 'task-1', revision: 1, logId: 'log-1' })
    expect(enq.status).toBe('enqueued')
    expect((await runner.enqueue({ taskId: 'task-1', revision: 1, logId: 'log-1' })).status).toBe('existing')

    // Attempt 1 fails -> backoff 1_000ms -> nextRetryAt = 51_000
    expect(await runner.processDue()).toEqual({ delivered: 0, retried: 1, dead: 0, skipped: 0 })
    expect(domain.outboxPlatform.get(enq.key)).toMatchObject({ status: 'pending', attempts: 1, nextRetryAt: 51_000 })

    // Not due yet at 50_500
    now = 50_500
    expect(await runner.processDue()).toEqual({ delivered: 0, retried: 0, dead: 0, skipped: 0 })

    // Attempt 2 at 51_000 fails -> backoff 2_000ms -> nextRetryAt = 53_000
    now = 51_000
    expect(await runner.processDue()).toEqual({ delivered: 0, retried: 1, dead: 0, skipped: 0 })
    expect(domain.outboxPlatform.get(enq.key)).toMatchObject({ status: 'pending', attempts: 2, nextRetryAt: 53_000 })

    // Attempt 3 at 53_000 reaches maxAttempts (3) -> transitions to 'dead'
    now = 53_000
    expect(await runner.processDue()).toEqual({ delivered: 0, retried: 0, dead: 1, skipped: 0 })
    expect(domain.outboxPlatform.get(enq.key)).toMatchObject({ status: 'dead', attempts: 3, lastError: 'HTTP 503 for log-1' })
    expect(deadEvents).toHaveLength(1)
    expect(runner.listDead()).toHaveLength(1)

    // Permanent failure goes straight to 'dead' on attempt 1
    mode = 'permanent-fail'
    const perm = await runner.enqueue({ taskId: 'task-2', revision: 1, logId: 'log-bad' })
    expect(await runner.processDue()).toEqual({ delivered: 0, retried: 0, dead: 1, skipped: 0 })
    expect(domain.outboxPlatform.get(perm.key)).toMatchObject({ status: 'dead', attempts: 1 })

    // Manual retryDead & retryAllDead succeed once platform recovers
    mode = 'succeed'
    now = 60_000
    expect(await runner.retryDead('nonexistent')).toBe('not-dead')
    expect(await runner.retryDead(enq.key)).toBe('requeued')
    expect(await runner.retryAllDead({ taskId: 'task-2' })).toEqual({ requeued: 1, superseded: 0 })
    expect(await runner.processDue()).toEqual({ delivered: 2, retried: 0, dead: 0, skipped: 0 })
    expect(domain.outboxPlatform.get(enq.key)).toMatchObject({
      status: 'done',
      analysisId: 'ana-1',
      detailUrl: 'https://logs.example.com/a/1',
    })
    expect((await runner.enqueue({ taskId: 'task-1', revision: 1, logId: 'log-1' })).status).toBe('already-done')

    await runner.drainAndClose()
    await domain.close()
  })

  it('enforces monotonic revision protection per (taskId, logId) so stale revisions never overwrite newer reports', async () => {
    const now = 10_000
    const domain = await openSupervisorDomain({ now: () => now })
    const deliveredRevs: string[] = []

    const runner = new OutboxRunner({
      table: domain.outboxPlatform,
      maxAttempts: 2,
      now: () => now,
      deliver: async (record) => {
        deliveredRevs.push(`${record.logId}:rev${record.revision}`)
        return { analysisId: `ana-r${record.revision}` }
      },
    })

    // Case 1: Both rev1 and rev2 are pending for `(task-A, log-1)` at the same time, plus `(task-A, log-2)` at rev1.
    await runner.enqueue({ taskId: 'task-A', revision: 1, logId: 'log-1' })
    await runner.enqueue({ taskId: 'task-A', revision: 2, logId: 'log-1' })
    await runner.enqueue({ taskId: 'task-A', revision: 1, logId: 'log-2' })

    // Also stage a dead rev0-like older entry (rev1 on log-3 where rev2 is also queued)
    await domain.outboxPlatform.put(outboxPlatformKey('task-A', 1, 'log-3'), {
      taskId: 'task-A',
      revision: 1,
      logId: 'log-3',
      status: 'dead',
      attempts: 2,
      nextRetryAt: now,
      lastError: 'timeout',
    })
    await runner.enqueue({ taskId: 'task-A', revision: 2, logId: 'log-3' })

    const summary = await runner.processDue()
    // rev2 of log-1, rev1 of log-2, rev2 of log-3 delivered (3); rev1 of log-1 skipped & deleted (1)!
    expect(summary).toEqual({ delivered: 3, retried: 0, dead: 0, skipped: 1 })
    expect(deliveredRevs.sort()).toEqual(['log-1:rev2', 'log-2:rev1', 'log-3:rev2'])
    expect(domain.outboxPlatform.has(outboxPlatformKey('task-A', 1, 'log-1'))).toBe(false)
    expect(runner.highestDoneRevision('task-A', 'log-1')).toBe(2)

    // Case 2: Enqueuing an older revision after rev2 is done is immediately superseded
    const staleEnqueue = await runner.enqueue({ taskId: 'task-A', revision: 1, logId: 'log-1' })
    expect(staleEnqueue).toEqual({
      status: 'superseded',
      key: 'task-A:rev1:log-1',
      doneRevision: 2,
    })

    // Case 3: Retrying a dead rev1 on log-3 after rev2 is already done skips & deletes it without calling deliver!
    expect(await runner.retryDead(outboxPlatformKey('task-A', 1, 'log-3'))).toBe('superseded')
    expect(domain.outboxPlatform.has(outboxPlatformKey('task-A', 1, 'log-3'))).toBe(false)

    // Case 4: A newer revision (rev3) for `(task-A, log-1)` executes and advances highestDoneRevision to 3
    await runner.enqueue({ taskId: 'task-A', revision: 3, logId: 'log-1' })
    expect(await runner.processDue()).toEqual({ delivered: 1, retried: 0, dead: 0, skipped: 0 })
    expect(runner.highestDoneRevision('task-A', 'log-1')).toBe(3)
    expect(deliveredRevs).toContain('log-1:rev3')

    runner.start(50)
    await runner.drainAndClose()
    await expect(runner.enqueue({ taskId: 'task-A', revision: 4, logId: 'log-1' })).rejects.toThrow('已关闭')
    await domain.close()
  })
})
