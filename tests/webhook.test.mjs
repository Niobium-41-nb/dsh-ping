/**
 * Webhook channel tests.
 *
 * This is the only channel that leaves the machine, and until now it had no
 * coverage at all: the payload shape, the non-2xx path, the request budget and
 * the "the endpoint is down" path were all code with a comment. Every case here
 * runs against a real `node:http` server, because the property being checked is
 * "does an actual POST arrive, and does a failing one stay quiet".
 *
 * Run: node --experimental-strip-types tests/webhook.test.mjs
 */

import { createServer } from 'node:http'
import { apply } from '../src/index.ts'
import { sendWebhook } from '../src/channels.ts'

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

/** Resolve once `predicate` is true, or fail after `budgetMs`. */
async function waitFor(predicate, budgetMs = 3000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  return predicate()
}

/** A one-shot HTTP endpoint that records what it received. */
async function endpoint(handler) {
  const received = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => { chunks.push(chunk) })
    request.on('end', () => {
      received.push({
        method: request.method,
        url: request.url,
        contentType: request.headers['content-type'],
        raw: Buffer.concat(chunks).toString('utf8'),
      })
      handler(request, response)
    })
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    received,
    close: () => new Promise((resolve) => { server.close(resolve) }),
  }
}

/** A port nothing listens on: guaranteed connection refused. */
async function deadUrl() {
  const server = createServer(() => {})
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => { server.close(resolve) })
  return `http://127.0.0.1:${String(port)}/hook`
}

/** Capture everything written to stderr. */
function captureStderr() {
  const original = process.stderr.write.bind(process.stderr)
  let text = ''
  process.stderr.write = (chunk) => { text += String(chunk); return true }
  return {
    stop() { process.stderr.write = original },
    get text() { return text },
  }
}

/** A cordis context stub that records listeners and hands out fake services. */
function makeHost(services = {}) {
  const listeners = new Map()
  const ctx = {
    on(name, listener, options) {
      const list = listeners.get(name) ?? []
      list.push({ listener, options })
      listeners.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'tools') return { register: () => {} }
      return services[name]
    },
    inject(_names, callback) {
      callback(ctx)
      return () => {}
    },
  }
  return {
    ctx,
    emit(name, ...args) {
      for (const { listener } of listeners.get(name) ?? []) listener(...args)
    },
  }
}

const SESSION = { id: 'sess-1', cwd: 'E:\\work\\demo' }
const ROOT_AGENT = { id: 'agent-1', session: SESSION }
const SERVICES = { sessionTitle: { get: () => ({ title: '修一个 bug' }) } }
const BASE = {
  channels: { toast: false, console: true, webhook: true },
  cooldownMs: 0,
  minTurnDurationMs: 0,
}

const PAYLOAD = {
  kind: 'done',
  title: 'DSH · 任务完成',
  lines: ['改好了', 'demo'],
  sessionId: 'sess-1',
  at: '2026-09-14T00:00:00.000Z',
}

process.stdout.write('\nsendWebhook: success\n')
{
  const server = await endpoint((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
  })
  const lines = []
  await sendWebhook(PAYLOAD, server.url, 3000, (line) => { lines.push(line) })
  const first = server.received[0]
  ok('posts once', server.received.length === 1, String(server.received.length))
  ok('uses POST', first?.method === 'POST', String(first?.method))
  ok('sends JSON', first?.contentType === 'application/json', String(first?.contentType))
  ok('the body is the payload verbatim', first?.raw === JSON.stringify(PAYLOAD), String(first?.raw))
  ok('a 2xx is silent', lines.length === 0, lines.join(' | '))
  await server.close()
}

