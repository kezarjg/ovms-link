# CHANGELOG

## 3.0.0-alpha.7 (unreleased)

- **Split into three plugins to shrink the abrp module element.** On-vehicle testing
  showed a plugin `module` element near ~50 KB overflows OVMS's 12 KB DukTape task
  stack while Duktape *compiles* it, aborting into a WDT reboot loop. Measured on-device
  with `module tasks`: the working side-load peaks at 11808 / 12288 bytes — only 480
  bytes of headroom — and the plugin-loader path has slightly less, so it crosses the
  canary. Restructuring the JS doesn't help (un-bundling into 11 smaller units dropped
  the peak just 224 bytes); the only robust fix is a larger firmware stack (reported
  upstream — see `~/uploads/ovms-plugin-module-element-stack-overflow.CORRECTED.md`).
  To reduce the pressure from the plugin side, the repo now ships three plugins:
  - **abrp** — the telemetry bundle only (50.7 KB -> 44.9 KB, -11%).
  - **abrpweb** — the web UI (config/dashboard/status-hook pages + backend), moved out
    of the bundle. Reads abrp state via the new public `abrp.snapshot()` / `abrp.meUrl()`
    and depends on the abrp plugin being installed (reports so, gracefully, if not).
  - **abrpcerts** — a standalone installer for the CA roots abrp's TLS needs (writes
    `/store/trustedca` + `tls trust reload`, gated by a version stamp), independent of
    the telemetry code.
- Reverted the alpha.6 cert-bootstrap deferral (its premise was disproven on-device)
  and removed the likewise-ineffective `build.js --defer-entry` experiment.
- Side-load (hand-copy) delivery is unaffected and remains the documented install
  method; the plugin-install path stays blocked on the firmware stack size.
- **metrics.js simplification** (behavior-preserving; bundle −2 KB): entries with no
  computed value now omit their `metric` function — getOVMSMetric defaults to a
  passthrough of `metrics[requiredMetrics[0]]` (19 near-identical functions collapsed
  to one default). `metricMap` is built incrementally via `add()` instead of one large
  array literal, all metric functions are hoisted to module top level, and vehicle
  overrides are flat data (`OVERRIDES` table) instead of a nested `switch`/`if`/`forEach`.
  Added characterization tests for the previously-untested vehicle overrides (NL/KS/
  SUBSOL/TOYBZ4X). Trimmed the abrp DukTape compile peak by ~370 bytes — but on-device
  measurement showed OVMS's own JS already uses ~10.6 KB of the 12 KB task stack (86%),
  so this is marginal; the firmware stack remains the real constraint (see the bug report).

## 3.0.0-alpha.6 (unreleased)

- **Attempted plugin-install crash fix — SUPERSEDED in alpha.7, did not work.**
  `Ev.startup()` was changed to defer `Certs.bootstrap()` off the synchronous
  module-load stack, on the theory that its nested `require('plugin/abrp/certdata')`
  caused the DukTape stack overflow seen on-vehicle (Stage-2). On-device measurement
  later disproved this: the overflow is Duktape compiling the ~50 KB module element
  itself against the 12 KB DukTape task stack, independent of the cert bootstrap. This
  change is reverted in alpha.7 (cert bootstrap moved to the separate abrpcerts plugin).
- **Fix plugin repo publishing (`publish.js`):** the assembled Pages tree was missing
  two files the on-device pluginstore requires, so the repo either wouldn't refresh
  or failed on install. Now emitted: `plugins.rev` (a single repo-revision string —
  OVMS only re-reads `plugins.json` when it changes; we use the plugin version so it
  advances every release) and `abrp/abrp.json` (the per-plugin manifest OVMS fetches
  on install — the single plugin object, i.e. `plugins.json[0]`; its absence made
  OVMS save the 404 HTML and fail with "could not parse metadata"). Matches the
  openvehicles reference repo layout. These were hand-patched onto the test server
  during Stage-2; now they're generated.

## 3.0.0-alpha.5 (unreleased)

- Configurable thresholds (RFC [#42](https://github.com/iternio/ovms-link/issues/42)):
  two more tunables are now user-settable, validated/clamped, live-reloaded on
  `config.changed`, and exposed on the web config page — following the existing
  `sample_interval` / `send_interval` pattern:
  - **`usr abrp.heartbeat_interval`** (seconds) — the stale-connection heartbeat.
    `0` disables it; other values floor to 30 and cap at 3600; default 160.
  - **`usr abrp.charge_power_delta_kw`** (kW) — the charging-power deadband width.
    `0` disables the deadband; fractional allowed; capped at 10; default 1.
  - Note for the reporter: "calibration speed" from the #42 comment does not exist
    in 3.0 — it belonged to the 2.x state-adaptive cadence / median smoothing, both
    removed in the change-based redesign.

## 3.0.0-alpha.4 (unreleased)

- Fix two 2.3.0 fixes that were lost when 3.0 forked before them (found by a
  2.3.0→3.0 regression sweep; see `docs/research/2026-07-04-2.3.0-to-3.0-regression-sweep.md`):
  - **Session state machine:** the four session events (`vehicle.on/off`,
    `charge.start/stop`) now route through a single level-based handler
    (`v.e.on || v.c.charging`) with an `isSampling` guard, instead of wiring
    `charge.start/stop` straight to on/off. A `charge.stop` while the vehicle is
    still on (unplug-and-drive) no longer kills the per-second sampler mid-drive,
    and an on+charging overlap no longer double-subscribes it. Teardown also
    unsubscribes `ticker.10` / `vehicle.type.set`, so `send(0)`/`send(1)` cycles no
    longer stack subscriptions.
  - **Charge-power deadband:** while charging, a power move smaller than
    `CHARGE_POWER_DELTA_KW` (1 kW) vs the last queued point is no longer treated as
    a change, killing the DC-fast-charge sub-kW point flood the change-based
    sampler had reintroduced (0.1 kW rounding made nearly every sample a "change").
    SoC/state changes still queue normally; the driving path is unaffected.
- Added charge/drive overlap tests (bundle) and a deadband test (`queue.test.js`)
  so these can't silently regress again.

## 3.0.0-alpha.3 (unreleased)

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
