const { describe, it } = require('node:test')
const assert = require('node:assert')

// Loads a fresh copy of the module with a clean global environment.
// Pass per-test host-global stubs (OvmsMetrics, HTTP, …) via `globals`.
// For stateful tests (shared module state), call loadAbrp() inside a setup()
// helper or beforeEach — NOT at describe-body level — so each test gets a fresh
// module instance. Describe-level calls share one instance across the block.
//
// The bundle (dist/abrp.js) is self-contained, so dropping it from require.cache
// and re-requiring re-runs its internal module registry — fresh queue/metricMap/
// state each time (replaces jest.resetModules()).
function loadAbrp(globals) {
  delete require.cache[require.resolve('../dist/abrp')]
  ;['OvmsConfig', 'OvmsMetrics', 'PubSub', 'HTTP', 'OvmsNotify'].forEach((k) => {
    delete global[k]
  })
  if (globals) Object.assign(global, globals)
  return require('../dist/abrp')
}

describe('round', () => {
  const { round } = loadAbrp()
  it('should default to no decimal', () => {
    assert.strictEqual(round(12), 12)
    assert.strictEqual(round(12.34567), 12)
  })
  it('should use provided precision', () => {
    assert.strictEqual(round(12.34567, 2), 12.35)
    assert.strictEqual(round(12.34, 6), 12.34)
  })
})

describe('sendBulkTelemetry data integrity', () => {
  function setup() {
    const requests = []
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.setSendInterval(0) // disable the flush gate so each call flushes immediately
    const q = abrp.__test.getQueue()
    q.length = 0
    return { abrp, requests, q }
  }

  it('removes only the batch that was sent, despite concurrent appends', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 }, { utc: 3 })
    abrp.__test.sendBulkTelemetry()
    assert.strictEqual(requests.length, 1)
    // telemetry queued while the request is in flight
    q.push({ utc: 4 })
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    assert.deepStrictEqual(q.map((t) => t.utc), [4])
  })

  it('does not start a second send while one is in flight', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry() // starts; done not yet called
    abrp.__test.sendBulkTelemetry() // must be skipped
    assert.strictEqual(requests.length, 1)
  })

  it('leaves the queue intact on a 200 with status:error', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 })
    abrp.__test.sendBulkTelemetry()
    requests[0].done({ statusCode: 200, body: '{"status":"error"}' })
    assert.deepStrictEqual(q.map((t) => t.utc), [1, 2])
    abrp.__test.sendBulkTelemetry() // guard must be cleared after a rejected-but-200 response
    assert.strictEqual(requests.length, 2)
  })

  it('sends and removes the whole queue per flush', () => {
    const { abrp, requests, q } = setup()
    for (let i = 1; i <= 15; i++) q.push({ utc: i })
    abrp.__test.sendBulkTelemetry()
    assert.strictEqual(requests.length, 1)
    assert.notStrictEqual(requests[0].post, undefined)
    const sent = JSON.parse(requests[0].post).data[0].tlm_list
    assert.strictEqual(sent.length, 15) // whole queue, not capped at 10
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    assert.deepStrictEqual(q.map((t) => t.utc), []) // queue emptied
  })

  it('clears the in-flight guard on failure so the next tick can retry', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].fail('timeout')
    abrp.__test.sendBulkTelemetry() // guard cleared => a new request goes out
    assert.strictEqual(requests.length, 2)
  })

  it('records lastSend on a successful flush', () => {
    const { abrp, requests, q } = setup()
    assert.strictEqual(abrp.__test.lastSend(), null)
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    const ls = abrp.__test.lastSend()
    assert.strictEqual(ls.ok, true)
    assert.strictEqual(ls.code, 200)
    assert.strictEqual(ls.count, 1)
    assert.ok(ls.ts)
  })

  it('records lastSend as failed on a network error', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].fail('boom')
    const ls = abrp.__test.lastSend()
    assert.strictEqual(ls.ok, false)
    assert.ok(ls.error)
    assert.ok(ls.ts)
  })

  it('records lastSend as not-ok on a 200 with status:error', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].done({ statusCode: 200, body: '{"status":"error"}' })
    const ls = abrp.__test.lastSend()
    assert.strictEqual(ls.ok, false)
    assert.strictEqual(ls.code, 200)
  })
})

