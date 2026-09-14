/**
 * Browser-half tests for the presence reporter.
 *
 * The bundle is plain JS written against `window.__ModuleLoader__.load`, so it
 * can be loaded here under a stub `window`/`document` and driven by hand. What
 * is worth guarding is not the happy path — it is that this half can never
 * throw into the Web client: it renders nothing, imports nothing, and every
 * entry point has to survive a missing API, a throwing `hasFocus`, a fetch
 * that rejects, and being applied twice.
 *
 * Run: node tests/client.test.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('../client/index.js', import.meta.url))

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

/** A window/document pair that records everything the bundle does to it. */
function makePage({ visibility = 'visible', focused = true, hasFocusThrows = false } = {}) {
  const documentListeners = new Map()
  const windowListeners = new Map()
  const timers = []
  const requests = []
  const warnings = []
  const doc = {
    visibilityState: visibility,
    hidden: visibility === 'hidden',
    hasFocus() {
      if (hasFocusThrows) throw new Error('detached frame')
      return focused
    },
    addEventListener(name, handler) {
      documentListeners.set(name, handler)
    },
  }
  const win = {
    fetch: (url, init) => {
      requests.push({ url, init })
      return Promise.resolve({ ok: true })
    },
    addEventListener(name, handler) {
      windowListeners.set(name, handler)
    },
    setInterval(handler, ms) {
      timers.push({ handler, ms })
      return timers.length
    },
  }
  const fire = (map, name) => {
    const handler = map.get(name)
    if (handler === undefined) throw new Error(`no listener for ${name}`)
    handler()
  }
  return {
    doc,
    win,
    requests,
    timers,
    warnings,
    documentListeners,
    windowListeners,
    fireDocument: (name) => fire(documentListeners, name),
    fireWindow: (name) => fire(windowListeners, name),
  }
}

/** Load the bundle into the given page and return its exports. */
function load(page, { captureConsole = true } = {}) {
  let entry = null
  const loader = { load: (value) => { entry = value } }
  const globalWindow = { ...page.win, __ModuleLoader__: loader }
  Object.assign(page.win, { __ModuleLoader__: loader })
  const originalWindow = globalThis.window
  const originalDocument = globalThis.document
  const originalWarn = console.warn
  if (captureConsole) console.warn = (...args) => { page.warnings.push(args.join(' ')) }
  globalThis.window = page.win
  globalThis.document = page.doc
  try {
    // eslint-disable-next-line no-eval -- the bundle is defined by the loader protocol.
    const run = new Function('window', 'document', 'console', readFileSync(SOURCE, 'utf8'))
    run(page.win, page.doc, console)
  } finally {
    globalThis.window = originalWindow
    globalThis.document = originalDocument
    console.warn = originalWarn
  }
  void globalWindow
  if (entry === null) throw new Error('the bundle did not call __ModuleLoader__.load')
  const module = { exports: {} }
  const factory = entry.factory(() => { throw new Error('this bundle must not require anything') })
  void module
  return { entry, api: factory }
}

process.stdout.write('\nthe bundle is loadable and inert\n')
{
  const page = makePage()
  const { entry, api } = load(page)
  ok('registers under the package id', entry.id === 'dsh-ping', String(entry.id))
  ok('exposes apply', typeof api.apply === 'function')
  ok('needs no host service', Array.isArray(api.inject) && api.inject.length === 0, JSON.stringify(api.inject))
  ok('names itself', typeof api.name === 'string' && api.name.length > 0, String(api.name))
}

process.stdout.write('\nfirst report on apply\n')
{
  const page = makePage()
  const { api } = load(page)
  api.apply({})
  ok('posts immediately', page.requests.length === 1, String(page.requests.length))
  const request = page.requests[0]
  ok('posts to the host route', request?.url === '/dsh-ping/presence', String(request?.url))
  ok('uses POST', request?.init?.method === 'POST', String(request?.init?.method))
  ok('sends JSON', request?.init?.headers?.['content-type'] === 'application/json')
  ok('stays same-origin', request?.init?.credentials === 'same-origin', String(request?.init?.credentials))
  ok('is keepalive so a closing tab still reports', request?.init?.keepalive === true)
  ok('the body is just the two flags', request?.init?.body === '{"visible":true,"focused":true}', String(request?.init?.body))
}

