/**
 * 一批日志的核对：按请求里的 `logIds` 对照日志平台返回的元数据，确认每份
 * 日志都能下载，整批属于同一应用、同一错误码，并把 `component_code` 对应到
 * 应用目录里唯一的应用（应用 id 或别名逐字相等）。核对不通过时给出可读原因，
 * 接口以 422 拒绝，不发卡片。
 *
 * @module dsh-logalyze/analyze/batch
 */

import type { PlatformLog } from '../platform/client.ts'
import type { AppManifest } from '../settings/contract.ts'

/** A batch that passed every check, with its logs in request order. */
export interface ResolvedBatch {
  readonly app: AppManifest
  readonly componentCode: string
  /** The batch's error code; null when the platform has none for any of the logs. */
  readonly errorCode: string | null
  readonly logs: readonly PlatformLog[]
}

/** A log that cannot be analyzed, and why. */
export interface InvalidLog {
  readonly logId: string
  readonly reason: string
}

/** Outcome of {@link resolveBatch}. */
export type BatchResolution =
  | { readonly ok: true; readonly value: ResolvedBatch }
  | { readonly ok: false; readonly error: string; readonly invalidLogs?: readonly InvalidLog[] }

/**
 * Values of one field across the batch, grouped with the logs that carry each.
 * @param logs - the batch.
 * @param field - the field to group by.
 * @returns readable groups, such as `a（2 份）、b（1 份）`.
 */
function groups(logs: readonly PlatformLog[], field: 'component_code' | 'error_code'): string {
  const counts = new Map<string, number>()
  for (const log of logs) {
    const value = log[field] ?? '（空）'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].map(([value, count]) => `${value}（${count} 份）`).join('、')
}

/**
 * Check one batch.
 * @param logIds - the request's log ids, lowercase and unique.
 * @param found - what the platform returned for them.
 * @param apps - usable applications of the catalog.
 * @returns the resolved batch, or why the request is refused.
 */
export function resolveBatch(logIds: readonly string[], found: readonly PlatformLog[], apps: readonly AppManifest[]): BatchResolution {
  const byId = new Map(found.map(log => [log.log_id.toLowerCase(), log]))
  const invalid: InvalidLog[] = []
  const logs: PlatformLog[] = []
  for (const logId of logIds) {
    const log = byId.get(logId)
    if (log === undefined) {
      invalid.push({ logId, reason: '日志平台没有这份日志，或观象的客户端无权查看' })
      continue
    }
    if (log.storage_type !== 'fds' || log.status !== 'completed') {
      invalid.push({ logId, reason: `日志还不能下载（storage_type=${log.storage_type}，status=${log.status}）：只支持已归档完成的对象存储日志` })
      continue
    }
    if (log.component_code === null || log.component_code === '') {
      invalid.push({ logId, reason: '日志没有 component_code，无法确定应用' })
      continue
    }
    logs.push(log)
  }
  if (invalid.length > 0) {
    return { ok: false, error: `有 ${invalid.length} 份日志不能分析：${invalid.map(item => `${item.logId}（${item.reason}）`).join('；')}`, invalidLogs: invalid }
  }
  const first = logs[0]
  if (first === undefined) return { ok: false, error: '没有可分析的日志' }
  const componentCode = first.component_code ?? ''
  if (logs.some(log => log.component_code !== componentCode)) {
    return { ok: false, error: `这批日志的 component_code 不一致：${groups(logs, 'component_code')}；一次请求只能分析同一应用的日志` }
  }
  if (logs.some(log => log.error_code !== first.error_code)) {
    return { ok: false, error: `这批日志的 error_code 不一致：${groups(logs, 'error_code')}；一次请求只能分析同一错误码的日志` }
  }
  const matches = apps.filter(app => app.id === componentCode || app.aliases.includes(componentCode))
  if (matches.length === 0) {
    return { ok: false, error: `component_code ${componentCode} 没有对应的应用：请在该应用仓库 .agents/logalyze.yaml 的 aliases 里加上它（应用的仓库也要在 dsh-repo 中打开「日志分析」并同步完成）` }
  }
  if (matches.length > 1) {
    return { ok: false, error: `component_code ${componentCode} 同时对应多个应用（${matches.map(app => app.id).join('、')}）：请只在一个应用的 id 或 aliases 里保留它` }
  }
  const [app] = matches
  if (app === undefined) return { ok: false, error: `component_code ${componentCode} 没有对应的应用` }
  return { ok: true, value: { app, componentCode, errorCode: first.error_code, logs } }
}
