# CHANGELOG

## 3.0.0-alpha.3 (unreleased)

- Charge deadband: while charging, `changedVsLastQueued` now ignores sub-threshold
  jitter on `power`/`current`/`voltage` per the `CHARGE_DEADBAND` map (defaults
  1 kW / 5 A / 2 V) so noisy DC fast-charge readings no longer force a queued point
  every sample. SOC steps, state flips, and any other changed field still queue
  normally, and each deadband measures against the last *queued* value so a slow drift
  still accumulates. Driving keeps full per-`ROUNDING` resolution (deadband is
  charge-only); omit a field or set its entry to `0` to disable it. Motivated by
  2026-06-13 field logs where DC fast charging produced ~70% of the session's queued
  points (≈64% of upload), dominated by sub-kW power jitter plus current/voltage noise.
- Fixed telemetry loss when unplugging with the vehicle already on: the four
  session events (`vehicle.on/off`, `charge.start/stop`) now feed a single
  level-based handler (`v.e.on || v.c.charging`), so a `charge.stop` no longer
  kills the per-second sampler mid-drive, and an overlapping on+charging state
  no longer double-subscribes it.
- Fixed `send(0)`/`send(1)` cycles stacking `ticker.10` / `vehicle.type.set`
  subscriptions: teardown is now symmetric with setup.
- Adaptive sample cadence: the sampler now times its own `createTelemetry()` collect
  and, when a collect runs slower than `COLLECT_PRESSURE_FACTOR`× its rolling baseline
  (event-loop congestion), multiplicatively stretches the effective sample interval up
  to `BACKOFF_MAX_INTERVAL` (180 s), recovering multiplicatively once collects are fast
  again. `usr abrp.sample_interval` becomes the *floor* (fastest cadence), not a fixed
  rate. During a deep crisis the interval can exceed `HEARTBEAT_INTERVAL`, intentionally
  letting the ABRP session lapse until OVMS recovers. Motivated by the 2026-06-07 field
  logs (18–42 s `ticker.1` stalls from web-dashboard websocket contention). The redundant
  `>500 ms` collect WARN in `createTelemetry()` is removed (the per-sample cadence DEBUG
  line and the adaptive back-off supersede it).
