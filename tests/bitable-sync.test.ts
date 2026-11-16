import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type {
  BitableCreateRecordsInput,
  BitableFieldInfo,
  BitableListRecordsInput,
  BitableRecord,
  BitableResult,
  BitableTargetInput,
  BitableTableSchema,
  BitableUpdateRecordsInput,
  FeishuBitableService,
} from '../src/deps/bitable-contract.ts'
import { FEISHU_BITABLE_SERVICE, FEISHU_BITABLE_VERSION, parseBitableUrl } from '../src/deps/bitable.ts'
import { DSH_REPOS_SERVICE } from '../src/deps/repos.ts'
import type { HostContext, HostRequestGate, HostWebServer } from '../src/host.ts'
import { ISSUE_BITABLE_COLUMNS, IssueBitableSyncer } from '../src/issues/bitable-sync.ts'
import { IssueMemory } from '../src/issues/memory.ts'
import { computeIssueAiFingerprint, openSupervisorDomain } from '../src/runtime/domain.ts'
import { SupervisorService } from '../src/service.ts'
import {
  ISSUE_CHECK_ROUTE,
  ISSUE_SYNC_ROUTE,
  SETTINGS_ROUTE,
  STATE_ROUTE,
} from '../src/settings/contract.ts'
import type { IssueSyncSettings, StateWire } from '../src/settings/contract.ts'
import { OverlayStore } from '../src/settings/overlay.ts'
import { registerSettingsRoutes } from '../src/settings/routes.ts'
import { loadBundledSkills } from '../src/skill/bundled.ts'
import { FakeRepos } from './fake-repos.ts'
import { tempDir } from './helpers.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(fn => fn()))
})

interface StoredTable {
  readonly baseToken: string
  readonly tableId: string
  readonly tableName: string
  fields: BitableFieldInfo[]
  records: { recordId: string; fields: Record<string, unknown> }[]
}

class FakeBitableService implements FeishuBitableService {
  readonly version = FEISHU_BITABLE_VERSION
  connected = true
  private seq = 0
  private readonly tables = new Map<string, StoredTable>()
  private readonly wikiNodes = new Map<string, string>()
  private readonly listeners = new Set<() => void>()

  inspectCalls = 0
  listCalls = 0
  createCalls = 0
  updateCalls = 0
  readonly createdBatches: Record<string, unknown>[][] = []
  readonly updatedBatches: Record<string, Readonly<Record<string, unknown>>>[] = []
  beforeCreateHook?: () => Promise<void> | void
  beforeUpdateHook?: () => Promise<void> | void

  putTable(table: StoredTable): void {
    this.tables.set(`${table.baseToken}:${table.tableId}`, table)
  }

  mapWiki(nodeToken: string, baseToken: string): void {
    this.wikiNodes.set(nodeToken, baseToken)
  }

  getTable(baseToken: string, tableId: string): StoredTable {
    const found = this.tables.get(`${baseToken}:${tableId}`)
    if (found === undefined) throw new Error(`Missing table ${baseToken}:${tableId}`)
    return found
  }