describe('getOVMSMetric: capacity and soe', () => {
  function withMetrics(present) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
  }

  it('capacity maps directly from v.b.capacity (kWh)', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    assert.deepStrictEqual(abrp.getOVMSMetric('capacity'), [true, 60])
  })

  it('soe is derived as (soc/100) * capacity', () => {
    const abrp = withMetrics({ 'v.b.soc': 50, 'v.b.capacity': 60 })
    assert.deepStrictEqual(abrp.getOVMSMetric('soe'), [true, 30])
  })

  it('capacity is unsupported when v.b.capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    assert.deepStrictEqual(abrp.getOVMSMetric('capacity'), [false, null])
  })

  it('soe is unsupported when capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    assert.deepStrictEqual(abrp.getOVMSMetric('soe'), [false, null])
  })

  it('soe is unsupported when soc is absent', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    assert.deepStrictEqual(abrp.getOVMSMetric('soe'), [false, null])
  })
})

describe('getOVMSMetric: tyre pressures from the v.t.pressure vector', () => {
  function withMetrics(present) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
  }

  // OVMS pushes a vector metric to Duktape as a JS array; wheel order FL=0, FR=1, RL=2, RR=3.
  it('each corner reads its fixed index of v.t.pressure (kPa)', () => {
    const abrp = withMetrics({ 'v.t.pressure': [230, 231, 232, 233] })
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_fl'), [true, 230])
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_fr'), [true, 231])
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_rl'), [true, 232])
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_rr'), [true, 233])
  })

  it('tyre pressures are unsupported when v.t.pressure is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_fl'), [false, null])
    assert.deepStrictEqual(abrp.getOVMSMetric('tire_pressure_rr'), [false, null])
  })
})

describe('sendBulkTelemetry queue-overflow during an in-flight batch', () => {
  it('a successful flush drops only the points that were actually sent', () => {
    const requests = []
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.setSendInterval(0) // disable the flush gate
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
    // identifiable points.
    for (let i = 1; i <= 100; i++) q.push({ utc: i })

    abrp.__test.sendBulkTelemetry() // snapshots batch = utc 1..100
    assert.strictEqual(requests.length, 1)

    // While the request is in flight, 5 new points arrive. The queue is at
    // capacity, so enqueue's overflow drop shifts the oldest (utc 1..5,
    // which are part of the in-flight batch) out of the front.
    for (let i = 101; i <= 105; i++) abrp.__test.enqueue({ utc: i })

    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })

    const remaining = q.map((t) => t.utc)
    // The sent batch (utc 1..100) is removed by identity; the 1..5 that were
    // shifted out as overflow were also part of the (already-sent) batch, so
    // dropping them is harmless. Only the points queued during the flight remain.
    assert.deepStrictEqual(remaining, [101, 102, 103, 104, 105])
  })
})

describe('sendBulkTelemetry flush interval gate', () => {
  it('does not flush until send_interval has elapsed', () => {
    const requests = []
    const mono = { t: 0 }
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: (k) => (k === 'm.monotonic' ? mono.t : 0), HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.setSendInterval(30)
    const q = abrp.__test.getQueue()
    q.length = 0
    q.push({ utc: 1 })

    mono.t = 10; abrp.__test.sendBulkTelemetry()   // 10 - 0 < 30 -> gated
    assert.strictEqual(requests.length, 0)
    mono.t = 29; abrp.__test.sendBulkTelemetry()   // 29 - 0 < 30 -> still gated (just under)
    assert.strictEqual(requests.length, 0)
    mono.t = 30; abrp.__test.sendBulkTelemetry()   // 30 - 0 == 30, gate is strict < -> flush
    assert.strictEqual(requests.length, 1)
  })
})

