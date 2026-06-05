# ABRP 3.0 — Change-Based Telemetry Redesign — Design

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan.
**Branch:** `feature/abrp-3.0.0`
**Supersedes** the median-smoothing + state-adaptive-cadence path described in
`docs/SPECIFICATION.md` §4.6 / §5.1–5.2.

## 1. Summary

Replace the current "collect 1 Hz samples → median-smooth → queue on a
state-adaptive cadence" pipeline with a simpler **change-based** model:

- Sample the full metric set every `sample_interval` seconds (configurable 1–5,
  default 3), gated on `m.monotonic` elapsed time.
- Round each metric to a per-field precision; **queue a point only when a rounded
  field actually changed** since the last queued point (if only `utc` changed,
  queue nothing). One time-based exception — a **heartbeat** — keeps the ABRP
  session alive during long static periods.
- The queue holds **full snapshots**; **delta-encode at send time** (first point
  of each bulk POST is full, the rest carry `utc` + changed fields only).
- Drop median smoothing and all speed/parked/charging cadence logic.

Net result: less code, less bandwidth (fewer points *and* smaller points), and a
delta scheme that is safe against dropped points.

## 2. Goals & non-goals

**Goals**

- Send ABRP only meaningful changes, encoded compactly, without losing integrity.
- Make the noisy-signal handling explicit and tunable (rounding precisions).
- Remove the median-smoothing machinery and the state-adaptive cadence branches.
- A clean vehicle-off bookend that unambiguously shows the car parked/stopped.

**Non-goals (explicitly out of scope; remain as tracked follow-ups)**

