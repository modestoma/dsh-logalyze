/**
 * `/logalyze` 入口 SKILL：用户可以显式调用；开启自动加载且有可用应用时，
 * 顶层 Agent 也能在任务匹配时自行加载。目录描述列出已就绪的应用，正文中的
 * 应用目录在每次加载时由已就绪仓库的应用描述生成。
 *
 * @module dsh-logalyze/skill/entry
 */

import type { SkillDefinition, SkillProvider, SkillProviderControl } from '../host.ts'
import type { AppManifest } from '../settings/contract.ts'
import type { BundledSkill } from './bundled.ts'
import { DISPATCH_TOOL_NAME } from '../dispatch/tool.ts'
import { ADD_REPO_TOOL_NAME } from '../onboard/names.ts'
import { IMPROVE_TOOL_NAME, SHOW_TOOL_NAME } from '../skill-update/names.ts'

/** Entry skill name, addressed as `/logalyze`. */
export const ENTRY_SKILL_NAME = 'logalyze'

/** Skill provider name in `ctx.skills`. */
export const SKILL_PROVIDER_NAME = 'dsh-logalyze'

/** DSH's precedence rank for packaged skill providers (`BUNDLED_SKILL_RANK`). */
export const BUNDLED_SKILL_RANK = 600

/** Character budget of the catalog description, DSH's default `catalogDescriptionMaxLength`. */
export const DESCRIPTION_MAX_CHARS = 500

const MANUAL_DESCRIPTION = '观象日志分析入口：识别日志属于哪个应用，并派发给在该应用代码仓库中工作的子 Agent 分析根因。'
const AUTO_DESCRIPTION_HEAD = '观象日志分析：识别日志属于哪个已注册应用，派发给在该应用代码仓库中工作的子 Agent 分析报错、定位根因。用户要分析或排查以下应用的日志、报错时使用：'
const AUTO_DESCRIPTION_TAIL = '。日志与这些应用无关时不要使用。'

/**
 * Catalog description for model loading: what the skill does and every
 * usable application with its id, aliases, and log hints, within
 * {@link DESCRIPTION_MAX_CHARS}. Applications that do not fit are counted.
 * @param apps - usable applications.
 * @returns the description.
 */
export function describeApps(apps: readonly AppManifest[]): string {
  const items = apps.map(app => `${app.name}（${[app.id, ...app.aliases, ...app.logHints].join('、')}）`)
  for (let shown = items.length; shown > 0; shown -= 1) {
    const rest = items.length - shown
    const list = items.slice(0, shown).join('；') + (rest === 0 ? '' : `；另有 ${rest} 个应用`)
    const text = `${AUTO_DESCRIPTION_HEAD}${list}${AUTO_DESCRIPTION_TAIL}`
    if (text.length <= DESCRIPTION_MAX_CHARS) return text
  }
  return `${AUTO_DESCRIPTION_HEAD}${apps.length} 个应用${AUTO_DESCRIPTION_TAIL}`
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/**
 * Render the application catalog as a Markdown table.
 * @param apps - usable applications.
 * @returns the table, or a notice when none is usable.
 */
export function renderCatalog(apps: readonly AppManifest[]): string {
  if (apps.length === 0) {
    return `当前没有可用的应用，不要自行分析日志。用户给出了应用代码仓库的 https 地址时，用 \`${ADD_REPO_TOOL_NAME}\` 添加并按工具结果继续；否则请用户提供仓库的 https 地址（不支持 ssh 地址），或在 DSH Web 左侧栏「观象」面板的「应用仓库」中添加，然后结束本次回复。`
  }
  const rows = apps.map(app => `| \`${app.id}\` | ${cell(app.name)} | ${cell(app.description)} | ${cell(app.aliases.join('、') || '—')} | ${cell(app.logHints.map(hint => `\`${hint}\``).join(' ') || '—')} |`)
  return ['| 应用 id | 名称 | 描述 | 别名 | 日志特征 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

function improveStep(): string {
  return `
