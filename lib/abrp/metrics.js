// Owns metricMap (the ABRP<->OVMS metric mapping) and the functions that read
// OVMS metrics through it. See CLAUDE.md "Architecture" for why metricMap is the
// heart of the design.
var U = require('./util')
var Logger = U.Logger

// Metric value functions, defined at module top level (not nested inside the
// metricMap build or the override table) so the Duktape compiler sees them at a
// shallow depth. Most metrics need none of these — getOVMSMetric defaults to a
// passthrough of the single required metric.
function mIsDcfc(m) { return m['v.c.mode'] === 'performance'; }
function mIsParked(m) { return m['v.e.parktime'] > 0; }
function mSoe(m) { return (m['v.b.soc'] / 100) * m['v.b.capacity']; }
function mTireFL(m) { return m['v.t.pressure'][0]; }
function mTireFR(m) { return m['v.t.pressure'][1]; }
function mTireRL(m) { return m['v.t.pressure'][2]; }
function mTireRR(m) { return m['v.t.pressure'][3]; }
// Vehicle-override value functions:
function mNlRange(m) {
  var instrumentRange = m['xnl.v.b.range.instrument'] || 0;
  var idealRange = m['v.b.range.ideal'];
  return idealRange > 1.1 * instrumentRange ? idealRange : instrumentRange;
}
function mSubaruParked(m) { return m['v.e.gear'] === 0; }

/**
 * metricMap maps each ABRP/Iternio telemetry key to the OVMS metric(s) it needs
 * and, optionally, a metric() function that computes the value. A metric is only
 * sent if all requiredMetrics report a value (so the plugin auto-adapts per vehicle).
 * - key: the Iternio Telemetry API key.
 * - label: descriptive name (UI/logs).
 * - unit: (optional) unit of measurement.
 * - requiredMetrics: OVMS metrics needed; empty => unsupported (auto-skipped).
 * - metric: (optional) value function; omit for a plain passthrough of
 *     metrics[requiredMetrics[0]] (see getOVMSMetric).
 *
 * Built incrementally via add() rather than one large array literal so the compiler
 * processes small statements. overrideMetricMap() adjusts entries per vehicle type.
 */
var metricMap = [];
function add(key, label, unit, requiredMetrics, metric) {
  var entry = { key: key, label: label, requiredMetrics: requiredMetrics };
  if (unit) { entry.unit = unit; }
  if (metric) { entry.metric = metric; }
  metricMap.push(entry);
}
add('utc', 'UTC Timestamp', 's', ['m.time.utc']);
add('soc', 'State of Charge', '%', ['v.b.soc']);
add('power', 'Battery Power', 'kW', ['v.b.power']);
add('speed', 'Vehicle Speed', 'kph', ['v.p.speed']);
add('lat', 'GPS Latitude', '°', ['v.p.latitude']);
add('lon', 'GPS Longitude', '°', ['v.p.longitude']);
add('is_charging', 'Charging', null, ['v.c.charging']);
add('is_dcfc', 'DC Fast Charging', null, ['v.c.mode'], mIsDcfc);
add('is_parked', 'Parked', null, ['v.e.parktime'], mIsParked);
add('capacity', 'Capacity', 'kWh', ['v.b.capacity']);
add('soe', 'Present Energy', 'kWh', ['v.b.soc', 'v.b.capacity'], mSoe);
add('soh', 'State of Health', '%', ['v.b.soh']);
add('heading', 'GPS Heading', '°', ['v.p.direction']);
add('elevation', 'GPS Elevation', 'm', ['v.p.altitude']);
add('ext_temp', 'External Temp', '°C', ['v.e.temp']);
add('batt_temp', 'Battery Temp', '°C', ['v.b.temp']);
add('voltage', 'Battery Voltage', 'V', ['v.b.voltage']);
add('current', 'Battery Current', 'A', ['v.b.current']);
add('odometer', 'Odometer', 'km', ['v.p.odometer']);
add('est_battery_range', 'Estimated Range', 'km', ['v.b.range.est']);
// No generic OVMS source for HVAC power; supply via overrideMetricMap() on
// vehicles that expose it (e.g. an x… extended metric). Unmapped => auto-skipped.
add('hvac_power', 'HVAC Power', 'kW', []);
add('hvac_setpoint', 'HVAC Setpoint', '°C', ['v.e.cabinsetpoint']);
add('cabin_temp', 'Cabin Temp', '°C', ['v.e.cabintemp']);
// OVMS exposes tyre data as a vector metric; wheel order is fixed: FL=0, FR=1, RL=2, RR=3.
add('tire_pressure_fl', 'FL Tire Pressure', 'kPa', ['v.t.pressure'], mTireFL);
add('tire_pressure_fr', 'FR Tire Pressure', 'kPa', ['v.t.pressure'], mTireFR);
add('tire_pressure_rl', 'RL Tire Pressure', 'kPa', ['v.t.pressure'], mTireRL);
add('tire_pressure_rr', 'RR Tire Pressure', 'kPa', ['v.t.pressure'], mTireRR);

