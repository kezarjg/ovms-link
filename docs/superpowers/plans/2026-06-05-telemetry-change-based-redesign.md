# Change-Based Telemetry Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace median smoothing + state-adaptive cadence with a change-based telemetry model: sample every N seconds (config 1–5, default 3) gated on `m.monotonic`, round per field, queue full snapshots only when something changed (+ a heartbeat), and delta-encode at send (first-of-batch full).

**Architecture:** All cadence logic moves into a single `sample()` loop in `queue.js` driven by `m.monotonic` elapsed time. The queue holds full *rounded* snapshots; `telemetry.js` delta-encodes each bulk POST (first point full → per-flush resync, drop-safe). Bookends in `events.js` become unconditional full enqueues; the off-bookend forces a coherent parked state. Spec: `docs/superpowers/specs/2026-06-05-telemetry-change-based-redesign-design.md`.

**Tech Stack:** JavaScript (ES2015 / Duktape-safe — `var`/`function` only, no arrows/templates/spread in `lib/abrp/*` or the bundle), Node 22, `node:test` + `node:assert`, ESLint 8. Build: `node build.js …` then run tests against `dist/abrp.js`.

---

## Conventions

- **Duktape-safe source:** every file under `lib/abrp/` uses `var` + `function` only. No arrow functions, template literals, object spread. (Test files may use modern JS.)
- **Green at every step:** after each task, `npm test` (which builds the bundle first) must pass, and `npx eslint lib/ build.js test/` must be clean. Commit only when green.
- **Sequencing:** Tasks 1–3 are purely additive (nothing removed). Task 4 switches consumers to the new code while the old code stays dormant. Task 5 removes all dead code + dead tests at once. Task 6 adds delta encoding. Task 7 bumps version + docs.
- **`m.monotonic` in tests:** any test that drives `sample()`/`enqueue()` must stub `OvmsMetrics.Value('m.monotonic')`. Tests that only push to the queue directly do not.

## File map

| File | Change |
| --- | --- |
| `lib/abrp/constants.js` | +`SAMPLE_INTERVAL_DEFAULT`, `HEARTBEAT_INTERVAL`, `ROUNDING` (T1); −`MIN_CALIBRATION_SPEED`, `METRIC_POLL_RATE_DRIVING`, `METRIC_POLL_RATE_CHARGING`, `METRIC_POLL_STALE_CONNECTION`, `BANDWIDTH_SAVER` (T5); `VERSION` bump (T7) |
| `lib/abrp/config.js` | +`require('./constants')`, +`sampleInterval()` (T1) |
| `lib/abrp/queue.js` | +`roundTelemetry`, `changedVsLastQueued` (T2); +`sample`, `enqueue`, `setSampleInterval`, mono state (T3); −old cadence/smoothing fns + `collectedMetrics` (T5) |
| `lib/abrp/events.js` | bookends → `enqueue`/`sample` + `setSampleInterval` (T4) |
| `lib/abrp/abrp.js` | `__test` seam → new fns (T4); drop `isSignificantTelemetryChange`/`calculateMaxElapsedDuration`/`medianPowerMetrics` exports (T5) |
| `lib/abrp/telemetry.js` | +`deltaEncode`, wire into `createBulkPost` (T6) |
| `lib/abrp/util.js` | −`medianPowerMetrics` + export (T5) |
| `lib/abrp/queue.test.js` | new module tests (T2, T3) |
| `lib/abrp/config.test.js` | new (T1) |
| `lib/abrp.test.js` | repoint/extend bundle tests (T4); delete dead suites (T5); delta-encode asserts (T6) |
| `lib/abrp/util.test.js` | −median test (T5) |
| `CHANGELOG.md`, `docs/SPECIFICATION.md` | T7 |

---

## Task 1: Constants + config `sampleInterval()`

**Files:**
- Modify: `lib/abrp/constants.js`
- Modify: `lib/abrp/config.js`
- Create: `lib/abrp/config.test.js`

- [ ] **Step 1: Add the new constants (additive)**

In `lib/abrp/constants.js`, add these keys inside `module.exports` (after `MAX_BULK_BATCH_SIZE`, keep the trailing comma style):