process.stdout.write('\nthe listeners drive the reports\n')
{
  const page = makePage()
  const { api } = load(page)
  api.apply({})
  ok('watches visibility', page.documentListeners.has('visibilitychange'))
  ok('watches focus', page.windowListeners.has('focus'))
  ok('watches blur', page.windowListeners.has('blur'))
  ok('sets a heartbeat', page.timers.length === 1, JSON.stringify(page.timers.map((timer) => timer.ms)))
  ok('the heartbeat is the documented cadence', page.timers[0]?.ms === api.__internals.HEARTBEAT_MS,
    String(page.timers[0]?.ms))

  page.doc.visibilityState = 'hidden'
  page.doc.hidden = true
  page.fireDocument('visibilitychange')
  ok('a hidden tab reports visible=false', page.requests.at(-1)?.init?.body === '{"visible":false,"focused":true}',
    String(page.requests.at(-1)?.init?.body))

  page.doc.visibilityState = 'visible'
  page.doc.hidden = false
  page.doc.hasFocus = () => false
  page.fireWindow('blur')
  ok('a blurred window reports focused=false', page.requests.at(-1)?.init?.body === '{"visible":true,"focused":false}',
    String(page.requests.at(-1)?.init?.body))

  page.doc.hasFocus = () => true
  page.fireWindow('focus')
  ok('refocusing reports focused=true', page.requests.at(-1)?.init?.body === '{"visible":true,"focused":true}',
    String(page.requests.at(-1)?.init?.body))

  page.fireDocument('visibilitychange')
  page.timers[0].handler()
  ok('the heartbeat also reports', page.requests.length === 6, String(page.requests.length))
}

process.stdout.write('\nit survives a hostile or partial page\n')
{
  const page = makePage()
  const { api } = load(page)
  api.apply({})
  page.win.fetch = () => { throw new Error('network stack missing') }
  let threw = false
  try {
    page.fireWindow('focus')
  } catch (error) {
    threw = true
  }
  ok('a fetch that throws synchronously is swallowed', !threw)
}
{
  const page = makePage()
  const { api } = load(page)
  api.apply({})
  page.win.fetch = () => Promise.reject(new Error('404'))
  let threw = false
  try {
    page.fireWindow('focus')
  } catch (error) {
    threw = true
  }
  ok('a rejected fetch is swallowed', !threw)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  ok('and produces no unhandled rejection', true)
}
{
  const page = makePage({ hasFocusThrows: true })
  const { api } = load(page)
  let threw = false
  try {
    api.apply({})
  } catch (error) {
    threw = true
  }
  ok('a throwing hasFocus does not break apply', !threw)
  ok('a throwing hasFocus reads as unfocused', page.requests.at(-1)?.init?.body === '{"visible":true,"focused":false}',
    String(page.requests.at(-1)?.init?.body))
}
{
  const page = makePage()
  page.doc.addEventListener = () => { throw new Error('frozen document') }
  const { api } = load(page)
  const originalWarn = console.warn
  console.warn = (...args) => { page.warnings.push(args.join(' ')) }
  let threw = false
  try {
    api.apply({})
  } catch (error) {
    threw = true
  } finally {
    console.warn = originalWarn
  }
  ok('a document that refuses listeners does not break apply', !threw)
  ok('and the failure is a warning, not an error', page.warnings.length === 1, JSON.stringify(page.warnings))
  ok('the warning names the plugin', String(page.warnings[0]).includes('[dsh-ping]'), String(page.warnings[0]))
}
{
  const page = makePage()
  const { api } = load(page)
  api.apply({})
  api.apply({})
  ok('a second apply does not stack timers', page.timers.length === 1, String(page.timers.length))
  ok('a second apply does not re-report', page.requests.length === 1, String(page.requests.length))
}
{
  const page = makePage()
  delete page.doc.visibilityState
  page.doc.hidden = true
  page.doc.hasFocus = undefined
  const { api } = load(page)
  api.apply({})
  ok('falls back to document.hidden', page.requests.at(-1)?.init?.body === '{"visible":false,"focused":false}',
    String(page.requests.at(-1)?.init?.body))
}
{
  const page = makePage()
  page.win.setInterval = undefined
  const { api } = load(page)
  let threw = false
  try {
    api.apply({})
  } catch (error) {
    threw = true
  }
  ok('a window without setInterval does not break apply', !threw)
}

process.stdout.write('\nthe bundle imports nothing\n')
{
  const source = readFileSync(SOURCE, 'utf8')
  ok('no require() of a host or client package', !/require\(['"]@/.test(source), 'a package require was found')
  const { api } = load(makePage())
  void api
  ok('the factory never calls require', true)
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
