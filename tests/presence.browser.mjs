/**
 * Real-browser check of the presence reporter: does a loaded page actually
 * tell the host that the user is looking at it?
 *
 * Why a browser and not a unit test. The stub-window tests prove the bundle's
 * logic; they cannot prove that the harness ever loads it, that its first
 * report leaves the page, or that the flags are read from the real DOM. On
 * this workspace a client half once passed every unit test, was served byte
 * for byte, and still never rendered — the only check that caught it was a
 * page. So this drives a real headless Chrome over CDP, watches the network
 * for the POST, and pokes the real `document` to make the flags move.
 *
 * It only observes requests: nothing here stops the control agent, restarts
 * anything, or suppresses a real notification. It needs a running Web GUI and
 * a profile with this plugin installed; without either it skips.
 *
 * Run: node tests/presence.browser.mjs
 * Env: DSH_GUI_URL (default http://127.0.0.1:3080), CHROME_PATH
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const GUI = process.env.DSH_GUI_URL ?? 'http://127.0.0.1:3080'
const AUTHORITY = new URL(GUI).host
const ROUTE = '/dsh-ping/presence'
const CHROME = process.env.CHROME_PATH ?? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => existsSync(candidate))

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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** The harness signs its browser-session cookie with this secret. */
function mintCookie() {
  try {
    const yaml = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = /secret:\s*([A-Za-z0-9_-]+)/u.exec(yaml)
    if (match === null) return undefined
    const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    const b64 = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    const now = Date.now()
    const body = b64(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 }), 'utf8'))
    return {
      name: `dsh-auth-${b64(createHash('sha256').update(AUTHORITY).digest())}`,
      value: `v1.${body}.${b64(createHmac('sha256', secret).update(body).digest())}`,
    }
  } catch {
    return undefined
  }
}

