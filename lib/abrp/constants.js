// Module + configuration constants (see CLAUDE.md "Tunable constants").
// Plain object so the bundler/Duktape treat it as a normal module export.
module.exports = {
  OVMS_API_KEY: '32b2162f-9599-4647-8139-66e9f9528370',
  VERSION: '3.0.0-alpha.7',
  DEBUG: true,
  MAX_TELEMETRY_QUEUE_SIZE: 100,
  SAMPLE_INTERVAL_DEFAULT: 3, // seconds between samples; overridden by usr abrp.sample_interval (1-5)
  COLLECT_PRESSURE_FACTOR: 3, // collect > this x the rolling baseline counts as a slow collect (congestion)
  BACKOFF_MAX_INTERVAL: 180, // seconds; cap for the stretched sample interval under sustained congestion
  COLLECT_BASELINE_ALPHA: 0.25, // EWMA weight for updating the collect baseline on calm samples
  HEARTBEAT_INTERVAL: 160, // seconds; force a point if nothing queued for this long; 0 disables
  CHARGE_POWER_DELTA_KW: 1, // while charging, a power move smaller than this (vs the last queued point) is not a change — kills the DC-fast-charge sub-kW point flood
  SEND_INTERVAL_DEFAULT: 30, // seconds between bulk flushes; overridden by usr abrp.send_interval (10-60)
  ROUNDING: {
    soc: 0, power: 1, speed: 0, lat: 5, lon: 5, heading: 0, elevation: 0,
    ext_temp: 0, batt_temp: 0, cabin_temp: 0, hvac_setpoint: 0, hvac_power: 1,
    voltage: 0, current: 0, odometer: 1, est_battery_range: 0, soh: 0, soe: 1, capacity: 1,
    tire_pressure_fl: 0, tire_pressure_fr: 0, tire_pressure_rl: 0, tire_pressure_rr: 0,
  },
}
