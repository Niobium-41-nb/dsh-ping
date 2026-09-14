/**
 * Wiring tests: mount the plugin against a fake cordis context and drive the
 * host events by hand.
 *
 * The two properties worth guarding here are the ones a unit test on the pure
 * functions cannot see: the waterfall listeners must delegate (a notification
 * plugin that swallows `approval/request` would break every approval), and the
 * bookkeeping must produce exactly one notice per turn.
 *
 * Run: node --experimental-strip-types tests/plugin.test.mjs
 */

import { EventEmitter } from 'node:events'
import { apply } from '../src/index.ts'
import { DEFAULTS } from '../src/defaults.ts'

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

/** A cordis context stub that records listeners and hands out fake services. */
function makeHost(services = {}) {
  const listeners = new Map()
  const registered = []
  const ctx = {
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      list.push({ listener, options })
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool) } }
      return services[name]
    },
    inject(_names, callback) {
      callback(ctx)
      return () => {}
    },
  }
  return {
    ctx,
    registered,
    /** Every listener registered for one event, in registration order. */
    listenersFor: (name) => (listeners.get(name) ?? []).map(entry => entry),
    has: (name) => listeners.has(name),
    emit(name, ...args) {
      for (const { listener } of listeners.get(name) ?? []) listener(...args)
    },
  }
}

/** A Web server stub that records the routes a plugin registers. */
function makeRouteHarness() {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  return { webServer, routes }
}

/** Drive one registered route with a hand-built request, and capture the reply. */
function callRoute(route, { method = 'POST', body = '' } = {}) {
  const request = new EventEmitter()
  request.method = method
  const response = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers ?? {}
    },
    end(value) {
      if (value !== undefined) response.body = String(value)
    },
  }
  route.handler(request, response)
  if (body !== '') request.emit('data', Buffer.from(body, 'utf8'))
  request.emit('end')
  return response
}

/** Capture everything the plugin writes to stderr. */
function captureStderr() {
  const original = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (chunk) => { text += String(chunk); return true }
  return {
    stop() { process.stderr.write = original },
    get text() { return text },
  }
}

const SESSION = { id: 'sess-1', cwd: 'E:\\work\\demo' }
const ROOT_AGENT = { id: 'agent-1', session: SESSION }
const SUBAGENT = { id: 'agent-child', session: { id: 'sess-child', cwd: 'E:\\work\\demo' }, parentAgent: ROOT_AGENT }
const SERVICES = { sessionTitle: { get: () => ({ title: '修一个 bug' }) } }

const BASE = {
  channels: { toast: false, console: true, webhook: false },
  cooldownMs: 0,
  // The production default is 20 s; these fixtures complete in milliseconds, so
  // the gate is opened here and asserted on its own below.
  minTurnDurationMs: 0,
}

process.stdout.write('\nregistration\n')
{
  const host = makeHost(SERVICES)
  apply(host.ctx, BASE)
  ok('listens for turn state', host.has('agent/status'))
  ok('listens for errors', host.has('agent/error'))
  ok('listens for approvals', host.has('approval/request'))
  ok('listens for questions', host.has('user-questions/request'))
  ok('listens for assistant messages', host.has('session/event'))
  const approval = host.listenersFor('approval/request')[0]
  const question = host.listenersFor('user-questions/request')[0]
  ok('the approval listener prepends', approval?.options?.prepend === true, JSON.stringify(approval?.options))
  ok('the question listener prepends', question?.options?.prepend === true, JSON.stringify(question?.options))
  ok('registers the self-test tool', host.registered.length === 1 && host.registered[0].name === 'dsh_ping_test')
}

process.stdout.write('\nturn completion\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('session/event', SESSION, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '改好了，测试通过。' }] } },
  })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('announces a finished turn', err.text.includes('DSH · 任务完成'), err.text)
  ok('quotes the assistant answer', err.text.includes('改好了，测试通过。'), err.text)
  ok('names the session title', err.text.includes('修一个 bug'), err.text)
  ok('reports the workspace', err.text.includes('demo'), err.text)
}

process.stdout.write('\nidle without a turn is silent\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('no notice for a stray idle', !err.text.includes('任务完成'), err.text)
}

process.stdout.write('\nerrors replace the completion notice\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/error', { agent: ROOT_AGENT, error: new Error('provider exploded') })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('announces the error', err.text.includes('DSH · 出错了'), err.text)
  ok('carries the error text', err.text.includes('provider exploded'), err.text)
  ok('does not also announce completion', !err.text.includes('任务完成'), err.text)
}