```javascript
  MAX_BULK_BATCH_SIZE: 10, // max telemetry points per bulk POST
  SAMPLE_INTERVAL_DEFAULT: 3, // seconds between samples; overridden by usr abrp.sample_interval (1-5)
  HEARTBEAT_INTERVAL: 160, // seconds; force a point if nothing queued for this long; 0 disables
  ROUNDING: {
    soc: 0, power: 1, speed: 0, lat: 5, lon: 5, heading: 0, elevation: 0,
    ext_temp: 0, batt_temp: 0, cabin_temp: 0, hvac_setpoint: 0, hvac_power: 1,
    voltage: 0, current: 0, odometer: 1, est_battery_range: 0, soh: 0, soe: 1, capacity: 1,
    tire_pressure_fl: 0, tire_pressure_fr: 0, tire_pressure_rl: 0, tire_pressure_rr: 0,
  },
```

- [ ] **Step 2: Write the failing config test**

Create `lib/abrp/config.test.js`:

```javascript
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --require ./test/globals.js --test lib/abrp/config.test.js 2>&1 | grep -E "fail|not a function"`
Expected: FAIL — `Cfg.sampleInterval is not a function`.

- [ ] **Step 4: Implement `sampleInterval()`**

In `lib/abrp/config.js`, add the require at the very top (above the `user_token` line):

```javascript
var C = require('./constants')
```

Add this function before `module.exports`:

```javascript
/**
 * Returns the per-sample interval in seconds from usr abrp.sample_interval,
 * validated/clamped to 1..5, defaulting to SAMPLE_INTERVAL_DEFAULT.
 */
function sampleInterval() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').sample_interval
    : undefined
  var n = parseInt(raw, 10)
  if (isNaN(n)) { return C.SAMPLE_INTERVAL_DEFAULT }
  if (n < 1) { return 1 }
  if (n > 5) { return 5 }
  return n
}
```

Add it to the exports:

```javascript
module.exports = {
  token: token,
  validate: validate,
  reset: reset,
  sampleInterval: sampleInterval,
}
```

- [ ] **Step 5: Run tests + lint**

Run: `node --require ./test/globals.js --test lib/abrp/config.test.js 2>&1 | grep -E "^# (tests|pass|fail)|pass [0-9]"`
Expected: all pass.
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → no regressions.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/abrp/constants.js lib/abrp/config.js lib/abrp/config.test.js
git commit -m "feat(3.0): add sample-interval config + rounding/heartbeat constants"
```

---

## Task 2: Queue helpers — `roundTelemetry` + `changedVsLastQueued`

**Files:**
- Modify: `lib/abrp/queue.js`
- Create: `lib/abrp/queue.test.js`

- [ ] **Step 1: Write the failing tests**

Create `lib/abrp/queue.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js 2>&1 | grep -E "fail|not a function"`
Expected: FAIL — `Q.roundTelemetry is not a function`.

- [ ] **Step 3: Implement the helpers (additive)**

In `lib/abrp/queue.js`, add after the existing `var lastQueuedTelemetry = {...}` block:

```javascript
var ROUNDING = C.ROUNDING

/**
 * Rounds each telemetry field that has a precision in ROUNDING (in place).
 * Unmapped keys (utc, booleans) are left untouched. Returns the same object.
 */
function roundTelemetry(snap) {
  for (var k in snap) {
    if (Object.prototype.hasOwnProperty.call(ROUNDING, k)) {
      snap[k] = round(snap[k], ROUNDING[k])
    }
  }
  return snap
}

/**
 * True if any non-utc field of snap differs from the last queued point.
 */
function changedVsLastQueued(snap) {
  for (var k in snap) {
    if (k === 'utc') { continue }
    if (snap[k] !== lastQueuedTelemetry[k]) { return true }
  }
  return false
}
```

Add both to `module.exports` (alongside the existing entries):

```javascript
  roundTelemetry: roundTelemetry,
  changedVsLastQueued: changedVsLastQueued,
```

(`setLastQueued` already exists in the exports — `setCollected`/`setLastQueued` block.)

- [ ] **Step 4: Run tests + full suite + lint**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js 2>&1 | grep -E "pass|fail"`
Expected: pass.
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → no regressions.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/abrp/queue.js lib/abrp/queue.test.js
git commit -m "feat(3.0): add roundTelemetry + changedVsLastQueued helpers"
```

---

## Task 3: Queue `sample()` + `enqueue()` + cadence state

**Files:**
- Modify: `lib/abrp/queue.js`
- Modify: `lib/abrp/queue.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `lib/abrp/queue.test.js`:

