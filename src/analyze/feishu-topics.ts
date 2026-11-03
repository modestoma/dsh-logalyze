/**
 * The part of dsh-channels' `feishuTopics` service (contract version 2) this
 * plugin uses, declared here so the plugin does not depend on the dsh-channels
 * package. dsh-channels provides the service under `feishuTopics` and emits
 * {@link FEISHU_TOPICS_STATUS_EVENT}; both are looked up at run time.
 *
 * @module dsh-logalyze/analyze/feishu-topics
 */

/** The contract version this plugin speaks. Version 2 dropped the `workspace` parameter: the channel derives the topic directory from the group and the topic. */
export type FeishuTopicsVersion = 2

/** One run of the root card's lead sentence. */
export interface TopicCardText {
  /** Plain text; Markdown characters are shown literally. */
  readonly text: string
  /** Shown in bold. */
  readonly bold?: boolean
}

/** One linked row of the root card's table. */
export interface TopicCardLink {
  readonly name: string
  /** `http(s)` address opened by the row's link. */
  readonly url: string
}

/** What the root card shows besides its status. */
export interface TopicRootCard {
  readonly title: string
  /** Word naming the work in the status texts (`分析` gives `分析中`). */
  readonly taskName: string
  /** Lead sentence, shown after an @-mention of the requester. */
  readonly lead: readonly TopicCardText[]
  readonly links?: {
    readonly nameHeader: string
    readonly linkHeader: string
    readonly rows: readonly TopicCardLink[]
  }
}

/** One topic to start. */
export interface TopicLaunchSpec {
  /** Idempotency key: a launch whose key was already accepted answers that launch's result. */
  readonly key: string
  /** Fingerprint of the request behind {@link key}; the same key with another fingerprint is refused. */
  readonly fingerprint: string
  /** Target group chat (`oc_…`). */
  readonly chatId: string
  /** Feishu `user_id` @-mentioned on the root card; the first turn is submitted as this user, so they need chat access in the channel. */
  readonly requesterUserId: string
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

/** Name of the event dsh-channels emits after a launch status is recorded; listeners receive the {@link TopicLaunchState}. */
export const FEISHU_TOPICS_STATUS_EVENT = 'feishu-topics/status'

/**
 * The `feishuTopics` service. `state` and `launchKeyOf` exist on providers
 * released with them; this plugin checks for them before calling.
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
  state?(key: string): TopicLaunchState | undefined
  /**
   * Find the launch whose topic route currently names a Session.
   * @param sessionId - DSH session id.
   * @returns the launch's idempotency key, or undefined.
   */
  launchKeyOf?(sessionId: string): string | undefined
}
