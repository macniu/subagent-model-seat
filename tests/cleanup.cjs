// Cleanup contract test for subagent-model-seat.
//
// User requirement: disabling or removing the bundle must restore the stock
// UI exactly — ordinary conversations keep the original model seat, subagent
// conversations lose the plugin seat (stock DSH never shows one there).
//
// DSH guarantees this through fiber-lifetime effects:
//   - slots.register / slots.inject wrap registration in ctx.effect, so fiber
//     unload removes the entry from the slot ledger.
//   - webServer.register's disposer is returned from ctx.effect, so fiber
//     unload unregisters the route.
//   - client-modules prunes the bundle's factory/loadCache/styles when the
//     boot graph drops that entry (HMR graph reconcile, or a page reload).
//
// This test verifies OUR plugin participates correctly in that contract:
//   1. Client apply's two slot injections clean every slot on fiber dispose.
//   2. Host apply wraps route registration in ctx.effect (disposer propagated).
//   3. Neither half writes persistent browser state or host files.
//   4. No model/selection rollback code exists (append-only session data).
//
// Run from the plugin root:
//   ELECTRON_RUN_AS_NODE=1 "<dsh-node>" tests/cleanup.cjs
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')
let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}${ok ? '' : ' (expected ' + JSON.stringify(expected) + ')'}`)
}

// ------------------------------------------------------------------ Client half
const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')
let captured = null
const fakeReact = {
  createElement() { return null }, useCallback: f => f, useEffect() {},
  useLayoutEffect() {}, useMemo: f => f(), useRef: () => ({ current: null }),
  useState: v => [v, () => {}], useSyncExternalStore: (_s, g) => g(),
}
const stubRequire = name => name === 'react' ? fakeReact
  : name === 'react-dom' ? { createPortal: n => n }
    : (() => { throw new Error('unexpected require: ' + name) })()
global.window = { __ModuleLoader__: { load({ id, factory }) { captured = { id, mod: factory(stubRequire) } } } }
global.navigator = { language: 'zh-CN' }
global.document = { addEventListener() {}, removeEventListener() {}, body: {}, querySelectorAll: () => [] }
global.fetch = async () => ({ status: 200, json: async () => ({ ok: true }) })
new Function(clientSrc)()

const slotLedger = new Map()
const injectDisposers = []
const clientCtx = {
  slots: {
    // Mirrors the renderer: inject's callback returns the register disposer,
    // which the renderer stores as a nested ctx.effect declaration.
    inject(name, cb) {
      const dispose = cb()
      injectDisposers.push(dispose)
      return () => {
        const i = injectDisposers.indexOf(dispose)
        if (i >= 0) injectDisposers.splice(i, 1)
        dispose()
      }
    },
    register(options) {
      slotLedger.set(options.name, options)
      return () => { slotLedger.delete(options.name) }
    },
  },
  workspaces: { list: { subscribe: () => () => {}, getSnapshot: () => ({ items: [] }) } },
  sessions: { subagentAddress: () => undefined },
  remote: { session: { selectModel: async () => ({ ok: true }) } },
  modelDirectories: { directoryFor: () => ({ store: { subscribe: () => () => {}, getSnapshot: () => ({ groups: [] }) } }) },
}
captured.mod.apply(clientCtx)

check('client: slots registered while live', [...slotLedger.keys()].sort(),
  ['conversation.input.model', 'settings.section'])
check('client: inject disposers tracked', injectDisposers.length, 2)

// Simulate fiber.dispose(): the renderer runs every declaration effect.
for (const dispose of [...injectDisposers]) dispose()
check('client: slot ledger empty after fiber dispose', slotLedger.size, 0)

// No persistent browser state written by the plugin itself.
const persistentWrites = ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'document.body.appendChild']
check('client: no persistent browser writes',
  persistentWrites.filter(k => clientSrc.includes(k)), [])

// -------------------------------------------------------------------- Host half
const hostSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const routeTable = new Map()
const hostEffectDisposers = []
const hostCtx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') hostEffectDisposers.push(dispose)
    return () => {}
  },
  webServer: {
    register(route) {
      routeTable.set(route.path, route)
      return () => { routeTable.delete(route.path) }
    },
  },
  connection: { requestRejection: () => undefined },
  llm: { resolveCallConfig: async () => ({}) },
  agents: { get: () => undefined },
  sessions: { get: () => undefined },
  sessionPersistence: { open: async () => ({ read: async () => ({ events: [] }), append: async () => {}, flush: async () => {}, close: async () => {} }) },
}
const hostSrcData = 'data:text/javascript;base64,' + Buffer.from(hostSrc).toString('base64')
import(hostSrcData).then(hostMod => {
  hostMod.apply(hostCtx)
  check('host: route registered while live', [...routeTable.keys()], ['/subagent-model-seat/select'])
  check('host: effect disposer tracked', hostEffectDisposers.length, 1)

  for (const dispose of [...hostEffectDisposers]) dispose()
  check('host: route table empty after fiber dispose', routeTable.size, 0)

  // The Host half never writes files or plugin-owned state.
  const hostWrites = ['writeFile', 'mkdir', 'localStorage', 'sessionStorage', 'fs.']
  check('host: no persistent writes', hostWrites.filter(k => hostSrc.includes(k)), [])

  // Session data is append-only: no rollback/truncate of model/selection.
  check('host: model/selection is append-only (no rollback)',
    /\b(truncate|rollback|deleteEvent)\b/.test(hostSrc), false)

  if (failures === 0) console.log('\nCLEANUP CONTRACT PASSED')
  else { console.error(`\nCLEANUP CONTRACT FAILED (${failures})`); process.exit(1) }
}).catch(e => { console.error('HOST LOAD ERROR:', e); process.exit(1) })