process.stdout.write('\nsendWebhook: the failure paths\n')
{
  const server = await endpoint((_request, response) => {
    response.writeHead(503, { 'content-type': 'text/plain' })
    response.end('nope')
  })
  const lines = []
  await sendWebhook(PAYLOAD, server.url, 3000, (line) => { lines.push(line) })
  ok('a non-2xx is logged', lines.some((line) => line.includes('503')), lines.join(' | '))
  ok('a non-2xx does not throw past the caller', lines.length >= 1)
  await server.close()
}
{
  const lines = []
  const url = await deadUrl()
  const startedAt = Date.now()
  await sendWebhook(PAYLOAD, url, 3000, (line) => { lines.push(line) })
  ok('a refused connection is logged', lines.some((line) => line.startsWith('webhook failed:')), lines.join(' | '))
  ok('a refused connection settles at once', Date.now() - startedAt < 2000, String(Date.now() - startedAt))
}
{
  const server = await endpoint(() => { /* never answers */ })
  const lines = []
  const startedAt = Date.now()
  await sendWebhook(PAYLOAD, server.url, 120, (line) => { lines.push(line) })
  const elapsed = Date.now() - startedAt
  ok('a hung endpoint hits the budget', lines.some((line) => line.startsWith('webhook failed:')), lines.join(' | '))
  ok('a hung endpoint does not hang the caller', elapsed < 2000, String(elapsed))
  ok('a hung endpoint is not waited out to the default timeout', elapsed < 3000, String(elapsed))
  await server.close()
}
{
  const lines = []
  await sendWebhook(PAYLOAD, '', 300, (line) => { lines.push(line) })
  ok('an empty url is a no-op', lines.length === 0, lines.join(' | '))
}

process.stdout.write('\nthe plugin actually posts a completion notice\n')
{
  const server = await endpoint((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, webhookUrl: server.url })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  const arrived = await waitFor(() => server.received.length > 0)
  err.stop()
  ok('the endpoint received a request', arrived, String(server.received.length))
  let body = null
  try {
    body = JSON.parse(server.received[0]?.raw ?? '')
  } catch (error) {
    body = null
  }
  ok('the body carries the kind', body?.kind === 'done', String(body?.kind))
  ok('the body carries the heading', body?.title === 'DSH · 任务完成', String(body?.title))
  ok('the body carries the body lines', Array.isArray(body?.lines) && body.lines.length > 0, JSON.stringify(body?.lines))
  ok('the body carries the session', body?.sessionId === 'sess-1', String(body?.sessionId))
  ok('the body carries a timestamp', typeof body?.at === 'string' && !Number.isNaN(Date.parse(body.at)), String(body?.at))
  ok('the console channel still ran', err.text.includes('DSH · 任务完成'), err.text)
  await server.close()
}

process.stdout.write('\na broken endpoint does not break the other channels\n')
{
  const server = await endpoint((_request, response) => {
    response.writeHead(500)
    response.end('boom')
  })
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, webhookUrl: server.url })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  await waitFor(() => err.text.includes('webhook answered 500'))
  err.stop()
  ok('the console notice was still emitted', err.text.includes('DSH · 任务完成'), err.text)
  ok('the failure is reported on stderr', err.text.includes('webhook answered 500'), err.text)
  ok('nothing was thrown into the event bus', !err.text.includes('handler failed'), err.text)
  await server.close()
}

process.stdout.write('\nwebhook stays off when it is not configured\n')
{
  const server = await endpoint((_request, response) => { response.writeHead(200); response.end() })
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, channels: { toast: false, console: true, webhook: true }, webhookUrl: '' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  await new Promise((resolve) => { setTimeout(resolve, 60) })
  err.stop()
  ok('an empty url posts nothing', server.received.length === 0, String(server.received.length))
  ok('an empty url is not an error',
    !err.text.includes('webhook failed') && !err.text.includes('webhook answered'), err.text)
  await server.close()
}
{
  const server = await endpoint((_request, response) => { response.writeHead(200); response.end() })
  const host = makeHost(SERVICES)
  const err = captureStderr()
  apply(host.ctx, { ...BASE, channels: { toast: false, console: true, webhook: false }, webhookUrl: server.url })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'running' })
  host.emit('agent/status', { agent: ROOT_AGENT, status: 'idle' })
  await new Promise((resolve) => { setTimeout(resolve, 60) })
  err.stop()
  ok('a disabled channel posts nothing', server.received.length === 0, String(server.received.length))
  await server.close()
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
