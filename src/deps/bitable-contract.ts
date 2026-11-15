/**
 * Narrow structural contract of `feishuBitable` v1 exposed by `@dsh/channels`.
 * Keeping a local mirror preserves zero package coupling between plugins while
 * validating version and required methods at runtime.
 */

export type FeishuBitableServiceName = 'feishuBitable'

export type FeishuBitableVersion = 1

export interface BitableTargetInput {
  readonly url: string
  readonly table?: string
}

export type BitableFailureCode =
  | 'invalid-target'
  | 'not-connected'
  | 'ambiguous-table'
  | 'table-not-found'
  | 'permission-denied'
  | 'not-found'
  | 'rate-limited'
  | 'api-error'

export type BitableResult<T> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly code: BitableFailureCode; readonly message: string }

export interface BitableFieldInfo {
  readonly fieldId: string
  readonly name: string
  readonly type: string
  readonly properties: Readonly<Record<string, unknown>>
}

export interface BitableTableSchema {
  readonly baseToken: string
  readonly tableId: string
  readonly tableName: string
  readonly fields: readonly BitableFieldInfo[]
}

export interface BitableRecord {
  readonly recordId: string
  readonly fields: Readonly<Record<string, unknown>>
}

export interface BitableListRecordsInput extends BitableTargetInput {
  readonly fields?: readonly string[]
  readonly filter?: object
  readonly sort?: readonly object[]
  readonly viewId?: string
  readonly offset?: number
  readonly limit?: number
}

export interface BitableRecordPage {
  readonly baseToken: string
  readonly tableId: string
  readonly records: readonly BitableRecord[]
  readonly hasMore: boolean
  readonly nextOffset?: number
  readonly rev?: number
  readonly ignoredFields: readonly string[]
}

export interface BitableCreateRecordsInput extends BitableTargetInput {
  readonly records: ReadonlyArray<Readonly<Record<string, unknown>>>
}

export interface BitableUpdateRecordsInput extends BitableTargetInput {
  readonly updates: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface FeishuBitableService {
  readonly version: FeishuBitableVersion
  inspectTable(target: BitableTargetInput): Promise<BitableResult<BitableTableSchema>>
  listRecords(input: BitableListRecordsInput): Promise<BitableResult<BitableRecordPage>>
  createRecords(input: BitableCreateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly recordIds: readonly string[] }>>
  updateRecords(input: BitableUpdateRecordsInput): Promise<BitableResult<{ readonly baseToken: string; readonly tableId: string; readonly ignoredFields: readonly string[] }>>
  onChange?(listener: () => void): () => void
}