// Vehicle-specific overrides as data (vehicleType -> { entryKey -> override }),
// applied by overrideMetricMap(). An override sets requiredMetrics and/or metric,
// or drops the entry. Kept flat (data + the top-level functions above) so nothing
// nests a function compile inside a switch/if/forEach.
var SUBARU_OVERRIDES = {
  is_parked: { requiredMetrics: ['v.e.gear'], metric: mSubaruParked },
  hvac_power: { requiredMetrics: ['xte.v.e.hvac.power'] },
};
var OVERRIDES = {
  // Kia Soul has an OVMS bug calculating SOH; drop it from reporting.
  KS: { soh: { drop: true } },
  // Nissan Leaf: instrument-cluster SoC/SoH + a range heuristic.
  NL: {
    soc: { requiredMetrics: ['xnl.v.b.soc.instrument'] },
    soh: { requiredMetrics: ['xnl.v.b.soh.instrument'] },
    est_battery_range: { requiredMetrics: ['xnl.v.b.range.instrument', 'v.b.range.ideal'], metric: mNlRange },
  },
  // Toyota e-TNGA (Subaru Solterra / Toyota bZ4X).
  SUBSOL: SUBARU_OVERRIDES,
  TOYBZ4X: SUBARU_OVERRIDES,
};

/**
 * Applies vehicle-specific overrides to metricMap based on OvmsMetrics 'v.type'.
 * Add vehicles by extending OVERRIDES.
 */
function overrideMetricMap() {
  Logger.debug('Running overrideMetricMap...');
  var vehicleType = OvmsMetrics.Value('v.type');
  Logger.debug('Vehicle type: ' + vehicleType);

  var overrides = OVERRIDES[vehicleType];
  if (!overrides) { return; }

  metricMap.forEach(function(entry) {
    var o = overrides[entry.key];
    if (!o) { return; }
    if (o.drop) {
      delete entry.requiredMetrics;
      delete entry.metric;
      return;
    }
    entry.requiredMetrics = o.requiredMetrics;
    if (o.metric) {
      entry.metric = o.metric;
    } else {
      delete entry.metric;
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
 * @returns {[boolean, any]} - [supported, value]. Unsupported/unknown => [false, null].
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
    // If requiredMetrics is empty/absent, the metric is unsupported.
    if (!telemetryEntry.requiredMetrics || telemetryEntry.requiredMetrics.length === 0) {
      return [false, null];
    }

    // Check if all required metrics are supported
    var isSupported = isOvmsMetricSupported(telemetryEntry.requiredMetrics);

    if (isSupported) {
      // Retrieve the metrics values
      var metrics = OvmsMetrics.GetValues(telemetryEntry.requiredMetrics);
      // Default: pass through the single required metric. Entries only carry a
      // `metric` function when they actually compute (comparison / calc / vector).
      var value;
      if (telemetryEntry.metric) {
        value = telemetryEntry.metric(metrics);
      } else {
        value = metrics[telemetryEntry.requiredMetrics[0]];
      }
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
 * Creates a telemetry object with the supported parameters and their values.
 * @returns {Object} The telemetry object.
 */
function createTelemetry() {
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

  return telemetry;  // Returning the telemetry object
}

module.exports = {
  metricMap: metricMap,
  overrideMetricMap: overrideMetricMap,
  getOVMSMetric: getOVMSMetric,
  createTelemetry: createTelemetry,
}