process.stdout.write('\nthe duration gate (the "stop pinging me" default)\n')
{
  // A turn that ends immediately: the user is plainly still at the keyboard.
  const quick = makeHost(SERVICES)
  const quickErr = captureStderr()
  apply(quick.ctx, { ...BASE, minTurnDurationMs: 60 })
  quick.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  quick.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  quickErr.stop()
  ok('an instant turn does not notify', !quickErr.text.includes('任务完成'), quickErr.text)

  // A turn that ran long enough that the user could have walked away.
  const slow = makeHost(SERVICES)
  const slowErr = captureStderr()
  apply(slow.ctx, { ...BASE, minTurnDurationMs: 10 })
  slow.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  await new Promise((resolve) => { setTimeout(resolve, 40) })
  slow.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  slowErr.stop()
  ok('a long turn notifies', slowErr.text.includes('任务完成'), slowErr.text)

  // An error is a "something needs you" moment, not a completion.
  const failed = makeHost(SERVICES)
  const failedErr = captureStderr()
  apply(failed.ctx, { ...BASE, minTurnDurationMs: 60_000 })
  failed.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  failed.emit('agent/error', { agent: ROOT_AGENT, error: new Error('boom') })
  failedErr.stop()
  ok('a fast failure still notifies', failedErr.text.includes('DSH · 出错了'), failedErr.text)

  // Approvals and questions are never gated by duration either.
  const asked = makeHost(SERVICES)
  const askedErr = captureStderr()
  apply(asked.ctx, { ...BASE, minTurnDurationMs: 60_000 })
  asked.emit('approval/request', { agent: ROOT_AGENT, toolName: 'bash' }, () => Promise.resolve({}))
  askedErr.stop()
  ok('an approval is never gated by duration', askedErr.text.includes('等你批准'), askedErr.text)
}

process.stdout.write('\nthe shipped defaults are quiet\n')
{
  // Guards the regression this whole section exists for: shipping a zero gate
  // means one toast per reply, which is exactly the complaint.
  ok('the default duration gate is off zero', DEFAULTS.minTurnDurationMs > 0, String(DEFAULTS.minTurnDurationMs))
  ok('the default cooldown is meaningful', DEFAULTS.cooldownMs >= 10_000, String(DEFAULTS.cooldownMs))
  ok('subagents are filtered out by default', DEFAULTS.rootsOnly === true)
}

process.stdout.write('\nsubagents stay quiet\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('agent/status', { agent: SUBAGENT, status: 'running' })
  host.emit('agent/status', { agent: SUBAGENT, status: 'idle' })
  err.stop()
  ok('no notice for a delegated agent', !err.text.includes('任务完成'), err.text)
}

process.stdout.write('\nsubagents notify when rootsOnly is off\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, rootsOnly: false })
  host.emit('agent/status', { agent: SUBAGENT, status: 'running' })
  host.emit('agent/status', { agent: SUBAGENT, status: 'idle' })
  err.stop()
  ok('notice for a delegated agent', err.text.includes('任务完成'), err.text)
}

process.stdout.write('\ncooldown\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, cooldownMs: 60_000 })
  for (let round = 0; round < 3; round += 1) {
    host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
    host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  }
  err.stop()
  const count = err.text.split('DSH · 任务完成').length - 1
  ok('three quick turns collapse to one notice', count === 1, `count=${String(count)}`)
}

process.stdout.write('\nattention events\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  let approvalsForwarded = 0
  host.emit('approval/request', { agent: ROOT_AGENT, toolName: 'bash', reason: 'runs rm -rf' }, () => {
    approvalsForwarded += 1
    return Promise.resolve({ kind: 'approved' })
  })
  err.stop()
  ok('announces the pending approval', err.text.includes('DSH · 等你批准'), err.text)
  ok('names the tool and the reason', err.text.includes('bash') && err.text.includes('runs rm -rf'), err.text)
  ok('delegates the approval exactly once', approvalsForwarded === 1, String(approvalsForwarded))
}

process.stdout.write('\nquestions\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  let forwarded = 0
  host.emit('user-questions/request', {
    agent: ROOT_AGENT,
    questions: [{ id: 'q1', question: '要覆盖已有文件吗？' }, { id: 'q2', question: '用哪个分支？' }],
  }, () => { forwarded += 1; return Promise.resolve({ answers: [] }) })
  err.stop()
  ok('announces the pending question', err.text.includes('DSH · 等你回答'), err.text)
  ok('carries the question text', err.text.includes('要覆盖已有文件吗？'), err.text)
  ok('counts the remaining questions', err.text.includes('2 个问题'), err.text)
  ok('delegates the question exactly once', forwarded === 1, String(forwarded))
}

process.stdout.write('\na hostile payload cannot break the waterfall\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  let forwarded = 0
  const exploding = { agent: ROOT_AGENT }
  Object.defineProperty(exploding, 'toolName', {
    get() { throw new Error('hostile payload') },
  })
  let threw = false
  try {
    host.emit('approval/request', exploding, () => { forwarded += 1; return Promise.resolve({}) })
  } catch {
    threw = true
  }
  err.stop()
  ok('the observer swallows its own failure', threw === false)
  ok('the approval is still delegated', forwarded === 1, String(forwarded))
  ok('the failure is reported for diagnosis', err.text.includes('approval/request handler failed'), err.text)
}

