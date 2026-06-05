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
