// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

// Module constants
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '2.2.0-beta'
const Logger = logger()

// Configuration constants
const DEBUG = true
const BANDWIDTH_SAVER = false // If true, minimizes the amount of data sent
const MIN_CALIBRATION_SPEED = 70 // kph
const METRIC_POLL_RATE_DRIVING = 5 // Poll rate during driving (s)
const METRIC_POLL_RATE_CHARGING = 30 * 60 // Poll rate during charging (s)
const METRIC_POLL_STALE_CONNECTION = (3 * 60) - 20// 3 minutes for OVMS API Key
const MAX_TELEMETRY_QUEUE_SIZE = 100

// Module variables
var user_token = OvmsConfig.GetValues('usr', 'abrp.').user_token
var isTimeValid = false;
var isActive = false;
var telemetryToSend = []
var collectedMetrics = []
var lastQueuedTelemetry = {
  utc: 0,
}
var subscriptions = {};

/**
 * metricMap defines a list of ABRP (A Better Routeplanner) metrics and their 
 *   corresponding OVMS (Open Vehicle Monitoring System) metrics.
 * 
 * Each entry in metricMap contains the following properties:
 * - key: A unique identifier for the metric from the Iternio Telemetry API.
 * - label: A descriptive name for the metric to be displayed in UI or logs.
 * - unit: (Optional) The unit of measurement for the metric.
 * - requiredMetrics: An array of OVMS metrics that are required to calculate the value of the metric.
 *     If requiredMetrics is empty, the metric is not supported or cannot be calculated from the available data.
 * - metric: A function that processes the telemetry data and returns the value for the metric.
 * 
 * Vehicle-Specific Implementations: 
 * A function called `overrideMetricMap` can be used to modify the default `metricMap` on startup, 
 *   allowing vehicle-specific implementations or adjustments to certain metrics.
 */
var metricMap = [
  { key: 'utc', label: 'UTC Timestamp', unit: 's' , requiredMetrics: ['m.time.utc'] ,
      metric: function(metrics) { return metrics['m.time.utc']; } },
  { key: 'soc', label: 'State of Charge', unit: '%' , requiredMetrics: ['v.b.soc'] ,
      metric: function(metrics) { return metrics['v.b.soc']; } },
  { key: 'power', label: 'Battery Power', unit: 'kW' , requiredMetrics: ['v.b.power'] ,
      metric: function(metrics) { return metrics['v.b.power']; } },
  { key: 'speed', label: 'Vehicle Speed', unit: 'kph' , requiredMetrics: ['v.p.speed'] ,
      metric: function(metrics) { return metrics['v.p.speed']; } },
  { key: 'lat', label: 'GPS Latitude', unit: '°' , requiredMetrics: ['v.p.latitude'] ,
      metric: function(metrics) { return metrics['v.p.latitude']; } },
  { key: 'lon', label: 'GPS Longitude', unit: '°' , requiredMetrics: ['v.p.longitude'] ,
      metric: function(metrics) { return metrics['v.p.longitude']; } },
  { key: 'is_charging', label: 'Charging' , requiredMetrics: ['v.c.charging'] ,
      metric: function(metrics) { return metrics['v.c.charging']; } },
  { key: 'is_dcfc', label: 'DC Fast Charging' , requiredMetrics: ['v.c.mode'] ,
      metric: function(metrics) { return metrics['v.c.mode'] === 'performance'; } },
  { key: 'is_parked', label: 'Parked' , requiredMetrics: ['v.e.parktime'] ,
      metric: function(metrics) { return metrics['v.e.parktime'] > 0; } },
  { key: 'capacity', label: 'Capacity', unit: 'kWh'  },
  { key: 'soe', label: 'Present Energy', unit: 'kWh'  },
  { key: 'soh', label: 'State of Health', unit: '%' , requiredMetrics: ['v.b.soh'] ,
      metric: function(metrics) { return metrics['v.b.soh']; } },
  { key: 'heading', label: 'GPS Heading', unit: '°' , requiredMetrics: ['v.p.direction'] ,
      metric: function(metrics) { return metrics['v.p.direction']; } },
  { key: 'elevation', label: 'GPS Elevation', unit: 'm' , requiredMetrics: ['v.p.altitude'] ,
      metric: function(metrics) { return metrics['v.p.altitude']; } },
  { key: 'ext_temp', label: 'External Temp', unit: '°C' , requiredMetrics: ['v.e.temp'] ,
      metric: function(metrics) { return metrics['v.e.temp']; } },
  { key: 'batt_temp', label: 'Battery Temp', unit: '°C' , requiredMetrics: ['v.b.temp'] ,
      metric: function(metrics) { return metrics['v.b.temp']; } },
  { key: 'voltage', label: 'Battery Voltage', unit: 'V' , requiredMetrics: ['v.b.voltage'] ,
      metric: function(metrics) { return metrics['v.b.voltage']; } },
  { key: 'current', label: 'Battery Current', unit: 'A' , requiredMetrics: ['v.b.current'] ,
      metric: function(metrics) { return metrics['v.b.current']; } },
  { key: 'odometer', label: 'Odometer', unit: 'km' , requiredMetrics: ['v.p.odometer'] ,
      metric: function(metrics) { return metrics['v.p.odometer']; } },
  { key: 'est_battery_range', label: 'Estimated Range', unit: 'km' , requiredMetrics: ['v.b.range.est'] ,
      metric: function(metrics) { return metrics['v.b.range.est']; } },
  { key: 'hvac_power', label: 'HVAC Power', unit: 'kW' , requiredMetrics: []  },
  { key: 'hvac_setpoint', label: 'HVAC Setpoint', unit: '°C' , requiredMetrics: ['v.e.cabinsetpoint'] ,
      metric: function(metrics) { return metrics['v.e.cabinsetpoint']; } },
  { key: 'cabin_temp', label: 'Cabin Temp', unit: '°C' , requiredMetrics: ['v.e.cabintemp'] ,
      metric: function(metrics) { return metrics['v.e.cabintemp']; } },
  { key: 'tire_pressure_fl', label: 'FL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.fl.p'] ,
      metric: function(metrics) { return metrics['v.tp.fl.p']; } },
  { key: 'tire_pressure_fr', label: 'FR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.fr.p'] ,
      metric: function(metrics) { return metrics['v.tp.fr.p']; } },
  { key: 'tire_pressure_rl', label: 'RL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.rl.p'] ,
      metric: function(metrics) { return metrics['v.tp.rl.p']; } },
  { key: 'tire_pressure_rr', label: 'RR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.rr.p'] ,
      metric: function(metrics) { return metrics['v.tp.rr.p']; } },
];

