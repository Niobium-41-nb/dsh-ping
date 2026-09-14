/**
 * Pure-function tests for the presence signal.
 *
 * The interesting properties are the ones the route tests can only sample:
 * staleness is judged on the host clock, the ttl boundary is exact, and a page
 * cannot make itself heard with a body that is not two booleans.
 *
 * Run: node --experimental-strip-types tests/presence.test.mjs
 */

import { MAX_BODY_BYTES, decodePresenceBody, isForeground, parsePresenceReport } from '../src/presence.ts'

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

process.stdout.write('\nparsePresenceReport\n')
ok('accepts two booleans', parsePresenceReport({ visible: true, focused: false }, 1234)?.visible === true)
ok('stamps the host clock, not the page clock',
  parsePresenceReport({ visible: true, focused: true, at: 999_999 }, 1234)?.receivedAt === 1234)
ok('drops unknown fields',
  Object.keys(parsePresenceReport({ visible: true, focused: true, extra: 'x' }, 0) ?? {}).length === 3)
ok('refuses a missing flag', parsePresenceReport({ visible: true }, 0) === undefined)
ok('refuses a string flag', parsePresenceReport({ visible: 'true', focused: true }, 0) === undefined)
ok('refuses a numeric flag', parsePresenceReport({ visible: 1, focused: 1 }, 0) === undefined)
ok('refuses an array', parsePresenceReport([true, false], 0) === undefined)
ok('refuses null', parsePresenceReport(null, 0) === undefined)
ok('refuses undefined', parsePresenceReport(undefined, 0) === undefined)
ok('refuses a bare string', parsePresenceReport('visible', 0) === undefined)

process.stdout.write('\nisForeground\n')
const seen = { visible: true, focused: true, receivedAt: 1000 }
ok('a fresh visible focused report is foreground', isForeground(seen, 1000, 5000) === true)
ok('the ttl boundary is inclusive', isForeground(seen, 6000, 5000) === true)
ok('one millisecond past the ttl is not', isForeground(seen, 6001, 5000) === false)
ok('no report is not foreground', isForeground(undefined, 1000, 5000) === false)
ok('a zero ttl disables the signal', isForeground(seen, 1000, 0) === false)
ok('a negative ttl disables the signal', isForeground(seen, 1000, -1) === false)
ok('a hidden page is not foreground', isForeground({ ...seen, visible: false }, 1000, 5000) === false)
ok('an unfocused page is not foreground', isForeground({ ...seen, focused: false }, 1000, 5000) === false)
ok('a clock that jumped backwards still counts as fresh', isForeground(seen, 900, 5000) === true)

process.stdout.write('\ndecodePresenceBody\n')
ok('decodes a valid body',
  decodePresenceBody([Buffer.from('{"visible":true,"focused":false}')])?.focused === false)
ok('an empty stream decodes to nothing', decodePresenceBody([]) === undefined)
ok('invalid json decodes to nothing', decodePresenceBody([Buffer.from('{oops')]) === undefined)
ok('splitting the bytes does not matter',
  decodePresenceBody([Buffer.from('{"visible":'), Buffer.from('true,"focused":true}')])?.visible === true)
ok('an oversized body is refused',
  decodePresenceBody([Buffer.alloc(MAX_BODY_BYTES + 1, 0x78)]) === undefined)
ok('a body exactly at the limit is accepted',
  decodePresenceBody([Buffer.from(`{"visible":true,"focused":true,"pad":"${'x'.repeat(MAX_BODY_BYTES - 46)}"}`)]) !== undefined)

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
