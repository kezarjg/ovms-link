const { test } = require('node:test')
const assert = require('node:assert')

function loadShim(pubsub) {
  delete global.PubSub
  if (pubsub) global.PubSub = pubsub
  delete require.cache[require.resolve('./abrp-shim')]
  return require('./abrp-shim')
}

test('shim is a no-op module that defers the core load to ticker.1', () => {
  let cb = null
  const exp = loadShim({
    subscribe(topic, fn) {
      if (topic === 'ticker.1') cb = fn
      return 9
    },
    unsubscribe() {},
  })
  assert.deepStrictEqual(exp, {}) // no-op export at load — the core is NOT loaded yet
  assert.strictEqual(typeof cb, 'function') // deferred onto ticker.1
  // Firing the ticker require()s the abrp-core element. Off-device that id does
  // not resolve, which proves the shim tries to load exactly abrp-core on the tick
  // (rather than compiling anything at load).
  assert.throws(() => cb(), /abrp-core/)
  delete global.PubSub
})

test('shim is side-effect-free off-device (no PubSub, no ticker)', () => {
  const exp = loadShim(null) // PubSub undefined
  assert.deepStrictEqual(exp, {})
})
