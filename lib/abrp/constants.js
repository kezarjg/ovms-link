// Module + configuration constants (see CLAUDE.md "Tunable constants").
// Plain object so the bundler/Duktape treat it as a normal module export.
module.exports = {
  OVMS_API_KEY: '32b2162f-9599-4647-8139-66e9f9528370',
  VERSION: '2.3.0',
  DEBUG: true,
  BANDWIDTH_SAVER: false, // When true, manual/bookend sends also apply median smoothing; the live path always smooths
  MIN_CALIBRATION_SPEED: 70, // kph
  METRIC_POLL_RATE_DRIVING: 5, // Poll rate during driving (s)
  METRIC_POLL_RATE_CHARGING: 30 * 60, // Poll rate during charging (s)
  METRIC_POLL_STALE_CONNECTION: (3 * 60) - 20, // 3 minutes for OVMS API Key
  MAX_TELEMETRY_QUEUE_SIZE: 100,
  MAX_BULK_BATCH_SIZE: 10, // max telemetry points per bulk POST
  SAMPLE_INTERVAL_DEFAULT: 3, // seconds between samples; overridden by usr abrp.sample_interval (1-5)
  HEARTBEAT_INTERVAL: 160, // seconds; force a point if nothing queued for this long; 0 disables
  ROUNDING: {
    soc: 0, power: 1, speed: 0, lat: 5, lon: 5, heading: 0, elevation: 0,
    ext_temp: 0, batt_temp: 0, cabin_temp: 0, hvac_setpoint: 0, hvac_power: 1,
    voltage: 0, current: 0, odometer: 1, est_battery_range: 0, soh: 0, soe: 1, capacity: 1,
    tire_pressure_fl: 0, tire_pressure_fr: 0, tire_pressure_rl: 0, tire_pressure_rr: 0,
  },
}