  triggerChange(): void {
    for (const listener of [...this.listeners]) {
      listener()
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private resolve(input: BitableTargetInput): BitableResult<{ readonly table: StoredTable }> {
    if (!this.connected) {
      return { ok: false, code: 'not-connected', message: '飞书渠道尚未连接' }
    }
    const parsed = parseBitableUrl(input.url, input.table)
    if (parsed === undefined) {
      return { ok: false, code: 'invalid-target', message: '无效多维表格 URL' }
    }
    const baseToken = parsed.kind === 'wiki' ? this.wikiNodes.get(parsed.token) : parsed.token
    if (baseToken === undefined) {
      return { ok: false, code: 'not-found', message: `未知知识库节点 ${parsed.token}` }
    }
    const baseTables = [...this.tables.values()].filter(item => item.baseToken === baseToken)
    if (baseTables.length === 0) {
      return { ok: false, code: 'table-not-found', message: `Base ${baseToken} 不存在数据表` }
    }
    if (parsed.table !== undefined) {
      const match = baseTables.find(item => item.tableId === parsed.table || item.tableName === parsed.table)
      if (match === undefined) {
        return { ok: false, code: 'table-not-found', message: `找不到数据表 ${parsed.table}` }
      }
      return { ok: true, table: match }
    }
    if (baseTables.length > 1) {
      return { ok: false, code: 'ambiguous-table', message: '包含多张表，请指定 table' }
    }
    return { ok: true, table: baseTables[0]! }
  }

  async inspectTable(target: BitableTargetInput): Promise<BitableResult<BitableTableSchema>> {
    this.inspectCalls += 1
    const res = this.resolve(target)
    if (!res.ok) return res
    return {
      ok: true,
      baseToken: res.table.baseToken,
      tableId: res.table.tableId,
      tableName: res.table.tableName,
      fields: res.table.fields,
    }
  }

  async listRecords(input: BitableListRecordsInput): Promise<BitableResult<{
    readonly baseToken: string
    readonly tableId: string
    readonly records: readonly BitableRecord[]
    readonly hasMore: boolean
    readonly nextOffset?: number
    readonly rev?: number
    readonly ignoredFields: readonly string[]
  }>> {
    this.listCalls += 1
    const res = this.resolve(input)
    if (!res.ok) return res
    const offset = input.offset ?? 0
    const limit = input.limit ?? 200
    const fieldNames = new Set(res.table.fields.map(f => f.name))
    const requested = input.fields
    const ignoredFields = requested === undefined
      ? []
      : requested.filter(name => !fieldNames.has(name))

    const slice = res.table.records.slice(offset, offset + limit).map((row) => {
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row.fields)) {
        if (requested === undefined || requested.includes(k)) {
          fields[k] = v
        }
      }
      return { recordId: row.recordId, fields }
    })
    const hasMore = offset + slice.length < res.table.records.length
    return {
      ok: true,
      baseToken: res.table.baseToken,
      tableId: res.table.tableId,
      records: slice,
      hasMore,
      ...(hasMore ? { nextOffset: offset + slice.length } : {}),
      rev: 1,
      ignoredFields,
    }
  }

  async createRecords(input: BitableCreateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly recordIds: readonly string[] }>> {
    this.createCalls += 1
    await this.beforeCreateHook?.()
    const res = this.resolve(input)
    if (!res.ok) return res
    const ids: string[] = []
    const batchSnapshot: Record<string, unknown>[] = []
    for (const row of input.records) {
      this.seq += 1
      const recordId = `rec_${this.seq}`
      res.table.records.push({ recordId, fields: { ...row } })
      ids.push(recordId)
      batchSnapshot.push({ ...row })
    }
    this.createdBatches.push(batchSnapshot)
    return { ok: true, baseToken: res.table.baseToken, tableId: res.table.tableId, recordIds: ids }
  }

  async updateRecords(input: BitableUpdateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly ignoredFields: readonly string[] }>> {
    this.updateCalls += 1
    await this.beforeUpdateHook?.()
    const res = this.resolve(input)
    if (!res.ok) return res
    const snapshot: Record<string, Readonly<Record<string, unknown>>> = {}
    for (const [recordId, patch] of Object.entries(input.updates)) {
      const idx = res.table.records.findIndex(item => item.recordId === recordId)
      if (idx < 0) {
        return { ok: false, code: 'not-found', message: `record ${recordId} not found` }
      }
      res.table.records[idx] = {
        recordId,
        fields: { ...res.table.records[idx]!.fields, ...patch },
      }
      snapshot[recordId] = { ...patch }
    }
    this.updatedBatches.push(snapshot)
    return { ok: true, baseToken: res.table.baseToken, tableId: res.table.tableId, ignoredFields: [] }
  }
}

function makeFullIssueFields(): BitableFieldInfo[] {
  return ISSUE_BITABLE_COLUMNS.map((col, idx) => ({
    fieldId: `fld_${idx + 1}`,
    name: col.name,
    type: col.expectedType,
    properties: col.expectedType === 'select' ? { options: [] } : {},
  }))
}

