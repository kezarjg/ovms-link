const { test } = require('node:test')
const assert = require('node:assert')
const { round } = require('./util')

test('round defaults to integer', () => {
  assert.strictEqual(round(12.34567), 12)
  assert.strictEqual(round(12.34567, 2), 12.35)
})
