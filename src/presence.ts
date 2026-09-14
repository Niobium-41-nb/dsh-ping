/**
 * Presence: is the user actually looking at the Web page right now?
 *
 * The duration gate in `decide.ts` only *approximates* "the user could have
 * walked away" from the turn length. A browser half that reports whether the
 * tab is visible and focused answers the question directly, which is the one
 * thing the host cannot see on its own.
 *
 * The signal is deliberately one-way and perishable: the page posts a small
 * JSON body, the plugin keeps only the newest one, and it goes stale on its own
 * (`ttlMs`). A closed tab, a crashed page, or a host without the browser half
 * therefore all degrade to "no signal" — which is exactly today's behaviour.
 * @module dsh-ping/presence
 */

/** The newest report received from a page. */
export interface PresenceState {
  /** The page reports itself as visible (not hidden/backgrounded). */
  visible: boolean
  /** The page reports itself as focused. */
  focused: boolean
  /** When the host received it, on the host clock. */
  receivedAt: number
}

/** Largest body accepted from the page; bigger ones are ignored. */
export const MAX_BODY_BYTES = 4096

/**
 * Narrow a body posted by the browser half into a presence report.
 *
 * Unknown fields are dropped and non-boolean flags are refused, so nothing a
 * page sends can become a truthy value by accident.
 * @param raw - the parsed JSON body.
 * @param receivedAt - host clock timestamp of the receipt.
 * @returns the report, or undefined when the body is not usable.
 */
export function parsePresenceReport(raw: unknown, receivedAt: number): PresenceState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const body = raw as { visible?: unknown; focused?: unknown }
  if (typeof body.visible !== 'boolean' || typeof body.focused !== 'boolean') return undefined
  return { visible: body.visible, focused: body.focused, receivedAt }
}

/**
 * Whether the user is looking at the page.
 *
 * Staleness is checked against the host clock rather than the timestamp the
 * page sent: a machine whose clock is off must not be able to pin the plugin
 * into permanent silence.
 * @param state - the newest report, if any.
 * @param now - host clock now.
 * @param ttlMs - how long a report stays valid.
 * @returns true only for a fresh, visible, focused report.
 */
export function isForeground(state: PresenceState | undefined, now: number, ttlMs: number): boolean {
  if (state === undefined) return false
  if (ttlMs <= 0) return false
  if (now - state.receivedAt > ttlMs) return false
  return state.visible && state.focused
}

/**
 * Read a JSON presence body from a stream, bounding how much is kept.
 * @param chunks - the chunks received so far.
 * @returns the parsed body, or undefined when it is absent, oversized or invalid.
 */
export function decodePresenceBody(chunks: readonly Buffer[]): unknown {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (total === 0 || total > MAX_BODY_BYTES) return undefined
  const text = Buffer.concat(chunks as Buffer[]).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
