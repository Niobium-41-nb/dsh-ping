/**
 * Pure-function tests for the decision core and the toast payload.
 *
 * Run: node --experimental-strip-types tests/decide.test.mjs
 */

import {
  buildNotice, escapeXml, flatten, formatDuration, shouldNotify, workspaceOf,
} from '../src/decide.ts'
import { TOAST_SCRIPT, buildToastXml, encodeCommand, minimalEnv } from '../src/channels.ts'
import { DEFAULTS, resolveConfig } from '../src/defaults.ts'

const failures = []
let checks = 0

function eq(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}\n       actual:   ${a}\n       expected: ${b}`)
  process.stdout.write(`  FAIL ${label}\n       actual:   ${a}\n       expected: ${b}\n`)
}

function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    process.stdout.write(`  ok   ${label}\n`)
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
  process.stdout.write(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/** Limits with everything on, so each test only varies what it is about. */
function limits(overrides = {}) {
  return {
    enabled: true,
    kinds: { done: true, error: true, approval: true, question: true },
    rootsOnly: true,
    cooldownMs: 10_000,
    minTurnDurationMs: 0,
    maxBodyChars: 180,
    ...overrides,
  }
}

process.stdout.write('\nflatten\n')
eq('collapses newlines and runs of spaces', flatten('  a\n\n  b \t c  '), 'a b c')
eq('removes control characters', flatten('a\u0000b\u0007c'), 'a b c')
eq('keeps everything when unbounded', flatten('x'.repeat(50), 0).length, 50)
eq('truncates with an ellipsis', flatten('abcdefghij', 5), 'abcd…')
eq('trims before truncating', flatten('   abcdefghij   ', 4), 'abc…')

process.stdout.write('\nescapeXml\n')
eq('escapes the five XML entities', escapeXml(`&<>"'`), '&amp;&lt;&gt;&quot;&apos;')
eq('escapes an ampersand before the entities it creates', escapeXml('&lt;'), '&amp;lt;')

process.stdout.write('\nworkspaceOf\n')
eq('takes the last segment', workspaceOf('<PLUGINS>\\dsh-ping'), 'dsh-ping')
eq('ignores a trailing separator', workspaceOf('/home/u/proj/'), 'proj')
eq('empty stays empty', workspaceOf(''), '')
eq('undefined stays empty', workspaceOf(undefined), '')

process.stdout.write('\nformatDuration\n')
eq('zero', formatDuration(0), '0 秒')
eq('seconds', formatDuration(45_000), '45 秒')
eq('exact minute', formatDuration(60_000), '1 分')
eq('minutes and seconds', formatDuration(133_000), '2 分 13 秒')
eq('exact hour', formatDuration(3_600_000), '1 小时')
eq('hours and minutes', formatDuration(3_780_000), '1 小时 3 分')
eq('undefined renders nothing', formatDuration(undefined), '')

process.stdout.write('\nbuildNotice\n')
const titles = DEFAULTS.titles
eq(
  'detail becomes the first line, identity the second',
  buildNotice(
    { kind: 'done', sessionId: 's1', sessionTitle: '修一个 bug', cwd: 'E:\\work\\proj', detail: '改好了', durationMs: 133_000 },
    titles, 180,
  ),
  { title: 'DSH · 任务完成', lines: ['改好了', '修一个 bug · proj · 2 分 13 秒'] },
)
eq(
  'without detail the subject leads',
  buildNotice({ kind: 'approval', sessionId: 's1', sessionTitle: '部署', cwd: '/w/api' }, titles, 180),
  { title: 'DSH · 等你批准', lines: ['部署', 'api'] },
)
eq(
  'falls back to the workspace when there is no title',
  buildNotice({ kind: 'error', sessionId: 's1', cwd: '/w/api', detail: 'boom' }, titles, 180),
  { title: 'DSH · 出错了', lines: ['boom', 'api'] },
)
eq(
  'never exceeds two body lines',
  buildNotice({ kind: 'done', sessionId: 's1', sessionTitle: 't', cwd: '/w/a', detail: 'd', durationMs: 1000 }, titles, 180).lines.length,
  2,
)
ok(
  'truncates a long payload to maxBodyChars',
  buildNotice({ kind: 'done', sessionId: 's1', detail: 'x'.repeat(500) }, titles, 40).lines[0].length <= 40,
)

