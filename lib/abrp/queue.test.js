const { test } = require('node:test')
const assert = require('node:assert')

function loadQueue() {
  delete require.cache[require.resolve('./queue')]
  delete require.cache[require.resolve('./metrics')]
  global.OvmsMetrics = { HasValue: () => false, GetValues: () => ({}), Value: () => 0 }
  global.performance = { now: () => 0 }
  return require('./queue')
}

test('roundTelemetry rounds mapped fields, leaves others untouched', () => {
  const Q = loadQueue()
  const out = Q.roundTelemetry({ utc: 100, power: 5.146, speed: 42.7, lat: 51.123456789, is_parked: true })
  assert.strictEqual(out.utc, 100)        // unmapped -> untouched
  assert.strictEqual(out.power, 5.1)      // 1 dp
  assert.strictEqual(out.speed, 43)       // 0 dp
  assert.strictEqual(out.lat, 51.12346)   // 5 dp
  assert.strictEqual(out.is_parked, true) // boolean untouched
})

test('changedVsLastQueued ignores utc and sub-precision noise', () => {
  const Q = loadQueue()
  Q.setLastQueued({ utc: 10, power: 5.1, soc: 50 })
  assert.strictEqual(Q.changedVsLastQueued({ utc: 11, power: 5.1, soc: 50 }), false) // only utc
  assert.strictEqual(Q.changedVsLastQueued({ utc: 11, power: 5.2, soc: 50 }), true)  // power moved
  assert.strictEqual(Q.changedVsLastQueued({ utc: 11, power: 5.1, soc: 51 }), true)  // soc moved
})
