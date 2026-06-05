// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

var C = require('./constants')
var U = require('./util')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
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
var isSending = false

/**
 * Logs the telemetry list (tlm_list) from a bulk telemetry post object.
 */
function logTlmList(bulkPost) {
  if (bulkPost && bulkPost.data && bulkPost.data.length > 0) {
    var tlmList = bulkPost.data[0].tlm_list; // Access the tlm_list
    
    tlmList.forEach(function(item) {
      Logger.debug('Sending: ' + JSON.stringify(item));
    });
  } 
}

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

// Queue Processing and Data Transmission

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

/**
 * Sends single telemetry data to the ABRP (A Better Routeplanner) API.
 * Only used in oneTime()
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
 */
function sendTelemetry(telemetry) {
  Logger.info('Sending telemetry to ABRP', telemetry)
  var url =
    'https://api.iternio.com/1/tlm/send?api_key=' +
    encodeURIComponent(C.OVMS_API_KEY) +
    '&token=' +
    encodeURIComponent(Cfg.token()) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))

  // Perform the HTTP request
  HTTP.Request({
    url: url,
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200 && isApiOk(response.body)) {
        Logger.debug('Telemetry data sent successfully.')
      } else {
        Logger.warn('ABRP did not accept telemetry', response)
      }
    },
    fail: function (error) {
      Logger.error('ABRP error', error);
    },
  });
}

/**
 * Builds a bulk telemetry post object for the given batch (a snapshot of up to
 * MAX_BULK_BATCH_SIZE queued points).
 */
function createBulkPost(batch) {
  return {
    data: [
      {
        token: Cfg.token(),
        tlm_list: batch,
      },
    ],
  }
}

/**
 * Flushes queued telemetry to the ABRP bulk endpoint. Sends at most one batch
 * per call, never overlaps in-flight requests, and only removes points from the
 * queue once the API confirms success (HTTP 200 AND body status === 'ok').
 */
function sendBulkTelemetry() {
  if (isSending) {
    Logger.debug('Bulk send already in progress; skipping this tick.')
    return
  }
  if (Q.getQueue().length === 0) {
    return
  }

  // Snapshot the batch now so the removal count cannot drift if more telemetry
  // is queued while the request is in flight.
  var batch = Q.snapshot(C.MAX_BULK_BATCH_SIZE)
  var bulkPost = createBulkPost(batch)
  var url =
    'https://api.iternio.com/1/tlm/bulk?api_key=' +
    encodeURIComponent(C.OVMS_API_KEY)

  Logger.debug('Sending bulk telemetry to ABRP')
  isSending = true
  try {
    HTTP.Request({
      url: url,
      headers: [{ 'Content-Type': 'application/json' }],
      post: JSON.stringify(bulkPost),
      timeout: 8000, // must complete within ticker.10
      done: function (response) {
        isSending = false
        if (response.statusCode === 200 && isApiOk(response.body)) {
          Logger.debug('Bulk telemetry accepted. Removing batch from queue.')
          logTlmList(bulkPost)
          // Remove exactly the sent objects by identity, so an overflow drop that
          // shifted the queue front mid-flight can't discard never-sent points.
          Q.removeTelemetryBatch(batch)
        } else {
          Logger.warn('ABRP rejected bulk telemetry; keeping batch for retry', response)
        }
      },
      fail: function (error) {
        isSending = false
        Logger.error('ABRP error', error)
      },
    })
  } catch (e) {
    isSending = false
    Logger.error('HTTP.Request threw synchronously', e)
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
    subscribe('ticker.10', sendBulkTelemetry)
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
  sendTelemetry(telemetry)
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
  createBulkPost,
  // Test-only seam (OVMS ignores extra exports; keeps the public surface clean)
  __test: {
    createTelemetry: createTelemetry,
    queueTelemetry: Q.queueTelemetry,
    queueTelemetryIfNecessary: Q.queueTelemetryIfNecessary,
    sendBulkTelemetry: sendBulkTelemetry,
    removeTelemetry: Q.removeTelemetry,
    getQueue: Q.getQueue,
    getCollected: Q.getCollected,
    setCollected: Q.setCollected,
    setLastQueued: Q.setLastQueued,
  },
}
