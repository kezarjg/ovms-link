# ABRP 3.0 — Configurable Flush Interval + Send-Whole-Queue — Design

**Date:** 2026-06-05
**Status:** Approved design, pending implementation plan.
**Branch:** `feature/abrp-3.0.0`
**Resolves** `docs/SPECIFICATION.md` §11 follow-up #6.
**Builds on** the change-based telemetry redesign
(`docs/superpowers/specs/2026-06-05-telemetry-change-based-redesign-design.md`).

## 1. Summary

Two coupled changes to the bulk-flush path (`telemetry.js`):

- **Send-whole-queue.** Each flush sends the *entire* queue (bounded by
  `MAX_TELEMETRY_QUEUE_SIZE = 100`) instead of a 10-point slice. `MAX_BULK_BATCH_SIZE`
  is removed. A backlog (after an outage) drains in one flush rather than 10 points
  per `ticker.10`.
- **Configurable flush interval.** The flush cadence becomes user-selectable 10–60 s
  via `usr abrp.send_interval` (default 10), gated on `m.monotonic` elapsed time —
  the same pattern as the sampler. Sending the whole queue is what makes a longer
  interval safe (no per-flush 10-point cap to back up behind).

Delta encoding (already implemented) keeps even a full-queue POST compact.

## 2. Goals & non-goals

**Goals**
- Let users trade latency for fewer network wakeups (10–60 s flush).
- Drain a backlog in a single flush; remove the drain-lag coupling the change-based
  redesign left open.
- Keep default behavior identical to today (flush every 10 s).