describe('IssueBitableSyncer two-way synchronization', () => {
  it('pushes 13 AI columns idempotently, never touches human columns, and pulls human corrections into IssueMemory', async () => {
    const { dir, cleanup } = await tempDir('bitable-sync-1-')
    cleanups.push(cleanup)
    let nowMs = 1_700_000_000_000
    const domain = await openSupervisorDomain({ fallbackDir: dir, now: () => nowMs })
    cleanups.push(() => domain.close())
    const memory = new IssueMemory(domain.issues)
    const bitable = new FakeBitableService()
    bitable.mapWiki('wikcnIssues1', 'appIssues1')
    bitable.putTable({
      baseToken: 'appIssues1',
      tableId: 'tblMain',
      tableName: '已知问题库',
      fields: makeFullIssueFields(),
      records: [],
    })

    const settings: IssueSyncSettings = {
      enabled: true,
      bitableUrl: 'https://mi.feishu.cn/wiki/wikcnIssues1',
      syncIntervalMs: 300_000,
    }
    const syncer = new IssueBitableSyncer({
      issues: domain.issues,
      getSettings: () => settings,
      getBitable: () => ({ status: 'ready', service: bitable }),
      now: () => nowMs,
      autoSyncTimer: false,
      aiMutateDebounceMs: 50,
    })
    cleanups.push(() => syncer.drainAndClose())

    const createdIssue = await memory.upsertNewOrReuseByTitle({
      appId: 'order-service',
      title: '库存扣减幂等键冲突',
      matchCriteria: 'error_code=INV_409',
      aiDiagnosis: '首次 AI 诊断：重试未复用幂等键',
      aiStatus: 'pending',
      resolutionAdvice: '改为按订单号生成稳定幂等键',
      seenAt: nowMs,
    })
    await domain.issues.attachUrlsByAi(createdIssue.issueId, {
      sampleReportUrl: 'https://logs.example.com/r/1',
      latestReportUrl: 'https://logs.example.com/r/1',
      fixMrUrl: 'https://git.example/org/order/merge_requests/12',
    })
    expect(domain.issues.get(createdIssue.issueId)?.syncDirty).toBe(true)

    const pass1 = await syncer.syncNow()
    expect(pass1).toEqual({ ok: true, pulled: 0, pushed: 1, created: 1, updated: 0 })
    expect(bitable.createCalls).toBe(1)

    const remoteTable = bitable.getTable('appIssues1', 'tblMain')
    expect(remoteTable.records).toHaveLength(1)
    const remoteRow = remoteTable.records[0]!
    expect(remoteRow.fields['问题ID']).toBe(createdIssue.issueId)
    expect(remoteRow.fields['AI 状态']).toEqual(['pending'])
    expect(remoteRow.fields['示例报告']).toEqual({
      text: 'https://logs.example.com/r/1',
      link: 'https://logs.example.com/r/1',
    })
    expect(remoteRow.fields['修复 MR']).toEqual({
      text: 'https://git.example/org/order/merge_requests/12',
      link: 'https://git.example/org/order/merge_requests/12',
    })
    // AI push must NEVER write human columns.
    expect('人工确认结论' in remoteRow.fields).toBe(false)
    expect('人工状态' in remoteRow.fields).toBe(false)
    expect('负责人' in remoteRow.fields).toBe(false)

    const afterPush = domain.issues.get(createdIssue.issueId)!
    expect(afterPush.syncDirty).toBe(false)
    expect(afterPush.bitableRecordId).toBe(remoteRow.recordId)
    expect(afterPush.bitableTableKey).toBe('appIssues1:tblMain')

    // Team engineer annotates human columns on Feishu Bitable while local syncDirty === false.
    remoteRow.fields['人工确认结论'] = [{ type: 'text', text: '已确认属于网关重试重放，无需回滚' }]
    remoteRow.fields['人工状态'] = ['已确认']
    remoteRow.fields['负责人'] = [{ id: 'ou_zhangsan', name: '张三' }]

    const pass2 = await syncer.syncNow()
    expect(pass2).toEqual({ ok: true, pulled: 1, pushed: 0, created: 0, updated: 0 })
    expect(bitable.updateCalls).toBe(0)

    const searched = memory.search({ appId: 'order-service', query: 'INV_409' })
    expect(searched).toHaveLength(1)
    expect(searched[0]!.humanConclusion).toBe('已确认属于网关重试重放，无需回滚')
    expect(searched[0]!.humanStatus).toBe('已确认')
    expect(searched[0]!.assignee).toBe('张三')

    // Subsequent AI diagnosis update uses updateRecords (no duplicate createRecords) and keeps remote human fields intact.
    nowMs += 5_000
    await memory.touchExisting({
      issueId: createdIssue.issueId,
      appId: 'order-service',
      title: '库存扣减幂等键冲突（已关联 MR）',
      matchCriteria: 'error_code=INV_409',
      aiDiagnosis: '二次 AI 诊断：已识别到重试链路',
      aiStatus: 'located',
      resolutionAdvice: '部署 MR #12',
      latestReportUrl: 'https://logs.example.com/r/2',
      seenAt: nowMs,
    })
    const pass3 = await syncer.syncNow()
    expect(pass3).toEqual({ ok: true, pulled: 0, pushed: 1, created: 0, updated: 1 })
    expect(bitable.createCalls).toBe(1)
    expect(bitable.updateCalls).toBe(1)
    expect(bitable.updatedBatches[0]![remoteRow.recordId]).not.toHaveProperty('人工确认结论')
    const updatedRemoteRow = remoteTable.records[0]!
    expect(updatedRemoteRow.fields['人工状态']).toEqual(['已确认'])
    expect(updatedRemoteRow.fields['人工确认结论']).toEqual([{ type: 'text', text: '已确认属于网关重试重放，无需回滚' }])
    expect(updatedRemoteRow.fields['AI 状态']).toEqual(['located'])
    expect(domain.issues.get(createdIssue.issueId)!.humanConclusion).toBe('已确认属于网关重试重放，无需回滚')
  })

  it('paginates >200 remote rows, deduplicates by 问题ID without duplicates, preserves missing columns, and clears emptied cells', async () => {
    const { dir, cleanup } = await tempDir('bitable-sync-2-')
    cleanups.push(cleanup)
    const nowMs = 1_700_000_000_000
    const domain = await openSupervisorDomain({ fallbackDir: dir, now: () => nowMs })
    cleanups.push(() => domain.close())
    const memory = new IssueMemory(domain.issues)
    const bitable = new FakeBitableService()

    // Table omits 负责人 column intentionally to test partial optional column schema.
    const fieldsWithoutAssignee = makeFullIssueFields().filter(f => f.name !== '负责人')
    const noiseRows = Array.from({ length: 203 }, (_, idx) => ({
      recordId: `rec_noise_${idx}`,
      fields: { 问题ID: `ISS-other-${idx}` },
    }))
    const targetRemoteRow = {
      recordId: 'rec_target_page2',
      fields: {
        问题ID: 'ISS-pay-0001',
        人工状态: ['待验证'],
        人工确认结论: '老方案确认',
      },
    }
    bitable.putTable({
      baseToken: 'appBase2',
      tableId: 'tblPage2',
      tableName: '主表',
      fields: fieldsWithoutAssignee,
      records: [...noiseRows, targetRemoteRow],
    })

    await memory.touchExisting({
      issueId: 'ISS-pay-0001',
      appId: 'pay',
      title: '支付超时',
      matchCriteria: 'PAY_504',
      aiDiagnosis: '上游超时',
      aiStatus: 'pending',
      resolutionAdvice: '调大连接池',
      seenAt: nowMs,
    })
    // Set local assignee manually before Bitable table omits 负责人 column.
    await domain.issues.syncHumanFields('ISS-pay-0001', { assignee: '王五' })

    const syncer = new IssueBitableSyncer({
      issues: domain.issues,
      getSettings: () => ({
        enabled: true,
        bitableUrl: 'https://mi.feishu.cn/base/appBase2',
        syncIntervalMs: 60_000,
      }),
      getBitable: () => ({ status: 'ready', service: bitable }),
      now: () => nowMs,
      autoSyncTimer: false,
    })
    cleanups.push(() => syncer.drainAndClose())

    const res = await syncer.syncNow()
    expect(res).toEqual({ ok: true, pulled: 1, pushed: 1, created: 0, updated: 1 })
    // ListRecords paginated twice (>= 2 calls), createCalls === 0 because matched by 问题ID on page 2.
    expect(bitable.listCalls).toBeGreaterThanOrEqual(2)
    expect(bitable.createCalls).toBe(0)
    expect(domain.issues.get('ISS-pay-0001')?.humanStatus).toBe('待验证')
    expect(domain.issues.get('ISS-pay-0001')?.assignee).toBe('王五')

    // Clearing an existing remote cell (人工状态 -> []) propagates back to local IssuesTable.
    bitable.getTable('appBase2', 'tblPage2').records.find(r => r.recordId === 'rec_target_page2')!.fields['人工状态'] = []
    const res2 = await syncer.syncNow()
    expect(res2).toEqual({ ok: true, pulled: 1, pushed: 0, created: 0, updated: 0 })
    expect(domain.issues.get('ISS-pay-0001')?.humanStatus).toBeUndefined()
    expect(domain.issues.get('ISS-pay-0001')?.assignee).toBe('王五')
  })

  it('keeps syncDirty true when upsertByAi mutates concurrently during in-flight Bitable write', async () => {
    const { dir, cleanup } = await tempDir('bitable-sync-3-')
    cleanups.push(cleanup)
    let nowMs = 1_700_000_000_000
    const domain = await openSupervisorDomain({ fallbackDir: dir, now: () => nowMs })
    cleanups.push(() => domain.close())
    const bitable = new FakeBitableService()
    bitable.putTable({
      baseToken: 'appRace',
      tableId: 'tblRace',
      tableName: '主表',
      fields: makeFullIssueFields(),
      records: [],
    })

    const createdIssue = await domain.issues.upsertByAi({
      issueId: 'ISS-race-0001',
      appId: 'app-race',
      title: '并发测试',
      matchCriteria: 'RACE',
      aiDiagnosis: 'V1 诊断',
      aiStatus: 'pending',
      resolutionAdvice: 'V1 建议',
    })
    expect(computeIssueAiFingerprint(createdIssue)).toBeTruthy()

    const createEntered = Promise.withResolvers<void>()
    const allowCreateFinish = Promise.withResolvers<void>()
    bitable.beforeCreateHook = async () => {
      createEntered.resolve()
      await allowCreateFinish.promise
    }

    const syncer = new IssueBitableSyncer({
      issues: domain.issues,
      getSettings: () => ({
        enabled: true,
        bitableUrl: 'https://mi.feishu.cn/base/appRace',
        syncIntervalMs: 60_000,
      }),
      getBitable: () => ({ status: 'ready', service: bitable }),
      now: () => nowMs,
      autoSyncTimer: false,
      aiMutateDebounceMs: 10_000,
    })
    cleanups.push(() => syncer.drainAndClose())

    const firstSyncPromise = syncer.syncNow()
    await createEntered.promise

    // While createRecords('V1 诊断') is in flight, AI commits 'V2 诊断' locally.
    nowMs += 1_000
    await domain.issues.upsertByAi({
      issueId: 'ISS-race-0001',
      appId: 'app-race',
      title: '并发测试',
      matchCriteria: 'RACE',
      aiDiagnosis: 'V2 诊断',
      aiStatus: 'pending',
      resolutionAdvice: 'V2 建议',
    })
    allowCreateFinish.resolve()

    const pass1 = await firstSyncPromise
    expect(pass1.ok).toBe(true)
    expect(pass1.created).toBe(1)

    const midState = domain.issues.get('ISS-race-0001')!
    expect(midState.bitableRecordId).toBeDefined()
    expect(midState.aiDiagnosis).toBe('V2 诊断')
    // Crucially: syncDirty stays true because AI fingerprint changed mid-flight!
    expect(midState.syncDirty).toBe(true)

    bitable.beforeCreateHook = undefined
    const pass2 = await syncer.syncNow()
    expect(pass2).toEqual({ ok: true, pulled: 0, pushed: 1, created: 0, updated: 1 })
    expect(bitable.createCalls).toBe(1)
    expect(bitable.getTable('appRace', 'tblRace').records).toHaveLength(1)
    expect(bitable.getTable('appRace', 'tblRace').records[0]!.fields['AI 诊断结论']).toBe('V2 诊断')
    expect(domain.issues.get('ISS-race-0001')!.syncDirty).toBe(false)
  })

  it('recreates remotely deleted rows cleanly and pushes all records after switching tables', async () => {
    const { dir, cleanup } = await tempDir('bitable-sync-4-')
    cleanups.push(cleanup)
    const nowMs = 1_700_000_000_000
    const domain = await openSupervisorDomain({ fallbackDir: dir, now: () => nowMs })
    cleanups.push(() => domain.close())
    const bitable = new FakeBitableService()
    bitable.putTable({
      baseToken: 'appSwitch',
      tableId: 'tblA',
      tableName: '表A',
      fields: makeFullIssueFields(),
      records: [],
    })
    bitable.putTable({
      baseToken: 'appSwitch',
      tableId: 'tblB',
      tableName: '表B',
      fields: makeFullIssueFields(),
      records: [{
        recordId: 'rec_b_existing',
        fields: { 问题ID: 'ISS-sw-1', 人工状态: ['已解决'] },
      }],
    })

    let currentSettings: IssueSyncSettings = {
      enabled: true,
      bitableUrl: 'https://mi.feishu.cn/base/appSwitch?table=tblA',
      syncIntervalMs: 60_000,
    }
    const syncer = new IssueBitableSyncer({
      issues: domain.issues,
      getSettings: () => currentSettings,
      getBitable: () => ({ status: 'ready', service: bitable }),
      now: () => nowMs,
      autoSyncTimer: false,
    })
    cleanups.push(() => syncer.drainAndClose())

    await domain.issues.upsertByAi({
      issueId: 'ISS-sw-1',
      appId: 'svc-a',
      title: '问题一',
      matchCriteria: 'E1',
      aiDiagnosis: '诊断1',
      aiStatus: 'pending',
      resolutionAdvice: '建议1',
    })
    await domain.issues.upsertByAi({
      issueId: 'ISS-sw-2',
      appId: 'svc-b',
      title: '问题二',
      matchCriteria: 'E2',
      aiDiagnosis: '诊断2',
      aiStatus: 'pending',
      resolutionAdvice: '建议2',
    })
    expect((await syncer.syncNow()).created).toBe(2)

    // Delete ISS-sw-1 remotely and mutate it locally -> triggers not-found fallback recreate in tblA.
    const tblA = bitable.getTable('appSwitch', 'tblA')
    tblA.records = tblA.records.filter(r => r.fields['问题ID'] !== 'ISS-sw-1')
    await domain.issues.attachUrlsByAi('ISS-sw-1', { fixMrUrl: 'https://git.example/mr/9' })

    const afterDeleteRes = await syncer.syncNow()
    expect(afterDeleteRes).toEqual({ ok: true, pulled: 0, pushed: 1, created: 1, updated: 0 })
    expect(tblA.records).toHaveLength(2)

    // Switch target to tblB -> if push fails after pull rebinds rec_b_existing, syncDirty must stay true for retry!
    currentSettings = {
      enabled: true,
      bitableUrl: 'https://mi.feishu.cn/base/appSwitch?table=tblB',
      syncIntervalMs: 60_000,
    }
    syncer.notifyConfigChanged()
    vi.spyOn(bitable, 'updateRecords').mockResolvedValueOnce({
      ok: false,
      code: 'rate-limited',
      message: 'rate limited during switch',
    })
    const failedSwitchRes = await syncer.syncNow()
    expect(failedSwitchRes.ok).toBe(false)
    expect(failedSwitchRes.pulled).toBe(1)
    expect(domain.issues.get('ISS-sw-1')?.humanStatus).toBe('已解决')
    expect(domain.issues.get('ISS-sw-1')?.bitableTableKey).toBe('appSwitch:tblB')
    expect(domain.issues.get('ISS-sw-1')?.syncDirty).toBe(true)

    const switchRes = await syncer.syncNow()
    expect(switchRes).toEqual({ ok: true, pulled: 0, pushed: 2, created: 1, updated: 1 })
    const tblB = bitable.getTable('appSwitch', 'tblB')
    expect(tblB.records).toHaveLength(2)
    expect(tblB.records.find(r => r.recordId === 'rec_b_existing')?.fields['AI 诊断结论']).toBe('诊断1')
    expect(domain.issues.get('ISS-sw-1')?.syncDirty).toBe(false)
    expect(domain.issues.get('ISS-sw-1')?.bitableTableKey).toBe('appSwitch:tblB')
    expect(domain.issues.get('ISS-sw-2')?.bitableTableKey).toBe('appSwitch:tblB')
  })

  it('serves check & sync routes, auto-recovers on feishuBitable reconnect, and exposes StateWire.issues + runtime', async () => {
    const { dir, cleanup } = await tempDir('bitable-routes-')
    cleanups.push(cleanup)
    const repos = new FakeRepos(dir)
    const bitable = new FakeBitableService()
    bitable.putTable({
      baseToken: 'appMissingId',
      tableId: 'tblBad',
      tableName: '缺主键表',
      fields: [{ fieldId: 'fldX', name: '标题', type: 'text', properties: {} }],
      records: [],
    })
    bitable.putTable({
      baseToken: 'appGood',
      tableId: 'tblGood',
      tableName: '标准问题库',
      fields: makeFullIssueFields().map(field => field.name === '首次发现' ? { ...field, type: 'formula' } : field),
      records: [],
    })

    let providedBitable: FeishuBitableService | undefined
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
    let rejection: 401 | 403 | undefined
    const webServer: HostWebServer = {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    }
    const gate: HostRequestGate = { requestRejection: () => rejection }
    const ctx: HostContext = {
      tools: { register: () => () => {} },
      skills: { registerProvider: () => () => {} },
      subagents: { getProvider: () => ({}), resolveMaxDepth: () => 1, startActivation: () => Promise.reject(new Error('unused')) },
      get: (name: string) => {
        if (name === DSH_REPOS_SERVICE) return repos
        if (name === FEISHU_BITABLE_SERVICE) return providedBitable
        if (name === 'webServer') return webServer
        if (name === 'connection') return gate
        return undefined
      },
      on: () => () => {},
      effect: cb => {
        const clean = cb()
        return () => { void clean?.() }
      },
    }

    const config = resolveConfig({ subagentProvider: 'custom-provider', autoInvoke: false })
    const bundled = loadBundledSkills(new URL('../skills/', import.meta.url))
    const service = new SupervisorService(
      ctx,
      config,
      new OverlayStore(join(dir, 'settings.json')),
      { bundled },
      {
        supervisorDir: join(dir, 'supervisor'),
        autoMrPollTimer: false,
        autoLogPollTimer: false,
        autoIssueSyncTimer: false,
        issueSyncDebounceMs: 10,
      },
    )
    registerSettingsRoutes(webServer, gate, service)
    await service.boot()
    cleanups.push(() => service.shutdown())

    const server: Server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
      const handler = routes.get(pathname)
      if (handler === undefined) {
        res.statusCode = 404
        res.end()
        return
      }
      void handler(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    // Initial state while feishuBitable is missing.
    const initial = await (await fetch(`${base}${STATE_ROUTE}`)).json() as StateWire
    expect(initial.issues?.bitableAvailable).toBe('missing')
    expect(initial.runtime).toEqual({
      platformSecretRef: 'SUPERVISOR_PLATFORM_CLIENT_SECRET',
      subagentProvider: 'custom-provider',
      refreshWaitMs: 15000,
      autoInvoke: false,
    })

    // Add a local issue via IssueMemory before feishuBitable appears.
    await service.logSupervisorInstance()!.toolsRuntime().issueMemory().upsertNewOrReuseByTitle({
      appId: 'auth',
      title: 'Token 签名失效',
      matchCriteria: 'ERR_SIG',
      aiDiagnosis: '密钥轮换未同步',
      aiStatus: 'pending',
      resolutionAdvice: '刷新公钥缓存',
      seenAt: Date.now(),
    })

    // Register FeishuBitableService, initially disconnected.
    bitable.connected = false
    providedBitable = bitable
    await service.bitableAvailable()

    const saveRes = await fetch(`${base}${SETTINGS_ROUTE}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...initial.settings,
        issueSync: {
          enabled: true,
          bitableUrl: 'https://mi.feishu.cn/base/appGood?table=tblGood',
          table: 'tblMissing',
          syncIntervalMs: 60_000,
        },
      }),
    })
    expect(saveRes.status).toBe(200)

    // Manual sync while disconnected fails cleanly with 400.
    const offlineSync = await fetch(`${base}${ISSUE_SYNC_ROUTE}`, { method: 'POST', body: '' })
    expect(offlineSync.status).toBe(400)
    expect(((await offlineSync.json()) as { error: string }).error).toMatch(/尚未连接/)

    // Reconnect triggers onChange -> auto-recovery schedules sync, and manual check works cleanly.
    bitable.connected = true
    const badCheckRes = await fetch(`${base}${ISSUE_CHECK_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bitableUrl: 'https://mi.feishu.cn/base/appMissingId', table: '' }),
    })
    expect(badCheckRes.status).toBe(200)
    const badCheckState = ((await badCheckRes.json()) as { ok: true; state: StateWire }).state
    expect(badCheckState.issues?.lastCheck?.ok).toBe(false)
    expect(badCheckState.issues?.lastCheck?.missingRequired).toEqual(['问题ID'])

    // Passing explicit empty table overrides saved `table: 'tblMissing'` when checking draft configuration.
    const clearedTableCheckRes = await fetch(`${base}${ISSUE_CHECK_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bitableUrl: 'https://mi.feishu.cn/base/appGood?table=tblGood', table: '' }),
    })
    expect(clearedTableCheckRes.status).toBe(200)
    const clearedTableState = ((await clearedTableCheckRes.json()) as { ok: true; state: StateWire }).state
    expect(clearedTableState.issues?.lastCheck?.ok).toBe(true)
    expect(clearedTableState.issues?.lastCheck?.resolvedTableId).toBe('tblGood')

    const clearSavedTableRes = await fetch(`${base}${SETTINGS_ROUTE}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...initial.settings,
        issueSync: {
          enabled: true,
          bitableUrl: 'https://mi.feishu.cn/base/appGood',
          syncIntervalMs: 60_000,
        },
      }),
    })
    expect(clearSavedTableRes.status).toBe(200)

    const goodCheckRes = await fetch(`${base}${ISSUE_CHECK_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(goodCheckRes.status).toBe(200)
    const goodCheckState = ((await goodCheckRes.json()) as { ok: true; state: StateWire }).state
    expect(goodCheckState.issues?.lastCheck?.ok).toBe(true)
    expect(goodCheckState.issues?.lastCheck?.resolvedTableId).toBe('tblGood')
    expect(goodCheckState.issues?.lastCheck?.warnings[0]).toMatch(/首次发现/)

    // Auth & cross-origin guard on sync route.
    rejection = 401
    expect((await fetch(`${base}${ISSUE_SYNC_ROUTE}`, { method: 'POST' })).status).toBe(401)
    rejection = undefined
    expect((await fetch(`${base}${ISSUE_SYNC_ROUTE}`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403)

    // Authenticated same-origin manual sync succeeds and skips readonly formula field without error.
    const onlineSync = await fetch(`${base}${ISSUE_SYNC_ROUTE}`, { method: 'POST' })
    expect(onlineSync.status).toBe(200)
    const syncedState = ((await onlineSync.json()) as { ok: true; state: StateWire }).state
    expect(syncedState.issues?.totalCount).toBe(1)
    expect(syncedState.issues?.linkedCount).toBe(1)
    expect(syncedState.issues?.dirtyCount).toBe(0)
    expect(bitable.getTable('appGood', 'tblGood').records[0]!.fields).not.toHaveProperty('首次发现')

    // Verify onChange auto-recovery on service reconnection pushes dirty record automatically.
    await service.logSupervisorInstance()!.toolsRuntime().issueMemory().upsertNewOrReuseByTitle({
      appId: 'auth',
      title: '第二条问题',
      matchCriteria: 'ERR_2',
      aiDiagnosis: '诊断2',
      aiStatus: 'pending',
      resolutionAdvice: '建议2',
      seenAt: Date.now(),
    })
    bitable.triggerChange()
    await vi.waitFor(() => {
      expect(bitable.getTable('appGood', 'tblGood').records).toHaveLength(2)
    }, { timeout: 2000 })
  })
})
