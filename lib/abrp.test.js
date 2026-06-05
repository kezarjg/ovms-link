// Loads a fresh copy of the module with a clean global environment.
// Pass per-test host-global stubs (OvmsMetrics, HTTP, …) via `globals`.
// For stateful tests (shared module state), call loadAbrp() inside a setup()
// helper or beforeEach — NOT at describe-body level — so each test gets a fresh
// module instance. Describe-level calls share one instance across the block.
function loadAbrp(globals) {
  jest.resetModules()
  ;['OvmsConfig', 'OvmsMetrics', 'PubSub', 'HTTP', 'OvmsNotify'].forEach(
    (k) => {
      delete global[k]
    }
  )
  if (globals) Object.assign(global, globals)
  return require('../dist/abrp')
}

describe('round', () => {
  const { round } = loadAbrp()
  test('should default to no decimal', () => {
    expect(round(12)).toBe(12)
    expect(round(12.34567)).toBe(12)
  })
  test('should use provided precision', () => {
    expect(round(12.34567, 2)).toBe(12.35)
    expect(round(12.34, 6)).toBe(12.34)
  })
})

describe('medianPowerMetrics', () => {
  const { medianPowerMetrics } = loadAbrp()
  test('should return null with no array elements', () => {
    expect(medianPowerMetrics([])).toBeNull()
  })
  test('odd number of elements returns the middle by power', () => {
    expect(
      medianPowerMetrics([
        { power: 1, speed: 10 },
        { power: 2, speed: 4 },
        { power: 3, speed: 3 },
        { power: 4, speed: 2 },
        { power: 10, speed: 1 },
      ])
    ).toEqual({ power: 3, speed: 3 })
    expect(
      medianPowerMetrics([
        { power: 10, speed: 1 },
        { power: 1, speed: 10 },
        { power: 4, speed: 2 },
        { power: 2, speed: 4 },
        { power: 3, speed: 3 },
      ])
    ).toEqual({ power: 3, speed: 3 })
  })
  test('even number of elements returns the lower-power middle', () => {
    expect(
      medianPowerMetrics([
        { power: 1, speed: 10 },
        { power: 3, speed: 3 },
        { power: 4, speed: 2 },
        { power: 10, speed: 1 },
      ])
    ).toEqual({ power: 3, speed: 3 })
    expect(
      medianPowerMetrics([
        { power: 10, speed: 1 },
        { power: 1, speed: 10 },
        { power: 4, speed: 2 },
        { power: 3, speed: 3 },
      ])
    ).toEqual({ power: 3, speed: 3 })
  })
})

describe('isSignificantTelemetryChange', () => {
  const { isSignificantTelemetryChange } = loadAbrp()
  const base = { soc: 50, is_charging: false, is_parked: true, power: 0 }

  test('SoC change is significant', () => {
    expect(isSignificantTelemetryChange({ ...base, soc: 51 }, base)).toBe(true)
  })
  test('charging-state change is significant', () => {
    expect(
      isSignificantTelemetryChange({ ...base, is_charging: true }, base)
    ).toBe(true)
  })
  test('parked-state change is significant', () => {
    expect(
      isSignificantTelemetryChange({ ...base, is_parked: false }, base)
    ).toBe(true)
  })
  test('power change >1kW while charging is significant', () => {
    const prev = { ...base, is_charging: true, power: 5 }
    const cur = { ...base, is_charging: true, power: 7 }
    expect(isSignificantTelemetryChange(cur, prev)).toBe(true)
  })
  test('power change while NOT charging is not significant', () => {
    expect(isSignificantTelemetryChange({ ...base, power: 7 }, base)).toBe(
      false
    )
  })
  test('sub-1kW power change while charging is not significant', () => {
    const prev = { ...base, is_charging: true, power: 5 }
    const cur = { ...base, is_charging: true, power: 5.4 }
    expect(isSignificantTelemetryChange(cur, prev)).toBe(false)
  })
  test('identical telemetry is not significant', () => {
    expect(isSignificantTelemetryChange({ ...base }, base)).toBe(false)
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

  test('removes only the batch that was sent, despite concurrent appends', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 }, { utc: 3 })
    abrp.__test.sendBulkTelemetry()
    expect(requests).toHaveLength(1)
    // telemetry queued while the request is in flight
    q.push({ utc: 4 })
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    expect(q.map((t) => t.utc)).toEqual([4])
  })

  test('does not start a second send while one is in flight', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry() // starts; done not yet called
    abrp.__test.sendBulkTelemetry() // must be skipped
    expect(requests).toHaveLength(1)
  })

  test('leaves the queue intact on a 200 with status:error', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 })
    abrp.__test.sendBulkTelemetry()
    requests[0].done({ statusCode: 200, body: '{"status":"error"}' })
    expect(q.map((t) => t.utc)).toEqual([1, 2])
    abrp.__test.sendBulkTelemetry() // guard must be cleared after a rejected-but-200 response
    expect(requests).toHaveLength(2)
  })

  test('sends and removes at most MAX_BULK_BATCH_SIZE (10) per flush', () => {
    const { abrp, requests, q } = setup()
    for (let i = 1; i <= 15; i++) q.push({ utc: i })
    abrp.__test.sendBulkTelemetry()
    expect(requests).toHaveLength(1)
    expect(requests[0].post).toBeDefined()
    const sent = JSON.parse(requests[0].post).data[0].tlm_list
    expect(sent).toHaveLength(10)
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    expect(q.map((t) => t.utc)).toEqual([11, 12, 13, 14, 15])
  })

  test('clears the in-flight guard on failure so the next tick can retry', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].fail('timeout')
    abrp.__test.sendBulkTelemetry() // guard cleared => a new request goes out
    expect(requests).toHaveLength(2)
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

  test('capacity maps directly from v.b.capacity (kWh)', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('capacity')).toEqual([true, 60])
  })

  test('soe is derived as (soc/100) * capacity', () => {
    const abrp = withMetrics({ 'v.b.soc': 50, 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('soe')).toEqual([true, 30])
  })

  test('capacity is unsupported when v.b.capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('capacity')).toEqual([false, null])
  })

  test('soe is unsupported when capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('soe')).toEqual([false, null])
  })

  test('soe is unsupported when soc is absent', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('soe')).toEqual([false, null])
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
  test('each corner reads its fixed index of v.t.pressure (kPa)', () => {
    const abrp = withMetrics({ 'v.t.pressure': [230, 231, 232, 233] })
    expect(abrp.getOVMSMetric('tire_pressure_fl')).toEqual([true, 230])
    expect(abrp.getOVMSMetric('tire_pressure_fr')).toEqual([true, 231])
    expect(abrp.getOVMSMetric('tire_pressure_rl')).toEqual([true, 232])
    expect(abrp.getOVMSMetric('tire_pressure_rr')).toEqual([true, 233])
  })

  test('tyre pressures are unsupported when v.t.pressure is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('tire_pressure_fl')).toEqual([false, null])
    expect(abrp.getOVMSMetric('tire_pressure_rr')).toEqual([false, null])
  })
})