// Utility Functions

/**
 * Creates a shallow copy of the provided object.
 */
function clone(obj) {
  return Object.assign({}, obj)
}

/**
 * Rounds the given number to the specified precision.
 */
function round(number, precision) {
  if (!number) {
    return number // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0))
}

/**
 * Returns the current date and time as a localized string.
 */ 
function timestamp() {
  return new Date().toLocaleString()
}

/**
 * Creates a logger object with various logging functions.
 * 
 * @returns {Object} - An object with logging functions (log, debug, error, info, warn).
 */
function logger() {
  function log(message, obj) {
    print(message + (obj ? ' ' + JSON.stringify(obj) : '') + '\n')
  }

  function debug(message, obj) {
    if (DEBUG) {
      log('(' + timestamp() + ') DEBUG: ' + message, obj)
    }
  }

  function error(message, obj) {
    log('(' + timestamp() + ') ERROR: ' + message, obj)
  }

  function info(message, obj) {
    log('(' + timestamp() + ') INFO: ' + message, obj)
  }

  function warn(message, obj) {
    log('(' + timestamp() + ') WARN: ' + message, obj)
  }

  return {
    debug,
    error,
    info,
    log,
    warn,
  }
}

/**
 * Calculates the median power metric from the given array of readings.
 * @param {Array} array - An array of readings containing power metrics.
 * @returns {Object|null} - The median power metric reading, or null if the input array is empty.
 */
function medianPowerMetrics(array) {
  if (!array.length) {
    return null
  }
  // Find the median based on the power metric
  var sorted = array.slice().sort(function (a, b) {
    return a.power - b.power
  })
  var midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    // Don't try and average the readings as they could have been some seconds
    // apart. Simply return the reading closest to the sorted middle with the
    // lower power reading.
    return sorted[midpoint - 1]
  } else {
    return sorted[midpoint]
  }
}

/**
 * Validates the ABRP configuration for the user.
 * 
 * @returns {boolean} True if the configuration is valid, false otherwise.
 */
