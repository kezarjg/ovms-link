const { test } = require('node:test')
const assert = require('node:assert')
const Bw = require('./bandwidth')

test('classify maps a charging point to the charging bucket', () => {
  Bw.reset()
  assert.strictEqual(Bw.classify({ is_charging: true, is_parked: true }), 'charging')
})

test('classify maps a moving point to the driving bucket', () => {
  assert.strictEqual(Bw.classify({ is_charging: false, is_parked: false }), 'driving')
})

test('classify maps a parked, non-charging point to idle (incl. missing fields)', () => {
  assert.strictEqual(Bw.classify({ is_charging: false, is_parked: true }), 'idle')
  assert.strictEqual(Bw.classify({}), 'idle')
})

test('record accumulates up/down/reqs into the phase bucket', () => {
  Bw.reset()
  Bw.record({ is_parked: false }, 100, 10)
  Bw.record({ is_parked: false }, 50, 5)
  Bw.record({ is_charging: true }, 80, 8)
  const s = Bw.snapshot()
  assert.deepStrictEqual(s.driving, { up: 150, down: 15, reqs: 2 })
  assert.deepStrictEqual(s.charging, { up: 80, down: 8, reqs: 1 })
  assert.deepStrictEqual(s.idle, { up: 0, down: 0, reqs: 0 })
})

test('snapshot computes a total across all phases', () => {
  Bw.reset()
  Bw.record({ is_parked: false }, 100, 10)
  Bw.record({ is_charging: true }, 80, 8)
  assert.deepStrictEqual(Bw.snapshot().total, { up: 180, down: 18, reqs: 2 })
})

test('snapshot is a copy — later records do not mutate a prior snapshot', () => {
  Bw.reset()
  Bw.record({ is_parked: false }, 100, 10)
  const s = Bw.snapshot()
  Bw.record({ is_parked: false }, 1, 1)
  assert.strictEqual(s.driving.up, 100)
})

test('reset zeroes all buckets', () => {
  Bw.record({ is_parked: false }, 100, 10)
  Bw.reset()
  assert.deepStrictEqual(Bw.snapshot().total, { up: 0, down: 0, reqs: 0 })
})
