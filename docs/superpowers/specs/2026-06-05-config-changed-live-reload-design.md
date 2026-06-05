# ABRP 3.0 — `config.changed` Live-Reload of Cadence Knobs — Design

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan.
**Branch:** `feature/abrp-3.0.0`
**Builds on** the sample-interval and send-interval config knobs
(`docs/superpowers/specs/2026-06-05-telemetry-change-based-redesign-design.md`,
`docs/superpowers/specs/2026-06-05-configurable-flush-interval-design.md`).

## 1. Summary

Re-read the two cadence config keys (`usr abrp.sample_interval`,
`usr abrp.send_interval`) when OVMS fires `config.changed`, so a `config set` takes
effect on the next sample/flush tick instead of only at the next session. No JS-engine
reload or session restart needed.

## 2. Goals & non-goals

**Goals**
- A `config set usr abrp.sample_interval|send_interval <n>` applies live (next tick).

**Non-goals**
- Re-reading the **token** on config change (`Cfg.validate()` already re-reads it
  lazily; out of scope).
- Any new config keys, constants, or validation (the clamping already lives in
  `Cfg.sampleInterval()`/`Cfg.sendInterval()`).
- Filtering by which key changed — OVMS's `config.changed` carries **no payload**
  identifying the parameter (verified against the OVMS events reference), so the
  handler re-reads both keys unconditionally.

## 3. Design

**Event:** OVMS fires `config.changed` ("Configuration has changed") on every
`config set`, with no event data. The handler therefore re-reads our two keys on
every fire — two `OvmsConfig.GetValues` + clamp calls, negligible cost (config changes
are infrequent user actions, not a ticker).

**Handler** (`events.js`):
```javascript
function applyIntervals() {
  Q.setSampleInterval(Cfg.sampleInterval());
  Tlm.setSendInterval(Cfg.sendInterval());
}
```

**Subscription:** in `Ev.startup()`, add `subscribe('config.changed', applyIntervals)`.
Subscribing at **startup** (process lifetime) — not session start — so the cached
intervals are kept current whether or not a session is active. The setters only update
module-level vars (`queue.js` `sampleInterval`, `telemetry.js` `sendInterval`) read by
the sampler / flush gates on their next tick, so updating them at any time is safe.

**Existing session-start reads stay unchanged:** `callbackVehicleOn` →
`Q.setSampleInterval(Cfg.sampleInterval())` and `manageVehicleStateEvents` →
`Tlm.setSendInterval(Cfg.sendInterval())`. They are now slightly redundant with the
live handler but harmless (same setters), and they guarantee correctness at session
start independent of event ordering. Minimal-change principle.

## 4. Edge cases & risks

- **Fires for unrelated config changes.** Any `config set` (not just `usr abrp.*`)
  triggers a re-read of our two keys. Cost is trivial and idempotent; no filtering
  needed.
- **Lowering an interval mid-wait applies promptly.** e.g. `send_interval` 60 → 10
  after 30 s have elapsed: the next `ticker.10` gate (`mono - lastFlushMono >= 10`)
  opens immediately. Raising it extends the next wait. Both correct.
- **Current in-flight tick is unaffected.** A change updates the var; the *next* gate
  evaluation uses it. No mid-cycle reconfiguration hazard.
- **Off-device/tests.** `Ev.startup()` is already guarded by
  `typeof OvmsConfig/OvmsMetrics/PubSub !== 'undefined'`, so the new subscribe only
  runs on-device; tests drive the handler directly via the `__test` seam.

## 5. Testing (`node:test`)

Expose `applyIntervals` via the entry `__test` seam. Bundle tests (using `loadAbrp`):

- **send_interval live-reload:** load with `OvmsConfig.GetValues` → `{ send_interval:
  '20' }` and a stubbed mutable `m.monotonic` + `HTTP`. Call `abrp.__test.applyIntervals()`,
  push a point, and assert the flush gate now uses 20 — `sendBulkTelemetry()` at
  `mono = 19` does not POST, at `mono = 20` does.
- **sample_interval live-reload:** load with `OvmsConfig.GetValues` → `{ sample_interval:
  '5' }`. Call `applyIntervals()`, seed a fresh baseline, and assert the sampler gate
  uses 5 — `sample()` at elapsed 4 does not enqueue, at elapsed 5 does.

## 6. Docs & versioning

Folds into the unreleased `3.0.0-alpha.1`: a CHANGELOG bullet (cadence config keys now
apply live via `config.changed`). In `SPECIFICATION.md`, add a `config.changed` →
`applyIntervals` row to the §4.4 event table, and note in the §8 config-keys text that
`sample_interval`/`send_interval` changes apply live (no session restart). (There is no
existing "takes effect next session" claim to correct — the cadence keys were simply
read at session start before.) No version bump beyond the existing alpha.
