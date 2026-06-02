# ovms-link — Project Specification

**Version:** 2.3.0
**Status:** Current (reflects `lib/abrp.js` as of 2.3.0)
**Audience:** Maintainers and integrators of the OVMS → ABRP telemetry plugin.

This document specifies the complete behavior of the plugin as built. It is
descriptive of the current implementation, not a forward-looking design (for the
2.3.0 change rationale see `docs/superpowers/specs/2026-06-01-abrp-2.3.0-refactor-design.md`).

---

## 1. Purpose & scope

`ovms-link` is a plugin for the [Open Vehicle Monitoring System
(OVMS)](https://www.openvehicles.com/) that streams live electric-vehicle
telemetry to [A Better Routeplanner (ABRP)](https://abetterrouteplanner.com) via
the Iternio Telemetry API. ABRP uses the live data to drive and continuously
re-plan EV routes (state of charge, charging stops, consumption calibration).

**In scope:** collecting supported OVMS metrics, mapping them to the Iternio
telemetry schema, and transmitting them with state-aware cadence and at-least-once
delivery semantics.

**Out of scope (non-goals):** route planning itself (done by ABRP); any UI;
multi-vehicle support (one OVMS module = one vehicle = one token); persistence
across JS-engine reloads (state is in-memory only).

---

## 2. System context

```
  ┌──────────────┐   metrics    ┌─────────────────┐   HTTPS    ┌──────────────┐
  │  Vehicle CAN │ ───────────► │  OVMS module    │ ─────────► │ Iternio /    │
  │  bus / ECUs  │   (OVMS      │  (Duktape JS)   │  tlm/send  │ ABRP servers │
  └──────────────┘    metrics)  │  lib/abrp.js    │  tlm/bulk  └──────────────┘
                                └─────────────────┘
```

- **OVMS module:** embedded hardware running the OVMS firmware, which exposes a
  **Duktape** JavaScript engine and a set of injected host objects. The plugin is
  a script loaded by that engine.
- **Iternio/ABRP API:** REST API at `https://api.iternio.com/1/`. The plugin is
  authenticated by a shared application **API key** and a per-user **token**.

---

## 3. Runtime constraints (these shape the whole design)

1. **Duktape / ECMAScript 2015.** The deliverable runs in Duktape, not Node. Code
   must avoid syntax Duktape does not support reliably: **no arrow functions, no
   template literals, no object spread/rest, no block-scope guarantees.** The
   house style is `var` + `function` declarations with string concatenation.
   `const` exists but offers little beyond `var` (see the note at the top of
   `lib/abrp.js`).
2. **Host globals are injected, not imported.** The plugin uses these OVMS-provided
   globals: `HTTP`, `OvmsConfig`, `OvmsMetrics`, `OvmsNotify`, `PubSub`,
   `performance`, `print`. There is no `console`, no `require` other than OVMS's
   own module loader, no filesystem.
3. **Single-file deliverable, hand-installed.** The product is `lib/abrp.js` plus a
   one-line `ovmsmain.js` and a set of CA certificates, copied file-by-file into
   the OVMS web editor. There is **no build/bundler step**; the source file *is*
   the artifact. This is why all logic lives in one file.
4. **In-memory, single-process.** All state is module-level variables. A JS-engine
   reload resets everything; there is no persistence.

---

## 4. Architecture

`lib/abrp.js` is organized top-to-bottom: constants → `metricMap` → utilities →
metric functions → telemetry pipeline → transmission → event handlers → core
control functions → initialization → exports.

### 4.1 Component responsibilities

| Area | Functions | Responsibility |
| --- | --- | --- |
| Metric definition | `metricMap`, `overrideMetricMap` | Declarative map of ABRP keys → OVMS source metrics; per-vehicle overrides |
| Metric resolution | `isOvmsMetricSupported`, `getOVMSMetric`, `createTelemetry` | Read OVMS metrics, build a telemetry object containing only supported keys |
| Cadence | `isSignificantTelemetryChange`, `calculateMaxElapsedDuration` | Decide when a telemetry point should be queued |
| Smoothing | `medianPowerMetrics`, `queueTelemetry`, `queueTelemetryIfNecessary` | Collect 1 Hz samples while driving; apply median power/speed on queue |
| Queue & transmit | `createBulkPost`, `sendBulkTelemetry`, `sendTelemetry`, `removeTelemetry`, `isApiOk` | FIFO queue, bulk upload, at-least-once delivery |
| Events | `subscribe`/`unsubscribe`, `manageVehicleStateEvents`, `callbackVehicleOn/Off`, `checkTime` | PubSub wiring, startup gating, session lifecycle |
| Control | `info`, `onetime`, `send`, `resetConfig`, `validateUsrAbrpConfig` | In-vehicle shell entry points and configuration |

### 4.2 The metric map (the heart of the design)

Telemetry is **data-driven**. `metricMap` is an array; each entry declares:

- `key` — the Iternio telemetry field name.
- `label`, `unit` — human-readable, used by `info()`.
- `requiredMetrics` — the OVMS metric names needed to compute the value. An empty
  array (or absent) means **unsupported** → never sent.
- `metric(metrics)` — pure function computing the value from the required metrics.

`createTelemetry()` iterates the map; for each entry, `getOVMSMetric(key)` returns
`[supported, value]`. A metric is included **only if every** `requiredMetrics`
entry currently reports a value (`OvmsMetrics.HasValue`). Therefore the plugin
**auto-adapts to each vehicle** — a metric the vehicle does not publish is
silently omitted, never sent as null.

**To add a telemetry field:** add one `metricMap` entry. Do not thread it through
individual functions.

### 4.3 Vehicle-specific overrides

`overrideMetricMap()` mutates `metricMap` at startup and on the `vehicle.type.set`
event, keyed on `OvmsMetrics.Value('v.type')`:

| `v.type` | Vehicle | Override |
| --- | --- | --- |
| `KS` | Kia Soul EV | Removes `soh` (OVMS SOH calc is buggy for this vehicle) |
| `NL` | Nissan Leaf | `soc`/`soh`/`est_battery_range` use instrument-cluster metrics (`xnl.*`) |
| `SUBSOL` | Subaru Solterra | `is_parked` derived from `v.e.gear === 0` |
| `TOYBZ4X` | Toyota bZ4X | `is_parked` derived from `v.e.gear === 0` |

New vehicles are added as `case` blocks in this `switch`.

### 4.4 Event-driven control flow

There is **no main loop**. The plugin reacts to OVMS PubSub events. Subscriptions
are made through the `subscribe`/`unsubscribe` wrappers, which **track PubSub
tokens** in the `subscriptions` map so teardown is reliable (always use these,
never `PubSub` directly).

| Event | Handler | When active |
| --- | --- | --- |
| `ticker.1` (1 Hz) | `checkTime` | At startup, until GPS time is valid |
| `ticker.1` (1 Hz) | `queueTelemetryIfNecessary` | While the vehicle is on/charging |
| `ticker.10` (0.1 Hz) | `sendBulkTelemetry` | Whenever sending is active |
| `vehicle.on`, `vehicle.charge.start` | `callbackVehicleOn` | Session start |
| `vehicle.off`, `vehicle.charge.stop` | `callbackVehicleOff` | Session end |
| `vehicle.type.set` | `overrideMetricMap` | Vehicle type becomes known/changes |

### 4.5 Startup sequence

1. Module load: if OVMS globals are present, `overrideMetricMap()` runs and
   `checkTime` subscribes to `ticker.1`. (Off-device, e.g. under Jest, this block
   is skipped — see §9.)
2. `checkTime` fires each second until `m.time.utc` > `946684800` (Jan 1 2000),
   i.e. **GPS/RTC time is valid**. Until then, nothing is sent (telemetry without a
   valid UTC is useless to ABRP).
3. Once valid: unsubscribe `checkTime` from `ticker.1`, call `send(true)`.
4. `send(true)` validates config + time, then `manageVehicleStateEvents(true)`
   subscribes the vehicle/charge events and `ticker.10` → `sendBulkTelemetry`. If
   the vehicle is already on (`v.e.on`), it immediately runs `callbackVehicleOn`.

### 4.6 Telemetry pipeline (collect → queue → bulk send)

```
ticker.1  ──► queueTelemetryIfNecessary
                 │  createTelemetry()  (current snapshot)
                 │  if !is_parked: collectedMetrics.push(sample)   ── 1 Hz collection
                 │  if elapsed >= calculateMaxElapsedDuration:
                 │       queueTelemetry(sample, applyMedian=true)
                 ▼
            telemetryToSend  (FIFO, cap 100)
                 ▲
ticker.10 ──► sendBulkTelemetry
                 │  if isSending or empty: return
                 │  batch = telemetryToSend.slice(0, 10)   ── snapshot
                 │  POST /1/tlm/bulk
                 │  on (HTTP 200 AND status:"ok"): removeTelemetry(batch.length)
                 │  else: keep batch for retry next tick
```

**Median smoothing.** While not parked, every 1 Hz sample is pushed to
`collectedMetrics`. When a point is queued, `queueTelemetry(..., true)` replaces
its `power`/`speed` with the **median by power** of the collected samples
(`medianPowerMetrics`), then resets `collectedMetrics`. This denoises the
power/speed used for ABRP's km/kWh calibration. Smoothing is **driving-only by
design**: `is_parked` is true during charging, so charge points carry
instantaneous power (responsiveness handled by significant-change detection, §5.1).

---

## 5. Behavioral specification

### 5.1 Significant-change detection (`isSignificantTelemetryChange`)

A change vs. the last queued telemetry is **significant** (forces an immediate
send) if any of:

- `soc` changed (so ABRP reflects SoC promptly), or
- `is_charging` changed, or
- `is_parked` changed, or
- charging **and** `round(power)` changed (responsive charge-power curve).

### 5.2 Send cadence (`calculateMaxElapsedDuration`)

Returns the maximum seconds that may elapse before the next queue, given current
state (first match wins):

| Condition | Max elapsed | Constant |
| --- | --- | --- |
| Significant change | `0` (always send) | — |
| Speed > 70 kph | `5 s` | `METRIC_POLL_RATE_DRIVING` |
| Not parked, or DC fast charging | `160 s` | `METRIC_POLL_STALE_CONNECTION` ((3·60)−20) |
| Standard charging | `1800 s` (30 min) | `METRIC_POLL_RATE_CHARGING` |
| Parked (default) | `86400 s` (24 h) | — |

`METRIC_POLL_STALE_CONNECTION` is kept below the OVMS API-key staleness window
(~3 min) so the session stays alive.

### 5.3 Session lifecycle

- **`callbackVehicleOn`** (vehicle on / charge start): queues an immediate snapshot
  (`queueTelemetryManual`) and subscribes `ticker.1` → `queueTelemetryIfNecessary`.
- **`callbackVehicleOff`** (vehicle off / charge stop): unsubscribes `ticker.1`,
  queues a final snapshot, clears `collectedMetrics`.

### 5.4 Queue management & delivery semantics

- `telemetryToSend` is a FIFO array, capacity `MAX_TELEMETRY_QUEUE_SIZE = 100`.
  On overflow the **oldest** entry is dropped (`shift`) with a warning.
- `sendBulkTelemetry` sends **at most one batch** per call:
  - **In-flight guard** (`isSending`): no overlapping requests; cleared in `done`,
    `fail`, and a `try/catch` around `HTTP.Request` (so a synchronous throw cannot
    wedge the flag).
  - **Batch snapshot:** `batch = telemetryToSend.slice(0, MAX_BULK_BATCH_SIZE)`
    (≤10). The removal count is fixed at send time, so telemetry appended during
    the in-flight request is not lost.
  - **Success = HTTP 200 AND body `status === "ok"`** (`isApiOk`). Only then are
    the batch's points removed **by identity** (so a concurrent overflow drop that
    shifted the queue front cannot discard unsent points). On any other outcome the batch
    is **kept for retry** on the next `ticker.10`. This is **at-least-once**
    delivery (a success the client never observes can cause a re-send; ABRP
    tolerates duplicate timestamps).

### 5.5 Number handling

`round(n, p)` returns `n` unchanged when falsy (0/null/undefined), else
`Number(n.toFixed(p||0))`. Median power is rounded to 2 dp, speed to integer.

### 5.6 Bandwidth & data usage

The OVMS module typically transmits over a **metered cellular link**, so
minimizing data is a first-class concern. The Iternio API and its reference
clients (`iternio/autopi-link`) support several bandwidth-reduction techniques.
The plugin already implements the core set; others remain available as candidate
optimizations.

**Implemented measures** (and the Iternio pattern each mirrors):

| Measure | Effect | Iternio reference |
| --- | --- | --- |
| Significant-change gating (§5.1) | Sends promptly only on SoC / charging / parked / charge-power change; otherwise waits | `min_changed = [soc, power, is_charging]` |
| State-adaptive cadence (§5.2) | Driving 5 s (>70 kph), 160 s keep-alive, charging 30 min, parked 24 h | driving 1 s / charging 30 s / parked suppressed |
| Median sampling (§4.6) | 1 Hz samples are reduced to **one** representative point per send, not all transmitted | client-side smoothing |
| Supported-field omission (§4.2) | Only metrics the vehicle actually publishes are sent | "only available values are sent" |
| Bulk batching (§5.4) | Up to `MAX_BULK_BATCH_SIZE` (10) points per HTTPS request — amortizes TLS/handshake/header overhead vs. one request per point | single **and** bulk endpoints |
| Compact JSON | `JSON.stringify` emits no whitespace | `json.dumps(separators=(',',':'))` |

**Candidate optimizations** (Iternio-supported, **not yet implemented**):

- **Per-point delta within a bulk batch.** Every telemetry field is optional, so
  points after the first in a batch could omit fields unchanged since the prior
  point (keeping `utc` + changed fields). A 10-point batch today repeats static
  fields (`lat`/`lon` when stopped, `odometer`, `capacity`, temps). *Risk:* ABRP
  must tolerate non-self-contained points; verify against ABRP behavior before
  adopting, and always retain `utc`.
- **Coordinate/precision trimming.** `lat`/`lon` are sent at full precision;
  rounding to ~5 dp (~1.1 m) and using integer temperatures shrinks every point
  with negligible accuracy loss.
- **Larger `MAX_BULK_BATCH_SIZE`.** Raising the 10-point cap further amortizes
  per-request overhead when a backlog exists, bounded by the 8 s bulk timeout and
  the 100-point queue cap.
- **Drop the slow-driving keep-alive.** The 160 s `METRIC_POLL_STALE_CONNECTION`
  send exists for the OVMS API-key staleness window; if ABRP does not require it,
  removing it during sub-70 kph driving cuts idle traffic.

**Not supported by the API (verified 2026-06-02):**

- **Request-body compression (gzip/deflate).** Empirically tested against
  `/1/tlm/bulk` with a differential probe: the same JSON payload was POSTed
  (a) uncompressed, (b) gzip-compressed with `Content-Encoding: gzip`, and
  (c) gzip bytes with no encoding header. The uncompressed request reached a
  token-level response (`401 Unauthorized Token`), proving the body was parsed;
  both gzip variants returned the **identical** `400 data field missing or is not
  a loadable JSON`. Because the `Content-Encoding: gzip` header changed nothing,
  the server **ignores it and does not decompress** request bodies. Conclusion:
  gzip request bodies are not accepted. (Independently, the plugin could not
  produce them anyway — Duktape ships no compression library and OVMS
  `HTTP.Request` does not gzip bodies. Note also that gzip *expands* small
  per-point payloads, so it would only help on large backlogged batches.)

---

## 6. External interfaces

### 6.1 Iternio Telemetry API

Base: `https://api.iternio.com/1/`. Auth: `api_key` query param (the plugin's
shared `OVMS_API_KEY`) + a per-user `token`. **Convention:** the API returns HTTP
200 even for application-level errors; the real outcome is in the JSON body
`{"status":"ok"|"error", ...}`. Non-200 is reserved for serious errors (bad key,
malformed request).

| Endpoint | Method | Used by | Payload |
| --- | --- | --- | --- |
| `/1/tlm/send` | GET (query string) | `onetime()` only | `tlm` = URL-encoded JSON telemetry, `token`, `api_key` |
| `/1/tlm/bulk` | POST (JSON body) | periodic `sendBulkTelemetry` | `{ data: [ { token, tlm_list: [ …telemetry ] } ] }`, header `Content-Type: application/json` |

Request timeouts: single send 5 s; bulk 8 s (must finish within the 10 s
`ticker.10` window). The OVMS `HTTP.Request` `done(response)` exposes
`statusCode`, `statusText`, `body`, `data`, `headers`.

### 6.2 OVMS host API surface used

| Host object | Members used |
| --- | --- |
| `OvmsMetrics` | `Value(name)`, `HasValue(name)`, `GetValues([names])` |
| `OvmsConfig` | `GetValues('usr','abrp.')`, `Delete('usr','abrp.user_token')` |
| `OvmsNotify` | `Raise(type, subtype, message)` |
| `PubSub` | `subscribe(topic, cb)`, `unsubscribe(token)` |
| `HTTP` | `Request({url, headers, post, timeout, done, fail})` |
| `performance` | `now()` (timing guard in `createTelemetry`) |
| `print` | stdout for the `Logger` |

### 6.3 Configuration

Single config item, in the OVMS `usr` namespace:

```
config set usr abrp.user_token <token>
```

Read once at module load (and re-read lazily by `validateUsrAbrpConfig` if unset).
`resetConfig()` deletes it. The token is obtained from ABRP's Live Data setup or
the OAuth2 API.

### 6.4 In-vehicle shell commands (public API — keep stable)

Invoked as `script eval abrp.<fn>()`:

| Command | Effect |
| --- | --- |
| `abrp.info()` | Logs the plugin version and every currently-supported telemetry value |
| `abrp.onetime()` | Sends the current telemetry once via `/1/tlm/send` |
| `abrp.send(1)` / `abrp.send(0)` | Start / stop periodic sending |
| `abrp.resetConfig()` | Stop sending and delete the stored token |

---

## 7. Data model — telemetry fields

All units match the Iternio schema; OVMS source units already align (no
conversion). A field is sent only when its OVMS source(s) are present.

| ABRP key | Unit | OVMS source(s) | Notes |
| --- | --- | --- | --- |
| `utc` | s | `m.time.utc` | Required for any send (see GPS gating) |
| `soc` | % | `v.b.soc` (NL: `xnl.v.b.soc.instrument`) | |
| `power` | kW | `v.b.power` | + charging, − discharging; median-smoothed while driving |
| `speed` | kph | `v.p.speed` | median-smoothed while driving |
| `lat` / `lon` | ° | `v.p.latitude` / `v.p.longitude` | |
| `is_charging` | bool | `v.c.charging` | |
| `is_dcfc` | bool | `v.c.mode === 'performance'` | DC fast charging |
| `is_parked` | bool | `v.e.parktime > 0` (e‑TNGA: `v.e.gear === 0`) | |
| `capacity` | kWh | `v.b.capacity` | usable pack capacity |
| `soe` | kWh | `v.b.soc`, `v.b.capacity` | derived `(soc/100) × capacity` |
| `soh` | % | `v.b.soh` (NL: `xnl.*`; KS: removed) | |
| `heading` | ° | `v.p.direction` | |
| `elevation` | m | `v.p.altitude` | |
| `ext_temp` | °C | `v.e.temp` | |
| `batt_temp` | °C | `v.b.temp` | |
| `voltage` | V | `v.b.voltage` | |
| `current` | A | `v.b.current` | |
| `odometer` | km | `v.p.odometer` | |
| `est_battery_range` | km | `v.b.range.est` (NL: instrument/ideal blend) | |
| `hvac_power` | kW | *(none by default)* | Override-only; supply per-vehicle via `overrideMetricMap` |
| `hvac_setpoint` | °C | `v.e.cabinsetpoint` | |
| `cabin_temp` | °C | `v.e.cabintemp` | |
| `tire_pressure_fl/fr/rl/rr` | kPa | `v.tp.fl.p` / `fr` / `rl` / `rr` | |

---

## 8. Configuration constants (tunables, top of `lib/abrp.js`)

| Constant | Value | Meaning |
| --- | --- | --- |
| `OVMS_API_KEY` | (fixed) | The plugin's shared Iternio application key |
| `VERSION` | `'2.3.0'` | Plugin version (bump on user-facing change; update CHANGELOG) |
| `DEBUG` | `true` | Verbose debug logging |
| `BANDWIDTH_SAVER` | `false` | When true, manual/bookend sends also apply median smoothing |
| `MIN_CALIBRATION_SPEED` | `70` kph | Above this, send every 5 s for calibration |
| `METRIC_POLL_RATE_DRIVING` | `5` s | Driving send interval |
| `METRIC_POLL_RATE_CHARGING` | `1800` s | Charging send interval |
| `METRIC_POLL_STALE_CONNECTION` | `160` s | Keep-alive interval (< OVMS API-key staleness) |
| `MAX_TELEMETRY_QUEUE_SIZE` | `100` | Queue cap; oldest dropped on overflow |
| `MAX_BULK_BATCH_SIZE` | `10` | Max telemetry points per bulk POST |

---

## 9. Testing model

- **Harness:** Jest (Node 18). `lib/abrp.js` is `require()`-able off-device because
  its module-load side effects (token read; `overrideMetricMap` + `ticker.1`
  subscribe) are guarded behind `typeof <global> !== 'undefined'`.
- **`loadAbrp(globals)`** (top of `lib/abrp.test.js`): `jest.resetModules()`,
  clears OVMS host globals, optionally injects per-test stubs (`OvmsMetrics`,
  `HTTP`, …), re-requires the module. `jest.setup.js` provides no-op
  `print`/`performance`.
- **Export seam:** `module.exports` exposes the public entry points, the pure
  decision/helper functions, and a `__test` object (getters/setters over the
  internal queue/state) used by stateful tests. OVMS ignores the extra export.
- **Coverage:** pure helpers (`round`, `medianPowerMetrics`,
  `isSignificantTelemetryChange`), metric resolution (`getOVMSMetric` for
  `capacity`/`soe`), the bulk data-integrity contract (snapshot, in-flight guard,
  `status:"ok"` gate, batch cap, retry), and the collect→queue→reset median cycle.
- **Lint/format:** `npx eslint lib/ jest.setup.js` (source pinned to ES2015; test
  files use an `ecmaVersion: 2021` override). Never Prettier-reformat
  `lib/abrp.js` (hand-styled for Duktape).
- **On-vehicle validation** (cannot be unit-tested): install, `tls trust reload`,
  reload JS engine, then `abrp.info()` / `abrp.onetime()` / `abrp.send(1)` and
  confirm the queue drains over `ticker.10` with no loss.

---

## 10. Error handling & resilience

- **No token:** `validateUsrAbrpConfig` raises an OVMS error notification and
  aborts the send; `send()` also refuses if GPS time is invalid.
- **Network/HTTP failure:** logged; the batch stays queued and is retried next
  `ticker.10`. No client-side retry storm (one attempt per tick).
- **Application error (200 + `status:"error"`):** treated as failure; batch kept.
- **Malformed response body:** `isApiOk` treats it as not-ok (keeps the batch).
- **Queue overflow:** oldest point dropped with a warning (bounded memory).

---

## 11. Known limitations & tracked follow-ups

1. **Queue overflow during an in-flight bulk send — RESOLVED in 2.3.0.** Previously,
   if `telemetryToSend` reached 100 while a batch was in flight, the overflow
   `shift()` moved the front and the positional `removeTelemetry(batch.length)`
   could splice the wrong rows (dropping unsent points). Fixed by removing the sent
   batch **by identity** (`removeTelemetryBatch`); see §5.4.
2. **Test filename — RESOLVED in 2.3.0.** Renamed `lib/arbp.test.js` →
   `lib/abrp.test.js`.
3. **`hvac_power`** has no generic OVMS source; only sent where a vehicle override
   provides one.
4. **Deploy via the OVMS plugin infrastructure** (upstream issue
   [iternio/ovms-link#38](https://github.com/iternio/ovms-link/issues/38)). The
   current install is a manual, multi-file copy (§12), which also makes updates
   painful. Packaging the plugin with an OVMS plugin **manifest** (`name`,
   `version`, `prerequisites`, `elements`) served from a repository would enable
   `plugin install` / `plugin update`. A `module` element is **auto-loaded** by the
   framework — at each JS-engine start it evaluates `require("plugin/<name>/<path>")`
   (resolving from `/store/plugins/<name>/`), independently of and before
   `ovmsmain.js`. **A plugin install leaves `ovmsmain.js` untouched** — that file is
   only ever read, never written — so a plugin-delivered build ships **no
   `ovmsmain.js`** and needs no manual wiring (verified in the OVMS source,
   `ovms_plugins.cpp` / `ovms_duktape.cpp`). **Open question:** the OVMS
   plugin element types (`module`/`json`/`webpage`/`webhook`/`webrsc`) have **no
   element for installing trusted root CAs** to `/store/trustedca` + running
   `tls trust reload`, so the CA certs (§3, §12) cannot be auto-installed by the
   plugin alone — they would remain a manual prerequisite unless the plugin
   bootstraps them at first run. Resolve the cert-install path before claiming a
   true one-command install. Routes: an independent Iternio repo
   (`plugin repo install`), and/or (re-)publishing `abrp` to the default
   `openvehicles` repo (`http://api.openvehicles.com/plugins`). Note: as of
   2026-06 that repo's `plugins.json` no longer lists `abrp` — the legacy `0.1`
   entry has been **removed** (a `plugin list` may still show it as a stale cached
   install) — and the OVMS firmware's `plugin/abrp/README.rst` already redirects
   users to this project. So this would be a **clean addition to an empty slot**,
   not a takeover.

---

## 12. Installation & deployment

The deliverable is copied into OVMS via the web console (Tools → Editor):

1. `lib/abrp.js` → `/store/scripts/lib/abrp.js`
2. `ovmsmain.js` → `/store/scripts/ovmsmain.js` (just `require("lib/abrp")`; the
   plugin auto-starts internally once GPS time is valid).
3. Each certificate in `trustedca/` → `/store/trustedca/`, then `tls trust reload`
   and verify with `tls trust list` (required for TLS to `api.iternio.com`).
4. Set the token: `config set usr abrp.user_token <token>`.
5. Reload the JS engine; expect the `ABRP::started` notification.

Requires OVMS firmware `3.3.004` or newer.

---

## 13. Repository layout

| Path | Purpose |
| --- | --- |
| `lib/abrp.js` | The plugin (single deliverable) |
| `lib/abrp.test.js` | Jest unit suite |
| `ovmsmain.js` | OVMS entry point (`require("lib/abrp")`) |
| `trustedca/` | CA certificates required for TLS, + install README |
| `jest.setup.js` | Jest host-global stubs |
| `CHANGELOG.md` | Version history |
| `CLAUDE.md` | Guidance for AI coding assistants |
| `docs/SPECIFICATION.md` | This document |
| `docs/superpowers/specs/`, `docs/superpowers/plans/` | Design spec & implementation plan for the 2.3.0 refactor |

---

## 14. Glossary

- **OVMS** — Open Vehicle Monitoring System (the host hardware/firmware).
- **ABRP / Iternio** — A Better Routeplanner and its parent; the telemetry
  consumer.
- **Duktape** — the embedded JavaScript engine OVMS runs scripts in.
- **Telemetry point** — one snapshot of supported metrics for a single UTC instant.
- **SoC / SoH / SoE** — State of Charge (%), State of Health (%), State of Energy
  (kWh = SoC × capacity).
- **DCFC** — DC fast charging.
- **e-TNGA** — Toyota/Subaru EV platform (bZ4X / Solterra).
