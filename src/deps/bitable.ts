import type {
  FeishuBitableService,
  FeishuBitableServiceName,
  FeishuBitableVersion,
} from './bitable-contract.ts'

export const FEISHU_BITABLE_SERVICE: FeishuBitableServiceName = 'feishuBitable'
export const FEISHU_BITABLE_VERSION: FeishuBitableVersion = 1
export const BITABLE_BATCH_MAX_RECORDS = 200

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,64}$/u

export type ParsedBitableTarget =
  | { readonly kind: 'base'; readonly token: string; readonly table?: string }
  | { readonly kind: 'wiki'; readonly token: string; readonly table?: string }

/** Parse a Feishu Base (`/base/...` or `/bitable/...`) or Wiki (`/wiki/...`) URL. */
export function parseBitableUrl(rawUrl: string, explicitTable?: string): ParsedBitableTarget | undefined {
  const trimmed = rawUrl.trim()
  if (trimmed === '' || trimmed.length > 2048) return undefined
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:') return undefined
  const segments = parsed.pathname.split('/').filter(segment => segment !== '')
  const explicit = explicitTable?.trim()
  const queryTable = parsed.searchParams.get('table')?.trim()
  const table = explicit !== undefined && explicit !== ''
    ? explicit
    : (queryTable !== undefined && queryTable !== '' ? queryTable : undefined)
  if (table !== undefined && table.length > 200) return undefined

  if (segments.length === 2 && (segments[0] === 'base' || segments[0] === 'bitable') && TOKEN_PATTERN.test(segments[1]!)) {
    return {
      kind: 'base',
      token: segments[1]!,
      ...(table === undefined ? {} : { table }),
    }
  }
  if (segments.length === 2 && segments[0] === 'wiki' && segments[1] !== 'space' && TOKEN_PATTERN.test(segments[1]!)) {
    return {
      kind: 'wiki',
      token: segments[1]!,
      ...(table === undefined ? {} : { table }),
    }
  }
  return undefined
}

export type LookupBitableResult =
  | { readonly status: 'missing' }
  | { readonly status: 'incompatible'; readonly detail: string }
  | { readonly status: 'ready'; readonly service: FeishuBitableService }

const REQUIRED_METHODS = ['inspectTable', 'listRecords', 'createRecords', 'updateRecords'] as const

/** Validate the Cordis-registered `feishuBitable` host service against contract v1. */
export function lookupBitable(raw: unknown): LookupBitableResult {
  if (raw === undefined || raw === null) {
    return { status: 'missing' }
  }
  if (typeof raw !== 'object') {
    return { status: 'incompatible', detail: `服务 "${FEISHU_BITABLE_SERVICE}" 不是对象` }
  }
  const candidate = raw as Partial<Record<string, unknown>>
  if (candidate.version !== FEISHU_BITABLE_VERSION) {
    return {
      status: 'incompatible',
      detail: `服务 "${FEISHU_BITABLE_SERVICE}" 版本不兼容（期望 ${FEISHU_BITABLE_VERSION}，实际 ${String(candidate.version)}）`,
    }
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof candidate[method] !== 'function') {
      return {
        status: 'incompatible',
        detail: `服务 "${FEISHU_BITABLE_SERVICE}" 缺少方法 ${method}`,
      }
    }
  }
  return { status: 'ready', service: raw as FeishuBitableService }
}
