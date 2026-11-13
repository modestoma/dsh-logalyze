/**
 * 飞书渠道插件 `feishuActions` 服务（contract version 1）的窄契约声明。
 *
 * 用于回合结束后的非阻塞持久化动作提议卡（如「🔧 修复代码并提 MR」「📚 改进 SKILL / 沉淀案例」），
 * 运行时通过 `ctx.get('feishuActions')` 按需发现，不直接依赖 `dsh_channels` 包。
 *
 * @module dsh-logalyze/deps/actions-contract
 */

/** Name the Feishu channel plugin provides the actions service under. */
export type FeishuActionsServiceName = 'feishuActions'

/** Contract version spoken by this plugin. */
export type FeishuActionsVersion = 1

/** Channel permission required when a user clicks an action button. */
export type ActionRequiredAccess = 'chat' | 'code-write' | 'wiki-write' | 'admin'

/** Visual style of an action button on the Feishu card. */
export type ActionButtonStyle = 'primary' | 'default'

/** One selectable button in a non-blocking action proposal card. */
export interface ProposedAction {
  /** Unique short identifier within this proposal (e.g. `'fix_code'` | `'improve_skill'`). */
  readonly id: string
  /** Button label shown on the card (1–32 chars). */
  readonly label: string
  /** Visual emphasis (`'primary'` highlights recommended action). */
  readonly style?: ActionButtonStyle
  /** Channel access level enforced before waking the session; defaults to `'chat'`. */
  readonly requiredAccess?: ActionRequiredAccess
  /** Self-contained follow-up instruction submitted into the session when clicked (1–8000 chars). */
  readonly followUpPrompt: string
  /** When `true`, clicking this button settles only itself instead of closing sibling actions. */
  readonly independent?: boolean
}

/** Model-facing / shared fields of an action proposal. */
export interface ProposeActionsInput {
  /** One-line guidance heading above the buttons (1–120 chars). */
  readonly prompt: string
  /** 1–4 selectable action buttons (the channel appends a neutral dismiss button automatically). */
  readonly actions: readonly ProposedAction[]
}

/** Plugin-side specification passed to {@link FeishuActionsService.propose}. */
export interface ActionProposalSpec extends ProposeActionsInput {
  /** Idempotency key (1–200 visible ASCII chars); replays return the original card. */
  readonly key: string
  /** Target DSH Session ID currently bound to a Feishu route. */
  readonly sessionId: string
}

/** Failure codes returned when an action proposal cannot be posted. */
export type ActionProposalFailureCode = 'invalid' | 'not-connected' | 'unrouted-session' | 'send-failed'

/** Outcome of {@link FeishuActionsService.propose}. */
export type ActionProposalPostResult =
  | { readonly ok: true; readonly replayed: boolean; readonly cardMessageId: string }
  | { readonly ok: false; readonly code: ActionProposalFailureCode; readonly message: string }

/** The `feishuActions` v1 service interface. */
export interface FeishuActionsService {
  readonly version: FeishuActionsVersion
  /** Post a persistent follow-up action proposal card in the Feishu topic bound to `spec.sessionId`. */
  propose(spec: ActionProposalSpec): Promise<ActionProposalPostResult>
  /** Mark a pending proposal identified by `key` as superseded when a newer analysis replaces it. */
  supersede(key: string, reason?: string): Promise<void>
}
