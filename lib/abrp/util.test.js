const { round, medianPowerMetrics } = require('./util')

test('round defaults to integer', () => {
  expect(round(12.34567)).toBe(12)
  expect(round(12.34567, 2)).toBe(12.35)
})

test('medianPowerMetrics returns null on empty', () => {
  expect(medianPowerMetrics([])).toBeNull()
})

test('medianPowerMetrics picks the lower-power middle (even)', () => {
  expect(
    medianPowerMetrics([
      { power: 10, speed: 1 },
      { power: 1, speed: 10 },
      { power: 4, speed: 2 },
      { power: 3, speed: 3 },
    ])
  ).toEqual({ power: 3, speed: 3 })
})
