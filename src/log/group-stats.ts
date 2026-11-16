/**
 * Same-group history of a platform log batch: how many archived logs share the
 * batch's `(product_code, component_code, error_code)` within a time window,
 * their software/component version distribution, and when they were first and
 * last archived. Reads metadata only; never returns download links.
 *
 * @module dsh-supervisor/log/group-stats
 */

import type { ListLogsPageParams, PlatformLog, PlatformLogPage } from '../platform/client.ts'

/** Pages read per query; at 100 logs a page this scans up to 1000 logs. */
export const GROUP_STATS_MAX_PAGES = 10

/** Versions listed per distribution; the rest are summed under `otherCount`. */
export const GROUP_STATS_TOP_VERSIONS = 10

/** The batch key a query matches. An undefined code matches logs whose code is empty. */
export interface LogGroup {
  readonly productCode?: string
  readonly componentCode: string
  readonly errorCode?: string
}

/** One version and how many matched logs carry it; `null` stands for an empty version. */
export interface VersionCount {
  readonly value: string | null
  readonly count: number
}

/** Version distribution of the matched logs, most frequent first. */
export interface VersionDistribution {
  readonly top: readonly VersionCount[]
  /** Matched logs whose version is outside `top`. */
  readonly otherCount: number
}

/** Result of {@link collectGroupStats}. */
export interface LogGroupStats {
  readonly group: { readonly productCode: string | null; readonly componentCode: string; readonly errorCode: string | null }
  readonly window: { readonly archivedFrom: string; readonly archivedTo: string }
  /** Matched archived logs; a lower bound when `truncated`. */
  readonly count: number
  /** True when the scan stopped at {@link GROUP_STATS_MAX_PAGES} with more pages left. */
  readonly truncated: boolean
  readonly firstArchivedAt: string | null
  readonly lastArchivedAt: string | null
  readonly swVersions: VersionDistribution
  readonly componentVersions: VersionDistribution
}

function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? null : trimmed
}

function distribution(values: readonly (string | null)[]): VersionDistribution {
  const counts = new Map<string | null, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const sorted = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
  const top = sorted.slice(0, GROUP_STATS_TOP_VERSIONS)
  return { top, otherCount: sorted.slice(GROUP_STATS_TOP_VERSIONS).reduce((sum, entry) => sum + entry.count, 0) }
}

/**
 * Query the platform for archived, completed logs of one group in
 * `[archivedFrom, archivedTo)`. Codes the group carries are sent as exact
 * filters; a missing code cannot be expressed as a platform filter, so it is
 * matched here against logs whose code is empty.
 * @param group - the batch key.
 * @param window - ISO archive-time bounds, `archivedFrom` before `archivedTo`.
 * @param listPage - reads one `GET /open-api/v1/logs` page.
 * @returns counts, version distributions, and first/last archive times.
 * @throws whatever `listPage` throws.
 */
export async function collectGroupStats(
  group: LogGroup,
  window: { readonly archivedFrom: string; readonly archivedTo: string },
  listPage: (params: ListLogsPageParams) => Promise<PlatformLogPage>,
): Promise<LogGroupStats> {
  const matched: PlatformLog[] = []
  let cursor: string | undefined
  let truncated = false
  for (let page = 0; ; page += 1) {
    if (page === GROUP_STATS_MAX_PAGES) {
      truncated = true
      break
    }
    const result = await listPage({
      archivedFrom: window.archivedFrom,
      archivedTo: window.archivedTo,
      status: 'completed',
      componentCode: group.componentCode,
      ...(group.productCode === undefined ? {} : { productCode: group.productCode }),
      ...(group.errorCode === undefined ? {} : { errorCode: group.errorCode }),
      ...(cursor === undefined ? {} : { cursor }),
    })
    for (const item of result.items) {
      if (item.archived_at === null) continue
      if (group.productCode === undefined && blankToNull(item.product_code) !== null) continue
      if (group.errorCode === undefined && blankToNull(item.error_code) !== null) continue
      matched.push(item)
    }
    cursor = result.nextCursor
    if (cursor === undefined) break
  }
  const archived = matched
    .map(item => ({ iso: item.archived_at!, ms: Date.parse(item.archived_at!) }))
    .filter(entry => !Number.isNaN(entry.ms))
    .sort((a, b) => a.ms - b.ms)
  return {
    group: { productCode: group.productCode ?? null, componentCode: group.componentCode, errorCode: group.errorCode ?? null },
    window: { archivedFrom: window.archivedFrom, archivedTo: window.archivedTo },
    count: matched.length,
    truncated,
    firstArchivedAt: archived[0]?.iso ?? null,
    lastArchivedAt: archived.at(-1)?.iso ?? null,
    swVersions: distribution(matched.map(item => blankToNull(item.sw_version))),
    componentVersions: distribution(matched.map(item => blankToNull(item.component_version))),
  }
}