function validateUsrAbrpConfig() {
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

// Telemetry and Metric Functions

/**
 * Updates the `metricMap` based on the vehicle type retrieved from the OvmsMetrics service.
 * Additional cases for other vehicle types can be added as needed.
 */
function overrideMetricMap() {
  Logger.debug("Running overrideMetricMap...");

  var vehicleType = OvmsMetrics.Value('v.type');
  Logger.debug("Vehicle type: " + vehicleType);

  metricMap.forEach(function(entry) {
    switch (vehicleType) {
      case 'KS':
        // Kia Soul has an OVMS bug for calculating SOH. This removes it from being reported.
        if (entry.key === 'soh') {
          delete entry.requiredMetrics;
          delete entry.metric;
        }
        break;
      case 'NL':
        if (entry.key === 'soc') {
          entry.requiredMetrics = ['xnl.v.b.soc.instrument'];
          entry.metric = function(metrics) { 
            return metrics['xnl.v.b.soc.instrument']; 
          };
        }
        if (entry.key === 'soh') {
            entry.requiredMetrics = ['xnl.v.b.soh.instrument'];
            entry.metric = function(metrics) { 
              return metrics['xnl.v.b.soh.instrument']; 
            };
          }
        if (entry.key === 'est_battery_range') {
          entry.requiredMetrics = ['xnl.v.b.range.instrument', 'v.b.range.ideal'];
          entry.metric = function(metrics) {
            instrumentRange = metrics['xnl.v.b.range.instrument'] || 0;
            idealRange = metrics['v.b.range.ideal'];
            return idealRange > 1.1 * instrumentRange ? idealRange : instrumentRange; 
          };
        }
        break;
      case 'SUBSOL':
      case 'TOYBZ4X':
        if (entry.key === 'is_parked') {
          entry.requiredMetrics = ['v.e.gear'];
          entry.metric = function(metrics) { 
            return metrics['v.e.gear'] === 0; 
          };
        }
        break;
      // Add cases for other vehicle types as needed
    }
  });
}

/**
 * Checks if all the required metrics are supported by the OvmsMetrics system.
 * @param {Array} requiredMetrics - An array of required metric names to be checked.
 * @returns {boolean} - Returns true if all the required metrics are supported, false otherwise.
 */
function isOvmsMetricSupported(requiredMetrics) {
  for (var i = 0; i < requiredMetrics.length; i++) {
    if (!OvmsMetrics.HasValue(requiredMetrics[i])) { 
      return false; // Return false if any metric is not defined or stale
    }
  }
  return true; // All metrics are supported
}

/**
 * Retrieves the value of the specified OVMS metric parameter.
 * @param {string} parameter - The parameter name of the OVMS metric.
 * @returns {[boolean, any]} - Returns a two-element array. The first element indicates whether the metric is supported, and the second element is the metric value. If the parameter is unrecognized, the array will contain [false, null].
 */
function getOVMSMetric(parameter) {
  // Search through metricMap to find the matching entry
  var telemetryEntry = null;
  for (var i = 0; i < metricMap.length; i++) {
    if (metricMap[i].key === parameter) {
      telemetryEntry = metricMap[i];
      break;
    }
  }

  if (telemetryEntry) {
    // If requiredMetrics is an empty array, return unsupported
    if (!telemetryEntry.requiredMetrics || telemetryEntry.requiredMetrics.length === 0) {
      return [false, null];
    }

    // Check if all required metrics are supported
    var isSupported = isOvmsMetricSupported(telemetryEntry.requiredMetrics);

    if (isSupported) {
      // Retrieve the metrics values
      var metrics = OvmsMetrics.GetValues(telemetryEntry.requiredMetrics);
      var value = telemetryEntry.metric(metrics); // Pass metrics
      return [true, value];
    } else {
      return [false, null];
    }
  } else {
    // If the parameter is not found in metricMap, return [false, null]
    return [false, null];
  }
}

/**
 * Creates a telemetry object with the specified parameters.
 * 
 * @returns {Object} The telemetry object containing the supported parameters and their values.
 */
function createTelemetry() {
  var startTime = performance.now();  // Start timer
  var telemetry = {};  // Creating an empty object to hold the telemetry data

  // Use metricMap to fetch and store telemetry data
  metricMap.forEach(function(entry) {
    var key = entry.key;
    
    var result = getOVMSMetric(key);  // Fetch the metric for the current key
    var isSupported = result[0];
    var value = result[1];

    if (isSupported) {
      telemetry[key] = value;  // Add the value to the telemetry object
    }
  });

  var duration = performance.now() - startTime;  // Calculate duration
  if (duration > 500) {
    Logger.warn("Metrics collected. Finished in " + duration.toFixed(2) + " ms");
  }

  return telemetry;  // Returning the telemetry object
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

  if (telemetry.speed > MIN_CALIBRATION_SPEED) {
    Logger.debug('Speed greater than minimum calibration speed');
    return METRIC_POLL_RATE_DRIVING;
  }

  if (!telemetry.is_parked || telemetry.is_dcfc) {
    Logger.debug('Driving or DC fast charging');
    return METRIC_POLL_STALE_CONNECTION;
  }

  if (telemetry.is_charging) {
    Logger.debug('Standard charging');
    return METRIC_POLL_RATE_CHARGING;
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
  if (telemetryToSend.length > MAX_TELEMETRY_QUEUE_SIZE) {
    telemetryToSend.shift();  // Remove the oldest element (first in queue)
    Logger.warn('Telemetry queue exceeded ' + MAX_TELEMETRY_QUEUE_SIZE + ' items. Oldest entry dropped.');
  }

  Logger.debug('Telemetry added, data in queue:', telemetryToSend.length);
}

/**
 * Sends telemetry data to ABRP (A Better Routeplanner) if necessary, based on specified conditions and timing considerations.
 */
function queueTelemetryIfNecessary() {
  var currentTelemetry = createTelemetry();
  var timeSinceLastSent = currentTelemetry.utc - lastQueuedTelemetry.utc;

  if (!BANDWIDTH_SAVER && !currentTelemetry.is_parked) {
    if (timeSinceLastSent >= METRIC_POLL_RATE_DRIVING) {
      queueTelemetry(currentTelemetry, BANDWIDTH_SAVER);
    }
    return;
  }

  // Collect all metrics if not parked
    if (!currentTelemetry.is_parked) {
    Logger.debug('Not parked. Moving telemetry to array')
    collectedMetrics.push(currentTelemetry);
    Logger.debug('Collected metrics in queue: ' + collectedMetrics.length);
  }

  var maxElapsedDuration = calculateMaxElapsedDuration(currentTelemetry);

  if (timeSinceLastSent >= maxElapsedDuration) {
    queueTelemetry(currentTelemetry, BANDWIDTH_SAVER);
  }
}

/**
 * Sends telemetry data to ABRP (A Better Routeplanner) if necessary, based on specified conditions and timing considerations.
 */
function queueTelemetryManual() {
  var currentTelemetry = createTelemetry();
  queueTelemetry(currentTelemetry, BANDWIDTH_SAVER);
}

// Queue Processing and Data Transmission

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
 * Sends single telemetry data to the ABRP (A Better Routeplanner) API.
 * Only used in oneTime()
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
 */
function sendTelemetry(telemetry) {
  Logger.info('Sending telemetry to ABRP', telemetry)
  var url =
    'https://api.iternio.com/1/tlm/send?api_key=' +
    encodeURIComponent(OVMS_API_KEY) +
    '&token=' +
    encodeURIComponent(user_token) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))

  // Perform the HTTP request
  HTTP.Request({
    url: url,
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200) {
        Logger.debug('Telemetry data sent successfully.');
      } else {
        Logger.warn('Non-200 response from ABRP', response);
      }
    },
    fail: function (error) {
      Logger.error('ABRP error', error);
    },
  });
}

