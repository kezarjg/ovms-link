# ABRP 3.0 — Adaptive Sample Cadence (Collect-Pressure Back-off) — Design

**Date:** 2026-06-08
**Status:** Approved design, pending implementation plan.
**Branch:** `feature/abrp-3.0.0`
**Builds on** the change-based telemetry redesign
(`docs/superpowers/specs/2026-06-05-telemetry-change-based-redesign-design.md`) and the
configurable-cadence work
(`docs/superpowers/specs/2026-06-05-configurable-flush-interval-design.md`).
**Motivated by** the 2026-06-07 field logs (`~/ovms-logs/log-crash-2026-06-07.txt`):
18–42 s `ticker.1` stalls and event-queue overflow while the OVMS web dashboard streamed
metrics over websocket. abrp was **not** the root cause (its own collect stayed ~90–190 ms),
but it kept running full collects into an already-congested event loop.

## 1. Summary

Make `queue.js`'s per-second sampler **self-throttling under event-loop congestion**. The
sampler times its own `createTelemetry()` collect; a collect that runs far slower than its
recent baseline is taken as a congestion signal, and the **effective** sample interval is
stretched multiplicatively (up to a high cap), then recovered multiplicatively once collects
are fast again. The configured `usr abrp.sample_interval` becomes a **floor**; the cadence
only ever *slows* relative to it.

Goal: when OVMS is in crisis, abrp stops piling collects onto the event loop and lets ABRP
telemetry degrade gracefully (and, in a deep crisis, lapse) rather than competing for a
saturated loop. It does **not** fix externally-caused stalls — it makes abrp a good citizen
during them.

### Why collect duration is the signal

`collect_ms` is measured with `performance.now()` (wall-clock). Under congestion it inflates
**even when abrp's CPU work is unchanged**, because the collect is preempted mid-sweep. That
is the desired property: the signal rises when the loop is hot, regardless of *who* caused the
heat — so the same number that looks like a "symptom" in a post-mortem is a sound real-time
congestion proxy here.

### Scope note — 3.0 only

This targets the 3.0 modules (`lib/abrp/*`), not the deployed 2.x line. The 2.x baseline has
no sample-interval gate (it collects every `ticker.1` at 1 Hz), so adaptive cadence has nothing
to stretch there without a larger rewrite; 3.0 already has the `m.monotonic` gate this design
extends. The 2.x back-off idea is explicitly deferred.

## 2. Goals & non-goals

**Goals**
- Detect event-loop congestion from inside Duktape using a signal abrp can observe itself
  (its own collect duration), with no per-tick bookkeeping beyond what `sample()` already does.
- Slow the sample cadence under sustained slow collects and recover when they clear, both fast.
- Auto-calibrate the "slow" threshold per vehicle/device (no magic millisecond constant to tune
  per car).
- Keep the controller a pure function of the measured duration so it is deterministic to test
  off-device (where `performance.now()` is a no-op stub).

**Non-goals**
- Not a fix for externally-caused stalls (web-dashboard/websocket contention still stalls the
  loop; abrp just stops contributing).
- No change to the **flush** path (`ticker.10` / `send_interval`), delta encoding, the in-flight
  guard, or removal-by-identity.
- No change to the configured `sample_interval` semantics — it remains the user's *fastest*
  cadence (now a floor), validated 1–5 s.
- No new `usr abrp.*` config surface. The back-off is automatic; its parameters are
  `constants.js` tunables, not user config.

## 3. Design

All new state and logic live in **`queue.js`**, which already owns `sampleInterval`,
`lastSampleMono`, and the gate.

### 3.1 State (`queue.js`)

Split today's single `sampleInterval` into a floor and an effective value, and add a baseline:

```
var baseInterval = C.SAMPLE_INTERVAL_DEFAULT   // configured floor (was: sampleInterval)
var effectiveInterval = baseInterval           // what the gate uses; >= baseInterval
var collectBaseline = null                     // EWMA of CALM collect durations (ms)
```