- Web UI: a **config page** (`/usr/abrp/config`, admin) to enter the ABRP token and
  cadence intervals with a live "Connected as …" check via `oauth/me`; a read-only
  **status dashboard** (`/usr/abrp/status`) showing connection/identity, GPS-time
  validity, sending state, queue depth, last-send result, and key telemetry
  (SoC/power/speed/charging); and a **status-page hook** line ("ABRP: connected · N
  queued"). The pages ship as `webpage`/`webhook` plugin elements and talk to the
  module via `abrp.webStatus()` / `abrp.webIdentityRefresh()`.
- OAuth2 onboarding and the plan dashboard remain deferred (blocked on registering a
  dedicated Iternio OAuth2 client).

## 3.0.0-alpha.1 (unreleased)

- Change-based telemetry: sample every `usr abrp.sample_interval` seconds (1-5,
  default 3, gated on `m.monotonic`); queue a point only when a rounded metric
  changed since the last, with a heartbeat keep-alive (`HEARTBEAT_INTERVAL`, 0
  disables). Removes median smoothing and the state-adaptive cadence.
- Bulk telemetry is delta-encoded: the first point of each POST is full (a resync),
  the rest carry `utc` + changed fields only.
- Vehicle-off bookend forces a coherent parked state (`speed`/`power`=0,
  `is_parked`=true, `is_charging`/`is_dcfc`=false).
- Cold-boot session detection now also checks `v.c.charging`, so a module reboot
  while parked-and-charging starts a session immediately (previously waited for the
  next `vehicle.charge.start` edge).
- Configurable bulk-flush interval via `usr abrp.send_interval` (10–60 s, **default
  30** — up from the prior effective 10 s), gated on `m.monotonic`. Each flush now
  sends the whole queue (bounded by `MAX_TELEMETRY_QUEUE_SIZE`); `MAX_BULK_BATCH_SIZE`
  is removed.
- `usr abrp.sample_interval` and `usr abrp.send_interval` changes now apply live on
  the OVMS `config.changed` event (next sample/flush tick), instead of only at the
  next session.
- Installable as an OVMS plugin: `plugin repo install abrp https://kezarjg.github.io/ovms-link/`
  then `plugin install abrp`. A `publish.js` / `npm run release` builds the bundle and
  publishes the plugin repo (`plugins.json` + `abrp/abrp.js`) to a `gh-pages` branch.
  The manual hand-copy install is retained as a fallback.
- Plugin install now bootstraps the runtime CA roots: the curated `trustedca/` set
  ships as a second `certdata` plugin element and is written to `/store/trustedca`
  with `tls trust reload` at first run, gated by a `usr abrp.certs_version` stamp
  (re-runs only when the cert set is bumped). The manual cert step is retained for
  the hand-copy install.

## Version 2.3.0, 2026-06-02, `kezarjg`

- Switched telemetry transmission to bulk uploads (`/1/tlm/bulk`) with a queue.
- Added GPS-time gating so telemetry is only sent once a valid UTC time is known.
- Added token-tracking subscribe/unsubscribe wrappers for clean event teardown.
- Wired `capacity` (from `v.b.capacity`) and derived `soe` (`SoC × capacity`).
- `hvac_power` is now supported only where a vehicle-specific override provides it.
- Wired `hvac_power` for the Toyota e-TNGA (`SUBSOL`/`TOYBZ4X`) from `xte.v.e.hvac.power`.
- Fixed tyre-pressure sources: read the `v.t.pressure` vector (FL=0, FR=1, RL=2, RR=3) instead of the non-existent `v.tp.*.p` metrics.
- Fixed telemetry loss on concurrent bulk flush (batch is snapshotted before send).
- Fixed silent data loss: the queue is cleared only when the API confirms success
  (HTTP 200 *and* JSON body `status: "ok"`), not on HTTP 200 alone.
- Restored median power/speed smoothing while driving on the default (non-bandwidth-saver) path; charging continues to send instantaneous power.
- Fixed a latent Nissan Leaf range-override bug (implicit globals under strict mode).
- Fixed a further telemetry-loss edge case: when the queue is full during an
  in-flight bulk flush, the sent batch is removed **by identity**, so a concurrent
  overflow drop cannot discard never-sent points.
- Made `lib/abrp.js` require()-able under Jest and expanded the unit test suite
  (`lib/abrp.test.js`).

## Version 2.2.0, 2025-05-21, `kezarjg`

- Introduced a centralized metricMap to define and compute telemetry parameters in a modular, declarative format.
- Added support for vehicle-specific metric overrides via new overrideMetricMap() function.
- New metrics added to the telemetry map:
  - `hvac_power`, `hvac_setpoint`, `cabin_temp`
  - Tire pressure metrics for all four wheels
  - `soe` (State of Energy)

## Version 2.1.0, 2024-09-24, `kezarjg`

- Programattically determine what vehicle metrics are supported and only add supported metrics to the telemetry object.
- Additional telemetry field sent to ABRP
  - `capacity`

## Version 2.0.1, 2023-01-02, `dteirney` and `Edwintenhaaf`

- Change to HTTPS for the ABRP API endpoint
- Associated instructions to setup the trusted root CA certificate for the ABRP
  API

## Version 2.0, 2022, `dteirney`

- Additional telemetry fields sent to ABRP
  - `is_dcfc`
  - `is_parked`
  - `kwh_charged`
  - `heading`
  - `odometer`
  - `est_battery_range`
- Nissan Leaf specific metrics used for SOC, SOH and estimated range
- Reduce bandwidth by only sending frequent data for calibration (every 10
  seconds) when the driving speed is greater than 70 kph
- Reduce bandwidth by changing the determination of a significant telemetry
  change to take into account whether the vehicle is charging, and only send if
  the power changes by more than 1 kW.
- Capture speed and power metrics every second and then send median based on the
  power reading for more accurate ABRP calibration of estimated km/kWh @ 110 kph
- Additional DEBUG logging included (off by default)
- Numerous code modifications to reduce use of module state within module
  functions

## Version 1.4, 2021, `Jason_ABRP`

- Update script so it can be running continuously
- Remove unneeded dependencies on multiple config items (Now only have to set
  token)
- Stability improvements

## Version 1.3, 2020, `inf0mike`

- Background on the OVMS forum at
  [Send live data to abrp](https://www.openvehicles.com/node/2375)
- Fix for rounding of fractional SOC causing abrp to report SOC off by 1
- Fix for altitude never being sent
- New convenience method to reset config to defaults

## Version 1.2

- based now on OVMS configuration to store user token, car model and url
- review messages sent during charge
- send a message when vehicle is on before moving to update abrp

## Version 1.1

- fixed the utc refreshing issue
- send notifications
- send live data only if necessary
- script eval abrp.resetConfig() => reset configuration to defaults
