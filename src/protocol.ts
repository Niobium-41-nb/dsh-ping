/**
 * Local, structural views of the host facts this plugin consumes.
 *
 * Nothing here imports a `@deepseek-ai/dsh-*` package. That is deliberate and
 * is the whole compatibility story: an out-of-tree plugin that named an
 * internal package broke on this machine when `@deepseek-ai/dsh-client-runtime`
 * was renamed, so this one only ever reaches the host through shapes it
 * declares itself, and treats every field as optional.
 * @module dsh-ping/protocol
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- the loose surface is the point. */

/** The subset of a cordis `Context` this plugin uses. */
export interface LooseContext {
  on(name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }): unknown
  get<T = unknown>(name: string): T | undefined
  inject?(names: string[], callback: (scope: LooseContext) => void): unknown
}

/** A session as far as notifications are concerned. */
export interface SessionLike {
  id?: unknown
  cwd?: unknown
}

/** An agent as far as notifications are concerned. */
export interface AgentLike {
  id?: unknown
  session?: SessionLike
  /** Present on subagents; absent on the root agent that owns a session. */
  parentAgent?: unknown
  options?: { origin?: unknown }
}

/** `agent/status` payload. */
export interface AgentStatusPayload {
  agent?: AgentLike
  status?: unknown
}

/** `agent/error` payload. */
export interface AgentErrorPayload {
  agent?: AgentLike
  error?: unknown
}

/** `approval/request` payload. */
export interface ApprovalRequestPayload {
  agent?: AgentLike
  toolName?: unknown
  reason?: unknown
}

/** One question inside a `user-questions/request` payload. */
export interface QuestionItem {
  id?: unknown
  question?: unknown
  header?: unknown
}

/** `user-questions/request` payload. */
export interface UserQuestionPayload {
  agent?: AgentLike
  questions?: unknown
}

/** One durable session event, narrowed to the fields used here. */
export interface SessionEventLike {
  type?: unknown
  data?: { message?: unknown }
}

/** `ctx.sessionTitle` service. */
export interface SessionTitleLike {
  get(session: unknown): { title?: unknown } | undefined
}

/** `ctx.webServer` service. */
export interface WebServerLike {
  port?: unknown
  host?: unknown
}

/** `ctx.tools` service. */
export interface ToolsLike {
  register(tool: unknown): unknown
}

/**
 * Narrow an unknown thrown value to a one-line message.
 * @param error - the thrown value.
 * @returns a single-line description.
 */
export function errorText(error: unknown): string {
  if (error === undefined || error === null) return ''
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown }).message
  if (typeof message === 'string') return message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Extract the visible text of an assistant message.
 * @param message - an unknown message value.
 * @returns concatenated text blocks, or an empty string.
 */
export function textOfMessage(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n')
}

/**
 * Whether an agent owns its session outright (the root agent) rather than
 * being a delegated subagent.
 * @param agent - the agent to classify.
 * @returns true for the root agent.
 */
export function isRootAgent(agent: AgentLike | undefined): boolean {
  if (agent === undefined) return true
  if (agent.parentAgent !== undefined && agent.parentAgent !== null) return false
  return agent.options?.origin !== 'subagent'
}

/**
 * Stable identity for one agent, used as the bookkeeping key.
 * @param agent - the agent to identify.
 * @returns the agent id, its session id, or an empty string.
 */
export function agentKey(agent: AgentLike | undefined): string {
  const id = agent?.id
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id === 'number') return String(id)
  const sessionId = agent?.session?.id
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  return ''
}

/**
 * Stable identity for one session.
 * @param session - the session to identify.
 * @returns the session id, or an empty string.
 */
export function sessionKey(session: unknown): string {
  const id = (session as SessionLike | undefined)?.id
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id === 'number') return String(id)
  return ''
}

/**
 * Read the working directory recorded on a session or agent.
 * @param value - a session-like value.
 * @returns the cwd, or an empty string.
 */
export function cwdOf(value: { cwd?: unknown } | undefined): string {
  const cwd = value?.cwd
  return typeof cwd === 'string' ? cwd : ''
}