describe('delta encoding (createBulkPost)', () => {
  it('first point full, rest carry utc + changed fields only', () => {
    const abrp = loadAbrp({ OvmsConfig: { GetValues: () => ({ user_token: 'T' }) } })
    const post = abrp.createBulkPost([
      { utc: 1, soc: 50, power: 3, lat: 51.1 },
      { utc: 2, soc: 50, power: 4, lat: 51.1 }, // power changed
      { utc: 3, soc: 51, power: 4, lat: 51.1 }, // soc changed
    ])
    const list = post.data[0].tlm_list
    assert.deepStrictEqual(list[0], { utc: 1, soc: 50, power: 3, lat: 51.1 }) // full
    assert.deepStrictEqual(list[1], { utc: 2, power: 4 })                     // delta
    assert.deepStrictEqual(list[2], { utc: 3, soc: 51 })                      // delta
  })

  it('does not mutate the input points', () => {
    const abrp = loadAbrp({ OvmsConfig: { GetValues: () => ({ user_token: 'T' }) } })
    const batch = [{ utc: 1, soc: 50 }, { utc: 2, soc: 50 }]
    abrp.createBulkPost(batch)
    assert.deepStrictEqual(batch[1], { utc: 2, soc: 50 }) // unchanged
  })
})

describe('change-based sampling (bundle)', () => {
  function withMonoMetrics(present, monoBox) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? monoBox.t : present[k]),
      },
    })
  }

  it('queues a point when a field changes, skips when only utc changes', () => {
    const present = { 'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 0 }
    const mono = { t: 0 }
    const abrp = withMonoMetrics(present, mono)
    abrp.__test.setSampleInterval(3)
    abrp.__test.getQueue().length = 0
    abrp.__test.setLastQueued({ utc: 0 })

    // First sample must be at >= interval (gate is mono - lastSampleMono < interval).
    mono.t = 3; abrp.__test.sample()            // soc 50 differs from baseline -> enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 1)

    present['m.time.utc'] = 1006; mono.t = 6    // only utc advances; soc unchanged
    abrp.__test.sample()
    assert.strictEqual(abrp.__test.getQueue().length, 1)
  })

  it('vehicle-off bookend forces a coherent parked snapshot', () => {
    const present = { 'm.time.utc': 2000, 'v.b.soc': 60, 'v.p.speed': 30, 'v.b.power': 8, 'v.e.parktime': 0 }
    const mono = { t: 0 }
    const abrp = loadAbrp({
      PubSub: { subscribe: () => 1, unsubscribe: () => {} },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.callbackVehicleOff()
    const q = abrp.__test.getQueue()
    assert.strictEqual(q.length, 1)
    const p = q[q.length - 1]
    assert.strictEqual(p.speed, 0)
    assert.strictEqual(p.power, 0)
    assert.strictEqual(p.is_parked, true)
    assert.strictEqual(p.is_charging, false)
    assert.strictEqual(p.is_dcfc, false)
    assert.strictEqual(p.soc, 60) // natural field preserved
  })

  it('vehicle-on bookend enqueues a full point and subscribes the sampler', () => {
    const present = { 'm.time.utc': 1500, 'v.b.soc': 55, 'v.e.parktime': 0 }
    const mono = { t: 0 }
    const subs = []
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({}) },
      PubSub: { subscribe: (topic) => { subs.push(topic); return 1 }, unsubscribe: () => {} },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.callbackVehicleOn()
    assert.strictEqual(abrp.__test.getQueue().length, 1)   // bookend enqueued
    assert.ok(subs.includes('ticker.1'))                   // sampler subscribed
  })
})