/**
 * Creates a bulk telemetry post object, containing up to the first 10 elements
 * of the telemetry data to be sent.
 * @returns {Object} The bulk telemetry post object, including the user token and 
 *                   a telemetry list with a maximum of 10 telemetry entries.
 */
function createBulkPost() {
  // Create the structure
  return {
    data: [
      {
        token: user_token,
        tlm_list: telemetryToSend
      }
    ]
  };
}

/**
 * Sends telemetry data to the ABRP (A Better Routeplanner) API.
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
 */
function sendBulkTelemetry() {
  if (telemetryToSend.length === 0) {
    // Logger.debug('Processing queue. No data to send.');
    return;
  }

  Logger.debug('Sending bulk telemetry to ABRP');
  var url =
  'https://api.iternio.com/1/tlm/bulk?api_key=' +
  encodeURIComponent(OVMS_API_KEY)

  var bulkPost = createBulkPost();

  // Perform the HTTP request
  HTTP.Request({
    url: url,
    headers: [ { "Content-Type": "application/json" } ], // Set the content type to JSON
    post: JSON.stringify(bulkPost),
    timeout: 8000,  // 8 second timeout - Need to complete within ticker.10
    done: function (response) {
      if (response.statusCode === 200) {
        Logger.debug('Telemetry bulk data sent successfully. Removing from queue.');
        logTlmList(bulkPost);        
        // Remove the successfully sent telemetry
        var count = bulkPost.data[0].tlm_list.length;
        removeTelemetry(count);
      } else {
        Logger.warn('Non-200 response from ABRP', response);
      }
    },
    fail: function (error) {
      Logger.error('ABRP error', error);
    },
  });
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
  collectedMetrics = []; // Session is complete. Clear collectedMetrics.
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
    if (telemetry.hasOwnProperty(key)) {
      Logger.log(label + ': ' + telemetry[key] + ' ' + unit);
    }
  }

  // Display plugin version
  Logger.log('Plugin Version: ' + VERSION);

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
  if (!validateUsrAbrpConfig()) {
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
  if (!validateUsrAbrpConfig()) return;

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
  OvmsConfig.Delete('usr', 'abrp.user_token')
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

// Main Initialization Logic
overrideMetricMap();
subscribe('ticker.1', checkTime);

// Module exports
module.exports = {
  medianPowerMetrics, // jest
  info,
  onetime,
  send,
  resetConfig,
  round, // jest
}
