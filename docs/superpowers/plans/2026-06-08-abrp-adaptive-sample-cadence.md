# Adaptive Sample Cadence (Collect-Pressure Back-off) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 3.0 sampler self-throttle under event-loop congestion — when its own `createTelemetry()` collect runs far slower than its recent baseline, multiplicatively stretch the effective sample interval (capped), and multiplicatively recover once collects are fast again.

**Architecture:** All new logic lives in `lib/abrp/queue.js`, which already owns the sample interval and the `m.monotonic` gate. Today's single `sampleInterval` splits into a `baseInterval` (the configured floor) and an `effectiveInterval` (what the gate uses). `sample()` times the collect with `performance.now()` and feeds the duration to a pure `adjustCadence(ms)` controller (×2 up on a collect > 3× a rolling EWMA baseline; ÷2 down on a calm collect; floored at `baseInterval`, capped at `BACKOFF_MAX_INTERVAL`). Keeping `adjustCadence` a pure function of its `ms` argument makes it deterministic to test off-device, where `performance.now()` is a no-op stub.

**Tech Stack:** Duktape-targeted ES2015 CommonJS (`var`/`function`, string concat — no arrow functions or template literals in `lib/abrp/*`), Node's built-in `node:test` runner against the source modules and the built bundle.

**Spec:** `docs/superpowers/specs/2026-06-08-abrp-adaptive-sample-cadence-design.md`

---

## File Structure

- **Modify `lib/abrp/constants.js`** — add `COLLECT_PRESSURE_FACTOR`, `BACKOFF_MAX_INTERVAL`, `COLLECT_BASELINE_ALPHA`; bump `VERSION`.
- **Modify `lib/abrp/queue.js`** — split interval state, add `collectBaseline` + `adjustCadence()`, time the collect in `sample()`, re-floor in `setSampleInterval()`, export `adjustCadence`/`getEffectiveInterval`/`getBaseline`.
- **Modify `lib/abrp/queue.test.js`** — add controller unit tests + a `sample()` integration test.
- **Modify `lib/abrp/abrp.js`** — add the three new accessors to the `__test` seam.
- **Modify `lib/abrp.test.js`** — one entry-seam smoke test.
- **Modify `CHANGELOG.md`, `docs/SPECIFICATION.md`** — document the behavior + constants.

Each task ends in a green test run and a commit. Per-module tests (`lib/abrp/*.test.js`) require the source directly and are fast; the entry test (`lib/abrp.test.js`) needs `npm run build` first. Run the whole suite with `npm test` (builds, then runs).

---

## Task 1: Add tunable constants and bump version

**Files:**
- Modify: `lib/abrp/constants.js`

- [ ] **Step 1: Add the three constants and bump VERSION**

In `lib/abrp/constants.js`, change the `VERSION` line and add the three new tunables after `SAMPLE_INTERVAL_DEFAULT`. The relevant region becomes:

```javascript
  VERSION: '3.0.0-alpha.3',
  CERTS_VERSION: 1, // bump when trustedca/ changes to force a one-time reinstall
  DEBUG: true,
  MAX_TELEMETRY_QUEUE_SIZE: 100,
  SAMPLE_INTERVAL_DEFAULT: 3, // seconds between samples; overridden by usr abrp.sample_interval (1-5)
  COLLECT_PRESSURE_FACTOR: 3, // collect > this x the rolling baseline counts as a slow collect (congestion)
  BACKOFF_MAX_INTERVAL: 180, // seconds; cap for the stretched sample interval under sustained congestion
  COLLECT_BASELINE_ALPHA: 0.25, // EWMA weight for updating the collect baseline on calm samples
  HEARTBEAT_INTERVAL: 160, // seconds; force a point if nothing queued for this long; 0 disables
```

(Leave `SEND_INTERVAL_DEFAULT`, `ROUNDING`, etc. unchanged.)

- [ ] **Step 2: Verify the bundle still builds (no syntax/Duktape violations)**

Run: `npm run build`
Expected: builds cleanly, emits `dist/abrp.js`, no error about arrow functions / template literals.

- [ ] **Step 3: Run the full suite to confirm nothing regressed**

Run: `npm test`
Expected: all tests pass (no behavior changed yet; constants are just added).

- [ ] **Step 4: Commit**

```bash
git add lib/abrp/constants.js
git commit -m "feat(constants): add collect-pressure back-off tunables; bump to 3.0.0-alpha.3"
```

