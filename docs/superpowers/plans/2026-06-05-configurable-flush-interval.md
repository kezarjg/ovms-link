# Configurable Flush Interval + Send-Whole-Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bulk-flush cadence user-configurable (`usr abrp.send_interval`, 10–60 s, default 30) gated on `m.monotonic`, and send the whole queue per flush instead of a 10-point slice (removing `MAX_BULK_BATCH_SIZE`).

**Architecture:** `sendBulkTelemetry` (in `telemetry.js`, on `ticker.10`) gains an `m.monotonic` elapsed-time gate — the same pattern as the sampler — and sends the entire queue (bounded by `MAX_TELEMETRY_QUEUE_SIZE`). The interval is read once per session via `Cfg.sendInterval()` and cached in `telemetry.js`. Spec: `docs/superpowers/specs/2026-06-05-configurable-flush-interval-design.md`.

**Tech Stack:** JavaScript (ES2015 / Duktape-safe — `var`/`function` only, no arrows/templates/spread in `lib/abrp/*` or the bundle), Node 22, `node:test` + `node:assert`, ESLint 8. Build: `npm test` builds `dist/abrp.js` then runs the suite.

---

## Conventions

- **Duktape-safe source:** `var` + `function` only in `lib/abrp/`. No arrows/templates/spread. (Test files may use modern JS.)
- **Green at every step:** after each task `npm test` (fail 0) and `npx eslint lib/ build.js test/` (exit 0). Commit only when green. Branch `feature/abrp-3.0.0` — commit directly.
- **Sequencing:** Task 1 additive (constants + config). Task 2 adds the gate and updates existing tests so they keep working (gate disabled via `setSendInterval(0)`); the batch is still 10 points. Task 3 switches to whole-queue and removes `MAX_BULK_BATCH_SIZE`. Task 4 docs.
- **Gate-disable for tests:** `setSendInterval(0)` makes `mono - lastFlushMono < 0` always false, so the gate never blocks — restoring flush-every-call behavior for the data-integrity tests.

## File map

| File | Change |
| --- | --- |
| `lib/abrp/constants.js` | +`SEND_INTERVAL_DEFAULT: 30` (T1); −`MAX_BULK_BATCH_SIZE` (T3) |
| `lib/abrp/config.js` | +`sendInterval()` (T1) |
| `lib/abrp/telemetry.js` | +flush gate, `lastFlushMono`/`sendInterval` state, `setSendInterval` (T2); batch → whole queue (T3) |
| `lib/abrp/events.js` | `Tlm.setSendInterval(Cfg.sendInterval())` at session start (T2) |
| `lib/abrp/abrp.js` | `__test.setSendInterval` (T2) |
| `lib/abrp/config.test.js` | +`sendInterval` tests (T1) |
| `lib/abrp.test.js` | data-integrity stubs + gate test (T2); whole-queue test changes (T3) |
| `CHANGELOG.md`, `docs/SPECIFICATION.md` | T4 |

---

## Task 1: Constant + `config.sendInterval()`

**Files:** Modify `lib/abrp/constants.js`, `lib/abrp/config.js`; Modify `lib/abrp/config.test.js`.

- [ ] **Step 1: Add the constant**

In `lib/abrp/constants.js`, add after the `HEARTBEAT_INTERVAL` line:

```javascript
  SEND_INTERVAL_DEFAULT: 30, // seconds between bulk flushes; overridden by usr abrp.send_interval (10-60)
```

- [ ] **Step 2: Write the failing config test**

Append to `lib/abrp/config.test.js` (inside the file; it already has `const { test } = require('node:test')` and `assert`, and a `withConfig(values)` helper that stubs `OvmsConfig.GetValues` to return `values` and re-requires `./config`):

```javascript
test('sendInterval defaults to 30 when unset', () => {
  assert.strictEqual(withConfig({}).sendInterval(), 30)
})

test('sendInterval reads and clamps usr abrp.send_interval to 10..60', () => {
  assert.strictEqual(withConfig({ send_interval: '20' }).sendInterval(), 20)
  assert.strictEqual(withConfig({ send_interval: '5' }).sendInterval(), 10)
  assert.strictEqual(withConfig({ send_interval: '90' }).sendInterval(), 60)
  assert.strictEqual(withConfig({ send_interval: 'x' }).sendInterval(), 30)
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --require ./test/globals.js --test lib/abrp/config.test.js 2>&1 | grep -E "fail|not a function"`
Expected: FAIL — `Cfg.sendInterval is not a function`.

