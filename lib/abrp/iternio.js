// Light transport seam for the Iternio Telemetry API: URL builder + the
// HTTP-200-but-status-error check. The cert-heal hook (WS3) will live here too.
var C = require('./constants')
var U = require('./util')
var Logger = U.Logger

/**
 * Builds an Iternio API URL for the given path (e.g. 'tlm/send', 'tlm/bulk'),
 * with the plugin's app api_key already appended.
 */
function apiUrl(path) {
  return 'https://api.iternio.com/1/' + path + '?api_key=' + encodeURIComponent(C.OVMS_API_KEY)
}

/**
 * Builds the Iternio oauth/me URL for the given access token (api_key + token).
 */
function meUrl(token) {
  return apiUrl('oauth/me') + '&access_token=' + encodeURIComponent(token)
}

/**
 * The Iternio API returns HTTP 200 even for application-level errors, signalling
 * the real outcome via a JSON body {"status":"ok"|"error"}. Returns true only
 * when the body parses and status === 'ok'. Defensive: a missing/malformed body
 * is treated as NOT ok.
 */
function isApiOk(body) {
  if (!body) {
    return false
  }
  try {
    return JSON.parse(body).status === 'ok'
  } catch (e) {
    Logger.warn('Could not parse ABRP response body', body)
    return false
  }
}

module.exports = {
  apiUrl: apiUrl,
  meUrl: meUrl,
  isApiOk: isApiOk,
}
