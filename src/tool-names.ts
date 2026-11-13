/**
 * Model-facing names of every tool this plugin registers, shared by the
 * entry skill, the tool results, and the tools that point to one another.
 *
 * @module dsh-logalyze/tool-names
 */

/** Dispatches log analyses to children working in the application repositories. */
export const DISPATCH_TOOL_NAME = 'logalyze_dispatch'

/** Shows an application's log-analysis SKILL as of its latest synced commit. */
export const SHOW_TOOL_NAME = 'logalyze_show_skill'

/** Drafts and submits one improvement of an application's SKILL after the user agreed in conversation. */
export const IMPROVE_TOOL_NAME = 'logalyze_improve_skill'

/** Prepares or refreshes an MR git workspace and returns incremental review context. */
export const MR_PREPARE_TOOL_NAME = 'supervisor_mr_prepare'

/** Publishes an MR review summary and optional inline comments while preventing bot self-triggers. */
export const MR_PUBLISH_REVIEW_TOOL_NAME = 'supervisor_mr_publish_review'

/** Replies to an existing MR discussion thread without triggering a self-review. */
export const MR_REPLY_THREAD_TOOL_NAME = 'supervisor_mr_reply_thread'

/** Resolves an existing MR discussion thread after addressing feedback. */
export const MR_RESOLVE_THREAD_TOOL_NAME = 'supervisor_mr_resolve_thread'

/** Records a reviewed/fixed checkpoint and optional bot-pushed commit SHA. */
export const MR_CHECKPOINT_TOOL_NAME = 'supervisor_mr_checkpoint'
