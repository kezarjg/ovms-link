const { test } = require('node:test')
const assert = require('node:assert')

function withMetrics(present) {
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
  }
  global.performance = { now: () => 0 }
  return require('./metrics')
}

test('soe derives (soc/100)*capacity', () => {
  const Met = withMetrics({ 'v.b.soc': 50, 'v.b.capacity': 60 })
  assert.deepStrictEqual(Met.getOVMSMetric('soe'), [true, 30])
})
