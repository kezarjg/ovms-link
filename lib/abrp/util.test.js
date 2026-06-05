const { test } = require('node:test')
const assert = require('node:assert')
const { round, medianPowerMetrics } = require('./util')

test('round defaults to integer', () => {
  assert.strictEqual(round(12.34567), 12)
  assert.strictEqual(round(12.34567, 2), 12.35)
})

test('medianPowerMetrics returns null on empty', () => {
  assert.strictEqual(medianPowerMetrics([]), null)
})

test('medianPowerMetrics picks the lower-power middle (even)', () => {
  assert.deepStrictEqual(
    medianPowerMetrics([
      { power: 10, speed: 1 },
      { power: 1, speed: 10 },
      { power: 4, speed: 2 },
      { power: 3, speed: 3 },
    ]),
    { power: 3, speed: 3 }
  )
})