describe('median smoothing on the live path', () => {
  test('queueTelemetry applies the median power/speed when samples were collected', () => {
    const abrp = loadAbrp()
    abrp.__test.setLastQueued({ utc: 0 })
    abrp.__test.getQueue().length = 0
    abrp.__test.setCollected([
      { power: 1, speed: 10 },
      { power: 3, speed: 3 },
      { power: 10, speed: 1 },
    ])
    const telemetry = { utc: 100, soc: 50, power: 99, speed: 99 }
    abrp.__test.queueTelemetry(telemetry, true)
    const queued = abrp.__test.getQueue()
    expect(queued).toHaveLength(1)
    expect(queued[0].power).toBe(3) // median by power
    expect(queued[0].speed).toBe(3)
  })

  test('queueTelemetryIfNecessary collects a sample while driving', () => {
    const present = {
      'm.time.utc': 1000,
      'v.b.soc': 50,
      'v.p.speed': 30,
      'v.b.power': 5,
      'v.e.parktime': 0, // parktime 0 => is_parked false
    }
    const abrp = loadAbrp({
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
    // No significant change and no elapsed time => collect but do not queue.
    // Omit is_charging so it matches the undefined value createTelemetry yields
    // here (no v.c.charging stub) — otherwise the change looks "significant".
    abrp.__test.setLastQueued({
      utc: 1000,
      soc: 50,
      is_parked: false,
      power: 5,
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.setCollected([])
    abrp.__test.queueTelemetryIfNecessary()
    expect(abrp.__test.getCollected()).toHaveLength(1)
    expect(abrp.__test.getQueue()).toHaveLength(0)
  })

  test('an elapsed tick collects the current sample, queues the median, and resets collected', () => {
    const present = {
      'm.time.utc': 1000,
      'v.b.soc': 50,
      'v.p.speed': 100,
      'v.b.power': 7,
      'v.e.parktime': 0, // not parked
    }
    const abrp = loadAbrp({
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
    abrp.__test.setCollected([
      { power: 1, speed: 10 },
      { power: 3, speed: 3 },
      { power: 10, speed: 1 },
    ])
    abrp.__test.setLastQueued({ utc: 0 })
    abrp.__test.getQueue().length = 0
    abrp.__test.queueTelemetryIfNecessary()
    const q = abrp.__test.getQueue()
    expect(q).toHaveLength(1)
    expect(q[0].power).toBe(3)
    expect(q[0].speed).toBe(3)
    expect(abrp.__test.getCollected()).toHaveLength(0)
  })
})

describe('sendBulkTelemetry queue-overflow during an in-flight batch', () => {
  test('a successful flush drops only the points that were actually sent', () => {
    const requests = []
    const abrp = loadAbrp({ HTTP: { Request: (o) => requests.push(o) } })
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
    // identifiable points.
    for (let i = 1; i <= 100; i++) q.push({ utc: i })

    abrp.__test.sendBulkTelemetry() // snapshots batch = utc 1..10
    expect(requests).toHaveLength(1)

    // While the request is in flight, 5 new points arrive. The queue is at
    // capacity, so queueTelemetry's overflow drop shifts the oldest (utc 1..5,
    // which are part of the in-flight batch) out of the front.
    for (let i = 101; i <= 105; i++) abrp.__test.queueTelemetry({ utc: i }, false)

    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })

    const remaining = q.map((t) => t.utc)
    // The sent batch (utc 1..10) must be gone...
    expect(remaining).not.toContain(10)
    // ...but the unsent points just behind it must NOT be dropped. The buggy
    // front-splice removes utc 6..15, silently discarding the never-sent 11..15.
    expect(remaining).toContain(11)
    expect(remaining).toContain(15)
    // ...and the newly queued points are retained.
    expect(remaining).toContain(105)
  })
})