process.stdout.write('\nshouldNotify\n')
const base = { kind: 'done', sessionId: 's1', durationMs: 5000 }
eq('notifies when nothing blocks it', shouldNotify({ fact: base, limits: limits(), isRoot: true, now: 1000 }), { notify: true, reason: 'ok' })
eq('plugin disabled', shouldNotify({ fact: base, limits: limits({ enabled: false }), isRoot: true, now: 0 }).reason, 'plugin-disabled')
eq('kind disabled', shouldNotify({ fact: base, limits: limits({ kinds: { done: false, error: true, approval: true, question: true } }), isRoot: true, now: 0 }).reason, 'kind-disabled:done')
eq('subagent suppressed', shouldNotify({ fact: base, limits: limits(), isRoot: false, now: 0 }).reason, 'subagent')
eq('subagent allowed when rootsOnly is off', shouldNotify({ fact: base, limits: limits({ rootsOnly: false }), isRoot: false, now: 0 }).notify, true)
eq('cooldown suppresses a repeat', shouldNotify({ fact: base, limits: limits(), isRoot: true, lastNotifiedAt: 1000, now: 5000 }).reason, 'cooldown')
eq('cooldown expires', shouldNotify({ fact: base, limits: limits(), isRoot: true, lastNotifiedAt: 1000, now: 20_000 }).notify, true)
eq('short turn suppressed', shouldNotify({ fact: base, limits: limits({ minTurnDurationMs: 10_000 }), isRoot: true, now: 0 }).reason, 'too-short')
eq(
  'the duration gate never applies to attention events',
  shouldNotify({ fact: { kind: 'approval', sessionId: 's1', durationMs: 0 }, limits: limits({ minTurnDurationMs: 60_000 }), isRoot: true, now: 0 }).notify,
  true,
)
for (const kind of ['approval', 'question', 'error']) {
  eq(
    `a zero-length ${kind} is still reported`,
    shouldNotify({ fact: { kind, sessionId: 's1', durationMs: 0 }, limits: limits({ minTurnDurationMs: 60_000 }), isRoot: true, now: 0 }).notify,
    true,
  )
}
eq(
  'a zero-length completion is gated',
  shouldNotify({ fact: { kind: 'done', sessionId: 's1', durationMs: 0 }, limits: limits({ minTurnDurationMs: 60_000 }), isRoot: true, now: 0 }).reason,
  'too-short',
)
eq(
  'cooldown is per session and kind',
  shouldNotify({ fact: { kind: 'approval', sessionId: 's1' }, limits: limits(), isRoot: true, lastNotifiedAt: 1000, now: 2000 }).notify,
  false,
)

process.stdout.write('\nbuildToastXml\n')
const xml = buildToastXml({ title: 'T', lines: ['L1', 'L2'] }, { appId: '', url: 'http://127.0.0.1:3080/', sound: 'ms-winsoundevent:Notification.Default', long: true })
ok('declares the generic template', xml.includes('<binding template="ToastGeneric">'))
ok('carries the heading and both lines', xml.includes('<text>T</text>') && xml.includes('<text>L1</text>') && xml.includes('<text>L2</text>'))
ok('activates by protocol with the url', xml.includes('activationType="protocol"') && xml.includes('launch="http://127.0.0.1:3080/"'))
ok('marks a long duration', xml.includes('duration="long"'))
ok('names the sound', xml.includes('src="ms-winsoundevent:Notification.Default"'))
ok('goes silent with no sound', buildToastXml({ title: 'T', lines: [] }, { appId: '' }).includes('<audio silent="true"/>'))
ok('omits activation when there is no url', !buildToastXml({ title: 'T', lines: [] }, { appId: '' }).includes('activationType'))
ok(
  'escapes every text node',
  buildToastXml({ title: 'a&b', lines: ['<c>', '"d"'] }, { appId: '' }).includes('a&amp;b')
    && buildToastXml({ title: 'x', lines: ['<c>'] }, { appId: '' }).includes('&lt;c&gt;'),
)

process.stdout.write('\ninjection resistance\n')
const hostile = `"$(Start-Process calc.exe)" '@ </text></binding></visual></toast><toast><visual><binding><text>x`
const hostileXml = buildToastXml({ title: hostile, lines: [hostile] }, { appId: '', url: `http://127.0.0.1:3080/?x=${hostile}` })
// `$()` inside a text node is data, not a subexpression: PowerShell never sees
// this document as source, it hands it to the WinRT XML parser. What must hold
// is that the text cannot leave its node, and that the script is a constant.
const countOf = (haystack, needle) => haystack.split(needle).length - 1
const structure = hostileXml.replace(/<text>[\s\S]*?<\/text>/g, '').replace(/="[^"]*"/g, '=""')
ok(
  'hostile text injects no extra elements',
  countOf(structure, '<toast') === 1 && countOf(structure, '</toast>') === 1
    && countOf(structure, '<binding') === 1 && countOf(structure, '</binding>') === 1
    && !structure.includes('Start-Process'),
  structure,
)
ok('no raw angle bracket reaches the payload', !hostileXml.includes('</text></binding></visual></toast><toast>'))
ok('the launch attribute cannot be closed early', !/launch="[^"]*" *\$\(/.test(hostileXml) && hostileXml.includes('&quot;'))
ok('the here-string terminator cannot appear as a line', !/\n'@/.test(hostileXml))
ok('the toast script carries no interpolated user text', !TOAST_SCRIPT.includes(hostile) && !TOAST_SCRIPT.includes('${'))
ok('the script decodes back byte for byte', Buffer.from(encodeCommand(TOAST_SCRIPT), 'base64').toString('utf16le') === TOAST_SCRIPT)
ok('the script passes the xml through the WinRT parser, not the shell', TOAST_SCRIPT.includes('$xml.LoadXml('))
ok('the script uses the in-box PowerShell AUMID by default', TOAST_SCRIPT.includes('WindowsPowerShell'))

process.stdout.write('\nminimalEnv\n')
const previous = process.env.DSH_TEST_SECRET
process.env.DSH_TEST_SECRET = 'hunter2'
const env = minimalEnv()
ok('drops unrelated variables', env.DSH_TEST_SECRET === undefined)
ok('keeps SystemRoot', typeof env.SystemRoot === 'string' && env.SystemRoot.length > 0)
if (previous === undefined) delete process.env.DSH_TEST_SECRET
else process.env.DSH_TEST_SECRET = previous

process.stdout.write('\nresolveConfig\n')
eq('fills nested defaults', resolveConfig({ rootsOnly: false }).notifyOn, DEFAULTS.notifyOn)
eq('keeps a nested override', resolveConfig({ notifyOn: { done: false } }).notifyOn.done, false)
eq('keeps sibling nested defaults', resolveConfig({ notifyOn: { done: false } }).notifyOn.error, true)
eq('an empty config is the defaults', resolveConfig(undefined), DEFAULTS)

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