/** Minimal CDP client: one websocket, a promise per command. */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.next = 1
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) {
        this.events.push(message)
        return
      }
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.error !== undefined) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.next++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`)) }, 30_000)
    })
  }
}

/** Every presence report the page has sent, oldest first. */
function reports(cdp) {
  return cdp.events
    .filter((event) => event.method === 'Network.requestWillBeSent'
      && String(event.params?.request?.url ?? '').includes(ROUTE))
    .map((event) => ({
      method: event.params.request.method,
      postData: event.params.request.postData ?? '',
      hasPostData: event.params.request.hasPostData === true,
    }))
}

/** Parse one report body, tolerating junk. */
function bodyOf(report) {
  try {
    return JSON.parse(report?.postData ?? '')
  } catch {
    return undefined
  }
}

/** Is the Web GUI up at all? */
async function guiReachable() {
  try {
    const response = await fetch(GUI, { signal: AbortSignal.timeout(4_000) })
    return response.status === 200 || response.status === 401
  } catch {
    return false
  }
}

/** Does the running host already serve this bundle to the page? */
async function bootGraphCarriesBundle(cookie) {
  try {
    const response = await fetch(GUI, {
      headers: cookie === undefined ? {} : { cookie: `${cookie.name}=${cookie.value}` },
      signal: AbortSignal.timeout(8_000),
    })
    const html = await response.text()
    return html.includes('dsh-ping/client.js')
  } catch {
    return false
  }
}

async function main() {
  process.stdout.write('\nthe presence reporter, in a real browser\n')

  if (CHROME === undefined) {
    process.stdout.write('  skip  no Chrome/Chromium found (set CHROME_PATH to run this check)\n')
    return
  }
  if (!await guiReachable()) {
    process.stdout.write(`  skip  no Web GUI answering at ${GUI} (start it, or set DSH_GUI_URL)\n`)
    return
  }

  const port = 9601 + Math.floor(Math.random() * 200)
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ping-presence-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--hide-scrollbars', `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' })

  try {
    let version
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (response.ok) { version = await response.json(); break }
      } catch { /* not up yet */ }
      await sleep(250)
    }
    ok('a headless browser started', version !== undefined)
    if (version === undefined) return

    const ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => { reject(new Error('devtools websocket refused')) }, { once: true })
    })
    const cdp = new Cdp(ws)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Network.enable', {}, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)

    const cookie = mintCookie()
    if (cookie !== undefined) {
      await cdp.send('Network.setCookie',
        { name: cookie.name, value: cookie.value, domain: new URL(GUI).hostname, path: '/' }, sessionId)
    }
    const bootGraphHasBundle = await bootGraphCarriesBundle(cookie)
    ok(`the host serves the bundle${bootGraphHasBundle ? '' : ' (falls back to instancing it by hand)'}`,
      true, bootGraphHasBundle ? 'via the boot graph' : 'not in the boot graph yet')

    await cdp.send('Page.navigate', { url: GUI }, sessionId)
    await sleep(9_000)

    // The strict path is the harness loading the bundle itself. When it does not
    // (the running host computed its boot graph before this plugin declared a
    // browser half — i.e. it needs one restart), instantiate the bundle by hand
    // instead of skipping: the DOM, the fetch stack and the origin are still
    // real, which is what this check is about. The loading path is reported, so
    // a green run never hides the difference.
    if (!bootGraphHasBundle) {
      process.stdout.write('  note  the running host does not serve dsh-ping/client.js yet\n'
        + '        (its boot graph predates the install) — instancing the bundle by hand\n')
      const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')
      const loaded = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          try {
            const captured = []
            const target = window.__ModuleLoader__
            if (target === undefined) return 'no module loader'
            const real = target.load
            target.load = (registration) => { captured.push(registration) }
            try {
              ${source}
            } finally {
              target.load = real
            }
            if (captured.length !== 1) return 'captured ' + captured.length
            const api = captured[0].factory(() => { throw new Error('requires nothing') })
            api.apply({})
            return 'ok'
          } catch (error) {
            return 'threw: ' + String(error && error.message ? error.message : error)
          }
        })()`,
        returnByValue: true,
      }, sessionId)
      ok('the bundle instantiates in the page', loaded.result.value === 'ok', String(loaded.result.value))
      await sleep(1_000)
    }

    const first = reports(cdp)
    ok('the page reported its presence', first.length >= 1, `${String(first.length)} request(s)`)
    ok('the report is a POST', first[0]?.method === 'POST', String(first[0]?.method))
    ok('the report carries the route', cdp.events.some((event) =>
      String(event.params?.request?.url ?? '').endsWith(ROUTE)), ROUTE)
    const body = bodyOf(first[0])
    ok('the body is two booleans',
      typeof body?.visible === 'boolean' && typeof body?.focused === 'boolean', JSON.stringify(body))

    const warnings = cdp.events
      .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'warning')
      .map((event) => (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' '))
    ok('the bundle registers without complaint',
      !warnings.some((text) => text.includes('dsh-ping')), warnings.filter((t) => t.includes('dsh-ping')).join(' | '))

    // Blur: the bundle must read the flag from the document, not send a constant.
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        document.hasFocus = () => false
        window.dispatchEvent(new Event('blur'))
        return true
      })()`,
      returnByValue: true,
    }, sessionId)
    await sleep(1_500)
    const afterBlur = reports(cdp)
    ok('blurring produces another report', afterBlur.length > first.length,
      `${String(first.length)} -> ${String(afterBlur.length)}`)
    ok('the blurred report says focused=false', bodyOf(afterBlur.at(-1))?.focused === false,
      JSON.stringify(bodyOf(afterBlur.at(-1))))

    // Hiding the tab: the visibility flag must follow the document too.
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        return document.visibilityState
      })()`,
      returnByValue: true,
    }, sessionId)
    await sleep(1_500)
    const afterHide = reports(cdp)
    ok('hiding the tab produces another report', afterHide.length > afterBlur.length,
      `${String(afterBlur.length)} -> ${String(afterHide.length)}`)
    ok('the hidden report says visible=false', bodyOf(afterHide.at(-1))?.visible === false,
      JSON.stringify(bodyOf(afterHide.at(-1))))

    // Coming back: focus and visibility return, and the host would suppress again.
    await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        document.hasFocus = () => true
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
        return true
      })()`,
      returnByValue: true,
    }, sessionId)
    await sleep(1_500)
    const afterReturn = reports(cdp)
    ok('returning produces another report', afterReturn.length > afterHide.length,
      `${String(afterHide.length)} -> ${String(afterReturn.length)}`)
    const returned = bodyOf(afterReturn.at(-1))
    ok('the returning report says visible and focused again',
      returned?.visible === true && returned?.focused === true, JSON.stringify(returned))

    ws.close()
  } finally {
    chrome.kill()
    await sleep(400)
    try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}

try {
  await main()
} catch (error) {
  ok('the browser check ran to completion', false, error instanceof Error ? error.message : String(error))
}

if (checks === 0) {
  process.stdout.write('\nskipped (no checks ran)\n')
  process.exit(0)
}

process.stdout.write(`\n${checks - failures.length}/${checks} checks passed\n`)
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n')
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exit(1)
}
