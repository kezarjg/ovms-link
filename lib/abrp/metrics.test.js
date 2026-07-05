const { test } = require('node:test')
const assert = require('node:assert')

function withMetrics(present, vtype) {
  // Fresh metrics module per call (rebuilds metricMap); replaces jest.resetModules.
  delete require.cache[require.resolve('./metrics')]
  global.OvmsMetrics = {
    HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
    GetValues: (keys) => {
      const o = {}
      keys.forEach((k) => {
        o[k] = present[k]
      })
      return o
    },
    Value: (k) => (k === 'v.type' ? vtype : present[k]),
  }
  global.performance = { now: () => 0 }
  return require('./metrics')
}

test('soe derives (soc/100)*capacity', () => {
  const Met = withMetrics({ 'v.b.soc': 50, 'v.b.capacity': 60 })
  assert.deepStrictEqual(Met.getOVMSMetric('soe'), [true, 30])
})

// Characterization tests for overrideMetricMap (previously uncovered) so the
// Lever B/C refactors can't silently change vehicle-specific behavior.

test('NL override: soc/soh read the instrument-cluster metrics', () => {
  const Met = withMetrics({ 'xnl.v.b.soc.instrument': 77, 'xnl.v.b.soh.instrument': 91 }, 'NL')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('soc'), [true, 77])
  assert.deepStrictEqual(Met.getOVMSMetric('soh'), [true, 91])
})

test('NL override: est_battery_range picks ideal when it exceeds 1.1x instrument, else instrument', () => {
  let Met = withMetrics({ 'xnl.v.b.range.instrument': 100, 'v.b.range.ideal': 130 }, 'NL')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('est_battery_range'), [true, 130])

  Met = withMetrics({ 'xnl.v.b.range.instrument': 100, 'v.b.range.ideal': 105 }, 'NL')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('est_battery_range'), [true, 100])
})

test('KS override: soh is dropped (unsupported)', () => {
  const Met = withMetrics({ 'v.b.soh': 95 }, 'KS')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('soh'), [false, null])
})

test('SUBSOL override: is_parked from v.e.gear, hvac_power from xte', () => {
  const Met = withMetrics({ 'v.e.gear': 0, 'xte.v.e.hvac.power': 1.2 }, 'SUBSOL')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('is_parked'), [true, true])
  assert.deepStrictEqual(Met.getOVMSMetric('hvac_power'), [true, 1.2])
})

test('TOYBZ4X override matches SUBSOL (is_parked from gear)', () => {
  const Met = withMetrics({ 'v.e.gear': 1 }, 'TOYBZ4X')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('is_parked'), [true, false])
})

test('no override for an unknown vehicle type leaves base metrics intact', () => {
  const Met = withMetrics({ 'v.b.soc': 42 }, 'UNKNOWN')
  Met.overrideMetricMap()
  assert.deepStrictEqual(Met.getOVMSMetric('soc'), [true, 42])
})
