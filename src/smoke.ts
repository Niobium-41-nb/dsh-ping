/**
 * Standalone toast smoke test — no harness required.
 *
 * `node lib/smoke.js [text]` raises one real Windows toast with the exact code
 * path the plugin uses, which is how the notification channel gets verified on
 * a machine without starting a session.
 * @module dsh-ping/smoke
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildNotice } from './decide.ts'
import { sendToastSync } from './channels.ts'
import { DEFAULTS, resolveConfig } from './defaults.ts'

/**
 * Raise one test toast.
 * @param argv - words appended to the default body text.
 * @returns the process exit code.
 */
export function runSmoke(argv: readonly string[]): number {
  const cfg = resolveConfig(undefined)
  const text = argv.join(' ').trim() === ''
    ? '这是一条 dsh-ping 自检通知（命令行）。看到它就说明 Windows 通知链路是通的。'
    : argv.join(' ').trim()
  const notice = buildNotice(
    { kind: 'done', sessionId: 'smoke', sessionTitle: 'dsh-ping 自检', detail: text, durationMs: 0 },
    cfg.titles,
    cfg.maxBodyChars,
  )
  const result = sendToastSync(notice, {
    appId: cfg.toastAppId,
    sound: cfg.toastSoundDone,
    long: false,
    ...(cfg.powershellPath === '' ? {} : { powershellPath: cfg.powershellPath }),
  })
  if (!result.started) {
    process.stdout.write(`dsh-ping: 这台机器上无法发送 Windows 通知（${result.output}）\n`)
    return 1
  }
  if (result.code !== 0) {
    process.stdout.write(`dsh-ping: 通知助手以退出码 ${String(result.code)} 失败\n${result.output}\n`)
    return 1
  }
  process.stdout.write(`dsh-ping: 已交给 Windows 通知中心「${notice.title}」 — ${notice.lines.join(' · ')}\n`)
  process.stdout.write('屏幕上没弹窗的话，检查 设置 → 系统 → 通知 是否为 Windows PowerShell 放行，以及「专注助手」是否开启。\n')
  return 0
}

/** The configured default headings, exported for the CLI banner. */
export const SMOKE_TITLES = DEFAULTS.titles

/**
 * Whether this module is the process entry point.
 * @returns true when argv[1] resolves to this module.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const invoked = realpathSync(resolve(entry))
    return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  process.exitCode = runSmoke(process.argv.slice(2))
}