5. **SKILL 改进。** 改进由 \`${IMPROVE_TOOL_NAME}\` 完成：工具先询问用户是否改进；用户同意后，改进子 Agent 修改 SKILL（需要时把问题整理为案例写入 SKILL 的 \`cases/\` 目录），观象推送到新分支并创建合并请求，整个过程需要几分钟。SKILL 改进一律通过这个工具，不要自己修改或推送 SKILL 文件。
   - 派发结果中某个应用标出「SKILL 不足」时：先照常写完汇总回复，在末尾另起一节「SKILL 改进」，用一两句话说明子 Agent 认为 SKILL 哪里不足，然后对每个这样的应用调用一次工具（\`workDir\` 取结果中给出的运行目录）。
   - 用户指出 SKILL 的记录有误、要求纠正或改进某个应用的 SKILL 时（不论本会话是否分析过）：先用 \`${SHOW_TOOL_NAME}\` 查看现有 SKILL 的相关内容，和用户确认哪部分不对、正确的做法是什么、有没有样例日志；信息不足时追问，一次只问最关键的一两点。问清后调用工具：刚分析过该应用时传那次的 \`workDir\`，否则传 \`app\`；\`feedback\` 写用户的纠正，尽量保留原话；用户给了日志时放进 \`logs\`。
   - 工具返回后，列出改动的文件和每处改动的要点（取自结果），附上合并请求链接，请用户在合并请求中评审。用户拒绝或无法询问时，一句话说明即可；改进失败时如实说明原因。
`
}

/**
 * The entry skill body.
 * @param apps - usable applications at load time.
 * @param maxAppsPerRequest - dispatch task ceiling.
 * @param skillUpdates - whether SKILL improvement is enabled.
 * @returns Markdown instructions.
 */
export function renderEntrySkill(apps: readonly AppManifest[], maxAppsPerRequest: number, skillUpdates: boolean): string {
  return `# 观象：日志分析入口

观其象，知其因。没有 \`${DISPATCH_TOOL_NAME}\` 工具可用时（例如你是子 Agent），忽略本 SKILL，按普通方式完成任务。

你负责「意图识别 + 派发 + 汇总」：判断每份日志属于哪个应用，用 \`${DISPATCH_TOOL_NAME}\` 交给在该应用代码仓库里工作的子 Agent 分析，再把各应用的结论汇总给用户。你自己不做逐行日志分析。

## 应用目录

${renderCatalog(apps)}

## 步骤

1. **读需求。** 从 \`/logalyze\` 之后的文字、消息附带的附件、消息里的下载 URL 中找出：要分析的现象、时间范围、关键标识（用户 id、订单号、请求 id 等）、日志位置。
2. **确定应用。** 拆分单位是「日志来源 → 应用」。
   - 用户或调用方已经写明应用 id 时直接使用；该 id 不在上表中时，告诉用户这个应用未注册（列出可用的应用 id），然后结束，不要改用别的应用。用户给出了该应用的 git 地址时，可以用 \`${ADD_REPO_TOOL_NAME}\` 接入。
   - 否则按名称、别名、描述和日志特征匹配。只有附件文件名或内容能区分时，可以只看日志开头几十行来判断，不要通读或解压整个日志。
   - 用户没有输入 \`/logalyze\`、是你按任务匹配自行加载了本 SKILL，而日志明显不属于上表任何应用时，不要派发也不要追问，按普通方式完成用户的请求。
   - 其余无法确定或同时匹配多个应用的情况，用 \`ask_user_question\`（不可用时直接在回复中提问并结束）让用户选择，不要猜。
   - 一个文件混有多个应用的输出时，把同一路径分别交给各应用，并在 \`filter\` 里写明区分方式（tag、进程名等）。
3. **派发。** 一次调用 \`${DISPATCH_TOOL_NAME}\`，把所有任务放进 \`tasks\`（最多 ${maxAppsPerRequest} 个）：
   - \`app\`：上表中的应用 id。
   - \`question\`：给子 Agent 的完整问题。子 Agent 看不到本对话，要写清现象、时间、关键标识和用户的原话要点。
   - \`logs\`：每项是 \`{ "path": 绝对路径 }\`（附件、本机文件）或 \`{ "url": 下载地址 }\`（对象存储链接，由工具下载），可加 \`filter\`。
   - 没有任何日志时，先向用户要日志，不要派发。
   工具会等待全部子 Agent 结束后一次返回结果。工具报错（应用不可用、路径不存在、域名不在白名单等）时，把原因告诉用户，不要绕过。
4. **汇总回复。** 按下面的格式写最终回复：

\`\`\`
## 结论
一两句话说明根因或当前判断。

## <应用名>
- 结论：……
- 关键证据：日志原文片段（带时间戳）与对应代码位置
- 建议：……

## 推演
（涉及两个及以上应用时）按时间线关联各应用的事件，说明跨应用的因果关系与仍待验证的假设。
\`\`\`

   每个派发的应用都有一节。子 Agent 失败、超时或结论不充分时，在该节如实说明，不要编造结论。日志版本与仓库代码可能不一致，子 Agent 提示了版本差异时保留这条提示。

   用户之后要求修复分析发现的代码问题时，按普通编码任务处理：从派发结果中该应用的仓库地址和提交开始修改，不要在观象的运行目录或代码快照里改代码。
${skillUpdates ? improveStep() : ''}`
}