```javascript
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js 2>&1 | grep -E "fail|not a function"`
Expected: FAIL — `Q.setSampleInterval is not a function`.

- [ ] **Step 3: Implement `sample`/`enqueue`/state (additive)**

In `lib/abrp/queue.js`, add the cadence state next to `var lastQueuedTelemetry`:

```javascript
var lastSampleMono = 0
var lastQueuedMono = 0
var sampleInterval = C.SAMPLE_INTERVAL_DEFAULT
```

Add these functions (after `changedVsLastQueued`):

```javascript
/**
 * Sets the per-session sample interval (seconds). Called at session start.
 */
function setSampleInterval(n) {
  sampleInterval = n
}

/**
 * Unconditionally queues a full snapshot, stamps the cadence baselines from
 * m.monotonic, and applies the overflow drop (oldest first).
 */
function enqueue(snap) {
  var mono = OvmsMetrics.Value('m.monotonic')
  telemetryToSend.push(snap)
  lastQueuedTelemetry = snap
  lastQueuedMono = mono
  lastSampleMono = mono
  if (telemetryToSend.length > C.MAX_TELEMETRY_QUEUE_SIZE) {
    telemetryToSend.shift()
    Logger.warn('Telemetry queue exceeded ' + C.MAX_TELEMETRY_QUEUE_SIZE + ' items. Oldest entry dropped.')
  }
  Logger.debug('Telemetry queued, data in queue:', telemetryToSend.length)
}

/**
 * Per-tick sampler (subscribed to ticker.1). Gated on m.monotonic elapsed time;
 * queues a rounded full snapshot only when a field changed, or on the heartbeat.
 */
function sample() {
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastSampleMono < sampleInterval) { return }
  lastSampleMono = mono
  var snap = roundTelemetry(Met.createTelemetry())
  if (changedVsLastQueued(snap)) {
    enqueue(snap)
  } else if (C.HEARTBEAT_INTERVAL > 0 && mono - lastQueuedMono >= C.HEARTBEAT_INTERVAL) {
    enqueue(snap)
  }
}
```

Add to `module.exports`:

```javascript
  setSampleInterval: setSampleInterval,
  enqueue: enqueue,
  sample: sample,
```

- [ ] **Step 4: Run tests + full suite + lint**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js 2>&1 | grep -E "pass|fail"`
Expected: pass.
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → no regressions.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/abrp/queue.js lib/abrp/queue.test.js
git commit -m "feat(3.0): add change-based sample() + enqueue() cadence loop"
```

---

## Task 4: Switch consumers — events bookends + entry `__test` seam

The old functions remain in place (dormant). This task points `events.js` and the entry's `__test` seam at the new code, and adds bundle-level tests for the new behavior.

**Files:**
- Modify: `lib/abrp/events.js`
- Modify: `lib/abrp/abrp.js`
- Modify: `lib/abrp.test.js`

- [ ] **Step 1: Rewire the bookends in `events.js`**

Replace `callbackVehicleOn` (currently lines ~44–49):

```javascript
function callbackVehicleOn() {
  Logger.info('Vehicle switched on...');
  Q.setSampleInterval(Cfg.sampleInterval());
  Q.enqueue(Q.roundTelemetry(Met.createTelemetry()));   // full bookend, rounded
  subscribe('ticker.1', Q.sample);
}
```

Replace `callbackVehicleOff` (currently lines ~59–65):

```javascript
function callbackVehicleOff() {
  Logger.info('Vehicle switched off...');
  unsubscribe('ticker.1');
  var snap = Q.roundTelemetry(Met.createTelemetry());
  snap.speed = 0;
  snap.power = 0;
  snap.is_parked = true;
  snap.is_charging = false;
  snap.is_dcfc = false;
  Q.enqueue(snap);                                       // forced parked bookend
}
```

`events.js` already requires `Met` and `Cfg` (used elsewhere) and `Q`. No new requires needed. (Verify: `grep -n "require('./metrics')\|require('./config')\|require('./queue')" lib/abrp/events.js`.)

- [ ] **Step 2: Repoint the entry `__test` seam in `lib/abrp/abrp.js`**

