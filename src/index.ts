/**
 * dsh-ping — desktop notifications for DeepSeek Harness.
 *
 * Watches four host moments and tells a human about them: a turn finished, an
 * agent errored, an approval is pending, or the agent asked a question. The
 * delivery is a Windows toast (plus a console line and an optional webhook).
 *
 * The plugin is host-only and imports exactly one `@deepseek-ai/*` module —
 * `schemastery`, the configuration schema library — at runtime. It has no
 * browser half, so it cannot affect what the Web client loads, and no
 * `dsh-*` internals, so renaming one cannot break it.
 * @module dsh-ping
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { buildNotice, shouldNotify, type NotifyFact, type NotifyLimits, type Notice } from './decide.ts'
import { DEFAULTS, resolveConfig, type Config as PingConfig } from './defaults.ts'
import { sendConsole, sendToast, sendWebhook, type ChannelLog, type ToastDelivery } from './channels.ts'
import { MAX_BODY_BYTES, decodePresenceBody, isForeground, parsePresenceReport, type PresenceState } from './presence.ts'
import {
  agentKey, cwdOf, errorText, isRootAgent, sessionKey, textOfMessage,
  type AgentErrorPayload, type AgentStatusPayload, type ApprovalRequestPayload, type LooseContext,
  type QuestionItem, type SessionEventLike, type SessionTitleLike, type ToolsLike, type UserQuestionPayload,
  type WebServerLike,
} from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-ping'

/** No service is required: every host fact is read optionally. */
export const inject: string[] = []

/**
 * The configuration schema.
 *
 * Every default is written twice on purpose — once here so the loader can
 * validate and fill a partial user config, and once in `defaults.ts` so the
 * dependency-free smoke test shares the same values.
 */
export const Config: z<PingConfig> = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  notifyOn: z.object({
    done: z.boolean().default(DEFAULTS.notifyOn.done),
    error: z.boolean().default(DEFAULTS.notifyOn.error),
    approval: z.boolean().default(DEFAULTS.notifyOn.approval),
    question: z.boolean().default(DEFAULTS.notifyOn.question),
  }).default(DEFAULTS.notifyOn),
  rootsOnly: z.boolean().default(DEFAULTS.rootsOnly),
  suppressWhenFocused: z.boolean().default(DEFAULTS.suppressWhenFocused),
  presenceTtlMs: z.natural().default(DEFAULTS.presenceTtlMs),
  cooldownMs: z.natural().default(DEFAULTS.cooldownMs),
  minTurnDurationMs: z.natural().default(DEFAULTS.minTurnDurationMs),
  channels: z.object({
    toast: z.boolean().default(DEFAULTS.channels.toast),
    console: z.boolean().default(DEFAULTS.channels.console),
    webhook: z.boolean().default(DEFAULTS.channels.webhook),
  }).default(DEFAULTS.channels),
  webhookUrl: z.string().default(DEFAULTS.webhookUrl),
  webhookTimeoutMs: z.natural().default(DEFAULTS.webhookTimeoutMs),
  url: z.string().default(DEFAULTS.url),
  maxBodyChars: z.natural().default(DEFAULTS.maxBodyChars),
  toastAppId: z.string().default(DEFAULTS.toastAppId),
  toastSoundDone: z.string().default(DEFAULTS.toastSoundDone),
  toastSoundAttention: z.string().default(DEFAULTS.toastSoundAttention),
  powershellPath: z.string().default(DEFAULTS.powershellPath),
  titles: z.object({
    done: z.string().default(DEFAULTS.titles.done),
    error: z.string().default(DEFAULTS.titles.error),
    approval: z.string().default(DEFAULTS.titles.approval),
    question: z.string().default(DEFAULTS.titles.question),
  }).default(DEFAULTS.titles),
  debug: z.boolean().default(DEFAULTS.debug),
})

export { DEFAULTS, resolveConfig } from './defaults.ts'

/** One in-flight turn, for duration and outcome. */
interface TurnState {
  startedAt: number
  sawError: boolean
  reported: boolean
}

/** Most recently rendered assistant text, keyed by session. */
const ASSISTANT_CACHE_LIMIT = 64

