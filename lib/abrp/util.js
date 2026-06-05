// Utility functions (pure helpers + the Logger). No module state.
var C = require('./constants')

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
    if (C.DEBUG) {
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

var Logger = logger()

module.exports = {
  Logger: Logger,
  round: round,
  clone: clone,
  timestamp: timestamp,
  medianPowerMetrics: medianPowerMetrics,
}