In `module.exports.__test`, replace the `queueTelemetryIfNecessary` line and add `sample`/`enqueue`. Change:

```javascript
    queueTelemetry: Q.queueTelemetry,
    queueTelemetryIfNecessary: Q.queueTelemetryIfNecessary,
```
to:
```javascript
    sample: Q.sample,
    enqueue: Q.enqueue,
    roundTelemetry: Q.roundTelemetry,
    setSampleInterval: Q.setSampleInterval,
    callbackVehicleOff: Ev.callbackVehicleOff,
```

`lib/abrp/abrp.js` already requires `Ev` (`var Ev = require('./events')`). Leave `getQueue`, `getCollected`, `setCollected`, `setLastQueued`, `removeTelemetry`, `sendBulkTelemetry`, `createTelemetry` as-is for now (removed/cleaned in Task 5).

- [ ] **Step 3: Add bundle-level tests for the new sampler/bookend wiring**

Append to `lib/abrp.test.js` (uses the existing `loadAbrp` helper):

```javascript
describe('change-based sampling (bundle)', () => {
  function withMonoMetrics(present, monoBox) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? monoBox.t : present[k]),
      },
    })
  }

  it('queues a point when a field changes, skips when only utc changes', () => {
    const present = { 'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 0 }
    const mono = { t: 0 }
    const abrp = withMonoMetrics(present, mono)
    abrp.__test.setSampleInterval(3)
    abrp.__test.getQueue().length = 0
    abrp.__test.setLastQueued({ utc: 0 })

    // First sample must be at >= interval (gate is mono - lastSampleMono < interval).
    mono.t = 3; abrp.__test.sample()            // soc 50 differs from baseline -> enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 1)

    present['m.time.utc'] = 1006; mono.t = 6    // only utc advances; soc unchanged
    abrp.__test.sample()
    assert.strictEqual(abrp.__test.getQueue().length, 1)
  })

  it('vehicle-off bookend forces a coherent parked snapshot', () => {
    const present = { 'm.time.utc': 2000, 'v.b.soc': 60, 'v.p.speed': 30, 'v.b.power': 8, 'v.e.parktime': 0 }
    const mono = { t: 0 }
    const abrp = loadAbrp({
      PubSub: { subscribe: () => 1, unsubscribe: () => {} },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.callbackVehicleOff()
    const q = abrp.__test.getQueue()
    assert.strictEqual(q.length, 1)
    const p = q[q.length - 1]
    assert.strictEqual(p.speed, 0)
    assert.strictEqual(p.power, 0)
    assert.strictEqual(p.is_parked, true)
    assert.strictEqual(p.is_charging, false)
    assert.strictEqual(p.is_dcfc, false)
    assert.strictEqual(p.soc, 60) // natural field preserved
  })
})
```

- [ ] **Step 4: Run the full suite + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass (old suites still green — old code dormant; new suite passes).
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/abrp/events.js lib/abrp/abrp.js lib/abrp.test.js
git commit -m "feat(3.0): wire bookends + test seam to change-based sampler"
```

---

## Task 5: Remove the old cadence/smoothing code + dead constants

Now that nothing references them, delete the old path in one atomic change, updating the few tests that referenced removed symbols.

**Files:**
- Modify: `lib/abrp/queue.js`, `lib/abrp/util.js`, `lib/abrp/constants.js`, `lib/abrp/abrp.js`
- Modify: `lib/abrp.test.js`, `lib/abrp/util.test.js`

- [ ] **Step 1: Delete dead functions/state from `queue.js`**

Remove these whole functions: `isSignificantTelemetryChange`, `calculateMaxElapsedDuration`, `queueTelemetry`, `queueTelemetryIfNecessary`, `queueTelemetryManual`. Remove the `var collectedMetrics = []` state. Remove the now-unused aliases `var clone = U.clone` and `var medianPowerMetrics = U.medianPowerMetrics` (keep `var round = U.round` and `var Logger = U.Logger`). In `module.exports`, remove: `queueTelemetry`, `queueTelemetryIfNecessary`, `queueTelemetryManual`, `isSignificantTelemetryChange`, `calculateMaxElapsedDuration`, `getCollected`, `setCollected`. Keep: `removeTelemetry`, `removeTelemetryBatch`, `snapshot`, `getQueue`, `setLastQueued`, `roundTelemetry`, `changedVsLastQueued`, `setSampleInterval`, `enqueue`, `sample`.

- [ ] **Step 2: Delete `medianPowerMetrics` from `util.js`**

Remove the `medianPowerMetrics` function and its `module.exports` entry. Keep `Logger`, `round`, `clone`, `timestamp`.

- [ ] **Step 3: Delete dead constants**

In `lib/abrp/constants.js`, remove `MIN_CALIBRATION_SPEED`, `METRIC_POLL_RATE_DRIVING`, `METRIC_POLL_RATE_CHARGING`, `METRIC_POLL_STALE_CONNECTION`, and `BANDWIDTH_SAVER`.

- [ ] **Step 4: Update entry exports in `lib/abrp/abrp.js`**

Remove these three lines from `module.exports`:

```javascript
  medianPowerMetrics: U.medianPowerMetrics,
  isSignificantTelemetryChange: Q.isSignificantTelemetryChange,
  calculateMaxElapsedDuration: Q.calculateMaxElapsedDuration,
