const { test, afterEach } = require('node:test')
const assert = require('node:assert')
const Certs = require('./abrpcerts')
const CERTS_VERSION = Certs.CERTS_VERSION

const HOST_KEYS = ['OvmsConfig', 'VFS', 'OvmsCommand', 'PubSub']

function clearGlobals() {
  HOST_KEYS.forEach((k) => {
    delete global[k]
  })
}
afterEach(clearGlobals)

function makeConfig(initial) {
  const store = Object.assign({}, initial)
  return {
    store,
    Get: (c, k, d) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d),
    Set: (c, k, v) => {
      store[k] = v
    },
  }
}

function makeVfs(saves, mode) {
  return {
    Save: (cfg) => {
      saves.push({ path: cfg.path, data: cfg.data })
      if (mode === 'fail') cfg.fail('disk full')
      else cfg.done()
    },
  }
}

function makeDeferredVfs(saves, pending) {
  return {
    Save: (cfg) => {
      saves.push({ path: cfg.path, data: cfg.data })
      pending.push(cfg)
    },
  }
}

const TWO_CERTS = [
  { file: 'a.crt', pem: 'PEM-A\n' },
  { file: 'b.crt', pem: 'PEM-B\n' },
]

test('skips entirely when the stamp is already current (zero I/O)', () => {
  const cfg = makeConfig({ 'abrp.certs_version': String(CERTS_VERSION) })
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'ok')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap()

  assert.strictEqual(saves.length, 0)
  assert.strictEqual(execs.length, 0)
})

test('installs certs, reloads trust, and writes the stamp on success', () => {
  const cfg = makeConfig({})
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'ok')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap()

  assert.deepStrictEqual(saves, [
    { path: '/store/trustedca/a.crt', data: 'PEM-A\n' },
    { path: '/store/trustedca/b.crt', data: 'PEM-B\n' },
  ])
  assert.deepStrictEqual(execs, ['tls trust reload'])
  assert.strictEqual(cfg.store['abrp.certs_version'], String(CERTS_VERSION))
})

test('does nothing when the cert data element is unavailable', () => {
  const cfg = makeConfig({})
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'ok')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => {
    throw new Error('not installed')
  })

  Certs.bootstrap()

  assert.strictEqual(saves.length, 0)
  assert.strictEqual(execs.length, 0)
  assert.strictEqual(cfg.store['abrp.certs_version'], undefined)
})

test('does not reload or stamp when a cert write fails', () => {
  const cfg = makeConfig({})
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'fail')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap()

  assert.strictEqual(execs.length, 0)
  assert.strictEqual(cfg.store['abrp.certs_version'], undefined)
})

test('is a no-op when the VFS global is absent', () => {
  const cfg = makeConfig({})
  clearGlobals()
  global.OvmsConfig = cfg // VFS + OvmsCommand intentionally absent
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  assert.doesNotThrow(() => Certs.bootstrap())
  assert.strictEqual(cfg.store['abrp.certs_version'], undefined)
})

test('ignores a re-entrant bootstrap while saves are in flight', () => {
  const cfg = makeConfig({})
  const saves = []
  const pending = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeDeferredVfs(saves, pending)
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap() // fans out 2 saves, none settled yet
  Certs.bootstrap() // must be a no-op (in-flight)
  assert.strictEqual(saves.length, 2)

  pending.forEach((c) => c.done()) // drain
  assert.deepStrictEqual(execs, ['tls trust reload'])
  assert.strictEqual(cfg.store['abrp.certs_version'], String(CERTS_VERSION))
})

test('does nothing when the cert data element is empty', () => {
  const cfg = makeConfig({})
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'ok')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => [])

  Certs.bootstrap()

  assert.strictEqual(saves.length, 0)
  assert.strictEqual(execs.length, 0)
  assert.strictEqual(cfg.store['abrp.certs_version'], undefined)
})

test('subscribes cert bootstrap to the first ticker.1 when PubSub is present', () => {
  // On-device the plugin element self-schedules the install off the load stack.
  // Requiring it with PubSub present should register exactly one ticker.1 handler
  // and NOT run the install synchronously.
  const subs = {}
  let nextTok = 1
  let installerRan = 0
  clearGlobals()
  global.PubSub = {
    subscribe(topic, cb) { (subs[topic] = subs[topic] || {})[nextTok] = cb; return nextTok++ },
    unsubscribe(tok) { for (const t in subs) delete subs[t][tok] },
  }
  // Host cert APIs present so bootstrap would proceed if (wrongly) called at load.
  global.OvmsConfig = makeConfig({})
  global.VFS = { Save: () => { installerRan++ } }
  global.OvmsCommand = { Exec: () => {} }

  delete require.cache[require.resolve('./abrpcerts')]
  const fresh = require('./abrpcerts')
  fresh.__test.setCertDataLoader(() => TWO_CERTS)

  assert.ok(subs['ticker.1'] && Object.keys(subs['ticker.1']).length === 1)
  assert.strictEqual(installerRan, 0) // not run synchronously at load
  // fire the ticker -> installer runs now
  Object.values(subs['ticker.1']).forEach((cb) => cb())
  assert.strictEqual(installerRan, 2) // two certs saved
  delete require.cache[require.resolve('./abrpcerts')]
})
