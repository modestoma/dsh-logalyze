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
