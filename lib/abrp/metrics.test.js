function withMetrics(present) {
  jest.resetModules()
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
  expect(Met.getOVMSMetric('soe')).toEqual([true, 30])
})
