const { test } = require('node:test')
const assert = require('node:assert')

function withConfig(values) {
  delete require.cache[require.resolve('./config')]
  global.OvmsConfig = {
    GetValues: () => values,
    Delete: () => {},
  }
  return require('./config')
}

test('sampleInterval defaults to 3 when unset', () => {
  const Cfg = withConfig({})
  assert.strictEqual(Cfg.sampleInterval(), 3)
})

test('sampleInterval reads and clamps usr abrp.sample_interval to 1..5', () => {
  assert.strictEqual(withConfig({ sample_interval: '2' }).sampleInterval(), 2)
  assert.strictEqual(withConfig({ sample_interval: '0' }).sampleInterval(), 1)
  assert.strictEqual(withConfig({ sample_interval: '9' }).sampleInterval(), 5)
  assert.strictEqual(withConfig({ sample_interval: 'x' }).sampleInterval(), 3)
})

test('sendInterval defaults to 30 when unset', () => {
  assert.strictEqual(withConfig({}).sendInterval(), 30)
})

test('sendInterval reads and clamps usr abrp.send_interval to 10..60', () => {
  assert.strictEqual(withConfig({ send_interval: '20' }).sendInterval(), 20)
  assert.strictEqual(withConfig({ send_interval: '5' }).sendInterval(), 10)
  assert.strictEqual(withConfig({ send_interval: '90' }).sendInterval(), 60)
  assert.strictEqual(withConfig({ send_interval: 'x' }).sendInterval(), 30)
})

test('heartbeatInterval defaults to 160 when unset or non-numeric', () => {
  assert.strictEqual(withConfig({}).heartbeatInterval(), 160)
  assert.strictEqual(withConfig({ heartbeat_interval: 'x' }).heartbeatInterval(), 160)
})

test('heartbeatInterval: 0 disables; small positives floor to 30; capped at 3600', () => {
  assert.strictEqual(withConfig({ heartbeat_interval: '300' }).heartbeatInterval(), 300)
  assert.strictEqual(withConfig({ heartbeat_interval: '0' }).heartbeatInterval(), 0)      // explicit disable
  assert.strictEqual(withConfig({ heartbeat_interval: '5' }).heartbeatInterval(), 30)     // floor
  assert.strictEqual(withConfig({ heartbeat_interval: '99999' }).heartbeatInterval(), 3600) // cap
})

test('chargePowerDeltaKw defaults to 1 when unset or non-numeric', () => {
  assert.strictEqual(withConfig({}).chargePowerDeltaKw(), 1)
  assert.strictEqual(withConfig({ charge_power_delta_kw: 'x' }).chargePowerDeltaKw(), 1)
})

test('chargePowerDeltaKw: fractional allowed, 0 permitted, negatives -> 0, capped at 10', () => {
  assert.strictEqual(withConfig({ charge_power_delta_kw: '2' }).chargePowerDeltaKw(), 2)
  assert.strictEqual(withConfig({ charge_power_delta_kw: '0.5' }).chargePowerDeltaKw(), 0.5)
  assert.strictEqual(withConfig({ charge_power_delta_kw: '0' }).chargePowerDeltaKw(), 0)
  assert.strictEqual(withConfig({ charge_power_delta_kw: '-3' }).chargePowerDeltaKw(), 0)
  assert.strictEqual(withConfig({ charge_power_delta_kw: '25' }).chargePowerDeltaKw(), 10)
})
