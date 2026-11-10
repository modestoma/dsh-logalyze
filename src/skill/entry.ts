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
import { DISPATCH_TOOL_NAME, IMPROVE_TOOL_NAME, INIT_REPO_TOOL_NAME, SHOW_TOOL_NAME } from '../tool-names.ts'

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
 * @param pending - writable repositories whose description or SKILL is missing or invalid, which can be drafted.
 * @returns the table, or a notice when none is usable.
 */
export function renderCatalog(apps: readonly AppManifest[], pending: readonly string[] = []): string {
  if (apps.length === 0 && pending.length > 0) {
    return `当前没有可用的应用，不要自行分析日志。这些应用仓库已经添加，但还缺少应用描述或日志分析 SKILL：${pending.map(url => `\`${url}\``).join('、')}。告诉用户可以先起草接入；用户同意后用 \`${INIT_REPO_TOOL_NAME}\` 起草（可以附上用户给的样例日志），否则结束本次回复。`
  }
  if (apps.length === 0) {
    return '当前没有可用的应用，不要自行分析日志。告诉用户：应用的代码仓库要由管理员在 dsh-repo 的「代码仓库 → 仓库」中添加，并打开「日志分析」；然后结束本次回复。'
  }
  const rows = apps.map(app => `| \`${app.id}\` | ${cell(app.name)} | ${cell(app.description)} | ${cell(app.aliases.join('、') || '—')} | ${cell(app.logHints.map(hint => `\`${hint}\``).join(' ') || '—')} |`)
  return ['| 应用 id | 名称 | 描述 | 别名 | 日志特征 |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

function improveStep(): string {
  return `
5. **SKILL 改进。** 改进由 \`${IMPROVE_TOOL_NAME}\` 完成：改进子 Agent 修改 SKILL（需要时把问题整理为案例写入 SKILL 的 \`cases/\` 目录），观象推送到新分支并创建合并请求，整个过程需要几分钟。只在用户于对话中明确同意后调用；推送前可能还会弹出审批请用户再批准一次，用户在那里拒绝时如实说明没有提交。仓库为只读的应用不能改进（工具会拒绝并说明原因）。SKILL 改进一律通过这个工具，不要自己修改或推送 SKILL 文件。
   - **先给结论，改进放到下一回合。** 派发结果中某个应用标出「SKILL 不足」时，照常写完汇总回复，在末尾另起一节「SKILL 改进建议」：每个这样的应用用一两句说明子 Agent 认为 SKILL 哪里不足、建议怎么改，然后问用户是否改进，结束本回合。这一回合不要调用工具（工具会拒绝）。
   - **用户同意后，每个应用调用一次。** 用户在之后的消息里同意时，为每个要改的应用调用一次工具，传 \`app\`；工具会自动带上本会话中该应用记录了不足、还没改进过的全部分析，所以同一应用的多个改进点只调用一次。用户同时补充了纠正或要求时写进 \`feedback\`。用户只同意其中一部分应用时，只为这些应用调用。
   - **用户主动纠正 SKILL 时**（不论本会话是否分析过）：先用 \`${SHOW_TOOL_NAME}\` 查看现有 SKILL 的相关内容，和用户确认哪部分不对、正确的做法是什么、有没有样例日志；信息不足时追问，一次只问最关键的一两点。问清并且用户同意改进后调用工具：传 \`app\` 和 \`feedback\`（用户的纠正，尽量保留原话）；纠正针对的是某次没有标出不足的分析时，把那次的运行目录放进 \`workDirs\`；用户给了日志时放进 \`logs\`。
   - 工具返回后，列出改动的文件和每处改动的要点（取自结果），附上合并请求链接，请用户在合并请求中评审。改进失败时如实说明原因；用户要求重试时再调用一次，把要重试的分析运行目录放进 \`workDirs\`。
`
}

/**
 * The entry skill body.
 * @param apps - usable applications at load time.
 * @param maxAppsPerRequest - dispatch task ceiling.
 * @param skillUpdates - whether SKILL improvement is enabled.
 * @param pending - writable repositories that can be drafted, named while no application is usable.
 * @returns Markdown instructions.
 */
export function renderEntrySkill(apps: readonly AppManifest[], maxAppsPerRequest: number, skillUpdates: boolean, pending: readonly string[] = []): string {
  return `# 观象：日志分析入口

观其象，知其因。没有 \`${DISPATCH_TOOL_NAME}\` 工具可用时（例如你是子 Agent），忽略本 SKILL，按普通方式完成任务。

你负责「意图识别 + 派发 + 汇总」：判断每份日志属于哪个应用，用 \`${DISPATCH_TOOL_NAME}\` 交给在该应用代码仓库里工作的子 Agent 分析，再把各应用的结论汇总给用户。你自己不做逐行日志分析。

## 应用目录

${renderCatalog(apps, pending)}

## 步骤

1. **读需求。** 从 \`/logalyze\` 之后的文字、消息附带的附件、消息里的下载 URL 中找出：要分析的现象、时间范围、关键标识（用户 id、订单号、请求 id 等）、日志位置。
2. **确定应用。** 拆分单位是「日志来源 → 应用」。
   - 用户或调用方已经写明应用 id 时直接使用；该 id 不在上表中时，告诉用户这个应用未注册（列出可用的应用 id），然后结束，不要改用别的应用。要接入新应用，请管理员在「代码仓库 → 仓库」中添加它的仓库并打开「日志分析」。
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
  /** Writable repositories whose description or SKILL can be drafted. */
  setupPending(): readonly string[]
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
          return { ...summary(), content: renderEntrySkill(source.apps(), source.maxAppsPerRequest(), source.skillUpdates(), source.setupPending()) }
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