`collectBaseline` is `null` until the first collect seeds it.

### 3.2 Gate + measurement (`sample()`)

`sample()` stays subscribed to `ticker.1`. The gate now reads `effectiveInterval`; the collect
is timed and fed to the controller:

```
function sample() {
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastSampleMono < effectiveInterval) { return }   // gate uses effectiveInterval
  lastSampleMono = mono

  var t0 = performance.now()
  var snap = roundTelemetry(Met.createTelemetry())
  adjustCadence(performance.now() - t0)                        // congestion controller

  if (changedVsLastQueued(snap)) {
    enqueue(snap)
  } else if (C.HEARTBEAT_INTERVAL > 0 && mono - lastQueuedMono >= C.HEARTBEAT_INTERVAL) {
    enqueue(snap)
  }
}
```

The controller runs **once per sample** (after the gate passes), not once per tick — each
sample is one control opportunity. So abrp re-evaluates congestion at exactly the cadence it is
currently sampling at.

### 3.3 Controller (`adjustCadence`)

```
function adjustCadence(ms) {
  if (collectBaseline === null) { collectBaseline = ms; return }              // seed, no step
  if (ms > collectBaseline * C.COLLECT_PRESSURE_FACTOR) {
    // PRESSURE: multiplicative increase, capped. Do NOT fold this slow sample into baseline.
    effectiveInterval = Math.min(effectiveInterval * 2, C.BACKOFF_MAX_INTERVAL)
  } else {
    // CALM: update baseline (EWMA toward this fast collect), multiplicative recovery toward floor.
    collectBaseline = collectBaseline + C.COLLECT_BASELINE_ALPHA * (ms - collectBaseline)
    if (effectiveInterval > baseInterval) {
      effectiveInterval = Math.max(Math.floor(effectiveInterval / 2), baseInterval)
    }
  }
  if (C.DEBUG) {
    Logger.debug('cadence: collect_ms=' + ms.toFixed(1) + ' baseline=' + collectBaseline.toFixed(1)
      + ' interval=' + effectiveInterval)
  }
}
```

- **Increase / decrease are both multiplicative** (×2 up, ÷2 down) — symmetric "fast up, fast
  down". From `baseInterval = 3`: up `3→6→12→24→48→96→180`; down `180→90→45→22→11→5→3`. All
  values stay integers (`Math.floor` on halve; `baseInterval` is an integer 1–5; the cap is an
  integer).
- **Baseline updates on calm samples only.** A slow collect never enters the EWMA, so a spike
  cannot inflate the baseline and desensitize the 3× threshold.
- **Reaching the cap requires sustained congestion.** Each ×2 step costs one current-interval
  wait, so climbing `3→…→180` takes on the order of three minutes of continuous slow collects —
  the back-off is inherently hysteretic without an explicit counter.

### 3.4 Constants (`constants.js`)

Add three tunables:

```
COLLECT_PRESSURE_FACTOR: 3,    // collect > 3x rolling baseline counts as a slow collect
BACKOFF_MAX_INTERVAL: 180,     // seconds; cap for the stretched interval (~ABRP staleness window)
COLLECT_BASELINE_ALPHA: 0.25,  // EWMA weight for calm-sample baseline updates
```

### 3.5 Lifecycle (`config.js` / `events.js` unchanged at call sites)

`setSampleInterval(n)` (called from `callbackVehicleOn` at session start and from
`applyIntervals` on `config.changed`) sets the floor **and re-floors** the effective interval:

```
function setSampleInterval(n) {
  baseInterval = n
  effectiveInterval = n   // reset to the floor (fresh session, or a deliberate config change)
}
```

`setSampleInterval(n)` resets `effectiveInterval = n` (back to the floor).
`collectBaseline` **persists** — it is a device/vehicle characteristic, not session state.
Rationale: a fresh drive should start un-throttled; a mid-drive `config.changed` is a rare,
deliberate user action, so resetting back-off then is acceptable. No separate `resetCadence()`
is needed.

No other call sites change. `ticker.10` flush, heartbeat, and the on/off bookends are untouched.

