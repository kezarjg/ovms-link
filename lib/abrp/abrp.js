// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

// Thin entry module: wires the focused lib/abrp/* modules together, exposes the
// in-vehicle entry points (info/onetime/send/resetConfig), and auto-starts inside
// OVMS. require()-able off-device (e.g. the node:test suite) with no side effects —
// the auto-start is guarded.
var C = require('./constants')
var U = require('./util')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
var Tlm = require('./telemetry')
var Ev = require('./events')
var Iternio = require('./iternio')
var Logger = U.Logger

// Telemetry fields surfaced to the web UI (a curated subset of the full map).
var WEB_TELEMETRY = ['soc', 'power', 'speed', 'is_charging']

// Core Control Functions

/**
 * Logs telemetry data to the console.
 */
function info() {
  var telemetry = Met.createTelemetry();

  // Helper function for formatting output
  function logTelemetry(key, label, unit) {
    unit = unit || '';  // Default to empty string if unit is not provided
    if (Object.prototype.hasOwnProperty.call(telemetry, key)) {
      Logger.log(label + ': ' + telemetry[key] + ' ' + unit);
    }
  }

  // Display plugin version
  Logger.log('Plugin Version: ' + C.VERSION);

  // Iterate over metricMap and display values if available
  Met.metricMap.forEach(function(item) {
    logTelemetry(item.key, item.label, item.unit);
  });
}

/**
 * Executes a one-time telemetry sending process.
 * Validates the user's ABRP configuration, creates telemetry data, and sends it.
 */
function onetime() {
  if (!Cfg.validate()) {
    return
  }
  Tlm.sendTelemetry(Met.createTelemetry())
}

/**
 * Resets the ABRP configuration to default values.
 */
function resetConfig() {
  Ev.send(0);
  Cfg.reset();
}

/**
 * Public read surface for the separate abrp-web plugin (and any other caller):
 * a plain status object. Synchronous, no network. The web UI renders this plus
 * its own identity cache; keeping only the raw state here (not the rendering)
 * lets the web pages live in their own plugin, off the abrp bundle.
 */
function snapshot() {
  var tele = {};
  for (var i = 0; i < WEB_TELEMETRY.length; i++) {
    var k = WEB_TELEMETRY[i];
    var result = Met.getOVMSMetric(k);
    if (result[0]) {
      tele[k] = result[1] !== undefined ? result[1] : null;
    }
  }
  return {
    version: C.VERSION,
    token_set: !!Cfg.token(),
    time_valid: Ev.isTimeValid(),
    sending: Ev.isActive(),
    queue_depth: Q.getQueue().length,
    last_send: Tlm.lastSend(),
    telemetry: tele,
  };
}

/**
 * The Iternio oauth/me URL for the currently configured token, or '' if none.
 * Lets the abrp-web plugin validate identity without duplicating the api key or
 * URL format (which stay here, in one place).
 */
function meUrl() {
  var token = Cfg.token();
  return token ? Iternio.meUrl(token) : '';
}

// Main Initialization Logic — only auto-start inside OVMS, so the module can be
// require()'d off-device (under the node:test suite) with no side effects.
if (typeof OvmsConfig !== 'undefined' &&
    typeof OvmsMetrics !== 'undefined' &&
    typeof PubSub !== 'undefined') {
  Ev.startup()
}

// Module exports
module.exports = {
  // Public, in-vehicle entry points (invoked via `script eval abrp.<fn>()`)
  info: info,
  onetime: onetime,
  send: Ev.send,
  resetConfig: resetConfig,
  // Public read surface consumed by the separate abrp-web plugin
  snapshot: snapshot,
  meUrl: meUrl,
  // Pure helpers exercised by the test suite
  round: U.round,
  getOVMSMetric: Met.getOVMSMetric,
  createBulkPost: Tlm.createBulkPost,
  // Test-only seam (OVMS ignores extra exports; keeps the public surface clean)
  __test: {
    createTelemetry: Met.createTelemetry,
    sample: Q.sample,
    enqueue: Q.enqueue,
    roundTelemetry: Q.roundTelemetry,
    setSampleInterval: Q.setSampleInterval,
    getHeartbeatInterval: Q.getHeartbeatInterval,
    getChargePowerDeltaKw: Q.getChargePowerDeltaKw,
    adjustCadence: Q.adjustCadence,
    getEffectiveInterval: Q.getEffectiveInterval,
    getBaseline: Q.getBaseline,
    setSendInterval: Tlm.setSendInterval,
    callbackVehicleOn: Ev.callbackVehicleOn,
    callbackVehicleOff: Ev.callbackVehicleOff,
    manageVehicleStateEvents: Ev.manageVehicleStateEvents,
    applyIntervals: Ev.applyIntervals,
    sendBulkTelemetry: Tlm.sendBulkTelemetry,
    getQueue: Q.getQueue,
    setLastQueued: Q.setLastQueued,
    lastSend: Tlm.lastSend,
    isActive: Ev.isActive,
    meUrl: Iternio.meUrl,
  },
}
