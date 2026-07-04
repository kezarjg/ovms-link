// Owns the per-user ABRP token (usr abrp.user_token) read from OVMS config.
var C = require('./constants')
var user_token = (typeof OvmsConfig !== 'undefined')
  ? OvmsConfig.GetValues('usr', 'abrp.').user_token
  : undefined

/**
 * Returns the current user token (may be undefined if unset).
 */
function token() {
  return user_token
}

/**
 * Validates the ABRP configuration for the user.
 *
 * @returns {boolean} True if the configuration is valid, false otherwise.
 */
function validate() {
  // If user_token is not set or empty, attempt to populate it
  if (!user_token) {
    user_token = OvmsConfig.GetValues('usr', 'abrp.').user_token;
  }

  // If user_token is still not set, raise an error notification
  if (!user_token) {
    OvmsNotify.Raise(
      'error',
      'usr.abrp.status',
      'ABRP::config usr abrp.user_token not set'
    );
    return false;
  }
  return true;
}

/**
 * Deletes the stored user token and notifies that config was reset.
 */
function reset() {
  OvmsConfig.Delete('usr', 'abrp.user_token')
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

/**
 * Returns the per-sample interval in seconds from usr abrp.sample_interval,
 * validated/clamped to 1..5, defaulting to SAMPLE_INTERVAL_DEFAULT.
 */
function sampleInterval() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').sample_interval
    : undefined
  var n = parseInt(raw, 10)
  if (isNaN(n)) { return C.SAMPLE_INTERVAL_DEFAULT }
  if (n < 1) { return 1 }
  if (n > 5) { return 5 }
  return n
}

/**
 * Returns the bulk-flush interval in seconds from usr abrp.send_interval,
 * validated/clamped to 10..60, defaulting to SEND_INTERVAL_DEFAULT.
 */
function sendInterval() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').send_interval
    : undefined
  var n = parseInt(raw, 10)
  if (isNaN(n)) { return C.SEND_INTERVAL_DEFAULT }
  if (n < 10) { return 10 }
  if (n > 60) { return 60 }
  return n
}

/**
 * Returns the stale-connection heartbeat interval in seconds from
 * usr abrp.heartbeat_interval. 0 disables the heartbeat; other values are
 * floored to 30 and capped at 3600; unset/invalid falls back to
 * HEARTBEAT_INTERVAL.
 */
function heartbeatInterval() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').heartbeat_interval
    : undefined
  var n = parseInt(raw, 10)
  if (isNaN(n)) { return C.HEARTBEAT_INTERVAL }
  if (n <= 0) { return 0 }     // explicit disable
  if (n < 30) { return 30 }
  if (n > 3600) { return 3600 }
  return n
}

/**
 * Returns the charging-power deadband width in kW from
 * usr abrp.charge_power_delta_kw. 0 disables the deadband; negatives clamp to 0;
 * capped at 10; fractional allowed; unset/invalid falls back to
 * CHARGE_POWER_DELTA_KW.
 */
function chargePowerDeltaKw() {
  var raw = (typeof OvmsConfig !== 'undefined')
    ? OvmsConfig.GetValues('usr', 'abrp.').charge_power_delta_kw
    : undefined
  var n = parseFloat(raw)
  if (isNaN(n)) { return C.CHARGE_POWER_DELTA_KW }
  if (n < 0) { return 0 }
  if (n > 10) { return 10 }
  return n
}

module.exports = {
  token: token,
  validate: validate,
  reset: reset,
  sampleInterval: sampleInterval,
  sendInterval: sendInterval,
  heartbeatInterval: heartbeatInterval,
  chargePowerDeltaKw: chargePowerDeltaKw,
}