## 4. Edge cases & risks

- **Heartbeat is suppressed during deep back-off (intentional).** `HEARTBEAT_INTERVAL` (160 s)
  is checked *after* the gate. Once `effectiveInterval > 160 s`, abrp samples too rarely to emit
  heartbeats, so the ABRP session goes stale and lapses. This is by design — "if OVMS is in
  crisis, ABRP data isn't important." The session re-establishes automatically when collects
  speed up and the interval recovers below the heartbeat. Documented, not guarded against.
- **Seed bias.** If the very first collect of a session is slow (startup contention),
  `collectBaseline` seeds high and the controller is briefly less sensitive; calm EWMA pulls it
  down within a few samples. Minor, self-correcting. (Considered seeding from min-of-first-K;
  rejected as unnecessary state.)
- **Recovery is coarse at high intervals.** abrp only re-checks "is it calm?" once per
  `effectiveInterval`, so the first recovery probe after a deep back-off is up to ~180 s out.
  Multiplicative decrease keeps total recovery time proportional to back-off depth (a handful of
  calm samples), which is the best achievable without a separate always-on probe (rejected:
  reintroduces per-tick work).
- **Cap vs `BACKOFF_MAX_INTERVAL = 180` vs config range.** `baseInterval` is ≤ 5 s, so the cap
  always leaves ample multiplicative headroom. The cap is a `constants.js` tunable.
- **Duktape constraints.** `var`/`function`, `Math.min`/`Math.max`/`Math.floor` only — no arrow
  functions, no template literals (string concatenation in the DEBUG line).

## 5. Test seam & tests

### Seam

`adjustCadence(ms)` is a **pure function of its `ms` argument** — it does not call
`performance.now()` itself (the caller measures and passes the duration), so it is fully
deterministic off-device where `performance` is a no-op stub. Expose via the owning module's
accessors and the entry's `__test` seam:

- `Q.adjustCadence(ms)` — drive the controller with synthetic durations.
- `Q.getEffectiveInterval()` — assert the current effective interval.
- `Q.getBaseline()` — assert the rolling baseline.

### New tests (`node:test`, against the bundle)

- **Seed:** first `adjustCadence(ms)` sets baseline to `ms`, leaves `effectiveInterval` at the
  floor, takes no step.
- **Back-off:** with baseline seeded (e.g. 90), a sequence of slow collects (e.g. 400) walks
  `effectiveInterval` `3→6→12→24→48→96→180` and **caps at 180** (further slow collects stay 180).
- **Baseline-poisoning guard:** slow collects do not change `getBaseline()`.
- **Recovery:** from a backed-off interval, calm collects (e.g. 95) halve it
  `…→…→baseInterval` and **floor at `baseInterval`** (never below); baseline EWMA moves toward
  the calm value.
- **Re-floor on config:** `setSampleInterval(n)` resets `effectiveInterval` to `n`; baseline
  persists.

### Updating existing tests

The current `sample()` gate tests reference `sampleInterval`/the single interval and the
`setSampleInterval` behavior. Update them to the `effectiveInterval` name and the re-floor
semantics. A test that needs the old "sample every gate-open" behavior is unaffected — with no
slow collects, `effectiveInterval` stays at the floor, so the gate behaves exactly as today.

## 6. Versioning & docs

Folds into the unreleased `3.0.0-alpha.x`: add a CHANGELOG bullet (adaptive sample cadence —
abrp slows its own sampling under event-loop congestion, detected via collect duration, capped
at `BACKOFF_MAX_INTERVAL`; configured `sample_interval` becomes the floor). Update
`SPECIFICATION.md` (sample cadence section + the constants table:
`+COLLECT_PRESSURE_FACTOR`, `+BACKOFF_MAX_INTERVAL`, `+COLLECT_BASELINE_ALPHA`) and note that
`sample_interval` is the *fastest* cadence (a floor), not a fixed rate. Cross-reference the
2026-06-07 stall investigation as the motivation.