- [ ] **Step 4: Implement `sendInterval()`**

In `lib/abrp/config.js`, add this function just below `sampleInterval()` (before `module.exports`):

```javascript
/**
 * Returns the bulk-flush interval in seconds from usr abrp.send_interval,
 * validated/clamped to 10..60, defaulting to SEND_INTERVAL_DEFAULT.
 */
function sendInterval() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').send_interval
    : undefined
  var n = parseInt(raw, 10)
  if (isNaN(n)) { return C.SEND_INTERVAL_DEFAULT }
  if (n < 10) { return 10 }
  if (n > 60) { return 60 }
  return n
}
```

Add it to `module.exports` (alongside `sampleInterval`):

```javascript
  sampleInterval: sampleInterval,
  sendInterval: sendInterval,
```

- [ ] **Step 5: Run tests + lint**

Run: `node --require ./test/globals.js --test lib/abrp/config.test.js 2>&1 | grep -E "pass|fail"` → pass.
Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/abrp/constants.js lib/abrp/config.js lib/abrp/config.test.js
git commit -m "feat(3.0): add send_interval config (10-60, default 30)"
```

---

## Task 2: Flush gate (`m.monotonic`), keep 10-point batch

Adds the gate + state + `setSendInterval`, wires it at session start, and updates the existing `sendBulkTelemetry` tests so they stub `m.monotonic` and disable the gate. The batch is still `MAX_BULK_BATCH_SIZE` here; Task 3 switches it to the whole queue.

**Files:** Modify `lib/abrp/telemetry.js`, `lib/abrp/abrp.js`, `lib/abrp/events.js`, `lib/abrp.test.js`.

- [ ] **Step 1: Add a failing flush-gate test**

In `lib/abrp.test.js`, append a new `describe` (the file already imports `describe`/`it`/`assert` and has `loadAbrp`):

```javascript
describe('sendBulkTelemetry flush interval gate', () => {
  it('does not flush until send_interval has elapsed', () => {
    const requests = []
    const mono = { t: 0 }
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: (k) => (k === 'm.monotonic' ? mono.t : 0), HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.setSendInterval(30)
    const q = abrp.__test.getQueue()
    q.length = 0
    q.push({ utc: 1 })

    mono.t = 10; abrp.__test.sendBulkTelemetry()   // 10 - 0 < 30 -> gated, no flush
    assert.strictEqual(requests.length, 0)
    mono.t = 40; abrp.__test.sendBulkTelemetry()   // 40 - 0 >= 30 -> flush
    assert.strictEqual(requests.length, 1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "flush interval gate|fail|not a function"`
Expected: FAIL — `abrp.__test.setSendInterval is not a function` (and the gate doesn't exist, so a request would fire at t=10).

- [ ] **Step 3: Add the gate + state + setter in `telemetry.js`**

In `lib/abrp/telemetry.js`, change the state line:

```javascript
// Module state: true while a bulk request is in flight.
var isSending = false
```
to:
```javascript
// Module state: in-flight guard + flush cadence (m.monotonic-gated).
var isSending = false
var lastFlushMono = 0
var sendInterval = C.SEND_INTERVAL_DEFAULT
```

Add this function above `sendBulkTelemetry`:

```javascript
/**
 * Sets the bulk-flush interval in seconds. Called at session start; a raw 0
 * disables the gate (flush on every tick) — used by tests.
 */
function setSendInterval(n) {
  sendInterval = n
}
```

`OvmsMetrics` is an OVMS-injected global (already used in `queue.js`/`events.js` and declared in `.eslintrc.json`) — reference it directly, do **not** add a `require`. In `sendBulkTelemetry`, insert the gate between the `isSending` guard and the empty-queue check, and stamp `lastFlushMono` once committed to a flush. Change:

```javascript
  if (isSending) {
    Logger.debug('Bulk send already in progress; skipping this tick.')
    return
  }
  if (Q.getQueue().length === 0) {
    return
  }

  // Snapshot the batch now so the removal count cannot drift if more telemetry
  // is queued while the request is in flight.
  var batch = Q.snapshot(C.MAX_BULK_BATCH_SIZE)
```
to:
```javascript
  if (isSending) {
    Logger.debug('Bulk send already in progress; skipping this tick.')
    return
  }
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastFlushMono < sendInterval) {
    return // not time to flush yet
  }
  if (Q.getQueue().length === 0) {
    return // nothing to send; leave lastFlushMono so data flushes promptly when it arrives
  }
  lastFlushMono = mono

  // Snapshot the batch now so the removal count cannot drift if more telemetry
  // is queued while the request is in flight.
  var batch = Q.snapshot(C.MAX_BULK_BATCH_SIZE)
```

Add `setSendInterval` to `module.exports`:

```javascript
module.exports = {
  sendTelemetry: sendTelemetry,
  sendBulkTelemetry: sendBulkTelemetry,
  createBulkPost: createBulkPost,
  setSendInterval: setSendInterval,
}
```

- [ ] **Step 4: Expose `setSendInterval` in the entry seam**

In `lib/abrp/abrp.js` `__test`, add after `setSampleInterval: Q.setSampleInterval,`:

```javascript
    setSendInterval: Tlm.setSendInterval,
```

(`Tlm` is already required in `abrp.js`.)

- [ ] **Step 5: Wire it at session start in `events.js`**

In `lib/abrp/events.js` `manageVehicleStateEvents`, in the `if (shouldSubscribe)` block, add the cache line right after the `ticker.10` subscribe:

```javascript
    subscribe('ticker.10', Tlm.sendBulkTelemetry)
    Tlm.setSendInterval(Cfg.sendInterval());
```

(`Tlm` and `Cfg` are already required in `events.js`.)

- [ ] **Step 6: Fix the existing `sendBulkTelemetry` tests for the m.monotonic read**

`sendBulkTelemetry` now reads `OvmsMetrics.Value('m.monotonic')`, which the `data integrity` suite did not stub, and the gate would block its repeated immediate calls. In `lib/abrp.test.js`, change the `sendBulkTelemetry data integrity` suite's `setup()`:

```javascript
  function setup() {
    const requests = []
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsMetrics: { Value: () => 0, HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.setSendInterval(0) // disable the flush gate so each call flushes immediately
    const q = abrp.__test.getQueue()
    q.length = 0
    return { abrp, requests, q }
  }
```

In the `sendBulkTelemetry queue-overflow during an in-flight batch` test, add the gate-disable right after the queue is grabbed (it already stubs `OvmsMetrics: { Value: () => 0, ... }`). Change:

```javascript
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
```
to:
```javascript
    abrp.__test.setSendInterval(0) // disable the flush gate
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
```

- [ ] **Step 7: Run tests + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0 (the new gate test passes; the data-integrity + overflow tests still pass with the gate disabled and the 10-point batch unchanged).
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/abrp/telemetry.js lib/abrp/abrp.js lib/abrp/events.js lib/abrp.test.js
git commit -m "feat(3.0): m.monotonic-gated configurable bulk-flush interval"
```

---

## Task 3: Send the whole queue; remove `MAX_BULK_BATCH_SIZE`

**Files:** Modify `lib/abrp/telemetry.js`, `lib/abrp/constants.js`, `lib/abrp.test.js`.

- [ ] **Step 1: Update the batch test to expect the whole queue**

In `lib/abrp.test.js`, replace the `sends and removes at most MAX_BULK_BATCH_SIZE (10) per flush` test with:

```javascript
  it('sends and removes the whole queue per flush', () => {
    const { abrp, requests, q } = setup()
    for (let i = 1; i <= 15; i++) q.push({ utc: i })
    abrp.__test.sendBulkTelemetry()
    assert.strictEqual(requests.length, 1)
    assert.notStrictEqual(requests[0].post, undefined)
    const sent = JSON.parse(requests[0].post).data[0].tlm_list
    assert.strictEqual(sent.length, 15) // whole queue, not capped at 10
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    assert.deepStrictEqual(q.map((t) => t.utc), []) // queue emptied
  })
```

- [ ] **Step 2: Update the overflow test assertions for whole-queue send**

In the `sendBulkTelemetry queue-overflow during an in-flight batch` test, the batch is now the whole queue (utc 1..100), so the points queued *during* the flight (101..105) are the only survivors. Replace the tail of that test — from the `requests[0].done(...)` line through the final assertions — with:

```javascript
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })

    const remaining = q.map((t) => t.utc)
    // The sent batch (utc 1..100) is removed by identity; the 1..5 that were
    // shifted out as overflow were also part of the (already-sent) batch, so
    // dropping them is harmless. Only the points queued during the flight remain.
    assert.deepStrictEqual(remaining, [101, 102, 103, 104, 105])
```

(Keep the earlier part of the test unchanged: filling 1..100, the first `sendBulkTelemetry()` + `assert.strictEqual(requests.length, 1)`, and the `for (let i = 101; i <= 105; i++) abrp.__test.enqueue({ utc: i })` overflow loop.)

- [ ] **Step 3: Run to verify these two tests now FAIL (batch still 10)**

Run: `npm test 2>&1 | grep -E "whole queue|queue-overflow|fail"`
Expected: FAIL — the batch is still `Q.snapshot(C.MAX_BULK_BATCH_SIZE)` (10), so `sent.length` is 10 not 15, and `remaining` is `[11..105]` not `[101..105]`.

- [ ] **Step 4: Switch the batch to the whole queue**

In `lib/abrp/telemetry.js`, change:

```javascript
  var batch = Q.snapshot(C.MAX_BULK_BATCH_SIZE)
```
to:
```javascript
  var batch = Q.snapshot(C.MAX_TELEMETRY_QUEUE_SIZE) // the whole queue (capped by MAX_TELEMETRY_QUEUE_SIZE)
```

Also update the `createBulkPost` JSDoc, changing:

```javascript
/**
 * Builds a bulk telemetry post object for the given batch (a snapshot of up to
 * MAX_BULK_BATCH_SIZE queued points).
 */
```
to:
```javascript
/**
 * Builds a bulk telemetry post object for the given batch (the queued points to
 * send — delta-encoded for transmission).
 */
```

- [ ] **Step 5: Remove the now-unused constant**

In `lib/abrp/constants.js`, delete the line:

```javascript
  MAX_BULK_BATCH_SIZE: 10, // max telemetry points per bulk POST
```

- [ ] **Step 6: Run tests + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `git grep -nE "MAX_BULK_BATCH_SIZE" -- lib/` → no matches (fully removed).
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/abrp/telemetry.js lib/abrp/constants.js lib/abrp.test.js
git commit -m "feat(3.0): flush the whole queue per send; remove MAX_BULK_BATCH_SIZE"
```

---

## Task 4: Docs

**Files:** Modify `CHANGELOG.md`, `docs/SPECIFICATION.md`.

- [ ] **Step 1: CHANGELOG**

In `CHANGELOG.md`, under `## 3.0.0-alpha.1 (unreleased)`, add:

```markdown
- Configurable bulk-flush interval via `usr abrp.send_interval` (10–60 s, **default
  30** — up from the prior effective 10 s), gated on `m.monotonic`. Each flush now
  sends the whole queue (bounded by `MAX_TELEMETRY_QUEUE_SIZE`); `MAX_BULK_BATCH_SIZE`
  is removed.
```

- [ ] **Step 2: SPECIFICATION — flush cadence + constants + §11 #6**

In `docs/SPECIFICATION.md`:
- In the §5 send-cadence material, note the flush is now `m.monotonic`-gated to
  `send_interval` (10–60 s, default 30, 10 s granularity since it lands on `ticker.10`),
  and each flush sends the whole queue (delta-encoded), removing the per-POST cap.
- In the §8 constants table, remove the `MAX_BULK_BATCH_SIZE` row and add a
  `SEND_INTERVAL_DEFAULT` row (`30`, "default bulk-flush interval seconds; overridden by
  `usr abrp.send_interval`, 10–60"). Note both config knobs (`sample_interval`,
  `send_interval`) near the existing config text.
- In §11, mark item **#6 RESOLVED in 3.0.0-alpha.1** (configurable flush interval +
  whole-queue send implemented; reference
  `docs/superpowers/specs/2026-06-05-configurable-flush-interval-design.md`). Keep the
  remaining open items unchanged.

- [ ] **Step 3: Build, test, lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 4: Commit + push**

```bash
git add CHANGELOG.md docs/SPECIFICATION.md
git commit -m "docs(3.0): configurable flush interval + whole-queue send; resolve §11 #6"
git push 2>&1 | tail -1
```

---

## Out of scope

- Scaling the 8 s HTTP timeout for the larger full-queue POST (kept fixed by design —
  delta keeps the payload small; a timeout retries losslessly next flush).
- Live config reload of `send_interval` mid-session (takes effect next session, like
  `sample_interval`).