---

## Task 2: Split interval state and add the `adjustCadence` controller

**Files:**
- Modify: `lib/abrp/queue.js`
- Test: `lib/abrp/queue.test.js`

This task adds the pure controller and its accessors. `sample()` is wired to it in Task 3.

- [ ] **Step 1: Write the failing controller tests**

Add these tests to `lib/abrp/queue.test.js` (after the existing `changedVsLastQueued` test; they use the existing `loadQueue()` helper). The numeric trajectories are computed from base 3, ×2 up capped at 180, ÷2 (floored division) down floored at 3:

```javascript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js`
Expected: FAIL — `Q.getEffectiveInterval is not a function` (accessors/controller not defined yet).

- [ ] **Step 3: Implement the state split, controller, and accessors**

In `lib/abrp/queue.js`, replace the single interval var:

```javascript
var sampleInterval = C.SAMPLE_INTERVAL_DEFAULT
```

with the split state plus the baseline:

```javascript
var baseInterval = C.SAMPLE_INTERVAL_DEFAULT   // configured floor (usr abrp.sample_interval)
var effectiveInterval = baseInterval           // what the gate uses; never below baseInterval
var collectBaseline = null                     // EWMA of calm collect durations (ms); null until seeded
```

Replace the existing `setSampleInterval` with the re-flooring version:

```javascript
/**
 * Sets the per-session sample interval (seconds) and resets the adaptive cadence
 * to that floor. Called at session start and on config.changed. The collect
 * baseline persists (it is a device/vehicle characteristic, not session state).
 */
function setSampleInterval(n) {
  baseInterval = n
  effectiveInterval = n
}
```

Add the controller (place it just above `sample()`):

```javascript
/**
 * Congestion controller. Given the latest collect duration (ms), stretches or
 * relaxes effectiveInterval. A collect slower than COLLECT_PRESSURE_FACTOR x the
 * rolling baseline is treated as event-loop congestion: multiplicative increase,
 * capped at BACKOFF_MAX_INTERVAL. A calm collect updates the EWMA baseline and
 * multiplicatively recovers toward baseInterval. Slow collects never update the
 * baseline (so a spike cannot desensitize the threshold). Pure function of ms.
 */
function adjustCadence(ms) {
  if (collectBaseline === null) {
    collectBaseline = ms
    return
  }
  if (ms > collectBaseline * C.COLLECT_PRESSURE_FACTOR) {
    effectiveInterval = Math.min(effectiveInterval * 2, C.BACKOFF_MAX_INTERVAL)
  } else {
    collectBaseline = collectBaseline + C.COLLECT_BASELINE_ALPHA * (ms - collectBaseline)
    if (effectiveInterval > baseInterval) {
      effectiveInterval = Math.max(Math.floor(effectiveInterval / 2), baseInterval)
    }
  }
  if (C.DEBUG) {
    Logger.debug('cadence: collect_ms=' + ms.toFixed(1) + ' baseline=' + collectBaseline.toFixed(1) + ' interval=' + effectiveInterval)
  }
}
```

Add the three accessors to `module.exports` (alongside `getQueue`/`setLastQueued`):

```javascript
  adjustCadence: adjustCadence,
  getEffectiveInterval: function () { return effectiveInterval },
  getBaseline: function () { return collectBaseline },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js`
