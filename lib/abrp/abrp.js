// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

var C = require('./constants')
var U = require('./util')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
var Tlm = require('./telemetry')
var Logger = U.Logger
var round = U.round
var medianPowerMetrics = U.medianPowerMetrics
var metricMap = Met.metricMap
var overrideMetricMap = Met.overrideMetricMap
var getOVMSMetric = Met.getOVMSMetric
var createTelemetry = Met.createTelemetry
var queueTelemetryIfNecessary = Q.queueTelemetryIfNecessary
var queueTelemetryManual = Q.queueTelemetryManual
var isSignificantTelemetryChange = Q.isSignificantTelemetryChange
var calculateMaxElapsedDuration = Q.calculateMaxElapsedDuration

// Module variables
var isTimeValid = false;
var isActive = false;
var subscriptions = {};

/**
 * Function to subscribe to events and store the token
 */
function subscribe(topic, callback) {
  var token = PubSub.subscribe(topic, callback);
  subscriptions[topic] = subscriptions[topic] || []; // Initialize array if not exists
  subscriptions[topic].push(token);
}

/**
 * Function to unsubscribe from events
 */
function unsubscribe(topic) {
  if (subscriptions[topic]) {
      for (var i = 0; i < subscriptions[topic].length; i++) {
          PubSub.unsubscribe(subscriptions[topic][i]);
      }
      delete subscriptions[topic]; // Optionally remove the topic from tracking
  }
}

// Event Handlers

/**
 * Handles the event when the vehicle is switched on.
 * Logs an informational message and sends an initial telemetry update to the queue.
 * Subscribes to the 'ticker.1' event to queue telemetry if necessary.
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOn() {
  Logger.info('Vehicle switched on...');
  // Send an initial telemetry to the queue
  queueTelemetryManual();
  subscribe('ticker.1', queueTelemetryIfNecessary);
}

/**
 * Handles the event when the vehicle is switched off.
 * Logs an informational message and unsubscribes from the 'ticker.1' event.
 * Sends a final telemetry update to the queue, attempts to process the telemetry queue,
 * and clears the collected metrics for the session.
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOff() {
  Logger.info('Vehicle switched off...');
  unsubscribe('ticker.1');
  // Send a final telemetry to the queue
  queueTelemetryManual();
  Q.setCollected([]); // Session is complete. Clear collectedMetrics.
}

/**
 * Manages subscribing or unsubscribing to vehicle state events based on the provided parameter.
 *
 * If subscribing, it registers callbacks for various vehicle state events and checks the current
 * state of the vehicle to invoke the appropriate callback. If unsubscribing, it removes the
 * event subscriptions and invokes the `callbackVehicleOff` function.
 *
 * @param {boolean} shouldSubscribe - If true, subscribes to vehicle state events; if false, unsubscribes.
 * 
 * @returns {void} - This function does not return a value; it modifies the subscription state for vehicle events.
 */
function manageVehicleStateEvents(shouldSubscribe) {
  if (shouldSubscribe) {
    Logger.debug('Subscribing to Vehicle State Events');
  } else {
    Logger.debug('Unsubscribing to Vehicle State Events');
  }
  
  if (shouldSubscribe) {
    subscribe('vehicle.type.set', overrideMetricMap);
    subscribe('ticker.10', Tlm.sendBulkTelemetry)
    subscribe('vehicle.on', callbackVehicleOn);
    subscribe('vehicle.charge.start', callbackVehicleOn);
    subscribe('vehicle.off', callbackVehicleOff);
    subscribe('vehicle.charge.stop', callbackVehicleOff);

    if (OvmsMetrics.Value('v.e.on')) {
      // Vehicle is already running
      Logger.debug('Vehicle is ON or charging');
      callbackVehicleOn();  
    } else {
      Logger.debug('Vehicle is OFF');
    }
  
  } else {
    unsubscribe('vehicle.on');
    unsubscribe('vehicle.charge.start');
    unsubscribe('vehicle.off');
    unsubscribe('vehicle.charge.stop');
    callbackVehicleOff();
  }

  isActive = shouldSubscribe;
}

/**
 * Monitors time and checks if it becomes valid, based on a minimum timestamp (Jan 1, 2000).
 * If valid, unsubscribes from the 'ticker.1' event and triggers startup logic.
 */
function checkTime() {
  const minValidTime = 946684800; // Unix timestamp for Jan 1, 2000
  if (OvmsMetrics.Value('m.time.utc') > minValidTime) {
    isTimeValid = true;  // Mark the time as valid
    Logger.debug('GPS time is valid, unsubscribing from ticker.1');
    
    // Unsubscribe from the ticker.1 event once the time is valid
    unsubscribe('ticker.1');
    
    // Proceed with startup
    send(true);
  } else {
    Logger.debug('Invalid GPS time, skipping telemetry processing.');
  }
}

// Core Control Functions

/**
 * Logs telemetry data to the console.
 */
function info() {
  var telemetry = createTelemetry();

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
  metricMap.forEach(function(item) {
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
  var telemetry = createTelemetry();
  Tlm.sendTelemetry(telemetry)
}

/**
 * Controls the sending of data based on the provided `shouldSend` flag.
 * @param {boolean} shouldSend - Indicates whether to start or stop sending data.
 */
function send(shouldSend) {
  // Check if config is valid
  if (!Cfg.validate()) return;

  // Check if time is valid
  if (!isTimeValid) {
    Logger.error('Cannot send data: GPS time is invalid.');
    return;
  }

  if (shouldSend && !isActive) {
    Logger.info('Start sending data...');
    manageVehicleStateEvents(true);
  } else if (!shouldSend && isActive) {
    Logger.info('Stop sending data');
    manageVehicleStateEvents(false);
  } else {
    Logger.warn(isActive ? 'Already running!' : 'Already stopped!');
  }
}

/**
 * Resets the ABRP configuration to default values.
 */
function resetConfig() {
  send(0);
  Cfg.reset();
}

// Main Initialization Logic — only auto-start inside OVMS, so the module can be
// require()'d under Jest with no side effects.
if (typeof OvmsConfig !== 'undefined' &&
    typeof OvmsMetrics !== 'undefined' &&
    typeof PubSub !== 'undefined') {
  overrideMetricMap()
  subscribe('ticker.1', checkTime)
}

// Module exports
module.exports = {
  // Public, in-vehicle entry points (invoked via `script eval abrp.<fn>()`)
  info,
  onetime,
  send,
  resetConfig,
  // Pure helpers exercised by the test suite
  round,
  medianPowerMetrics,
  isSignificantTelemetryChange,
  calculateMaxElapsedDuration,
  getOVMSMetric,
  createBulkPost: Tlm.createBulkPost,
  // Test-only seam (OVMS ignores extra exports; keeps the public surface clean)
  __test: {
    createTelemetry: createTelemetry,
    queueTelemetry: Q.queueTelemetry,
    queueTelemetryIfNecessary: Q.queueTelemetryIfNecessary,
    sendBulkTelemetry: Tlm.sendBulkTelemetry,
    removeTelemetry: Q.removeTelemetry,
    getQueue: Q.getQueue,
    getCollected: Q.getCollected,
    setCollected: Q.setCollected,
    setLastQueued: Q.setLastQueued,
  },
}
