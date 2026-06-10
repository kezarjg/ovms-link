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
var Certs = require('./certs')
var Iternio = require('./iternio')
var Web = require('./web')
var Bw = require('./bandwidth')
var Logger = U.Logger

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

  // Bandwidth usage since boot (RAM-only; app-layer estimate)
  logBandwidth();
}

/**
 * Logs the per-phase bandwidth counters (driving/charging/idle/total) as KB.
 * App-layer estimate — excludes TLS/TCP framing and the per-connection handshake.
 */
function logBandwidth() {
  var bw = Bw.snapshot();
  function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
  function row(label, b) {
    Logger.log('  ' + label + ' up ' + kb(b.up) + '  down ' + kb(b.down) + '  ' + b.reqs + ' req');
  }
  Logger.log('ABRP bandwidth (since boot, app-layer est.):');
  row('driving ', bw.driving);
  row('charging', bw.charging);
  row('idle    ', bw.idle);
  row('total   ', bw.total);
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
  webStatus: Web.webStatus,
  webIdentityRefresh: Web.webIdentityRefresh,
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
    bootstrap: Certs.bootstrap,
    setCertDataLoader: Certs.__test.setCertDataLoader,
    bandwidth: Bw.snapshot,
    resetBandwidth: Bw.reset,
  },
}
