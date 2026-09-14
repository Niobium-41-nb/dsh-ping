// Browser half of dsh-ping: report whether the user is looking at the page.
//
// The host can time a turn but cannot see the screen, so its only noise filter
// is "that turn was shorter than 20 s, the user was probably still there".
// That guess is wrong in both directions. The page itself knows the answer:
// `document.visibilityState` says whether the tab is in front, and
// `document.hasFocus()` says whether the browser window has the keyboard.
//
// So this half does one thing: it posts that pair to the host route
// `/dsh-ping/presence` whenever it changes and on a heartbeat, and the host
// suppresses *completion* notices (never errors or pending decisions) while a
// fresh report says "visible and focused".
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load).
// It imports nothing at all — not even React — registers no slot and renders
// nothing, so it cannot break the Web client the way a bundle that requires a
// renamed `@deepseek-ai/dsh-client-*` package does. Every entry point is
// wrapped: a presence reporter that throws is infinitely worse than one that
// stays quiet, because the page it runs in is the whole product.
window.__ModuleLoader__.load({
  id: 'dsh-ping',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Host route that accepts a presence report. */
    var ROUTE = '/dsh-ping/presence'
    /** Heartbeat: often enough to outlive a tab that stops talking, cheap enough to ignore. */
    var HEARTBEAT_MS = 15000
    /** Set on `window` so a re-applied bundle does not stack timers. */
    var INSTALLED = '__dshPingPresence'

    /** Whether the page is in front, honouring both the old and the standard API. */
    function visibilityOf(doc) {
      if (doc === null || doc === undefined) return false
      if (typeof doc.visibilityState === 'string') return doc.visibilityState !== 'hidden'
      return doc.hidden !== true
    }

    /** Whether the window has the keyboard focus. */
    function focusOf(doc) {
      if (doc === null || doc === undefined) return false
      if (typeof doc.hasFocus === 'function') {
        try {
          return doc.hasFocus() === true
        } catch (error) {
          return false
        }
      }
      return doc.hasFocus === true
    }

    /** What the host is told: a pair of booleans and nothing else. */
    function readPresence(doc) {
      return { visible: visibilityOf(doc), focused: focusOf(doc) }
    }

    /** POST one report; never throws, never returns a rejected promise. */
    function sendPresence(win, doc) {
      try {
        var state = readPresence(doc)
        var body = JSON.stringify({ visible: state.visible, focused: state.focused })
        var request = win.fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          // Same-origin so the page's own credentials travel with it, and
          // `keepalive` so a report fired on the way out is not cancelled.
          credentials: 'same-origin',
          keepalive: true,
        })
        if (request !== null && request !== undefined && typeof request.catch === 'function') {
          request.catch(function () { /* the host may not have the route; that is fine */ })
        }
      } catch (error) {
        // Deliberately silent: a failed presence report must never surface in
        // a console the user is watching the app in.
      }
    }

    /** Install the listeners, once. */
    function apply(ctx) {
      try {
        var win = typeof window === 'undefined' ? null : window
        var doc = typeof document === 'undefined' ? null : document
        if (win === null || doc === null) return
        if (win[INSTALLED] === true) return
        win[INSTALLED] = true
        if (typeof win.addEventListener !== 'function' || typeof doc.addEventListener !== 'function') return
        var report = function () { sendPresence(win, doc) }
        doc.addEventListener('visibilitychange', report)
        win.addEventListener('focus', report)
        win.addEventListener('blur', report)
        win.setInterval(report, HEARTBEAT_MS)
        // The host may have loaded after the tab did: tell it where things stand.
        report()
      } catch (error) {
        console.warn('[dsh-ping] could not report page presence:', error)
      }
    }

    exports.name = 'dsh-ping-presence'
    exports.apply = apply
    // Empty on purpose: this half needs no host service, and a non-empty list
    // would keep it from loading on a host that has none.
    exports.inject = []
    // Exposed for this repo's tests only; not part of the plugin contract.
    exports.__internals = {
      ROUTE: ROUTE,
      HEARTBEAT_MS: HEARTBEAT_MS,
      INSTALLED: INSTALLED,
      visibilityOf: visibilityOf,
      focusOf: focusOf,
      readPresence: readPresence,
      sendPresence: sendPresence,
    }
    return module.exports
  },
})