describe('cold-boot session detection (bundle)', () => {
  function bootWith(present) {
    const mono = { t: 0 }
    // NOTE: loadAbrp re-runs the bundle's auto-start (Ev.startup subscribes
    // ticker.1 -> checkTime), so ticker.1 is always in subs at load. The clean
    // signal that a SESSION started is the queue length — only callbackVehicleOn
    // enqueues a bookend.
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({}) },
      PubSub: { subscribe: () => 1, unsubscribe: () => {} },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.manageVehicleStateEvents(true)
    return abrp
  }

  it('reboot while charging (ignition off) still starts a session', () => {
    // v.e.on false but v.c.charging true: the charge.start edge already fired, so
    // the level check must catch it or the charge session goes unreported.
    const abrp = bootWith({
      'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 100,
      'v.e.on': false, 'v.c.charging': true,
    })
    assert.strictEqual(abrp.__test.getQueue().length, 1) // bookend enqueued => session started
  })

  it('reboot while off and not charging stays idle', () => {
    const abrp = bootWith({
      'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 100,
      'v.e.on': false, 'v.c.charging': false,
    })
    assert.strictEqual(abrp.__test.getQueue().length, 0) // no session
  })
})

describe('config.changed live-reload (bundle)', () => {
  it('applyIntervals re-reads send_interval; the flush gate uses the new value', () => {
    const requests = []
    const mono = { t: 0 }
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsConfig: { GetValues: () => ({ send_interval: '20' }) },
      OvmsMetrics: { Value: (k) => (k === 'm.monotonic' ? mono.t : 0), HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.applyIntervals() // re-reads -> setSendInterval(20)
    const q = abrp.__test.getQueue()
    q.length = 0
    q.push({ utc: 1 })

    mono.t = 19; abrp.__test.sendBulkTelemetry() // 19 - 0 < 20 -> gated
    assert.strictEqual(requests.length, 0)
    mono.t = 20; abrp.__test.sendBulkTelemetry() // 20 - 0 == 20, strict < -> flush
    assert.strictEqual(requests.length, 1)
  })

  it('applyIntervals re-reads sample_interval; the sampler gate uses the new value', () => {
    const present = { 'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 100 }
    const mono = { t: 0 }
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ sample_interval: '5' }) },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.applyIntervals() // re-reads -> setSampleInterval(5)
    abrp.__test.getQueue().length = 0
    abrp.__test.setLastQueued({ utc: 0 })

    mono.t = 4; abrp.__test.sample() // 4 - 0 < 5 -> gated, no enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 0)
    mono.t = 5; abrp.__test.sample() // 5 - 0 == 5, strict < -> sample; soc differs -> enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 1)
  })

  it('startup subscribes applyIntervals to config.changed', () => {
    const subs = []
    // All three host globals present -> the guarded Ev.startup() runs at load.
    loadAbrp({
      OvmsConfig: { GetValues: () => ({}) },
      OvmsMetrics: { Value: () => '', HasValue: () => false, GetValues: () => ({}) },
      PubSub: { subscribe: (topic) => { subs.push(topic); return 1 }, unsubscribe: () => {} },
    })
    assert.ok(subs.includes('config.changed'))
  })
})

