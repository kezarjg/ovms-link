// Owns the telemetry queue, the change-based sampling gate, and the overflow drop. Other
// modules read/mutate this state only through the accessors exported below.
var C = require('./constants')
var U = require('./util')
var Met = require('./metrics')
var Logger = U.Logger
var round = U.round

// Module state owned by this module.
var telemetryToSend = []
var lastQueuedTelemetry = {
  utc: 0,
}
var lastSampleMono = 0
var lastQueuedMono = 0
var sampleInterval = C.SAMPLE_INTERVAL_DEFAULT

var ROUNDING = C.ROUNDING

/**
 * Rounds each telemetry field that has a precision in ROUNDING (in place).
 * Unmapped keys (utc, booleans) are left untouched. Returns the same object.
 */
function roundTelemetry(snap) {
  for (var k in snap) {
    if (Object.prototype.hasOwnProperty.call(ROUNDING, k)) {
      snap[k] = round(snap[k], ROUNDING[k])
    }
  }
  return snap
}

/**
 * True if any non-utc field of snap differs from the last queued point.
 */
function changedVsLastQueued(snap) {
  for (var k in snap) {
    if (k === 'utc') { continue }
    if (snap[k] !== lastQueuedTelemetry[k]) { return true }
  }
  return false
}

/**
 * Sets the per-session sample interval (seconds). Called at session start.
 */
function setSampleInterval(n) {
  sampleInterval = n
}

/**
 * Unconditionally queues a full snapshot, stamps the cadence baselines from
 * m.monotonic, and applies the overflow drop (oldest first).
 */
function enqueue(snap) {
  var mono = OvmsMetrics.Value('m.monotonic')
  telemetryToSend.push(snap)
  lastQueuedTelemetry = snap
  lastQueuedMono = mono
  lastSampleMono = mono
  if (telemetryToSend.length > C.MAX_TELEMETRY_QUEUE_SIZE) {
    telemetryToSend.shift()
    Logger.warn('Telemetry queue exceeded ' + C.MAX_TELEMETRY_QUEUE_SIZE + ' items. Oldest entry dropped.')
  }
  Logger.debug('Telemetry queued, data in queue:', telemetryToSend.length)
}

/**
 * Per-tick sampler (subscribed to ticker.1). Gated on m.monotonic elapsed time;
 * queues a rounded full snapshot only when a field changed, or on the heartbeat.
 */
function sample() {
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastSampleMono < sampleInterval) { return }
  lastSampleMono = mono
  var snap = roundTelemetry(Met.createTelemetry())
  if (changedVsLastQueued(snap)) {
    enqueue(snap)
  } else if (C.HEARTBEAT_INTERVAL > 0 && mono - lastQueuedMono >= C.HEARTBEAT_INTERVAL) {
    enqueue(snap)
  }
}

/**
 * Removes a specified number of elements from the beginning of the telemetryToSend array.
 *
 * @param {number} count - The number of elements to remove from the start of the telemetryToSend array.
 * @returns {void} - This function does not return a value; it modifies the telemetryToSend array in place.
 */
function removeTelemetry(count) {
  telemetryToSend.splice(0, count);
}

/**
 * Removes the given batch's telemetry objects from the queue by identity. A
 * successful flush thus drops only the points that were actually sent, even if
 * the queue's front shifted (an overflow drop) while the request was in flight —
 * unlike a positional splice, which could discard never-sent points. Objects
 * already removed (e.g. shifted out as overflow) are simply not found.
 */
function removeTelemetryBatch(batch) {
  for (var i = 0; i < batch.length; i++) {
    var idx = telemetryToSend.indexOf(batch[i]);
    if (idx !== -1) {
      telemetryToSend.splice(idx, 1);
    }
  }
}

/**
 * Returns a shallow snapshot of up to `n` queued points from the front.
 */
function snapshot(n) {
  return telemetryToSend.slice(0, n)
}

module.exports = {
  roundTelemetry: roundTelemetry,
  changedVsLastQueued: changedVsLastQueued,
  setSampleInterval: setSampleInterval,
  enqueue: enqueue,
  sample: sample,
  removeTelemetry: removeTelemetry,
  removeTelemetryBatch: removeTelemetryBatch,
  snapshot: snapshot,
  getQueue: function () { return telemetryToSend },
  setLastQueued: function (o) { lastQueuedTelemetry = o },
}
