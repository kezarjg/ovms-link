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

// Drives sample()/enqueue() with a controllable monotonic clock + metric stub.
function loadQueueWithClock(present, monoBox) {
  delete require.cache[require.resolve('./queue')]
  delete require.cache[require.resolve('./metrics')]
  global.performance = { now: () => 0 }
  global.OvmsMetrics = {
    HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
    GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
    Value: (k) => (k === 'm.monotonic' ? monoBox.t : present[k]),
  }
  return require('./queue')
}

test('sample enqueues only after the interval has elapsed', () => {
  const present = { 'm.time.utc': 1000, 'v.b.soc': 50 }
  const mono = { t: 100 }
  const Q = loadQueueWithClock(present, mono)
  Q.setSampleInterval(3)
  Q.getQueue().length = 0
  Q.setLastQueued({ utc: 0 })

  mono.t = 100; Q.sample()           // first call: elapsed from 0 -> runs, soc changed -> enqueue
  assert.strictEqual(Q.getQueue().length, 1)
  mono.t = 101; Q.sample()           // 1s later: under interval -> skip
  assert.strictEqual(Q.getQueue().length, 1)
})

test('sample skips when nothing changed, but heartbeat forces a point', () => {
  const present = { 'm.time.utc': 1000, 'v.b.soc': 50 }
  const mono = { t: 0 }
  const Q = loadQueueWithClock(present, mono)
  Q.setSampleInterval(3)
  Q.getQueue().length = 0
  // Seed lastQueued to the same rounded values createTelemetry will produce (soc 50).
  mono.t = 0; Q.enqueue(Q.roundTelemetry({ utc: 1000, soc: 50 }))
  assert.strictEqual(Q.getQueue().length, 1)

  mono.t = 10; Q.sample()            // changed? no (only utc) -> skip (10 < 160 heartbeat)
  assert.strictEqual(Q.getQueue().length, 1)
  mono.t = 200; Q.sample()           // heartbeat elapsed (>=160) -> force enqueue
  assert.strictEqual(Q.getQueue().length, 2)
})

test('enqueue applies the overflow drop by oldest', () => {
  const Q = loadQueueWithClock({ 'm.time.utc': 1 }, { t: 0 })
  Q.getQueue().length = 0
  for (let i = 1; i <= 101; i++) Q.enqueue({ utc: i })
  const q = Q.getQueue()
  assert.strictEqual(q.length, 100)
  assert.strictEqual(q[0].utc, 2)     // utc 1 was shifted out
})

test('adjustCadence seeds the baseline on the first collect without stepping', () => {
  const Q = loadQueue()
  Q.setSampleInterval(3)
  assert.strictEqual(Q.getEffectiveInterval(), 3)
  Q.adjustCadence(90)
  assert.strictEqual(Q.getBaseline(), 90)
  assert.strictEqual(Q.getEffectiveInterval(), 3) // seed takes no step
})

test('adjustCadence backs off x2 on slow collects, capped, baseline unpoisoned', () => {
  const Q = loadQueue()
  Q.setSampleInterval(3)
  Q.adjustCadence(90) // seed baseline = 90; threshold = 270
  const steps = []
  for (let i = 0; i < 8; i++) { Q.adjustCadence(400); steps.push(Q.getEffectiveInterval()) }
  assert.deepStrictEqual(steps, [6, 12, 24, 48, 96, 180, 180, 180])
  assert.strictEqual(Q.getBaseline(), 90) // slow collects never update the baseline
})

test('adjustCadence ignores ms<=0 (never seeds or steps on a zero/negative timing)', () => {
  const Q = loadQueue()
  Q.setSampleInterval(3)
  Q.adjustCadence(0)                          // zero timing: guarded out, no seed
  assert.strictEqual(Q.getBaseline(), null)   // baseline still unseeded
  assert.strictEqual(Q.getEffectiveInterval(), 3)
  Q.adjustCadence(90)                         // now seed for real
  Q.adjustCadence(0)                          // zero again: no step, baseline untouched
  assert.strictEqual(Q.getBaseline(), 90)
  assert.strictEqual(Q.getEffectiveInterval(), 3)
})

test('adjustCadence recovers /2 on calm collects, floored at baseInterval', () => {
  const Q = loadQueue()
  Q.setSampleInterval(3)
  Q.adjustCadence(90)
  for (let i = 0; i < 8; i++) Q.adjustCadence(400) // pin at 180
  assert.strictEqual(Q.getEffectiveInterval(), 180)
  const steps = []
  for (let i = 0; i < 7; i++) { Q.adjustCadence(95); steps.push(Q.getEffectiveInterval()) }
  assert.deepStrictEqual(steps, [90, 45, 22, 11, 5, 3, 3])
})

test('sample() times the collect and backs off under slow collects', () => {
  const present = { 'm.time.utc': 1000, 'v.b.soc': 50 }
  const mono = { t: 0 }
  const durations = [90, 400, 400] // ms returned for successive collects
  let s = 0      // collect index
  let half = 0   // 0 = t0 read, 1 = t1 read within one sample()
  delete require.cache[require.resolve('./queue')]
  delete require.cache[require.resolve('./metrics')]
  global.performance = {
    now: () => {
      if (half === 0) { half = 1; return 0 }
      half = 0; return durations[s++]
    },
  }
  global.OvmsMetrics = {
    HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
    GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
    Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
  }
  const Q = require('./queue')
  Q.setSampleInterval(3)
  Q.getQueue().length = 0
  Q.setLastQueued({ utc: 0 })
  Q.setLastSampleMono(-Infinity) // ensure gate opens on the very first call

  mono.t = 0;   Q.sample() // collect 90 -> seed baseline, stays at floor
  assert.strictEqual(Q.getEffectiveInterval(), 3)
  mono.t = 10;  Q.sample() // collect 400 (> 270) -> x2 -> 6
  assert.strictEqual(Q.getEffectiveInterval(), 6)
  mono.t = 100; Q.sample() // collect 400 -> x2 -> 12
  assert.strictEqual(Q.getEffectiveInterval(), 12)
})

test('setSampleInterval re-floors the effective interval; baseline persists', () => {
  const Q = loadQueue()
  Q.setSampleInterval(3)
  Q.adjustCadence(90)                       // seed baseline = 90
  for (let i = 0; i < 8; i++) Q.adjustCadence(400) // back off to the cap
  assert.strictEqual(Q.getEffectiveInterval(), 180)
  Q.setSampleInterval(2)                    // e.g. config.changed mid-drive
  assert.strictEqual(Q.getEffectiveInterval(), 2)  // reset to the new floor
  assert.strictEqual(Q.getBaseline(), 90)          // baseline unchanged by slow collects / re-floor
})
