// Web read-surface: functions the plugin web pages call via the OVMS command
// bridge (loadcmd "script eval abrp.webStatus()"). webStatus() prints a JSON
// status snapshot (synchronous, no network). webIdentityRefresh() fires an async
// oauth/me call and caches the identity. Owns only the identity cache.
var C = require('./constants')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
var Tlm = require('./telemetry')
var Ev = require('./events')
var Iternio = require('./iternio')

// Expose getOVMSMetric via the metrics module accessor (avoids the timing
// Logger.debug call in createTelemetry, keeping webStatus output pure JSON).
var getOVMSMetric = Met.getOVMSMetric

// Cached result of the last oauth/me call. state: unknown|checking|ok|error.
var identity = { state: 'unknown' }

// Telemetry fields surfaced on the dashboard (a curated subset of the full map).
var KEY_TELEMETRY = ['soc', 'power', 'speed', 'is_charging']

/**
 * Prints a one-line JSON status snapshot for the web pages. Synchronous, no
 * network, defensive: any internal error is printed as {"error":...} rather than
 * thrown into the command layer.
 */
function webStatus() {
  try {
    var tele = {}
    for (var i = 0; i < KEY_TELEMETRY.length; i++) {
      var k = KEY_TELEMETRY[i]
      var result = getOVMSMetric(k)
      if (result[0]) {
        tele[k] = result[1] !== undefined ? result[1] : null
      }
    }
    var snap = {
      version: C.VERSION,
      token_set: !!Cfg.token(),
      time_valid: Ev.isTimeValid(),
      sending: Ev.isActive(),
      queue_depth: Q.getQueue().length,
      last_send: Tlm.lastSend(),
      identity: identity,
      telemetry: tele,
    }
    print(JSON.stringify(snap))
  } catch (e) {
    print(JSON.stringify({ error: String(e) }))
  }
}

/**
 * Fires an async oauth/me call to validate the configured token and cache the
 * identity. Prints a synchronous ack; the done/fail callbacks only mutate the
 * cache (webStatus surfaces it). No-ops to an error state if HTTP is unavailable
 * or no token is set.
 */
function webIdentityRefresh() {
  if (typeof HTTP === 'undefined' || !Cfg.token()) {
    identity = { state: 'error', error: 'no token' }
    print('{"ok":false}')
    return
  }
  identity = { state: 'checking' }
  HTTP.Request({
    url: Iternio.meUrl(Cfg.token()),
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200 && Iternio.isApiOk(response.body)) {
        // Safe: isApiOk() above already parsed/validated this body.
        var b = JSON.parse(response.body)
        identity = {
          state: 'ok',
          name: b.full_name,
          vehicle: b.vehicle_name,
          typecode: b.vehicle_typecode,
        }
      } else {
        identity = { state: 'error', error: 'rejected' }
      }
    },
    fail: function (error) {
      identity = { state: 'error', error: String(error) }
    },
  })
  print('{"ok":true}')
}

module.exports = {
  webStatus: webStatus,
  webIdentityRefresh: webIdentityRefresh,
  __test: {
    getIdentity: function () {
      return identity
    },
  },
}