Expected: PASS — all three new tests plus the existing queue tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/abrp/queue.js lib/abrp/queue.test.js
git commit -m "feat(queue): add collect-pressure cadence controller (adjustCadence)"
```

---

## Task 3: Time the collect in `sample()` and gate on `effectiveInterval`

**Files:**
- Modify: `lib/abrp/queue.js:72-82` (`sample()`)
- Test: `lib/abrp/queue.test.js`

- [ ] **Step 1: Write the failing integration test**

Add this to `lib/abrp/queue.test.js`. It drives `sample()` with a `performance.now()` that returns `0` then the collect duration on alternate calls, so each gate-pass measures a controlled duration. The first collect (90 ms) seeds the baseline; the rest (400 ms) trigger back-off. `mono.t` is advanced past `effectiveInterval` each call so the gate opens:

```javascript
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

  mono.t = 0;   Q.sample() // collect 90 -> seed baseline, stays at floor
  assert.strictEqual(Q.getEffectiveInterval(), 3)
  mono.t = 10;  Q.sample() // collect 400 (> 270) -> x2 -> 6
  assert.strictEqual(Q.getEffectiveInterval(), 6)
  mono.t = 100; Q.sample() // collect 400 -> x2 -> 12
  assert.strictEqual(Q.getEffectiveInterval(), 12)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --require ./test/globals.js --test --test-name-pattern="times the collect" lib/abrp/queue.test.js`
Expected: FAIL — `effectiveInterval` stays `3` because `sample()` does not yet time the collect or call `adjustCadence`.

- [ ] **Step 3: Wire timing + the gate into `sample()`**

Replace the body of `sample()` in `lib/abrp/queue.js` with the version that gates on `effectiveInterval` and times the collect:

```javascript
function sample() {
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastSampleMono < effectiveInterval) { return }
  lastSampleMono = mono
  var t0 = performance.now()
  var snap = roundTelemetry(Met.createTelemetry())
  adjustCadence(performance.now() - t0)
  if (changedVsLastQueued(snap)) {
    enqueue(snap)
  } else if (C.HEARTBEAT_INTERVAL > 0 && mono - lastQueuedMono >= C.HEARTBEAT_INTERVAL) {
    enqueue(snap)
  }
}
```

(Only two things change vs. today: the gate compares against `effectiveInterval` instead of `sampleInterval`, and the collect is wrapped in `performance.now()` timing feeding `adjustCadence`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --require ./test/globals.js --test --test-name-pattern="times the collect" lib/abrp/queue.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full queue suite to confirm the existing gate/heartbeat tests still pass**

Run: `node --require ./test/globals.js --test lib/abrp/queue.test.js`
Expected: PASS — the existing `sample enqueues only after the interval has elapsed` and heartbeat tests are unaffected (with the stubbed `performance.now()` returning `0`, every collect measures `0 ms`, which seeds the baseline to `0` and stays calm, so `effectiveInterval` never leaves the floor).

- [ ] **Step 6: Commit**

```bash
git add lib/abrp/queue.js lib/abrp/queue.test.js
git commit -m "feat(queue): drive adaptive cadence from sample() collect timing"
```

---

## Task 4: Confirm `setSampleInterval` re-floors while the baseline persists

**Files:**
- Test: `lib/abrp/queue.test.js`

The re-flooring behavior was implemented in Task 2; this task locks it with a test (the lifecycle contract from spec §3.5).

- [ ] **Step 1: Write the failing test**

Add to `lib/abrp/queue.test.js`:

```javascript
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
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --require ./test/globals.js --test --test-name-pattern="re-floors" lib/abrp/queue.test.js`
Expected: PASS (behavior already implemented in Task 2; this is a regression guard).

If it FAILS, `setSampleInterval` is not resetting `effectiveInterval` — re-check Task 2 Step 3.

- [ ] **Step 3: Commit**

```bash
git add lib/abrp/queue.test.js
git commit -m "test(queue): lock setSampleInterval re-floor + baseline persistence"
```

---

## Task 5: Expose the new accessors through the entry `__test` seam

**Files:**
- Modify: `lib/abrp/abrp.js:88-107` (`__test` block)
- Test: `lib/abrp.test.js`

- [ ] **Step 1: Add the three delegations to the `__test` seam**

In `lib/abrp/abrp.js`, inside the `__test` object, add after `setSampleInterval: Q.setSampleInterval,`:

```javascript
    adjustCadence: Q.adjustCadence,
    getEffectiveInterval: Q.getEffectiveInterval,
    getBaseline: Q.getBaseline,
```

- [ ] **Step 2: Write the failing entry-seam smoke test**

Add to `lib/abrp.test.js` a test that drives the controller through the built bundle's `__test` seam. The file uses Node's `describe`/`it` (imported at the top as `const { describe, it } = require('node:test')`) and the `loadAbrp(globals)` helper (re-requires the bundle with injected host-global stubs). Add this block at the top level of the file (e.g. after the `sendBulkTelemetry data integrity` describe):

```javascript
describe('adaptive cadence __test seam', () => {
  it('is reachable and backs off under a slow collect', () => {
    const abrp = loadAbrp({ OvmsMetrics: { HasValue: () => false, GetValues: () => ({}), Value: () => 0 } })
    abrp.__test.setSampleInterval(3)
    abrp.__test.adjustCadence(90)  // seed baseline
    abrp.__test.adjustCadence(400) // slow collect (> 270) -> back off x2
    assert.strictEqual(abrp.__test.getEffectiveInterval(), 6)
    assert.strictEqual(abrp.__test.getBaseline(), 90)
  })
})
```

- [ ] **Step 3: Build, then run the entry test to verify it passes**

Run: `npm run build && node --require ./test/globals.js --test --test-name-pattern="is reachable and backs off" lib/abrp.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/abrp/abrp.js lib/abrp.test.js
git commit -m "test(abrp): expose adaptive-cadence accessors via __test seam"
```

---

## Task 6: Lint, full suite, and documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/SPECIFICATION.md`

