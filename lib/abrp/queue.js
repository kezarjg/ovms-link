// Owns the telemetry queue and the collect-then-send cadence logic. Other
// modules read/mutate this state only through the accessors exported below.
var C = require('./constants')
var U = require('./util')
var Met = require('./metrics')
var Logger = U.Logger
var round = U.round
var clone = U.clone
var medianPowerMetrics = U.medianPowerMetrics

// Module state owned by this module.
var telemetryToSend = []
var collectedMetrics = []
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
 * Determines if a telemetry change is significant based on a comparison between current and previous telemetry data.
 * @param {Object} currentTelemetry - The current telemetry data object.
 * @param {Object} previousTelemetry - The previous telemetry data object.
 * @returns {boolean} - Returns true if the telemetry change is considered significant, false otherwise.
 */
function isSignificantTelemetryChange(currentTelemetry, previousTelemetry) {
  // Significant if the SOC changes so that it updates in ABRP as soon as
  // possible after it's changed within the vehicle.
  if (currentTelemetry.soc !== previousTelemetry.soc) {
    return true
  }
  // Significant change if either the is_parked or is_charging states changes
  if (currentTelemetry.is_charging !== previousTelemetry.is_charging) {
    return true
  }
  if (currentTelemetry.is_parked !== previousTelemetry.is_parked) {
    return true
  }
  // Significant change if the power changes by more than 1 kW while charging.
  // Another piece of information that is clearly shown within ABRP so good
  // to be responsive to those changes in charging power.
  if (
    currentTelemetry.is_charging &&
    round(currentTelemetry.power) !== round(previousTelemetry.power)
  ) {
    return true
  }
  // Otherwise, updates purely based on timing considerations based on the
  // current state of the metrics and when the last telemetry was sent
  return false
}

/**
 * Calculates the maximum elapsed duration for telemetry transmission
 * based on the current telemetry data and predefined conditions.
 *
 * @param {Object} telemetry - The current telemetry data.
 * @param {number} telemetry.speed - The current speed of the vehicle.
 * @param {boolean} telemetry.is_parked - Indicates if the vehicle is parked.
 * @param {boolean} telemetry.is_dcfc - Indicates if the vehicle is using DC fast charging.
 * @param {boolean} telemetry.is_charging - Indicates if the vehicle is currently charging.
 *
 * @returns {number} - The maximum elapsed duration in seconds for telemetry transmission.
 *                     Returns 0 if a significant telemetry change is detected,
 *                     otherwise returns predefined poll rates based on the vehicle's state,
 *                     or defaults to 86400 seconds (24 hours) if parked.
 */
function calculateMaxElapsedDuration(telemetry) {
  if (isSignificantTelemetryChange(telemetry, lastQueuedTelemetry)) {
    Logger.debug('Significant telemetry change');
    return 0; // Always send
  }

  if (telemetry.speed > C.MIN_CALIBRATION_SPEED) {
    Logger.debug('Speed greater than minimum calibration speed');
    return C.METRIC_POLL_RATE_DRIVING;
  }

  if (!telemetry.is_parked || telemetry.is_dcfc) {
    Logger.debug('Driving or DC fast charging');
    return C.METRIC_POLL_STALE_CONNECTION;
  }

  if (telemetry.is_charging) {
    Logger.debug('Standard charging');
    return C.METRIC_POLL_RATE_CHARGING;
  }

  // Default to 24 hours if parked
  return 24 * 3600;
}

/**
 * Queues telemetry, optionally processing collected data for smoothing.
 */
function queueTelemetry(telemetry, processCollectedData) {
  // If processing collected data, smooth power and speed metrics
  if (processCollectedData && collectedMetrics.length) {
    Logger.debug('Processing collected metrics');
    var medianMetrics = medianPowerMetrics(collectedMetrics);
    if (medianMetrics) {
      telemetry.power = round(medianMetrics.power, 2);  // Round power to nearest 10W
      telemetry.speed = round(medianMetrics.speed);     // Round speed
    }
  }

  telemetryToSend.push(telemetry);
  lastQueuedTelemetry = clone(telemetry);
  collectedMetrics = [];  // Reset collected metrics after sending

  // Check the size of telemetryToSend and handle overflow
  if (telemetryToSend.length > C.MAX_TELEMETRY_QUEUE_SIZE) {
    // KNOWN LIMITATION: if this overflow drop happens while a bulk batch is in
    // flight, the queue front shifts and sendBulkTelemetry's removeTelemetry(
    // batch.length) can then splice the wrong rows. Narrow (requires a full
    // queue mid-flight, i.e. a prolonged outage). Tracked as a follow-up in the
    // plan doc.
    telemetryToSend.shift();  // Remove the oldest element (first in queue)
    Logger.warn('Telemetry queue exceeded ' + C.MAX_TELEMETRY_QUEUE_SIZE + ' items. Oldest entry dropped.');
  }

  Logger.debug('Telemetry added, data in queue:', telemetryToSend.length);
}

/**
 * Per-second handler while the vehicle is on. Always collects high-frequency
 * samples (for median power/speed smoothing) while not parked, then queues a
 * smoothed telemetry point once enough time has elapsed for the current state.
 */
function queueTelemetryIfNecessary() {
  var currentTelemetry = Met.createTelemetry()
  var timeSinceLastSent = currentTelemetry.utc - lastQueuedTelemetry.utc

  // Collect 1 Hz samples only while moving. is_parked is true during charging,
  // so charge points intentionally carry instantaneous power (sent on a
  // significant >1 kW change); a median over a 30-min charge window would be
  // meaningless. The median smooths driving power/speed for ABRP km/kWh calibration.
  if (!currentTelemetry.is_parked) {
    collectedMetrics.push(currentTelemetry)
    Logger.debug('Collected metrics in queue: ' + collectedMetrics.length)
  }

  var maxElapsedDuration = calculateMaxElapsedDuration(currentTelemetry)

  if (timeSinceLastSent >= maxElapsedDuration) {
    queueTelemetry(currentTelemetry, true) // apply median smoothing
  }
}

/**
 * Queues the current telemetry snapshot immediately, regardless of timing.
 * Used by the vehicle on/off handlers to bookend a driving/charging session.
 */
function queueTelemetryManual() {
  var currentTelemetry = Met.createTelemetry();
  // Manual/one-off sends pass BANDWIDTH_SAVER as processCollectedData; with the
  // default BANDWIDTH_SAVER=false this ships the snapshot without median smoothing.
  queueTelemetry(currentTelemetry, C.BANDWIDTH_SAVER);
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
  queueTelemetry: queueTelemetry,
  queueTelemetryIfNecessary: queueTelemetryIfNecessary,
  queueTelemetryManual: queueTelemetryManual,
  removeTelemetry: removeTelemetry,
  removeTelemetryBatch: removeTelemetryBatch,
  isSignificantTelemetryChange: isSignificantTelemetryChange,
  calculateMaxElapsedDuration: calculateMaxElapsedDuration,
  snapshot: snapshot,
  getQueue: function () { return telemetryToSend },
  getCollected: function () { return collectedMetrics },
  setCollected: function (a) { collectedMetrics = a },
  setLastQueued: function (o) { lastQueuedTelemetry = o },
}
