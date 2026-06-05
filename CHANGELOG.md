# CHANGELOG

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
