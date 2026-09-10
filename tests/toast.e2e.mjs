/**
 * End-to-end test of the Windows toast channel.
 *
 * Raising a toast only proves PowerShell exited 0; this test goes one step
 * further and reads the notification back out of the Windows notification
 * platform's history, which is the same store the Action Center shows. A
 * unique marker in the body is what makes the check unambiguous.
 *
 * It really does pop a notification on the desktop — that is the point.
 *
 * Run: node tests/toast.e2e.mjs
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { buildNotice } from '../src/decide.ts'
import { resolvePowershell, sendToast, sendToastSync } from '../src/channels.ts'
import { DEFAULTS, resolveConfig } from '../src/defaults.ts'

const failures = []
let checks = 0

function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/** Read the toast history the way the Action Center does. */
function historyXml(appId) {
  // The result comes back base64-encoded: Windows PowerShell 5.1 writes to
  // stdout in the OEM code page, so handing the XML through the console would
  // mangle every non-ASCII character in the assertions.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]',
    '$ps = [Text.Encoding]::UTF8',
    `$appId = '${appId.replace(/'/g, "''")}'`,
    '$history = [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId)',
    '$out = @()',
    // Entries with a null Content exist in real histories; touching one would abort
    // the whole read under ErrorActionPreference=Stop and look like a missing toast.
    'foreach ($t in $history) { if ($null -ne $t -and $null -ne $t.Content) { $out += $t.Content.GetXml() } }',
    '[Convert]::ToBase64String($ps.GetBytes(($out -join "<!--SPLIT-->")))',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const powershell = resolvePowershell()
  if (powershell === undefined) return { ok: false, xml: '', error: 'Windows PowerShell 5.1 not found' }
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.status !== 0) return { ok: false, xml: '', error: result.stderr ?? `exit ${String(result.status)}` }
  try {
    return { ok: true, xml: Buffer.from((result.stdout ?? '').trim(), 'base64').toString('utf8'), error: '' }
  } catch (error) {
    return { ok: false, xml: '', error: `could not decode the history payload: ${String(error)}` }
  }
}

process.stdout.write('\ndsh-ping toast channel\n')
if (process.platform !== 'win32') {
  process.stdout.write('  skip — this host is not Windows\n')
  process.exit(0)
}

const powershell = resolvePowershell()
ok('finds Windows PowerShell 5.1', powershell !== undefined, 'the WinRT toast API needs 5.1, not pwsh')

const marker = `dsh-ping-e2e-${randomBytes(4).toString('hex')}`
const cfg = resolveConfig(undefined)
const notice = buildNotice(
  { kind: 'approval', sessionId: 'e2e', sessionTitle: 'dsh-ping 端到端测试', detail: marker, durationMs: 65_000 },
  cfg.titles,
  cfg.maxBodyChars,
)

const sent = sendToastSync(notice, { appId: cfg.toastAppId, sound: cfg.toastSoundAttention, long: true })
ok('the toast helper exits cleanly', sent.started && sent.code === 0, `code=${String(sent.code)} ${sent.output}`)

// The platform records asynchronously; give it a moment before reading back.
await new Promise((resolve) => { setTimeout(resolve, 1_500) })

const appId = cfg.toastAppId === ''
  ? '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  : cfg.toastAppId
const history = historyXml(appId)
ok('the notification history is readable', history.ok, history.error)

const record = history.xml.split('<!--SPLIT-->').find(entry => entry.includes(marker)) ?? ''
ok('the toast reached the notification platform', record !== '', `marker ${marker} not found in ${String(history.xml.length)} bytes of history`)
ok('the heading is the approval heading', record.includes('DSH · 等你批准'), record)
ok('the body carries the payload', record.includes(marker))
ok('the attribution line is present', record.includes('dsh-ping 端到端测试'))
ok('the attention sound is attached', record.includes('Notification.Reminder'), record)

// The diagnostic path uses spawnSync; the plugin uses the fire-and-forget
// path. They are different spawn options, and only this one runs in a session,
// so it needs its own history check — a detached child silently raises nothing
// while still exiting 0.
process.stdout.write('\nthe live (fire-and-forget) path\n')
const liveMarker = `dsh-ping-live-${randomBytes(4).toString('hex')}`
const dispatched = sendToast(
  { title: 'DSH · 任务完成', lines: [liveMarker] },
  { appId: cfg.toastAppId, sound: cfg.toastSoundDone },
  () => {},
)
ok('the helper was started', dispatched === true)
await new Promise((resolve) => { setTimeout(resolve, 3_000) })
const liveHistory = historyXml(appId)
const liveRecord = liveHistory.xml.split('<!--SPLIT-->').find(entry => entry.includes(liveMarker)) ?? ''
ok('the fire-and-forget toast reached the platform', liveRecord !== '', `marker ${liveMarker} was dispatched but never recorded`)

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
