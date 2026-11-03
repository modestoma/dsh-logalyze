/**
 * Model-facing names of the repository onboarding tools, shared by the tools
 * that point to one another.
 *
 * @module dsh-logalyze/onboard/names
 */

/** Adds a repository from a conversation. */
export const ADD_REPO_TOOL_NAME = 'logalyze_add_repo'

/** Drafts the application description and SKILL of a repository that lacks them. */
export const INIT_REPO_TOOL_NAME = 'logalyze_init_repo'

/** Submits a draft as a merge request. */
export const SUBMIT_INIT_TOOL_NAME = 'logalyze_submit_init'