/** Inputs the provider reads at each listing and load. */
export interface EntrySkillSource {
  /**
   * Settles when the catalog may be rendered: after the first repository sync
   * since startup, then after the stale repositories were refreshed or the
   * refresh wait limit passed.
   * @param signal - load cancellation.
   * @throws the signal's reason when the load is cancelled.
   */
  prepare(signal: AbortSignal | undefined): Promise<void>
  /** Usable applications. */
  apps(): readonly AppManifest[]
  /** Current dispatch task ceiling. */
  maxAppsPerRequest(): number
  /** Whether SKILL improvement is enabled. */
  skillUpdates(): boolean
  /** Whether top-level agents may load the skill without `/logalyze`. */
  readonly autoInvoke: boolean
  /**
   * Whether a lookup directory lies where children work (the repository
   * mirrors or a run directory's workspace); the skill is not listed there.
   * @param cwd - lookup working directory.
   * @returns whether the directory belongs to the repositories.
   */
  inRepositories(cwd: string): boolean
  /** Bundled guide skills served from the same provider. */
  readonly bundled: readonly BundledSkill[]
}

/**
 * Build the skill provider serving `/logalyze` and the bundled guide skills.
 * The bundled skills are listed in every directory, including the snapshots
 * and workspaces children work in, where `/logalyze` is not listed.
 * @param source - live registry view and the bundled skills.
 * @returns a provider factory for `ctx.skills.registerProvider`, plus the
 *   hook to call after the usable applications may have changed; it
 *   invalidates the DSH catalog only when the listed entry changes.
 */
export function createEntrySkillProvider(source: EntrySkillSource): {
  factory: (control: SkillProviderControl) => SkillProvider
  invalidate: () => void
} {
  let control: SkillProviderControl | undefined
  let listed: string | undefined
  // Bundled skills are user-invoked (or loaded by a child's first line), never chosen by the model.
  const bundled = new Map(source.bundled.map(skill => [skill.name as string, {
    summary: {
      name: skill.name,
      description: skill.description,
      whenToUse: `仅在用户输入 /${skill.name} 时使用。`,
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'bundled',
      provider: SKILL_PROVIDER_NAME,
    } as const,
    content: skill.content,
  }]))
  const summary = () => {
    const apps = source.apps()
    const automatic = source.autoInvoke && apps.length > 0
    return {
      name: ENTRY_SKILL_NAME,
      description: automatic ? describeApps(apps) : MANUAL_DESCRIPTION,
      whenToUse: automatic ? '用户输入 /logalyze，或要分析、排查描述中所列应用的日志时使用。' : '仅在用户输入 /logalyze 时使用。',
      invocation: { modelInvocable: automatic, userInvocable: true },
      source: 'bundled',
      provider: SKILL_PROVIDER_NAME,
    } as const
  }
  return {
    factory: (registration) => {
      control = registration
      return {
        name: SKILL_PROVIDER_NAME,
        list: (options) => {
          const guides = [...bundled.values()].map(({ summary: guide }) => ({ ...guide, rank: BUNDLED_SKILL_RANK, locator: guide.name }))
          if (options.cwd !== undefined && source.inRepositories(options.cwd)) return Promise.resolve(guides)
          const current = summary()
          listed = JSON.stringify(current)
          return Promise.resolve([{ ...current, rank: BUNDLED_SKILL_RANK, locator: ENTRY_SKILL_NAME }, ...guides])
        },
        get: async (requested, options): Promise<SkillDefinition | undefined> => {
          const guide = bundled.get(requested.name)
          if (guide !== undefined) return { ...guide.summary, content: guide.content }
          if (requested.name !== ENTRY_SKILL_NAME) return undefined
          await source.prepare(options.signal)
          return { ...summary(), content: renderEntrySkill(source.apps(), source.maxAppsPerRequest(), source.skillUpdates()) }
        },
      }
    },
    invalidate: () => {
      if (control === undefined || control.signal.aborted) return
      if (listed !== undefined && JSON.stringify(summary()) === listed) return
      control.invalidate()
    },
  }
}