process.stdout.write('\nthe self-test tool\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  const tool = host.registered[0]
  const result = await tool.execute({ text: '自检正文' })
  err.stop()
  ok('returns a channel summary', typeof result === 'string' && result.includes('console'), result)
  ok('uses the supplied text', err.text.includes('自检正文'), err.text)
  ok('validates its parameters as plain JSON Schema', tool.parameters.type === 'object' && Array.isArray(tool.parameters.required))
  ok('declares a string output', tool.output.schema.type === 'string')
  ok('renders a text block', tool.output.render({}, result)[0].type === 'text')
}

process.stdout.write('\na disabled plugin does nothing\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, enabled: false })
  err.stop()
  ok('registers no listeners', !host.has('agent/status'))
  ok('says so on stderr', err.text.includes('disabled by configuration'), err.text)
}

process.stdout.write('\nthe presence route\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, BASE)
  err.stop()
  ok('registers one route', harness.routes.length === 1, String(harness.routes.length))
  ok('at the plugin-namespaced path', harness.routes[0]?.path === '/dsh-ping/presence', String(harness.routes[0]?.path))
  ok('as an exact route', harness.routes[0]?.kind === 'exact', String(harness.routes[0]?.kind))
}

process.stdout.write('\na focused page silences completions\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, { ...BASE, debug: true })
  const response = callRoute(harness.routes[0], { body: JSON.stringify({ visible: true, focused: true }) })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('the report is accepted', response.status === 204, String(response.status))
  ok('the completion stays silent', !err.text.includes('任务完成'), err.text)
  ok('and the reason is recorded', err.text.includes('page-focused'), err.text)
}

process.stdout.write('\nan unfocused page gets its notifications back\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, BASE)
  callRoute(harness.routes[0], { body: JSON.stringify({ visible: true, focused: false }) })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('a visible but unfocused page still notifies', err.text.includes('任务完成'), err.text)
}
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, BASE)
  callRoute(harness.routes[0], { body: JSON.stringify({ visible: false, focused: true }) })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('a hidden page still notifies', err.text.includes('任务完成'), err.text)
}

process.stdout.write('\na stale report stops mattering\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, { ...BASE, presenceTtlMs: 40 })
  callRoute(harness.routes[0], { body: JSON.stringify({ visible: true, focused: true }) })
  await new Promise((resolve) => { setTimeout(resolve, 60) })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('a report past its ttl is ignored', err.text.includes('任务完成'), err.text)
}

process.stdout.write('\nattention events ignore the page\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, BASE)
  callRoute(harness.routes[0], { body: JSON.stringify({ visible: true, focused: true }) })
  host.emit('approval/request', { agent: ROOT_AGENT, toolName: 'bash' }, () => Promise.resolve({}))
  host.emit('agent/error', { agent: ROOT_AGENT, error: new Error('boom') })
  err.stop()
  ok('a pending approval is still announced', err.text.includes('等你批准'), err.text)
  ok('an error is still announced', err.text.includes('DSH · 出错了'), err.text)
}

process.stdout.write('\nthe route refuses what it cannot trust\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, BASE)
  const route = harness.routes[0]
  const badJson = callRoute(route, { body: 'not json at all' })
  const badTypes = callRoute(route, { body: JSON.stringify({ visible: 'yes', focused: 1 }) })
  const missing = callRoute(route, { body: JSON.stringify({}) })
  const wrongMethod = callRoute(route, { method: 'GET' })
  const oversized = callRoute(route, { body: `{"visible":true,"focused":true,"pad":"${'x'.repeat(5000)}"}` })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('a malformed body is not an error', badJson.status === 204, String(badJson.status))
  ok('a non-boolean flag is refused', badTypes.status === 204, String(badTypes.status))
  ok('an empty body is refused', missing.status === 204, String(missing.status))
  ok('a non-POST is refused', wrongMethod.status === 405, String(wrongMethod.status))
  ok('the refusal names the allowed method', wrongMethod.headers?.allow === 'POST', JSON.stringify(wrongMethod.headers))
  ok('an oversized body is ignored', oversized.status === 204, String(oversized.status))
  ok('none of them silenced the completion', err.text.includes('任务完成'), err.text)
}

process.stdout.write('\nthe feature can be turned off entirely\n')
{
  const harness = makeRouteHarness()
  const host = makeHost({ ...SERVICES, webServer: harness.webServer })
  const err = captureStderr()
  apply(host.ctx, { ...BASE, suppressWhenFocused: false })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('no route is registered', harness.routes.length === 0, String(harness.routes.length))
  ok('completions are unaffected', err.text.includes('任务完成'), err.text)
  ok('the ready line reports the setting', err.text.includes('focusedSuppression=false'), err.text)
}

process.stdout.write('\na host without a web server is not a failure\n')
{
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('the plugin still works', err.text.includes('任务完成'), err.text)
  ok('and nothing was reported as broken', !err.text.includes('could not expose'), err.text)
}
{
  const host = makeHost({ ...SERVICES, webServer: { register: () => { throw new Error('route conflict') } } })
  const err = captureStderr()
  apply(host.ctx, BASE)
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  err.stop()
  ok('a route conflict does not break notifications', err.text.includes('任务完成'), err.text)
  ok('a route conflict is reported', err.text.includes('could not expose the presence route'), err.text)
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
