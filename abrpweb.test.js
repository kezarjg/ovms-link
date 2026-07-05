const { test } = require('node:test')
const assert = require('node:assert')

const HOST = ['abrp', 'HTTP', 'print']

function clear() {
  HOST.forEach((k) => {
    delete global[k]
  })
}

// Fresh module each test (identity is module-level state).
function loadWeb(globals) {
  clear()
  if (globals) Object.assign(global, globals)
  delete require.cache[require.resolve('./abrpweb')]
  return require('./abrpweb')
}

function capture(fn) {
  const orig = global.print
  let out = ''
  global.print = (s) => {
    out += s
  }
  try {
    fn()
  } finally {
    global.print = orig
  }
  return out
}

const SNAP = {
  version: '9.9',
  token_set: true,
  time_valid: false,
  sending: false,
  queue_depth: 2,
  last_send: null,
  telemetry: {},
}

test('webStatus prints abrp.snapshot() plus the identity cache', () => {
  const web = loadWeb({ abrp: { snapshot: () => Object.assign({}, SNAP), meUrl: () => '' } })
  const s = JSON.parse(capture(() => web.webStatus()))
  assert.strictEqual(s.queue_depth, 2)
  assert.strictEqual(s.version, '9.9')
  assert.deepStrictEqual(s.identity, { state: 'unknown' })
})

test('webStatus reports an error when the abrp plugin is not loaded', () => {
  const web = loadWeb({}) // no global.abrp
  const s = JSON.parse(capture(() => web.webStatus()))
  assert.ok(/not loaded/.test(s.error))
})

test('webStatus prints {error} if snapshot throws', () => {
  const web = loadWeb({
    abrp: {
      snapshot: () => {
        throw new Error('boom')
      },
      meUrl: () => '',
    },
  })
  const s = JSON.parse(capture(() => web.webStatus()))
  assert.ok(s.error)
})

test('webIdentityRefresh with no token/url caches an error and fires no request', () => {
  const reqs = []
  const web = loadWeb({ abrp: { snapshot: () => ({}), meUrl: () => '' }, HTTP: { Request: (o) => reqs.push(o) } })
  const ack = capture(() => web.webIdentityRefresh())
  assert.ok(ack.indexOf('"ok":false') !== -1)
  assert.strictEqual(reqs.length, 0)
  assert.strictEqual(web.__test.getIdentity().state, 'error')
})

test('webIdentityRefresh caches identity from a successful oauth/me', () => {
  const reqs = []
  const web = loadWeb({
    abrp: { snapshot: () => ({}), meUrl: () => 'https://api.iternio.com/1/oauth/me?x' },
    HTTP: { Request: (o) => reqs.push(o) },
  })
  const ack = capture(() => web.webIdentityRefresh())
  assert.ok(ack.indexOf('"ok":true') !== -1)
  assert.strictEqual(reqs.length, 1)
  reqs[0].done({
    statusCode: 200,
    body: JSON.stringify({
      status: 'ok',
      full_name: 'Jane D',
      vehicle_name: 'Solterra',
      vehicle_typecode: 'subaru:solterra:x',
    }),
  })
  const id = web.__test.getIdentity()
  assert.strictEqual(id.state, 'ok')
  assert.strictEqual(id.name, 'Jane D')
  assert.strictEqual(id.vehicle, 'Solterra')
  assert.strictEqual(id.typecode, 'subaru:solterra:x')
})

test('webIdentityRefresh caches an error when the request fails', () => {
  const reqs = []
  const web = loadWeb({ abrp: { snapshot: () => ({}), meUrl: () => 'https://x' }, HTTP: { Request: (o) => reqs.push(o) } })
  capture(() => web.webIdentityRefresh())
  reqs[0].fail('network down')
  assert.strictEqual(web.__test.getIdentity().state, 'error')
})

test('webIdentityRefresh caches an error when oauth/me returns status:error', () => {
  const reqs = []
  const web = loadWeb({ abrp: { snapshot: () => ({}), meUrl: () => 'https://x' }, HTTP: { Request: (o) => reqs.push(o) } })
  capture(() => web.webIdentityRefresh())
  reqs[0].done({ statusCode: 200, body: '{"status":"error"}' })
  assert.strictEqual(web.__test.getIdentity().state, 'error')
})
