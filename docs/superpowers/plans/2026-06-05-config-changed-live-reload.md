# config.changed Live-Reload of Cadence Knobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-read `usr abrp.sample_interval` / `usr abrp.send_interval` on the OVMS `config.changed` event so a `config set` takes effect on the next sample/flush tick instead of only at the next session.

**Architecture:** Add an `applyIntervals()` handler in `events.js` that re-reads both cadence keys via the existing `Cfg.sampleInterval()`/`Cfg.sendInterval()` and applies them through the existing `Q.setSampleInterval`/`Tlm.setSendInterval` setters; subscribe it to `config.changed` in `Ev.startup()`. Spec: `docs/superpowers/specs/2026-06-05-config-changed-live-reload-design.md`.

**Tech Stack:** JavaScript (ES2015 / Duktape-safe — `var`/`function` only, no arrows/templates/spread in `lib/abrp/*` or the bundle), Node 22, `node:test` + `node:assert`. Build: `npm test` builds `dist/abrp.js` then runs the suite.

---

## Conventions

- **Duktape-safe source:** `var` + `function` only in `lib/abrp/`. No arrows/templates/spread. (Test files may use modern JS.)
- **Green at every step:** after each task `npm test` (fail 0) and `npx eslint lib/ build.js test/` (exit 0). Commit only when green. Branch `feature/abrp-3.0.0` — commit directly.
- Background facts: OVMS fires `config.changed` on every `config set` with **no payload** identifying the key (verified), so the handler re-reads both keys unconditionally. `events.js` already requires `Cfg` (`./config`), `Q` (`./queue`), `Tlm` (`./telemetry`). `Ev.startup()` is guarded behind `typeof OvmsConfig/OvmsMetrics/PubSub` in the entry, so the new subscribe only runs on-device.

## File map

| File | Change |
| --- | --- |
| `lib/abrp/events.js` | +`applyIntervals()`, +`subscribe('config.changed', applyIntervals)` in `startup()`, +export (T1) |
| `lib/abrp/abrp.js` | +`__test.applyIntervals` (T1) |
| `lib/abrp.test.js` | +2 bundle tests (T1) |
| `CHANGELOG.md`, `docs/SPECIFICATION.md` | T2 |

---

## Task 1: `applyIntervals` handler + `config.changed` subscription

**Files:** Modify `lib/abrp/events.js`, `lib/abrp/abrp.js`, `lib/abrp.test.js`.

- [ ] **Step 1: Write the failing tests**

In `lib/abrp.test.js`, append a new describe (the file already imports `describe`/`it`/`assert` and has `loadAbrp`):

```javascript
describe('config.changed live-reload (bundle)', () => {
  it('applyIntervals re-reads send_interval; the flush gate uses the new value', () => {
    const requests = []
    const mono = { t: 0 }
    const abrp = loadAbrp({
      HTTP: { Request: (o) => requests.push(o) },
      OvmsConfig: { GetValues: () => ({ send_interval: '20' }) },
      OvmsMetrics: { Value: (k) => (k === 'm.monotonic' ? mono.t : 0), HasValue: () => false, GetValues: () => ({}) },
    })
    abrp.__test.applyIntervals() // re-reads -> setSendInterval(20)
    const q = abrp.__test.getQueue()
    q.length = 0
    q.push({ utc: 1 })

    mono.t = 19; abrp.__test.sendBulkTelemetry() // 19 - 0 < 20 -> gated
    assert.strictEqual(requests.length, 0)
    mono.t = 20; abrp.__test.sendBulkTelemetry() // 20 - 0 == 20, strict < -> flush
    assert.strictEqual(requests.length, 1)
  })

  it('applyIntervals re-reads sample_interval; the sampler gate uses the new value', () => {
    const present = { 'm.time.utc': 1000, 'v.b.soc': 50, 'v.e.parktime': 100 }
    const mono = { t: 0 }
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ sample_interval: '5' }) },
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => { const o = {}; keys.forEach((k) => { o[k] = present[k] }); return o },
        Value: (k) => (k === 'm.monotonic' ? mono.t : present[k]),
      },
    })
    abrp.__test.applyIntervals() // re-reads -> setSampleInterval(5)
    abrp.__test.getQueue().length = 0
    abrp.__test.setLastQueued({ utc: 0 })

    mono.t = 4; abrp.__test.sample() // 4 - 0 < 5 -> gated, no enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 0)
    mono.t = 5; abrp.__test.sample() // 5 - 0 == 5, strict < -> sample; soc differs -> enqueue
    assert.strictEqual(abrp.__test.getQueue().length, 1)
  })

  it('startup subscribes applyIntervals to config.changed', () => {
    const subs = []
    // All three host globals present -> the guarded Ev.startup() runs at load.
    loadAbrp({
      OvmsConfig: { GetValues: () => ({}) },
      OvmsMetrics: { Value: () => '', HasValue: () => false, GetValues: () => ({}) },
      PubSub: { subscribe: (topic) => { subs.push(topic); return 1 }, unsubscribe: () => {} },
    })
    assert.ok(subs.includes('config.changed'))
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "config.changed live-reload|fail|not a function"`
Expected: FAIL — `abrp.__test.applyIntervals is not a function`.

