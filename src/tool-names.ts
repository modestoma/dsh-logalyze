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

/** Adds a repository from a conversation. */
export const ADD_REPO_TOOL_NAME = 'logalyze_add_repo'

/** Drafts the application description and SKILL of a repository that lacks them. */
export const INIT_REPO_TOOL_NAME = 'logalyze_init_repo'

/** Submits a draft as a merge request. */
export const SUBMIT_INIT_TOOL_NAME = 'logalyze_submit_init'