- Configurable **send/flush** interval (`SPECIFICATION.md` §11 #6) — this redesign
  keeps the `ticker.10` flush as-is. The design is *compatible* with a configurable
  flush interval but does not implement it.
- "Send the whole queue per flush" (§11 #6 note) — `MAX_BULK_BATCH_SIZE = 10` is
  unchanged. Delta encoding works for any batch size (first-of-batch is full).
- The session lifecycle is unchanged: `callbackVehicleOn`/`callbackVehicleOff`
  (and charge start/stop) still decide *when* sampling runs.

## 3. Architecture & data flow

```
ticker.1  ──▶  sample()                         (queue.js)
                 ├─ elapsed-gate on m.monotonic (every sample_interval s)
                 ├─ snap = roundTelemetry(createTelemetry())
                 ├─ changed vs lastQueued?  ──yes──▶ enqueue(snap)
                 └─ else heartbeat elapsed? ──yes──▶ enqueue(snap)

vehicle.on / charge.start ──▶ callbackVehicleOn()   (events.js)
                                └─ enqueue(full natural snapshot), subscribe ticker.1

vehicle.off / charge.stop ──▶ callbackVehicleOff()  (events.js)
                                └─ enqueue(full snapshot, forced parked), unsubscribe ticker.1

ticker.10 ──▶ sendBulkTelemetry()                   (telemetry.js)
                └─ createBulkPost(batch) delta-encodes: point[0] full, rest utc+changed
                └─ on 200+status:ok: removeTelemetryBatch(batch) by identity (unchanged)
```

**Cadence clock vs telemetry timestamp.** All cadence timing (sample gate,
heartbeat) uses `m.monotonic` (uptime seconds) — monotonic, immune to NTP jumps,
and self-correcting if a `ticker.1` is delayed or coalesced (the documented 3.0
ticker-stall concern). The telemetry point's `utc` field still comes from
`m.time.utc` — that is data for ABRP, not a cadence clock. No hand-maintained tick
counter; OVMS exposes no tick-count metric, and elapsed-time gating is more robust
than counting anyway.

## 4. Collection loop (`queue.js`)

Replaces `queueTelemetryIfNecessary`, `calculateMaxElapsedDuration`,
`isSignificantTelemetryChange`, and the `collectedMetrics`/`medianPowerMetrics`
smoothing path.

**Module state:** `lastQueuedTelemetry` (existing — the most recent queued full
snapshot, the change-detection baseline), `lastSampleMono`, `lastQueuedMono`. The
session's `sample_interval` is cached at session start.

```
function sample() {                                  // subscribed to ticker.1
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastSampleMono < sampleInterval) return // elapsed-time gate
  lastSampleMono = mono

  var snap = roundTelemetry(Met.createTelemetry())   // full, rounded snapshot
  if (changedVsLastQueued(snap)) {
    enqueue(snap)
  } else if (HEARTBEAT_INTERVAL > 0 && mono - lastQueuedMono >= HEARTBEAT_INTERVAL) {
    enqueue(snap)                                    // keep the session alive
  }
}
```

- **`roundTelemetry(snap)`** rounds each key present in the `ROUNDING` map to its
  precision (via the existing `round()` helper, which already passes through
  `0`/`null`/`undefined`). Keys absent from the map (`utc`, the `is_*` booleans)
  are left as-is. The rounded value is what gets queued **and** sent — change
  detection and payload use the same value (no "compared X, sent Y" class of bug).
- **`changedVsLastQueued(snap)`** iterates `snap`'s keys, skips `utc`, and returns
  true on the first field that differs from `lastQueuedTelemetry`. If only `utc`
  differs → false → nothing queued. (Limitation: a field that *disappears*
  mid-session is not detected as a change; see §8.)
- **`enqueue(snap)`** pushes to `telemetryToSend`, applies the existing overflow
  drop (`> MAX_TELEMETRY_QUEUE_SIZE` → `shift()` oldest), and stamps
  `lastQueuedTelemetry = snap` and `lastQueuedMono` from `m.monotonic`. Overflow
  drops the *oldest*, never the most-recent baseline, so change detection is
  unaffected.
- **Heartbeat** is the only time-based rule; `HEARTBEAT_INTERVAL = 0` disables it.

## 5. Bookends (`events.js`)

Both are **unconditional** enqueues (they bypass the change check — a session edge
always produces a point) and seed the cadence baselines.

**`callbackVehicleOn()`** — `roundTelemetry(createTelemetry())` of the start state
(rounded, so the change-detection baseline matches subsequent samples),
`enqueue(snap)`, then subscribe `ticker.1` to `sample`. Reads + caches
`sample_interval` from config (`Cfg.sampleInterval()`) and seeds `lastSampleMono`
so the first sample times cleanly off the start.

**`callbackVehicleOff()`** — rounded full snapshot with a forced,
internally-coherent "parked & idle" state, then unsubscribe `ticker.1`:

```
snap = roundTelemetry(createTelemetry())
snap.speed = 0; snap.power = 0; snap.is_parked = true
snap.is_charging = false; snap.is_dcfc = false
enqueue(snap)
```

Everything else (`soc`, `lat`/`lon`, `soh`, temps, `odometer`) reads naturally —
the true arrival values. Applies to **both** triggers (`vehicle.off` and
`vehicle.charge.stop`), since both end with the car parked. `v.e.parktime` may not
have flipped at the exact event instant, so forcing avoids a stale "still driving"
final point.

**Bookend encoding (decision: option (i), no special-casing).** Bookends are full
snapshots in the queue like any other point; on the wire they follow the normal
first-of-batch-full / delta rule (§6). This is sufficient because (a) the
off-bookend's forced values are *changes* (`is_parked` false→true, `speed`/`power`
→0), so they always appear in the delta, and (b) the per-batch full resync already
gives ABRP a complete state every flush. No per-point "always full" flag is needed.

## 6. Send-side delta encoding (`telemetry.js`)

Folded into `createBulkPost(batch)`. The in-flight guard, the
`200 && status:"ok"` gate, and removal-by-identity are unchanged.

```
function deltaEncode(batch) {        // batch = full rounded snapshots from the queue
  var out = [], prev = null
  for (var i = 0; i < batch.length; i++) {
    var p = batch[i]
    if (prev === null) {
      out.push(clone(p))             // FIRST point of the POST = full → resync
    } else {
      var d = { utc: p.utc }         // utc always present (only required field)
      for (var k in p) {
        if (k !== 'utc' && p[k] !== prev[k]) d[k] = p[k]
      }
      out.push(d)
    }
    prev = p
  }
  return out
}

createBulkPost(batch) → { data: [ { token: Cfg.token(), tlm_list: deltaEncode(batch) } ] }
```

**Integrity invariants:**

- **First point of every POST is full.** Each `ticker.10` flush sends one batch, so
  ABRP is fully resynced every flush (~10 s). This immunizes the delta chain against
  a dropped point — the hazard that motivated the full-snapshot-in-queue decision.
- **`deltaEncode` never mutates the queued originals** (it builds new objects and
  clones the first). A failed send keeps the batch in the queue and re-encodes it
  fresh (first-full again) next flush — failures cannot corrupt the chain.
- **Removal stays by identity** of the original full snapshots
  (`removeTelemetryBatch(batch)`), independent of the encoded body. The
  overflow-during-flight fix (`SPECIFICATION.md` §5.4) is untouched.

## 7. Constants, config, removals

**New tunables (`constants.js`):**

```
SAMPLE_INTERVAL_DEFAULT = 3     // seconds; overridden by usr abrp.sample_interval (1–5)
HEARTBEAT_INTERVAL      = 160   // seconds; 0 disables (supersedes METRIC_POLL_STALE_CONNECTION)
ROUNDING = {                    // telemetry key -> decimal places; one map, easy to tune
  soc:0, power:1, speed:0, lat:5, lon:5, heading:0, elevation:0,
  ext_temp:0, batt_temp:0, cabin_temp:0, hvac_setpoint:0, hvac_power:1,
  voltage:0, current:0, odometer:1, est_battery_range:0, soh:0, soe:1, capacity:1,
  tire_pressure_fl:0, tire_pressure_fr:0, tire_pressure_rl:0, tire_pressure_rr:0
}
// keys absent from ROUNDING (utc, is_charging, is_dcfc, is_parked) compare/send as-is
```

**Config (`config.js`):** add `sampleInterval()` — reads `usr abrp.sample_interval`,
validates/clamps to 1–5, defaults to `SAMPLE_INTERVAL_DEFAULT`. Read once at session
start and cached; a change takes effect on the next session. (Live update via a
`config.changed` subscription is a future nicety, out of scope.)

**Removed:**

- `queue.js`: `collectedMetrics` + accessors, `medianPowerMetrics` use,
  `calculateMaxElapsedDuration`, `isSignificantTelemetryChange`, old cadence branches.
- `util.js`: `medianPowerMetrics` (now dead) + its unit tests. `round()` stays.
- `constants.js`: `MIN_CALIBRATION_SPEED`, `METRIC_POLL_RATE_DRIVING`,
  `METRIC_POLL_RATE_CHARGING`, `METRIC_POLL_STALE_CONNECTION`, `BANDWIDTH_SAVER`.
- `events.js`: `callbackVehicleOff` no longer clears `collectedMetrics`.

**Public-surface change:** the entry's `module.exports` drops the test-only pure
helpers `isSignificantTelemetryChange` and `calculateMaxElapsedDuration` (deleted).
The in-vehicle entry points (`info`/`onetime`/`send`/`resetConfig`) are unchanged —
**no user-facing interface change** beyond the new optional config key.

## 8. Edge cases & risks

- **Field disappears mid-session.** ABRP's persistence model cannot "unset" a key;
  neither full nor delta points can remove a previously-sent field. If a metric
  stops being supported mid-session (rare), ABRP keeps carrying its last value.
  Accepted — not specific to this design.
- **Heartbeat necessity is unverified.** Whether ABRP actually drops a quiet session
  is not confirmed (`SPECIFICATION.md` §5.3 lists dropping the keep-alive as an
  untested candidate). `HEARTBEAT_INTERVAL` defaults to 160 s as safe insurance and
  can be set to `0` on-device to A/B it without code changes.
- **Rounding-boundary flap.** A value oscillating across a rounding boundary (e.g.
  `49.5 ↔ 50.5` at 0 dp) can flip the rounded value and queue a point each way.
  Acceptable; tune the precision or revisit with deadbands only if it shows up.
- **Removing median smoothing** sends instantaneous (rounded) `power`/`speed` rather
  than a windowed median. Rounding tames the noise that smoothing addressed; if ABRP
  consumption accuracy regresses on-vehicle, revisit `ROUND_POWER` first.
- **Sample interval is read per session.** Changing `usr abrp.sample_interval`
  mid-drive has no effect until the next session. Acceptable.

## 9. Testing (`node:test`)

**New:**

- `roundTelemetry`: each mapped field rounds to its precision; unmapped fields and
  booleans pass through.
- `changedVsLastQueued`: false when only `utc` differs; sub-precision noise ignored
  (e.g. `power 5.04 → 5.06` both round to `5.0` at 1 dp → no change); a real change
  detected.
- `sample`: `m.monotonic` elapsed-gate (skips before interval, runs after);
  enqueues on change; skips on no-change; heartbeat forces an enqueue after
  `HEARTBEAT_INTERVAL`; `HEARTBEAT_INTERVAL = 0` disables.
- Bookends: on = natural full snapshot; off = forced `speed`/`power` `= 0`,
  `is_parked = true`, `is_charging`/`is_dcfc` `= false`, other fields natural.
- `deltaEncode`: first point full; subsequent points `utc` + changed only; `utc`
  always present; originals not mutated; batch of 1 → single full point.
- `sendBulkTelemetry`: body is delta-encoded; identity-removal and the
  `status:"error"` / failure-retry behavior unchanged.

**Updated/removed:** delete the median-smoothing and
`isSignificant`/`calculateMaxElapsed` suites; keep the bulk data-integrity tests but
assert delta-encoded bodies. Stub `m.monotonic` in the `OvmsMetrics` mock.

## 10. Versioning

User-facing config key + behavior change → bump `VERSION` (a `3.0.0-alpha`-tier
change) and add a `CHANGELOG.md` entry. Update `SPECIFICATION.md` §4.6 / §5.1–5.2
to describe the change-based model (and resolve §11 #5 — the cold-boot charging
note — separately, unless folded into this work).