- [ ] **Step 3: Add `applyIntervals` + subscribe + export in `events.js`**

In `lib/abrp/events.js`, add this function immediately above `function startup()`:

```javascript
/**
 * Re-reads the cadence config keys and applies them, so a `config set` of
 * usr abrp.sample_interval / send_interval takes effect on the next tick
 * (no session restart). Fired on OVMS `config.changed`, which carries no key,
 * so both are re-read unconditionally.
 */
function applyIntervals() {
  Q.setSampleInterval(Cfg.sampleInterval());
  Tlm.setSendInterval(Cfg.sendInterval());
}
```

Change `startup()` from:

```javascript
function startup() {
  Met.overrideMetricMap()
  subscribe('ticker.1', checkTime)
}
```
to:
```javascript
function startup() {
  Met.overrideMetricMap()
  subscribe('ticker.1', checkTime)
  subscribe('config.changed', applyIntervals)
}
```

Add `applyIntervals` to `module.exports` (alongside the other exports, e.g. after `startup: startup,`):

```javascript
  startup: startup,
  applyIntervals: applyIntervals,
```

- [ ] **Step 4: Expose `applyIntervals` in the entry seam**

In `lib/abrp/abrp.js` `__test`, add after the `manageVehicleStateEvents: Ev.manageVehicleStateEvents,` line:

```javascript
    applyIntervals: Ev.applyIntervals,
```

- [ ] **Step 5: Run tests + lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: fail 0 (the three new tests pass; was 35, now 38).
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/abrp/events.js lib/abrp/abrp.js lib/abrp.test.js
git commit -m "feat(3.0): live-reload cadence intervals on config.changed"
```

---

## Task 2: Docs

**Files:** Modify `CHANGELOG.md`, `docs/SPECIFICATION.md`.

- [ ] **Step 1: CHANGELOG**

In `CHANGELOG.md`, under `## 3.0.0-alpha.1 (unreleased)`, add:

```markdown
- `usr abrp.sample_interval` and `usr abrp.send_interval` changes now apply live on
  the OVMS `config.changed` event (next sample/flush tick), instead of only at the
  next session.
```

- [ ] **Step 2: SPECIFICATION — event table + config note**

In `docs/SPECIFICATION.md` §4.4, add a row to the event table (after the `vehicle.type.set` row):

```markdown
| `config.changed` | `applyIntervals` | Any config change — re-reads `sample_interval`/`send_interval` |
```

In §8 (configuration keys), append a sentence to the paragraph listing the config keys, e.g.:

```markdown
Changes to `usr abrp.sample_interval` / `usr abrp.send_interval` apply **live** —
`events.js` re-reads them on `config.changed` and they take effect on the next tick
(no session restart or JS-engine reload).
```

- [ ] **Step 3: Build, test, lint**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` → fail 0.
Run: `npx eslint lib/ build.js test/` → exit 0.

- [ ] **Step 4: Commit + push**

```bash
git add CHANGELOG.md docs/SPECIFICATION.md
git commit -m "docs(3.0): config.changed live-reload of cadence keys"
git push 2>&1 | tail -1
```

---

## Out of scope

- Re-reading the token on `config.changed` (`Cfg.validate()` already re-reads it lazily).
- Filtering `config.changed` by which key changed (the event carries no key; re-reading two keys is trivial).
