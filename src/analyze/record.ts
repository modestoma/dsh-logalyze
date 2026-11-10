/**
 * 被接受的分析请求到分析记录的转换：日志按请求顺序编号 L1…Ln，保存首轮
 * 消息、根卡片和报告用到的日志平台元数据。
 *
 * @module dsh-logalyze/analyze/record
 */

import { analysisIdOf } from '../report/store.ts'
import type { AnalysisRecord } from '../report/store.ts'
import type { ResolvedBatch } from './batch.ts'
import type { AnalyzeRequest } from './contract.ts'

/**
 * A new analysis record.
 * @param request - the validated request.
 * @param key - its `Idempotency-Key`.
 * @param fingerprint - its fingerprint.
 * @param batch - the checked batch.
 * @param now - acceptance time, epoch milliseconds.
 * @returns the record, with nothing recorded or uploaded yet.
 */
export function newAnalysisRecord(request: AnalyzeRequest, key: string, fingerprint: string, batch: ResolvedBatch, now: number): AnalysisRecord {
  return {
    id: analysisIdOf(key),
    key,
    fingerprint,
    triggerType: request.triggerType,
    triggerId: request.triggerId,
    triggeredAt: request.triggeredAt,
    chatId: request.chatId,
    ...request.instructions === undefined ? {} : { instructions: request.instructions },
    app: batch.app.id,
    appName: batch.app.name,
    componentCode: batch.componentCode,
    errorCode: batch.errorCode,
    logs: batch.logs.map((log, index) => ({
      ref: `L${index + 1}`,
      logId: log.log_id.toLowerCase(),
      fileName: log.file_name,
      productSn: log.product_sn,
      hwVersion: log.hw_version,
      swVersion: log.sw_version,
      componentVersion: log.component_version,
      logType: log.log_type,
      sizeBytes: log.file_size_bytes,
      createdAt: log.created_at,
      ...log.detail_url === null || log.detail_url.length > 2048 || !/^https?:\/\//iu.test(log.detail_url) ? {} : { detailUrl: log.detail_url },
      uploadedRevision: 0,
      generation: 0,
    })),
    acceptedAt: now,
    sections: [],
    turns: {},
    snapshot: {},
    warnings: [],
    skipped: [],
    revision: 0,
  }
}
