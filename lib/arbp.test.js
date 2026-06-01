// Loads a fresh copy of the module with a clean global environment.
// Pass per-test host-global stubs (OvmsMetrics, HTTP, …) via `globals`.
// For stateful tests (shared module state), call loadAbrp() inside a setup()
// helper or beforeEach — NOT at describe-body level — so each test gets a fresh
// module instance. Describe-level calls share one instance across the block.
function loadAbrp(globals) {
  jest.resetModules()
  ;['OvmsConfig', 'OvmsMetrics', 'PubSub', 'HTTP', 'OvmsNotify'].forEach((k) => {
    delete global[k]
  })
  if (globals) Object.assign(global, globals)
  return require('./abrp')
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
    expect(isSignificantTelemetryChange({ ...base, power: 7 }, base)).toBe(false)
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
