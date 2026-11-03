/**
 * 观象使用的 DSH 宿主接口的最小结构声明。
 *
 * 只声明本插件实际调用的字段，不在运行时 import 任何 `@deepseek-ai/dsh-*`
 * 包；字段含义以 DSH 源码为准（`packages/core/tools`、`packages/skill/skill`、
 * `packages/subagent/subagent`、`packages/session/working-directory`、
 * `packages/credentials/credentials`、`packages/interaction/user-approval`）。
 *
 * @module dsh-logalyze/host
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FEISHU_TOPICS_STATUS_EVENT, TopicLaunchState } from './analyze/feishu-topics.ts'

/** One model-facing content block (text is the only kind this plugin produces). */
export interface ContentBlock {
  readonly type: string
  readonly text?: string
  readonly [key: string]: unknown
}

/** Durable session header fields read by the dispatch tool. */
export interface SessionHeader {
  readonly id: string
  /** Original project directory; the sandbox's writable root. */
  readonly cwd?: string
  /** Delegation depth of a subagent child; absent or 0 for a top-level session. */
  readonly delegationDepth?: number
}

/**
 * An appended Session event: `type` is the discriminator, `data` the payload
 * of DSH's `SessionEventMap` entry. Report tracking reads `turn/start`,
 * `user/message`, `assistant/message`, and `turn/end`; other readers only the type.
 */
export interface SessionEventEnvelope {
  readonly type: string
  readonly data?: unknown
}

/** The calling Agent as seen by a tool execution. */
export interface Agent {
  readonly id: string
  readonly session: { readonly header: SessionHeader }
}

/** Per-call execution context handed to `execute`. */
export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly agent?: Agent
  /** Model-requested call id; approval answerers use it to show the call being decided. */
  readonly callId?: string
}

/** Step-time activation input of a registered tool. */
export interface ToolActivationContext {
  readonly agent: Agent
  /** Cancellation of step preparation; asynchronous conditions observe it. */
  readonly signal: AbortSignal
}

/** Canonical output declaration of one tool. */
export interface ToolOutputDefinition<V> {
  readonly schema: Record<string, unknown>
  render(args: unknown, value: V): ContentBlock[]
}

/** One raw JSON-schema tool registration. */
export interface ToolDefinition<V = unknown> {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutputDefinition<V>
  execute(args: unknown, exec: ToolRunContext): Promise<V>
  isConcurrencySafe?(args: unknown): boolean
}

/** The `ctx.tools` registry slice. */
export interface ToolRegistry {
  register<V>(
    definition: ToolDefinition<V>,
    options?: { when?: (context: ToolActivationContext) => boolean | Promise<boolean> },
  ): () => void
}

/** Model and user invocation controls of one skill. */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** One provider catalog entry. */
export interface SkillCandidate {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly rank: number
  readonly locator: unknown
}

/** A loaded skill body. */
export interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly source: string
  readonly provider: string
  readonly content: string
}

/** Cwd-sensitive, abortable lookup options. */
export interface SkillLookupOptions {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

/** One skill source. */
export interface SkillProvider {
  readonly name: string
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

/** Registration-scoped control handed to a provider factory. */
export interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

/** The `ctx.skills` registry slice. */
export interface SkillRegistry {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void
}

/** Why a subagent run ended (merge-extensible in DSH). */
export type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' | (string & {})

/** Terminal outcome of one child. */
export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReason
}

/** One managed child execution. */
export interface SubagentActivation {
  readonly childId: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** Start request of one child. */
export interface SubagentStartRequest {
  readonly cwd: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly maxDepth?: number
}

/** The `ctx.subagents` slice. */
export interface SubagentService {
  getProvider(name: string): unknown
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
  startActivation(spec: {
    readonly provider: string
    readonly label: string
    readonly request: SubagentStartRequest
    readonly signal: AbortSignal
    readonly delivery: 'parent' | 'caller'
  }): Promise<SubagentActivation>
}

/** The `ctx.workingDirectory` slice. */
export interface WorkingDirectoryService {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

/** The optional `ctx.webServer` slice. */
export interface HostWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The optional `ctx.connection` slice: DSH's Host/Origin fence plus login check. */
export interface HostRequestGate {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Source and writability of one credential reference — never its value. */
export interface HostCredentialInfo {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/**
 * The optional `ctx.credentials` slice (`@deepseek-ai/dsh-credentials`).
 * References are environment-variable names; DSH brands them, which is a
 * compile-time marker only.
 */
export interface HostCredentials {
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
  describe(ref: string): Promise<HostCredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/**
 * Closed approval outcomes of `@deepseek-ai/dsh-user-approval`; only
 * `allowed-once` grants the action.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One decision request; DSH requires an open turn of the agent's session. */
export interface ApprovalRequest {
  readonly agent: Agent
  /** Tool the question is about. */
  readonly toolName: string
  /** The exact tool call being decided. */
  readonly callId?: string
  /** Audit-logged explanation of what will happen. */
  readonly reason?: string
  /** Localized presentation-only text; answerers prefer it over `reason`. */
  readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
  /** Aborting withdraws the question (`cancelled`). */
  readonly signal?: AbortSignal
}

/**
 * The optional `ctx.approval` slice. Answerers such as dsh_channels' Feishu
 * decision cards or the DSH Web prompt claim the request; without an answerer
 * the outcome is `unavailable`.
 */
export interface HostApproval {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
}

/** Cordis logger slice. */
export interface HostLogger {
  info?(message: string, ...args: unknown[]): void
  warn?(message: string, ...args: unknown[]): void
  error?(message: string, ...args: unknown[]): void
}

/** The plugin context slice this plugin uses. */
export interface HostContext {
  readonly tools: ToolRegistry
  readonly skills: SkillRegistry
  readonly subagents: SubagentService
  readonly logger?: HostLogger
  get?(name: string): unknown
  /**
   * Listen to the post-commit append feed of every Session (`session/event`).
   * @param name - the event name.
   * @param listener - receives the Session and the appended event.
   * @returns the disposer.
   */
  on(name: 'session/event', listener: (session: { readonly header: SessionHeader }, event: SessionEventEnvelope) => void): () => unknown
  /**
   * Listen to dsh-channels' launch status event; it never fires without dsh-channels.
   * @param name - the event name.
   * @param listener - receives the new launch state.
   * @returns the disposer.
   */
  on(name: typeof FEISHU_TOPICS_STATUS_EVENT, listener: (state: TopicLaunchState) => void): () => unknown
  effect(callback: () => (() => void) | void, label?: string): () => unknown
  inject?(dependencies: string[], callback: (child: HostContext) => void): unknown
}
