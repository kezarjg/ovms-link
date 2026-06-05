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

var Logger = logger()

module.exports = {
  Logger: Logger,
  round: round,
  clone: clone,
  timestamp: timestamp,
}
