// Owns metricMap (the ABRP<->OVMS metric mapping) and the functions that read
// OVMS metrics through it. See CLAUDE.md "Architecture" for why metricMap is the
// heart of the design.
var U = require('./util')
var Logger = U.Logger

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
  { key: 'capacity', label: 'Capacity', unit: 'kWh' , requiredMetrics: ['v.b.capacity'] ,
      metric: function(metrics) { return metrics['v.b.capacity']; } },
  { key: 'soe', label: 'Present Energy', unit: 'kWh' , requiredMetrics: ['v.b.soc', 'v.b.capacity'] ,
      metric: function(metrics) { return (metrics['v.b.soc'] / 100) * metrics['v.b.capacity']; } },
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
  // No generic OVMS source for HVAC power; supply via overrideMetricMap() on
  // vehicles that expose it (e.g. an x… extended metric). Unmapped => auto-skipped.
  { key: 'hvac_power', label: 'HVAC Power', unit: 'kW' , requiredMetrics: []  },
  { key: 'hvac_setpoint', label: 'HVAC Setpoint', unit: '°C' , requiredMetrics: ['v.e.cabinsetpoint'] ,
      metric: function(metrics) { return metrics['v.e.cabinsetpoint']; } },
  { key: 'cabin_temp', label: 'Cabin Temp', unit: '°C' , requiredMetrics: ['v.e.cabintemp'] ,
      metric: function(metrics) { return metrics['v.e.cabintemp']; } },
  // OVMS exposes tyre data as a vector metric; wheel order is fixed: FL=0, FR=1, RL=2, RR=3.
  { key: 'tire_pressure_fl', label: 'FL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][0]; } },
  { key: 'tire_pressure_fr', label: 'FR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][1]; } },
  { key: 'tire_pressure_rl', label: 'RL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][2]; } },
  { key: 'tire_pressure_rr', label: 'RR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][3]; } },
];

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
            var instrumentRange = metrics['xnl.v.b.range.instrument'] || 0;
            var idealRange = metrics['v.b.range.ideal'];
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
        if (entry.key === 'hvac_power') {
          entry.requiredMetrics = ['xte.v.e.hvac.power'];
          entry.metric = function(metrics) {
            return metrics['xte.v.e.hvac.power'];
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

module.exports = {
  metricMap: metricMap,
  overrideMetricMap: overrideMetricMap,
  getOVMSMetric: getOVMSMetric,
  createTelemetry: createTelemetry,
}
