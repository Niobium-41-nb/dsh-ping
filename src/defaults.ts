/**
 * Configuration shape and defaults.
 *
 * Kept free of every runtime import — including the schema library — so the
 * standalone smoke test can reuse the defaults without pulling a
 * `@deepseek-ai/*` module into a CLI that has to run outside the harness.
 * @module dsh-ping/defaults
 */

import type { NotifyKind, NotifyTitles } from './decide.ts'

/** Plugin configuration. */
export interface Config {
  /** Master switch. */
  enabled: boolean
  /** Which moments notify. */
  notifyOn: Record<NotifyKind, boolean>
  /** Only the root agent notifies; delegated subagents stay silent. */
  rootsOnly: boolean
  /** Minimum gap between two notices for the same session and kind. */
  cooldownMs: number
  /**
   * Completed turns shorter than this stay silent, because the user was still
   * at the keyboard. Applies to `done` only: errors and pending decisions
   * always notify. Set to 0 to be told about every turn.
   */
  minTurnDurationMs: number
  /**
   * Stay silent about completed turns while the Web page is visible and
   * focused, because the user is reading the answer themselves. Applies to
   * `done` only; errors and pending decisions notify either way. Needs the
   * browser half to report presence — without it this changes nothing.
   */
  suppressWhenFocused: boolean
  /** How long a presence report stays valid before the page counts as unseen. */
  presenceTtlMs: number
  /** Enabled delivery channels. */
  channels: { toast: boolean; console: boolean; webhook: boolean }
  /** Webhook destination; empty disables the channel even when enabled. */
  webhookUrl: string
  /** Webhook request budget. */
  webhookTimeoutMs: number
  /** Click-through URL; empty derives the loopback Web URL when one exists. */
  url: string
  /** Maximum characters of the payload line. */
  maxBodyChars: number
  /** AUMID the toast is attributed to; empty uses the Windows PowerShell identity. */
  toastAppId: string
  /** Sound for completed turns and errors. */
  toastSoundDone: string
  /** Sound for pending approvals and questions. */
  toastSoundAttention: string
  /** Explicit Windows PowerShell 5.1 path; empty resolves the in-box one. */
  powershellPath: string
  /** Per-moment headings. */
  titles: NotifyTitles
  /** Log every suppressed notice and its reason. */
  debug: boolean
}

/** The defaults, restated by the schema in `index.ts` so the loader applies them too. */
export const DEFAULTS: Config = {
  enabled: true,
  notifyOn: { done: true, error: true, approval: true, question: true },
  rootsOnly: true,
  cooldownMs: 30_000,
  minTurnDurationMs: 20_000,
  suppressWhenFocused: true,
  presenceTtlMs: 45_000,
  channels: { toast: true, console: true, webhook: false },
  webhookUrl: '',
  webhookTimeoutMs: 5_000,
  url: '',
  maxBodyChars: 180,
  toastAppId: '',
  toastSoundDone: 'ms-winsoundevent:Notification.Default',
  toastSoundAttention: 'ms-winsoundevent:Notification.Reminder',
  powershellPath: '',
  titles: {
    done: 'DSH · 任务完成',
    error: 'DSH · 出错了',
    approval: 'DSH · 等你批准',
    question: 'DSH · 等你回答',
  },
  debug: false,
}

/**
 * Merge a partially applied configuration over the defaults.
 *
 * The loader normally hands over a fully defaulted object, but a deployment
 * that instantiates the plugin directly should not have to.
 * @param config - raw configuration.
 * @returns a complete configuration.
 */
export function resolveConfig(config: Partial<Config> | undefined): Config {
  const source = config ?? {}
  return {
    ...DEFAULTS,
    ...source,
    notifyOn: { ...DEFAULTS.notifyOn, ...source.notifyOn },
    channels: { ...DEFAULTS.channels, ...source.channels },
    titles: { ...DEFAULTS.titles, ...source.titles },
  }
}