```

In `__test`, remove `getCollected: Q.getCollected,` and `setCollected: Q.setCollected,`.

- [ ] **Step 5: Delete the obsolete test suites**

In `lib/abrp.test.js`, delete these `describe` blocks entirely: `medianPowerMetrics`, `isSignificantTelemetryChange`, and `median smoothing on the live path`. In the `sendBulkTelemetry queue-overflow during an in-flight batch` test, replace the two `abrp.__test.queueTelemetry({ utc: i }, false)` calls with `abrp.__test.enqueue({ utc: i })`, and add a `m.monotonic` value to its loaded globals so `enqueue` can read it — change its `loadAbrp({ HTTP: ... })` call to:

```javascript
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
```

In `lib/abrp/util.test.js`, delete the two `medianPowerMetrics` tests (keep the `round` test).

- [ ] **Step 6: Run the full suite + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass.
Run: `npx eslint lib/ build.js test/` → exit 0 (catches any now-unused `var`).

- [ ] **Step 7: Confirm the public surface**

Run:
```bash
node -e "global.print=function(){};global.performance={now:function(){return 0}};var a=require('./dist/abrp');console.log(Object.keys(a).sort().join(','))"
```
Expected: `__test,createBulkPost,getOVMSMetric,info,onetime,resetConfig,round,send` (no `medianPowerMetrics`/`isSignificantTelemetryChange`/`calculateMaxElapsedDuration`).

- [ ] **Step 8: Commit**

```bash
git add lib/abrp lib/abrp.test.js
git commit -m "refactor(3.0): remove median smoothing + state-adaptive cadence"
```

---

## Task 6: Delta encoding at send (`telemetry.js`)

**Files:**
- Modify: `lib/abrp/telemetry.js`
- Modify: `lib/abrp.test.js`

- [ ] **Step 1: Write the failing test**

Append to `lib/abrp.test.js`:

```javascript
describe('delta encoding (createBulkPost)', () => {
  it('first point full, rest carry utc + changed fields only', () => {
    const abrp = loadAbrp({ OvmsConfig: { GetValues: () => ({ user_token: 'T' }) } })
    const post = abrp.createBulkPost([
      { utc: 1, soc: 50, power: 3, lat: 51.1 },
      { utc: 2, soc: 50, power: 4, lat: 51.1 }, // power changed
      { utc: 3, soc: 51, power: 4, lat: 51.1 }, // soc changed
    ])
    const list = post.data[0].tlm_list
    assert.deepStrictEqual(list[0], { utc: 1, soc: 50, power: 3, lat: 51.1 }) // full
    assert.deepStrictEqual(list[1], { utc: 2, power: 4 })                     // delta
    assert.deepStrictEqual(list[2], { utc: 3, soc: 51 })                      // delta
  })

  it('does not mutate the input points', () => {
    const abrp = loadAbrp({ OvmsConfig: { GetValues: () => ({ user_token: 'T' }) } })
    const batch = [{ utc: 1, soc: 50 }, { utc: 2, soc: 50 }]
    abrp.createBulkPost(batch)
    assert.deepStrictEqual(batch[1], { utc: 2, soc: 50 }) // unchanged
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "delta encoding|fail"`
Expected: FAIL — `list[1]` still equals the full point (no delta encoding yet).

- [ ] **Step 3: Implement `deltaEncode` and wire it in**

In `lib/abrp/telemetry.js`, add `clone` to the util alias near the top (below `var Logger = U.Logger`):

```javascript
var clone = U.clone
```

Add the function above `createBulkPost`:

```javascript
/**
 * Delta-encodes a batch of full snapshots for transmission: the first point is
 * full (a resync), each subsequent point carries utc + only the fields that
 * changed from the previous point. Does not mutate the input points.
 */
function deltaEncode(batch) {
  var out = []
  var prev = null
  for (var i = 0; i < batch.length; i++) {
    var p = batch[i]
    if (prev === null) {
      out.push(clone(p))
    } else {
      var d = { utc: p.utc }
      for (var k in p) {
        if (k !== 'utc' && p[k] !== prev[k]) { d[k] = p[k] }
      }
      out.push(d)
    }
    prev = p
  }
  return out
}
```

Change `createBulkPost` to encode the batch:

```javascript
function createBulkPost(batch) {
  return {
    data: [
      {
        token: Cfg.token(),
        tlm_list: deltaEncode(batch),
      },
    ],
  }
}
```

- [ ] **Step 4: Run tests + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass — including the unchanged bulk data-integrity suite (removal is still by identity of the original points; the `{utc:N}`-only points delta-encode to `[{utc:1},{utc:2},…]`, length unchanged).
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add lib/abrp/telemetry.js lib/abrp.test.js
git commit -m "feat(3.0): delta-encode bulk telemetry (first-of-batch full resync)"
```

---

## Task 7: Version bump + docs

**Files:**
- Modify: `lib/abrp/constants.js`, `package.json`, `CHANGELOG.md`, `docs/SPECIFICATION.md`

- [ ] **Step 1: Bump VERSION**

In `lib/abrp/constants.js` set `VERSION: '3.0.0-alpha.1',`. In `package.json` set `"version": "3.0.0-alpha.1",`.

- [ ] **Step 2: CHANGELOG entry**

Add a top section to `CHANGELOG.md`:

```markdown
## 3.0.0-alpha.1 (unreleased)

- Change-based telemetry: sample every `usr abrp.sample_interval` seconds (1–5,
  default 3); queue a point only when a rounded metric changed since the last,
  with a heartbeat keep-alive (`HEARTBEAT_INTERVAL`, 0 disables). Removes median
  smoothing and the state-adaptive cadence.
- Bulk telemetry is delta-encoded: the first point of each POST is full (a resync),
  the rest carry `utc` + changed fields only.
- Vehicle-off bookend forces a coherent parked state (`speed`/`power`=0,
  `is_parked`=true, `is_charging`/`is_dcfc`=false).
```

- [ ] **Step 3: Update SPECIFICATION.md**

Replace the §4.6 (median sampling) and §5.1–5.2 (significant-change / state-adaptive cadence) descriptions with the change-based model, pointing to the design spec `docs/superpowers/specs/2026-06-05-telemetry-change-based-redesign-design.md`. In §5.3 "Candidate optimizations", mark **per-point delta encoding** as implemented (move it out of the not-yet-implemented list). Leave §11 #6 (configurable *flush* interval / send-whole-queue) and §11 #5 (cold-boot charging) open and unchanged.

- [ ] **Step 4: Build, test, lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|wrote"` → all pass.
Run: `npx eslint lib/ build.js test/` → exit 0.
Run: `node -e "global.print=function(){};global.performance={now:function(){return 0}};console.log(require('./dist/abrp'),)" >/dev/null && echo loads-ok` (sanity that the bundle loads).

- [ ] **Step 5: Commit + push**

```bash
git add lib/abrp/constants.js package.json CHANGELOG.md docs/SPECIFICATION.md
git commit -m "release(3.0): version 3.0.0-alpha.1 + changelog + spec updates"
git push 2>&1 | tail -1
```

---

## Out of scope (tracked separately)

- Configurable **flush** interval + "send whole queue" (`SPECIFICATION.md` §11 #6).
- Cold-boot charging session detection (`SPECIFICATION.md` §11 #5).
- Live config reload via a `config.changed` subscription for `sample_interval`.
