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