/**
 * Register the notification plugin.
 * @param ctx - the plugin context.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: PingConfig): void {
  const cfg = resolveConfig(config)
  const host = ctx as unknown as LooseContext
  const log: ChannelLog = (line) => { process.stderr.write(`[dsh-ping] ${line}\n`) }
  if (!cfg.enabled) {
    log('disabled by configuration')
    return
  }

  const limits: NotifyLimits = {
    enabled: cfg.enabled,
    kinds: { ...cfg.notifyOn },
    rootsOnly: cfg.rootsOnly,
    cooldownMs: cfg.cooldownMs,
    minTurnDurationMs: cfg.minTurnDurationMs,
    suppressWhenFocused: cfg.suppressWhenFocused,
    maxBodyChars: cfg.maxBodyChars,
  }
  /** The newest report from a Web page, when there is one. */
  let presence: PresenceState | undefined
  const turns = new Map<string, TurnState>()
  const lastNotified = new Map<string, number>()
  const lastAssistant = new Map<string, string>()

  /** The URL a toast click opens. */
  const clickUrl = (): string => {
    if (cfg.url !== '') return cfg.url
    const server = host.get<WebServerLike>('webServer')
    const port = server?.port
    if (typeof port !== 'number' || port <= 0) return ''
    const bound = typeof server?.host === 'string' ? server.host : ''
    const address = bound === '0.0.0.0' || bound === '' ? '127.0.0.1' : bound
    return `http://${address}:${String(port)}/`
  }

  /** The host's title for a session, when a title service is mounted. */
  const titleOf = (session: unknown): string => {
    // Guarded on its own: a title projection that throws (an unknown session
    // shape, a provider mid-rebuild) must cost the title, not the notice.
    try {
      const service = host.get<SessionTitleLike>('sessionTitle')
      const title = service?.get(session)?.title
      return typeof title === 'string' ? title : ''
    } catch {
      return ''
    }
  }

  const toastDelivery = (attention: boolean): ToastDelivery => ({
    appId: cfg.toastAppId,
    url: clickUrl(),
    sound: attention ? cfg.toastSoundAttention : cfg.toastSoundDone,
    long: attention,
    ...(cfg.powershellPath === '' ? {} : { powershellPath: cfg.powershellPath }),
  })

  /**
   * Apply the rate limits, render the notice, and hand it to the channels.
   * @param fact - what happened.
   * @param isRoot - whether the agent owns its session.
   */
  const deliver = (fact: NotifyFact, isRoot: boolean): void => {
    const now = Date.now()
    const key = `${fact.sessionId}:${fact.kind}`
    const lastNotifiedAt = lastNotified.get(key)
    // Asked only for the fact being judged, and only when the feature is on:
    // this is what lets a `done` notice stay silent while the answer is being
    // read on screen, without changing any other kind.
    const foreground = cfg.suppressWhenFocused
      ? isForeground(presence, now, cfg.presenceTtlMs)
      : false
    const verdict = shouldNotify({
      fact,
      limits,
      isRoot,
      ...(lastNotifiedAt === undefined ? {} : { lastNotifiedAt }),
      foreground,
      now,
    })
    if (!verdict.notify) {
      if (cfg.debug) log(`suppressed ${fact.kind} (${verdict.reason})`)
      return
    }
    lastNotified.set(key, now)

    const notice = buildNotice(fact, cfg.titles, cfg.maxBodyChars)
    if (cfg.channels.console) sendConsole(notice, log)
    if (cfg.channels.toast) {
      const attention = fact.kind === 'approval' || fact.kind === 'question'
      sendToast(notice, toastDelivery(attention), log)
    }
    if (cfg.channels.webhook && cfg.webhookUrl !== '') {
      void sendWebhook(
        { kind: fact.kind, title: notice.title, lines: notice.lines, sessionId: fact.sessionId, at: new Date(now).toISOString() },
        cfg.webhookUrl,
        cfg.webhookTimeoutMs,
        log,
      )
    }
  }

  /** Identity used for bookkeeping and rate limiting. */
  const identityOf = (agent: AgentStatusPayload['agent']): { key: string; sessionId: string } => {
    const key = agentKey(agent)
    const sessionId = sessionKey(agent?.session) || key
    return { key, sessionId }
  }

  const onStatus = (payload: AgentStatusPayload): void => {
    const agent = payload.agent
    const { key, sessionId } = identityOf(agent)
    if (key === '') return
    if (payload.status === 'running') {
      turns.set(key, { startedAt: Date.now(), sawError: false, reported: false })
      return
    }
    if (payload.status !== 'idle') return
    const turn = turns.get(key)
    turns.delete(key)
    if (turn === undefined) return
    // An error already raised its own notice for this turn.
    if (turn.sawError && turn.reported) return
    const cwd = cwdOf(agent?.session)
    deliver({
      kind: 'done',
      sessionId,
      sessionTitle: titleOf(agent?.session),
      cwd,
      ...(lastAssistant.has(sessionId) ? { detail: lastAssistant.get(sessionId) as string } : {}),
      durationMs: Date.now() - turn.startedAt,
    }, isRootAgent(agent))
  }

  const onError = (payload: AgentErrorPayload): void => {
    const agent = payload.agent
    const { key, sessionId } = identityOf(agent)
    const turn = turns.get(key)
    if (turn !== undefined) {
      turn.sawError = true
      turn.reported = true
    }
    deliver({
      kind: 'error',
      sessionId,
      sessionTitle: titleOf(agent?.session),
      cwd: cwdOf(agent?.session),
      detail: errorText(payload.error),
    }, isRootAgent(agent))
  }

  const onApproval = (payload: ApprovalRequestPayload): void => {
    const agent = payload.agent
    const { sessionId } = identityOf(agent)
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : ''
    const reason = typeof payload.reason === 'string' ? payload.reason : ''
    deliver({
      kind: 'approval',
      sessionId,
      sessionTitle: titleOf(agent?.session),
      cwd: cwdOf(agent?.session),
      detail: [toolName, reason].filter(part => part !== '').join(' — '),
    }, isRootAgent(agent))
  }

  const onQuestion = (payload: UserQuestionPayload): void => {
    const agent = payload.agent
    const { sessionId } = identityOf(agent)
    const items = Array.isArray(payload.questions) ? payload.questions as QuestionItem[] : []
    const first = items[0]
    const text = typeof first?.question === 'string' ? first.question : ''
    deliver({
      kind: 'question',
      sessionId,
      sessionTitle: titleOf(agent?.session),
      cwd: cwdOf(agent?.session),
      detail: items.length > 1 ? `${text}（共 ${String(items.length)} 个问题）` : text,
    }, isRootAgent(agent))
  }

  /** Keep the last assistant text so a completion notice can quote it. */
  const rememberAssistant = (session: unknown, event: SessionEventLike): void => {
    if (event.type !== 'assistant/message') return
    const id = sessionKey(session)
    if (id === '') return
    const text = textOfMessage(event.data?.message)
    if (text.trim() === '') return
    lastAssistant.delete(id)
    lastAssistant.set(id, text)
    while (lastAssistant.size > ASSISTANT_CACHE_LIMIT) {
      const oldest = lastAssistant.keys().next().value
      if (oldest === undefined) break
      lastAssistant.delete(oldest)
    }
  }

  /** Run a handler without ever letting it reach the caller. */
  const guard = (label: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      log(`${label} handler failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  host.on('agent/status', (payload: AgentStatusPayload) => { guard('agent/status', () => { onStatus(payload) }) })
  host.on('agent/error', (payload: AgentErrorPayload) => { guard('agent/error', () => { onError(payload) }) })
  host.on('session/event', (session: unknown, event: SessionEventLike) => {
    guard('session/event', () => { rememberAssistant(session, event) })
  })
  // Both are waterfalls: notifying must not change who answers them, so the
  // listener always delegates — and prepends, because an answerer registered
  // earlier would otherwise claim the request before this plugin ever saw it.
  host.on('approval/request', (payload: ApprovalRequestPayload, next: () => unknown) => {
    guard('approval/request', () => { onApproval(payload) })
    return next()
  }, { prepend: true })
  host.on('user-questions/request', (payload: UserQuestionPayload, next: () => unknown) => {
    guard('user-questions/request', () => { onQuestion(payload) })
    return next()
  }, { prepend: true })

  /**
   * Register a self-test tool so the channel can be verified from inside a
   * session, without a terminal and without waiting for a real turn to end.
   */
  const registerTestTool = (scope: LooseContext): void => {
    const tools = scope.get<ToolsLike>('tools')
    if (tools === undefined || typeof tools.register !== 'function') return
    tools.register({
      name: 'dsh_ping_test',
      description:
        'Send a test desktop notification through dsh-ping and report which channels accepted it. Use this to '
        + 'verify that turn-completion and attention notifications will actually reach the user, or when the user '
        + 'asks whether notifications work.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Optional body text for the test notification.' },
        },
        required: [],
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute(args: { text?: unknown }) {
        const text = typeof args?.text === 'string' && args.text.trim() !== ''
          ? args.text
          : '这是一条 dsh-ping 自检通知，看到它就说明通知链路是通的。'
        const notice: Notice = buildNotice(
          { kind: 'done', sessionId: 'self-test', sessionTitle: 'dsh-ping 自检', detail: text },
          cfg.titles,
          cfg.maxBodyChars,
        )
        const accepted: string[] = []
        if (cfg.channels.console) {
          sendConsole(notice, log)
          accepted.push('console')
        }
        if (cfg.channels.toast) {
          accepted.push(sendToast(notice, toastDelivery(false), log) ? 'toast' : 'toast（不可用）')
        }
        if (cfg.channels.webhook && cfg.webhookUrl !== '') {
          accepted.push('webhook')
          await sendWebhook(
            { kind: 'test', title: notice.title, lines: notice.lines, sessionId: 'self-test', at: new Date().toISOString() },
            cfg.webhookUrl,
            cfg.webhookTimeoutMs,
            log,
          )
        }
        return `dsh-ping 自检：已通过 ${accepted.join(' + ') || '（无可用通道）'} 发送「${notice.title}」`
      },
    })
  }
  if (typeof host.inject === 'function') host.inject(['tools'], registerTestTool)
  else registerTestTool(host)

  /**
   * Accept a presence report from the browser half.
   *
   * The page posts on load, on focus/blur/visibility changes and on a
   * heartbeat, so one report is enough to know the user is watching and a
   * missing one means "fall back to the duration gate".
   */
  const registerPresenceRoute = (scope: LooseContext): void => {
    if (!cfg.suppressWhenFocused) return
    const webServer = scope.get<WebServerLike>('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    try {
      webServer.register({
        kind: 'exact',
        path: '/dsh-ping/presence',
        handler: (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          const chunks: Buffer[] = []
          let bytes = 0
          request.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength
            // Stop buffering as soon as the body is too big: a page must not
            // be able to grow this process's heap.
            if (bytes <= MAX_BODY_BYTES) chunks.push(chunk)
          })
          request.on('end', () => {
            const report = parsePresenceReport(decodePresenceBody(chunks), Date.now())
            if (report === undefined) {
              if (cfg.debug) log('ignored a malformed presence report')
              response.writeHead(204)
              response.end()
              return
            }
            presence = report
            if (cfg.debug) log(`presence: visible=${String(report.visible)} focused=${String(report.focused)}`)
            response.writeHead(204)
            response.end()
          })
        },
      })
    } catch (error) {
      log(`could not expose the presence route: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (cfg.suppressWhenFocused && typeof host.inject === 'function') host.inject(['webServer'], registerPresenceRoute)
  else registerPresenceRoute(host)

  const enabled = Object.entries(cfg.channels)
    .filter(([, on]) => on)
    .map(([channel]) => channel)
    .join('+')
  log(`ready — channels=${enabled} rootsOnly=${String(cfg.rootsOnly)} cooldown=${String(cfg.cooldownMs)}ms`
    + ` focusedSuppression=${String(cfg.suppressWhenFocused)}`)
}
