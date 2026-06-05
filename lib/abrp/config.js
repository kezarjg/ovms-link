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

module.exports = {
  token: token,
  validate: validate,
  reset: reset,
  sampleInterval: sampleInterval,
}