**Non-goals**
- No change to the **sample** cadence (`usr abrp.sample_interval`) — that's a separate
  knob (how often points are *captured*; this is how often they're *sent*).
- No change to delta encoding, the in-flight guard, the `200 && status:"ok"` success
  gate, or removal-by-identity.
- No change to `MAX_TELEMETRY_QUEUE_SIZE` (still the queue/POST ceiling).

## 3. Design

### 3.1 Flush gate (`telemetry.js`)

`sendBulkTelemetry` stays subscribed to `ticker.10`. New module state:
`var lastFlushMono = 0`, `var sendInterval = C.SEND_INTERVAL_DEFAULT`.

```
function sendBulkTelemetry() {
  if (isSending) { return }
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastFlushMono < sendInterval) { return }   // not time to flush yet
  if (Q.getQueue().length === 0) { return }             // nothing to send (lastFlushMono unchanged)
  lastFlushMono = mono
  var batch = Q.snapshot(C.MAX_TELEMETRY_QUEUE_SIZE)     // the whole queue
  var bulkPost = createBulkPost(batch)
  // ... unchanged: isSending=true, HTTP.Request(timeout 8000),
  //     on 200+status:ok -> Q.removeTelemetryBatch(batch); else keep for retry ...
}
```

- **Why `m.monotonic`, not a tick counter:** identical rationale to the sampler —
  monotonic, immune to NTP jumps, self-correcting if a `ticker.10` is delayed/coalesced.
  The flush still only lands on `ticker.10` boundaries, so effective granularity is
  10 s (a `send_interval` of, say, 25 effectively flushes at the next boundary ≥ 25 s,
  i.e. 30 s).
- **`lastFlushMono` is stamped only when a flush actually starts** (after the
  non-empty check). So an interval that elapses while the queue is empty does not reset
  the clock — the moment data arrives on a later tick, it flushes promptly.
- **Whole queue:** `Q.snapshot(C.MAX_TELEMETRY_QUEUE_SIZE)` returns every queued point
  (the queue can never exceed that cap). `MAX_BULK_BATCH_SIZE` is removed.

### 3.2 Config (`config.js`)

Add `sendInterval()` — reads `usr abrp.send_interval`, `parseInt`, clamps to 10–60,
defaults to `C.SEND_INTERVAL_DEFAULT` when unset/NaN. (Same shape as `sampleInterval()`,
different range/default.)

### 3.3 Wiring (`events.js`)

`sendInterval` is read once per session and cached in `telemetry.js`, mirroring how
`sample_interval` is cached at session start. In `manageVehicleStateEvents(true)` —
where `ticker.10 -> sendBulkTelemetry` is subscribed — add
`Tlm.setSendInterval(Cfg.sendInterval())`. `telemetry.js` exposes
`setSendInterval(n)` (sets the module `sendInterval`). A config change takes effect on
the next session (acceptable; matches `sample_interval`).

### 3.4 Constants (`constants.js`)

- Add `SEND_INTERVAL_DEFAULT: 10`.
- Remove `MAX_BULK_BATCH_SIZE` (no longer referenced).

## 4. Edge cases & risks

- **8 s HTTP timeout on a full-queue POST.** A worst-case ~100-point batch must finish
  within the 8 s window (it must complete before the next `ticker.10`). Delta encoding
  shrinks the payload (first point full, rest `utc`+changed); a timeout is **lossless**
  — the batch stays queued and retries next flush. Accepted; confirm headroom
  on-vehicle over a poor link. No timeout change.
- **Flush granularity is 10 s.** `send_interval` values between multiples of 10 round
  up to the next `ticker.10` boundary. Documented; the config is described as "10–60 s
  (10 s granularity)".
- **`send_interval` read per session.** Changing it mid-drive takes effect next session.
- **Two independent cadence knobs.** `sample_interval` (capture) and `send_interval`
  (flush) are orthogonal; `send_interval >= sample_interval` is the sensible regime but
  not enforced (any combination is safe — sending simply batches whatever was captured).

### Test seam

`telemetry.js` exports `setSendInterval(n)` (a raw setter — no clamp; clamping lives in
`Cfg.sendInterval()`), and the entry re-exposes it via `__test.setSendInterval`. A raw
`setSendInterval(0)` **disables the gate** (`mono - lastFlushMono < 0` is never true when
`mono >= lastFlushMono`), which restores today's flush-every-tick behavior for tests that
need it.

### New tests (`node:test`)

- `config.sendInterval()`: default 10 when unset; `'30'`→30; `'5'`→10 (clamp low);
  `'90'`→60 (clamp high); `'x'`→10.
- `sendBulkTelemetry` flush gate (bundle, stubbed mutable `m.monotonic` + `HTTP`):
  - with `setSendInterval(30)`: a tick at `mono=10` (interval not elapsed, queue
    non-empty) does **not** POST; advancing to `mono=40` **does** POST.
  - **sends the whole queue** — push >10 points, open the gate, assert the POST's
    `tlm_list` length equals the queued count (not capped at 10) and on success the queue
    is emptied.

### Updating existing tests (required — `sendBulkTelemetry` now reads `m.monotonic`)

The current `sendBulkTelemetry data integrity` suite stubs only `HTTP` and calls
`sendBulkTelemetry` repeatedly expecting **immediate** re-flush. Two breakages to fix:

1. `OvmsMetrics` is no longer present → `OvmsMetrics.Value('m.monotonic')` throws. Add an
   `OvmsMetrics` stub to that suite's `loadAbrp`.
2. The interval gate would block the 2nd+ call (same `mono` → closed). In `setup()`, call
   `abrp.__test.setSendInterval(0)` to disable the gate so those tests keep their
   immediate, multi-call semantics.

The "sends and removes at most `MAX_BULK_BATCH_SIZE` (10) per flush" test changes meaning:
with the gate disabled it now sends the **whole** 15-point queue — assert `tlm_list`
length 15 and an empty queue after success (and the `queue-overflow` test's expectations
follow from whole-queue send).

## 6. Versioning & docs

Folds into the unreleased `3.0.0-alpha.1`: add a CHANGELOG bullet (configurable
`usr abrp.send_interval`; whole-queue flush; `MAX_BULK_BATCH_SIZE` removed). Update
`SPECIFICATION.md` §5 (flush cadence + whole-queue), the §8 constants table
(−`MAX_BULK_BATCH_SIZE`, +`SEND_INTERVAL_DEFAULT`), and mark §11 #6 **resolved**. Note
both config knobs (`sample_interval`, `send_interval`) in the config docs.
