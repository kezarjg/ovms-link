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
    const abrp = loadAbrp({ HTTP: { Request: (o) => requests.push(o) } })
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

  it('sends and removes at most MAX_BULK_BATCH_SIZE (10) per flush', () => {
    const { abrp, requests, q } = setup()
    for (let i = 1; i <= 15; i++) q.push({ utc: i })
    abrp.__test.sendBulkTelemetry()
    assert.strictEqual(requests.length, 1)
    assert.notStrictEqual(requests[0].post, undefined)
    const sent = JSON.parse(requests[0].post).data[0].tlm_list
    assert.strictEqual(sent.length, 10)
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    assert.deepStrictEqual(q.map((t) => t.utc), [11, 12, 13, 14, 15])
  })

  it('clears the in-flight guard on failure so the next tick can retry', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].fail('timeout')
    abrp.__test.sendBulkTelemetry() // guard cleared => a new request goes out
    assert.strictEqual(requests.length, 2)
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
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
    // identifiable points.
    for (let i = 1; i <= 100; i++) q.push({ utc: i })

    abrp.__test.sendBulkTelemetry() // snapshots batch = utc 1..10
    assert.strictEqual(requests.length, 1)

    // While the request is in flight, 5 new points arrive. The queue is at
    // capacity, so enqueue's overflow drop shifts the oldest (utc 1..5,
    // which are part of the in-flight batch) out of the front.
    for (let i = 101; i <= 105; i++) abrp.__test.enqueue({ utc: i })

    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })

    const remaining = q.map((t) => t.utc)
    // The sent batch (utc 1..10) must be gone...
    assert.ok(!remaining.includes(10))
    // ...but the unsent points just behind it must NOT be dropped. The buggy
    // front-splice removes utc 6..15, silently discarding the never-sent 11..15.
    assert.ok(remaining.includes(11))
    assert.ok(remaining.includes(15))
    // ...and the newly queued points are retained.
    assert.ok(remaining.includes(105))
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
