/**
 * Delivery channels: Windows toast, console line, optional webhook.
 *
 * All three are best-effort by contract — a notification that cannot be shown
 * must never affect the harness, so every failure is logged and swallowed.
 * @module dsh-ping/channels
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { escapeXml, type Notice } from './decide.ts'

/**
 * The toast script, sent as one `-EncodedCommand` payload.
 *
 * It is a constant. No session text is ever concatenated into PowerShell
 * source, so no amount of text in a session title, an error message, or a tool
 * name can reach the PowerShell parser: the text arrives as an XML document in
 * an environment variable and is handed straight to the WinRT XML parser.
 */
export const TOAST_SCRIPT = `$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:DSH_PING_XML)))
$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
$appId = $env:DSH_PING_APPID
if ([string]::IsNullOrEmpty($appId)) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
`

/** How one toast is presented. */
export interface ToastDelivery {
  /** AUMID the toast is attributed to. */
  appId: string
  /** URL opened when the toast is clicked; omitted makes the toast inert. */
  url?: string
  /** `ms-winsoundevent:*` source, or empty for a silent toast. */
  sound?: string
  /** Keep the toast on screen longer (used for attention events). */
  long?: boolean
  /** Explicit Windows PowerShell path; resolved by default. */
  powershellPath?: string
}

/** Diagnostic sink shared by every channel. */
export type ChannelLog = (line: string) => void

/**
 * Render the toast XML payload.
 * @param notice - the heading and body lines.
 * @param delivery - presentation options.
 * @returns a complete `<toast>` document.
 */
export function buildToastXml(notice: Notice, delivery: ToastDelivery): string {
  const attributes = [
    delivery.url === undefined || delivery.url === '' ? '' : `activationType="protocol" launch="${escapeXml(delivery.url)}"`,
    delivery.long === true ? 'duration="long"' : '',
  ].filter(part => part !== '').join(' ')
  const texts = [notice.title, ...notice.lines]
    .map(line => `      <text>${escapeXml(line)}</text>`)
    .join('\n')
  const audio = delivery.sound === undefined || delivery.sound === ''
    ? '  <audio silent="true"/>'
    : `  <audio src="${escapeXml(delivery.sound)}" loop="false" silent="false"/>`
  return [
    `<toast ${attributes}>`.replace(' >', '>'),
    '  <visual>',
    '    <binding template="ToastGeneric">',
    texts,
    '    </binding>',
    '  </visual>',
    audio,
    '</toast>',
  ].join('\n')
}

/**
 * Encode a script for `powershell.exe -EncodedCommand`.
 * @param script - PowerShell source.
 * @returns base64 of the UTF-16LE script.
 */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Resolve the Windows PowerShell 5.1 executable.
 *
 * WinRT type projection is a 5.1 feature; `pwsh` is not a substitute, so the
 * in-box path is used rather than a PATH lookup that could find PowerShell 7.
 * @param configured - an explicit path from configuration.
 * @returns the executable path, or `undefined` when unavailable.
 */
export function resolvePowershell(configured?: string): string | undefined {
  if (configured !== undefined && configured !== '' && existsSync(configured)) return configured
  if (process.platform !== 'win32') return undefined
  const path = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(path) ? path : undefined
}

/** Environment names Windows PowerShell needs to start cleanly. */
const KEEP_ENV = [
  'SystemRoot', 'windir', 'SystemDrive', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP',
  'USERPROFILE', 'USERNAME', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PSModulePath', 'LANG', 'LC_ALL',
]

/**
 * Build a minimal child environment.
 *
 * A notification process has no business inheriting API keys, so the
 * environment is rebuilt from an allowlist instead of copied.
 * @returns the environment for the toast helper.
 */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of KEEP_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * Show a Windows toast. Fire-and-forget by design.
 * @param notice - the heading and body lines.
 * @param delivery - presentation options.
 * @param log - diagnostic sink.
 * @returns true when the helper was started.
 */
export function sendToast(notice: Notice, delivery: ToastDelivery, log: ChannelLog): boolean {
  const powershell = resolvePowershell(delivery.powershellPath)
  if (powershell === undefined) {
    log('toast channel unavailable: Windows PowerShell 5.1 not found')
    return false
  }
  const xml = buildToastXml(notice, delivery)
  try {
    const child = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(TOAST_SCRIPT)],
      {
        windowsHide: true,
        // NOT detached. A detached Windows process has no console, and in that
        // state Windows PowerShell 5.1 loads the WinRT toast types, runs
        // Show(), and exits 0 while no notification is ever raised — a silent
        // failure that cost three lost notifications before it was caught.
        // `unref()` below is what keeps the call non-blocking.
        detached: false,
        stdio: 'ignore',
        env: {
          ...minimalEnv(),
          DSH_PING_XML: Buffer.from(xml, 'utf16le').toString('base64'),
          DSH_PING_APPID: delivery.appId,
        },
      },
    )
    child.on('error', (error: Error) => { log(`toast helper failed: ${error.message}`) })
    child.unref()
    return true
  } catch (error) {
    log(`toast helper could not start: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Show a Windows toast and wait for the helper to finish.
 *
 * The plugin never uses this — a live notification must not block a session
 * event — but a diagnostic run has to see the helper's exit code to tell
 * "shown" apart from "silently refused".
 * @param notice - the heading and body lines.
 * @param delivery - presentation options.
 * @returns the helper's exit code and captured error output.
 */
export function sendToastSync(notice: Notice, delivery: ToastDelivery): { started: boolean; code: number | null; output: string } {
  const powershell = resolvePowershell(delivery.powershellPath)
  if (powershell === undefined) return { started: false, code: null, output: 'Windows PowerShell 5.1 not found' }
  const xml = buildToastXml(notice, delivery)
  const result = spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(TOAST_SCRIPT)],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...minimalEnv(),
        DSH_PING_XML: Buffer.from(xml, 'utf16le').toString('base64'),
        DSH_PING_APPID: delivery.appId,
      },
    },
  )
  const output = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim()
  return { started: true, code: result.status, output }
}

/**
 * Write the notice to stderr, where the launching terminal shows it.
 * @param notice - the heading and body lines.
 * @param log - diagnostic sink.
 */
export function sendConsole(notice: Notice, log: ChannelLog): void {
  log(`${notice.title}${notice.lines.length === 0 ? '' : ` — ${notice.lines.join(' · ')}`}`)
}

/** Webhook payload. */
export interface WebhookPayload {
  kind: string
  title: string
  lines: string[]
  sessionId: string
  at: string
}

/**
 * POST the notice to a webhook.
 * @param payload - the JSON body.
 * @param url - destination URL.
 * @param timeoutMs - request budget.
 * @param log - diagnostic sink.
 * @returns a promise that settles when the attempt finishes.
 */
export async function sendWebhook(
  payload: WebhookPayload,
  url: string,
  timeoutMs: number,
  log: ChannelLog,
): Promise<void> {
  if (url === '') return
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel()
    if (!response.ok) log(`webhook answered ${String(response.status)}`)
  } catch (error) {
    log(`webhook failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
