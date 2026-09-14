/**
 * The decision core: whether to notify, and what the notification says.
 *
 * Everything here is a pure function so the interesting behaviour — the
 * "don't be annoying" rules and the text assembly — is testable without a
 * live harness, a desktop, or a PowerShell.
 * @module dsh-ping/decide
 */

/** The four moments worth interrupting a human for. */
export type NotifyKind = 'done' | 'error' | 'approval' | 'question'

/** One observable fact about the harness, ready to be turned into a notice. */
export interface NotifyFact {
  kind: NotifyKind
  sessionId: string
  /** Human title of the session, when the host has one. */
  sessionTitle?: string
  /** Working directory the session runs in. */
  cwd?: string
  /** Kind-specific payload: answer excerpt, error text, tool name, question. */
  detail?: string
  /** Wall-clock duration of the turn that just ended. */
  durationMs?: number
}

/** The user's "don't be annoying" settings, already resolved. */
export interface NotifyLimits {
  enabled: boolean
  kinds: Record<NotifyKind, boolean>
  /** Only the root agent notifies; delegated subagents stay silent. */
  rootsOnly: boolean
  /** Minimum gap between two notices for the same session and kind. */
  cooldownMs: number
  /** Turns shorter than this are considered interactive and stay silent. */
  minTurnDurationMs: number
  /** Suppress `done` while the Web page reports itself visible and focused. */
  suppressWhenFocused: boolean
  /** Maximum characters of `detail` kept in the notice. */
  maxBodyChars: number
}

/** Why a notice was or was not emitted. */
export interface NotifyVerdict {
  notify: boolean
  reason: string
}

/** Inputs to the notification decision. */
export interface ShouldNotifyInput {
  fact: NotifyFact
  limits: NotifyLimits
  isRoot: boolean
  /** When this session and kind last produced a notice. */
  lastNotifiedAt?: number
  /** The user is looking at the Web page right now. Absent means "unknown". */
  foreground?: boolean
  now: number
}

/**
 * Decide whether one fact should reach the user.
 *
 * Order matters: a disabled kind is a configuration statement, a subagent is a
 * structural statement, and both outrank the rate limits, so the reported
 * reason always names the real cause.
 * @param input - the fact plus the limits and bookkeeping it is judged against.
 * @returns the verdict and a short reason.
 */
export function shouldNotify(input: ShouldNotifyInput): NotifyVerdict {
  const { fact, limits } = input
  if (!limits.enabled) return { notify: false, reason: 'plugin-disabled' }
  if (!limits.kinds[fact.kind]) return { notify: false, reason: `kind-disabled:${fact.kind}` }
  if (limits.rootsOnly && !input.isRoot) return { notify: false, reason: 'subagent' }
  if (limits.cooldownMs > 0 && input.lastNotifiedAt !== undefined
    && input.now - input.lastNotifiedAt < limits.cooldownMs) {
    return { notify: false, reason: 'cooldown' }
  }
  // A live page is better evidence than a short turn: if the user has the
  // tab visible and focused, they are reading the answer as it lands, and a
  // toast would interrupt someone already looking at it. Only `done` is
  // affected — an error or a pending decision is worth telling them about
  // even while they watch.
  if (fact.kind === 'done' && limits.suppressWhenFocused && input.foreground === true) {
    return { notify: false, reason: 'page-focused' }
  }
  // The duration gate answers one question only: "could the user have walked
  // away?" A short turn means they were still at the keyboard, so a completion
  // toast would interrupt someone who is already reading the answer. Errors
  // and pending decisions are exempt — those are the moments the user asked to
  // be told about regardless of how long the turn took.
  if (fact.kind === 'done') {
    const duration = fact.durationMs ?? 0
    if (duration < limits.minTurnDurationMs) return { notify: false, reason: 'too-short' }
  }
  return { notify: true, reason: 'ok' }
}

/** A rendered notice: one heading plus up to two body lines. */
export interface Notice {
  title: string
  lines: string[]
}

/** Per-kind headings, so a deployment can localize or reword them. */
export type NotifyTitles = Record<NotifyKind, string>

/**
 * Collapse a value into one printable line.
 *
 * Newlines are removed rather than kept: the Windows toast path carries text
 * through an environment variable and a here-string, and a single line cannot
 * terminate either of them.
 * @param value - raw text.
 * @param maxChars - maximum kept characters (0 keeps everything).
 * @returns the flattened, truncated text.
 */
export function flatten(value: string, maxChars = 0): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex -- control characters break the toast carrier.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (maxChars <= 0 || cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/**
 * Last path segment, used as a short workspace label.
 * @param cwd - an absolute working directory.
 * @returns the final segment, or an empty string.
 */
export function workspaceOf(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  const trimmed = cwd.replace(/[\\/]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Human duration, Chinese units to match the default headings.
 * @param ms - duration in milliseconds.
 * @returns a compact label such as `2 分 13 秒`.
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(seconds)} 秒`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(rest)} 分`
}

/**
 * Render the notice for one fact.
 *
 * Shape: the heading states what happened, the first line carries the payload
 * (or the session identity when there is none), and the last line always says
 * which workspace and how long — that is what makes several concurrent
 * sessions distinguishable at a glance.
 * @param fact - the fact to render.
 * @param titles - per-kind headings.
 * @param maxBodyChars - maximum characters of the payload line.
 * @returns the notice.
 */
export function buildNotice(fact: NotifyFact, titles: NotifyTitles, maxBodyChars: number): Notice {
  const title = titles[fact.kind]
  const workspace = workspaceOf(fact.cwd)
  const subject = flatten(fact.sessionTitle ?? '', 80) || workspace || 'DSH 会话'
  const detail = fact.detail === undefined ? '' : flatten(fact.detail, maxBodyChars)
  // The workspace is already the subject when the session has no title;
  // repeating it in the attribution line reads as a bug to the user.
  const meta = [
    workspace === subject ? '' : workspace,
    formatDuration(fact.durationMs),
  ].filter(part => part !== '').join(' · ')

  const lines: string[] = []
  if (detail !== '') {
    lines.push(detail)
    const attribution = [subject, meta].filter(part => part !== '').join(' · ')
    if (attribution !== '') lines.push(attribution)
  } else {
    lines.push(subject)
    if (meta !== '' && meta !== subject) lines.push(meta)
  }
  return { title, lines: lines.slice(0, 2) }
}

/**
 * Escape text for inclusion in the toast XML.
 * @param value - raw text.
 * @returns XML-safe text.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