- [ ] **Step 1: Lint the source and run the whole suite**

Run: `npx eslint lib/ build.js test/ && npm test`
Expected: eslint clean (no ES2015 violations in `lib/abrp/*`), and `npm test` builds the bundle then passes every test.

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, under `## 3.0.0-alpha.2 (unreleased)`, change the heading to `## 3.0.0-alpha.3 (unreleased)` and add this as the first bullet:

```markdown
- Adaptive sample cadence: the sampler now times its own `createTelemetry()` collect
  and, when a collect runs slower than `COLLECT_PRESSURE_FACTOR`× its rolling baseline
  (event-loop congestion), multiplicatively stretches the effective sample interval up
  to `BACKOFF_MAX_INTERVAL` (180 s), recovering multiplicatively once collects are fast
  again. `usr abrp.sample_interval` becomes the *floor* (fastest cadence), not a fixed
  rate. During a deep crisis the interval can exceed `HEARTBEAT_INTERVAL`, intentionally
  letting the ABRP session lapse until OVMS recovers. Motivated by the 2026-06-07 field
  logs (18–42 s `ticker.1` stalls from web-dashboard websocket contention).
```

- [ ] **Step 3: Update the SPECIFICATION constants table**

In `docs/SPECIFICATION.md` §8 (the table starting at line 469), update the `VERSION` row value to `'3.0.0-alpha.3'` and add these three rows after the `SAMPLE_INTERVAL_DEFAULT` row:

```markdown
| `COLLECT_PRESSURE_FACTOR` | `3` | A collect slower than this × the rolling baseline counts as congestion (triggers a back-off step) |
| `BACKOFF_MAX_INTERVAL` | `180` s | Cap for the stretched sample interval under sustained congestion (§5.2) |
| `COLLECT_BASELINE_ALPHA` | `0.25` | EWMA weight for updating the collect baseline on calm samples |
```

- [ ] **Step 4: Update the SPECIFICATION sample-cadence prose**

In `docs/SPECIFICATION.md`, update the §8 row for `sampleInterval`/`SAMPLE_INTERVAL_DEFAULT` context and the sampling section so `sample_interval` is described as the **floor (fastest) cadence**. Append this sentence to the sampling description near line 186–187 (after the sentence ending `via \`Cfg.sampleInterval()\`, applied through ...`):

```markdown
This interval is a floor: under event-loop congestion the sampler stretches its
effective interval above it (multiplicatively, capped at `BACKOFF_MAX_INTERVAL`) and
recovers when collects speed up — see the adaptive-cadence controller in `queue.js`
(`adjustCadence`). The trigger is the sampler's own `createTelemetry()` collect duration
exceeding `COLLECT_PRESSURE_FACTOR`× a rolling baseline of calm collects.
```

- [ ] **Step 5: Final build + suite to confirm docs edits didn't touch code paths**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/SPECIFICATION.md
git commit -m "docs: document adaptive sample cadence + new back-off constants"
```

---

## Self-Review Notes (for the implementer)

- **Duktape guardrail:** every edit to `lib/abrp/queue.js`, `constants.js`, `abrp.js` must stay ES2015 — `var`/`function`, string concatenation (the DEBUG log line uses `+`, not template literals), `Math.min/max/floor`. The `build.js` guard and `npx eslint lib/` enforce this; do not run Prettier on `lib/abrp/*`.
- **Test files may use ES2021** (`const`/arrow funcs) freely — that's why the test snippets above use them.
- **No new config surface:** the back-off is automatic; its three parameters are `constants.js` tunables only (no `usr abrp.*` key, no `config.js` change).
- **Trajectory arithmetic** (used in the test assertions): up = `min(prev×2, 180)`; down = `max(floor(prev/2), base)`. From base 3: up `3→6→12→24→48→96→180`; down `180→90→45→22→11→5→3`.
