/**
 * The part of the Feishu channel plugin's `feishuTopics` service (contract version 3) this
 * plugin uses, declared here so the plugin does not depend on that plugin's
 * package. The plugin provides the service under `feishuTopics` and emits
 * {@link FEISHU_TOPICS_STATUS_EVENT}; both are looked up at run time.
 *
 * @module dsh-logalyze/deps/topics-contract
 */

/** The contract version this plugin speaks. Version 3 replaced `requesterUserId` with {@link TopicLaunchSpec.requester}; version 2 dropped the `workspace` parameter. */
export type FeishuTopicsVersion = 3

/** One run of the root card's lead sentence. */
export interface TopicCardText {
  /** Plain text; Markdown characters are shown literally. */
  readonly text: string
  /** Shown in bold. */
  readonly bold?: boolean
}

/** One row of the root card's link table. */
export interface TopicCardLink {
  readonly name: string
  /** `http(s)` address of the link column; without it the cell shows `—`. */
  readonly url?: string
  /** `http(s)` address of the second link column; without it the cell shows `—`. */
  readonly extraUrl?: string
}

/** The root card's link table (at most 50 rows). */
export interface TopicCardLinks {
  readonly nameHeader: string
  readonly linkHeader: string
  /** Header of the second link column, shown only when set. */
  readonly extraLinkHeader?: string
  readonly rows: readonly TopicCardLink[]
}

/** What the root card shows besides its status. */
export interface TopicRootCard {
  readonly title: string
  /** Word naming the work in the status texts (`分析` gives `分析中`). */
  readonly taskName: string
  /** Lead sentence, shown after the requester (an @-mention, or the external requester's text). */
  readonly lead: readonly TopicCardText[]
  readonly links?: TopicCardLinks
}

/** Who a launch is for. */
export type TopicRequester =
  /** A Feishu user: @-mentioned on the root card; the first turn is submitted with them as the speaker, so they need chat access in the channel. */
  | { readonly kind: 'feishu-user'; readonly userId: string }
  /** A requester without a Feishu account: `label` (1–200 characters, one line) is shown literally instead of a mention; no channel access check applies. */
  | { readonly kind: 'external'; readonly label: string }

/** One topic to start. */
export interface TopicLaunchSpec {
  /** Idempotency key: a launch whose key was already accepted answers that launch's result. */
  readonly key: string
  /** Fingerprint of the request behind {@link key}; the same key with another fingerprint is refused. */
  readonly fingerprint: string
  /** Target group chat (`oc_…`). */
  readonly chatId: string
  readonly requester: TopicRequester
  readonly card: TopicRootCard
  /** First user message of the Session, sent verbatim. */
  readonly prompt: string
}

/** Why a launch was refused; merge-extensible on the provider side. */
export type TopicLaunchFailureCode = 'invalid' | 'not-connected' | 'forbidden-chat' | 'key-conflict' | 'send-failed'

/** Outcome of {@link FeishuTopicService.launch}. */
export type TopicLaunchResult =
  | {
    readonly ok: true
    readonly replayed: boolean
    readonly chatId: string
    /** Root card message id; the topic hangs below it. */
    readonly messageId: string
  }
  | {
    readonly ok: false
    readonly code: TopicLaunchFailureCode
    /** Readable reason (Chinese). */
    readonly message: string
  }

/**
 * Root card status of a launch: `running` until the first turn settles, then
 * `done`, `stopped`, or `error`; `failed` when the topic or Session could not
 * be started; `interrupted` when DSH restarted before the first turn settled.
 */
export type TopicLaunchStatus = 'running' | 'done' | 'stopped' | 'error' | 'failed' | 'interrupted'

/** What one accepted launch has become. */
export interface TopicLaunchState {
  readonly key: string
  readonly status: TopicLaunchStatus
  /** Why the topic could not be started; only with status `failed`. */
  readonly reason?: string
  /** Session the topic's route currently names. */
  readonly sessionId?: string
  /** The topic's directory (its DSH workspace); present exactly when {@link sessionId} is. */
  readonly workDir?: string
}

/** Name of the event the Feishu channel plugin emits after a launch status is recorded; listeners receive the {@link TopicLaunchState}. */
export const FEISHU_TOPICS_STATUS_EVENT = 'feishu-topics/status'

/** Outcome of {@link FeishuTopicService.updateLinks}. */
export type TopicLinksUpdateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'invalid' | 'unknown-key' | 'not-connected' | 'update-failed'; readonly message: string }

/**
 * The `feishuTopics` service. {@link FeishuTopicService.state},
 * {@link FeishuTopicService.launchKeyOf}, {@link FeishuTopicService.updateLinks},
 * and the optional link fields were added without a version change, so older
 * providers lack them; this plugin treats such a provider as incompatible.
 */
export interface FeishuTopicService {
  readonly version: FeishuTopicsVersion
  /**
   * Post the root card and start the topic in the background.
   * @param spec - the topic to start.
   * @returns the root card, or why nothing was started.
   */
  launch(spec: TopicLaunchSpec): Promise<TopicLaunchResult>
  /**
   * Read what one launch has become.
   * @param key - the launch's idempotency key.
   * @returns the state, or undefined for an unknown key or while disconnected.
   */
  state(key: string): TopicLaunchState | undefined
  /**
   * Find the launch whose topic route currently names a Session.
   * @param sessionId - DSH session id.
   * @returns the launch's idempotency key, or undefined.
   */
  launchKeyOf(sessionId: string): string | undefined
  /**
   * Replace the link table of a launch's root card and redraw the card.
   * @param key - the launch's idempotency key.
   * @param links - the new table; undefined removes it.
   * @returns whether the card shows the new table, or why not.
   */
  updateLinks(key: string, links: TopicCardLinks | undefined): Promise<TopicLinksUpdateResult>
}
