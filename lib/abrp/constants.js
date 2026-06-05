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
}
