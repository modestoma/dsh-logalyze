/**
 * 接口分析话题根卡片的链接表：每份日志一行，链接到日志详情页，报告回传后
 * 第二列补「分析报告」。
 *
 * @module dsh-supervisor/report/links
 */

import type { TopicCardLinks } from '../deps/topics-contract.ts'
import type { AnalysisRecord } from './store.ts'

/** Longest row label the card accepts. */
const ROW_NAME_MAX = 200

/**
 * The root card's link table: one row per log, linking its platform page and,
 * once its first revision completed, its analysis page.
 * @param record - the analysis.
 * @returns the table.
 */
export function analysisCardLinks(record: AnalysisRecord): TopicCardLinks {
  return {
    nameHeader: '日志',
    linkHeader: '详情页',
    extraLinkHeader: '分析报告',
    rows: record.logs.map((log) => {
      const label = [log.ref, log.fileName, log.productSn].filter(part => part !== null && part !== '').join(' · ')
      return {
        name: label.length > ROW_NAME_MAX ? `${label.slice(0, ROW_NAME_MAX - 1)}…` : label,
        ...log.detailUrl === undefined ? {} : { url: log.detailUrl },
        ...log.reportUrl === undefined ? {} : { extraUrl: log.reportUrl },
      }
    }),
  }
}
