const { test, afterEach } = require('node:test')
const assert = require('node:assert')
const C = require('./constants')
const Certs = require('./certs')

const HOST_KEYS = ['OvmsConfig', 'VFS', 'OvmsCommand']

function clearGlobals() {
  HOST_KEYS.forEach((k) => {
    delete global[k]
  })
}
afterEach(clearGlobals)

// OvmsConfig stub backed by a plain object so tests can read the written stamp.
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

// VFS stub whose Save resolves synchronously; `mode` picks success vs failure.
function makeVfs(saves, mode) {
  return {
    Save: (cfg) => {
      saves.push({ path: cfg.path, data: cfg.data })
      if (mode === 'fail') cfg.fail('disk full')
      else cfg.done()
    },
  }
}

// VFS stub that records saves but defers settling: callbacks are captured in
// `pending` and only fire when the test drains them.
function makeDeferredVfs(saves, pending) {
  return {
    Save: (cfg) => {
      saves.push({ path: cfg.path, data: cfg.data })
      pending.push(cfg)
    },
  }
}

// VFS stub that fails only the save whose path contains `failFile`.
function makeVfsFailing(saves, failFile) {
  return {
    Save: (cfg) => {
      saves.push({ path: cfg.path, data: cfg.data })
      if (cfg.path.indexOf(failFile) !== -1) cfg.fail('boom')
      else cfg.done()
    },
  }
}

const TWO_CERTS = [
  { file: 'a.crt', pem: 'PEM-A\n' },
  { file: 'b.crt', pem: 'PEM-B\n' },
]

test('skips entirely when the stamp is already current (zero I/O)', () => {
  const cfg = makeConfig({ 'abrp.certs_version': String(C.CERTS_VERSION) })
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
  assert.strictEqual(cfg.store['abrp.certs_version'], String(C.CERTS_VERSION))
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

test('does not stamp when tls trust reload fails', () => {
  const cfg = makeConfig({})
  const saves = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfs(saves, 'ok')
  global.OvmsCommand = {
    Exec: () => {
      throw new Error('reload boom')
    },
  }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap()

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
  assert.strictEqual(cfg.store['abrp.certs_version'], String(C.CERTS_VERSION))
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

test('one failed save among successes skips reload and stamp', () => {
  const cfg = makeConfig({})
  const saves = []
  const execs = []
  clearGlobals()
  global.OvmsConfig = cfg
  global.VFS = makeVfsFailing(saves, 'b.crt')
  global.OvmsCommand = { Exec: (cmd) => execs.push(cmd) }
  Certs.__test.setCertDataLoader(() => TWO_CERTS)

  Certs.bootstrap()

  assert.strictEqual(saves.length, 2)
  assert.strictEqual(execs.length, 0)
  assert.strictEqual(cfg.store['abrp.certs_version'], undefined)
})