describe('web status surface', () => {
  const C = require('../lib/abrp/constants')

  // Runs fn() with global.print captured; returns the concatenated output.
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

  it('webStatus prints a JSON snapshot of operational state', () => {
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    const q = abrp.__test.getQueue()
    q.length = 0
    q.push({ utc: 1 }, { utc: 2 })
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.strictEqual(s.version, C.VERSION)
    assert.strictEqual(s.token_set, true)
    assert.strictEqual(s.queue_depth, 2)
    assert.strictEqual(s.last_send, null)
    assert.deepStrictEqual(s.identity, { state: 'unknown' })
    assert.strictEqual(typeof s.sending, 'boolean')
    assert.strictEqual(typeof s.time_valid, 'boolean')
    assert.deepStrictEqual(s.telemetry, {})
  })

  it('webStatus includes key telemetry fields when sources have values', () => {
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      OvmsMetrics: { Value: () => 0, HasValue: () => true, GetValues: () => ({}) },
    })
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.ok('soc' in s.telemetry)
    assert.ok('power' in s.telemetry)
    assert.ok('speed' in s.telemetry)
    assert.ok('is_charging' in s.telemetry)
  })

  it('webStatus prints {error} on an internal failure', () => {
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      OvmsMetrics: {
        Value: () => 0,
        HasValue: () => {
          throw new Error('boom')
        },
        GetValues: () => ({}),
      },
    })
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.ok(s.error)
  })

  it('webIdentityRefresh with no token caches an error and fires no request', () => {
    const reqs = []
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({}) },
      HTTP: { Request: (o) => reqs.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    const ack = capture(() => abrp.webIdentityRefresh())
    assert.ok(ack.indexOf('"ok":false') !== -1)
    assert.strictEqual(reqs.length, 0)
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.strictEqual(s.identity.state, 'error')
  })

  it('webIdentityRefresh caches identity from a successful oauth/me', () => {
    const reqs = []
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      HTTP: { Request: (o) => reqs.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    const ack = capture(() => abrp.webIdentityRefresh())
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
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.strictEqual(s.identity.state, 'ok')
    assert.strictEqual(s.identity.name, 'Jane D')
    assert.strictEqual(s.identity.vehicle, 'Solterra')
    assert.strictEqual(s.identity.typecode, 'subaru:solterra:x')
  })

  it('webIdentityRefresh caches an error when oauth/me fails', () => {
    const reqs = []
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      HTTP: { Request: (o) => reqs.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    capture(() => abrp.webIdentityRefresh())
    reqs[0].fail('network down')
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.strictEqual(s.identity.state, 'error')
  })

  it('webIdentityRefresh caches an error when oauth/me returns status:error', () => {
    const reqs = []
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'TOK' }) },
      HTTP: { Request: (o) => reqs.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    capture(() => abrp.webIdentityRefresh())
    reqs[0].done({ statusCode: 200, body: '{"status":"error"}' })
    const s = JSON.parse(capture(() => abrp.webStatus()))
    assert.strictEqual(s.identity.state, 'error')
  })
})

describe('adaptive cadence __test seam', () => {
  it('is reachable and backs off under a slow collect', () => {
    const abrp = loadAbrp({ OvmsMetrics: { HasValue: () => false, GetValues: () => ({}), Value: () => 0 } })
    abrp.__test.setSampleInterval(3)
    abrp.__test.adjustCadence(90)  // seed baseline
    abrp.__test.adjustCadence(400) // slow collect (> 270) -> back off x2
    assert.strictEqual(abrp.__test.getEffectiveInterval(), 6)
    assert.strictEqual(abrp.__test.getBaseline(), 90)
  })
})

describe('web accessors', () => {
  it('isActive() reflects manageVehicleStateEvents', () => {
    const abrp = loadAbrp({
      PubSub: { subscribe: () => 1, unsubscribe: () => {} },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
      OvmsConfig: { GetValues: () => ({}) },
    })
    assert.strictEqual(abrp.__test.isActive(), false)
    abrp.__test.manageVehicleStateEvents(true)
    assert.strictEqual(abrp.__test.isActive(), true)
    abrp.__test.manageVehicleStateEvents(false)
    assert.strictEqual(abrp.__test.isActive(), false)
  })

  it('meUrl() builds the oauth/me URL with api_key and encoded token', () => {
    const abrp = loadAbrp()
    const url = abrp.__test.meUrl('a b')
    assert.ok(url.indexOf('https://api.iternio.com/1/oauth/me?') === 0)
    assert.ok(url.indexOf('api_key=') !== -1)
    assert.ok(url.indexOf('access_token=a%20b') !== -1)
  })
})
