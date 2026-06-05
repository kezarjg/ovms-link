// Transmission: single-shot send (onetime) + bulk flush of the queue. Owns the
// in-flight guard (isSending) so overlapping bulk requests can't race.
var C = require('./constants')
var U = require('./util')
var Cfg = require('./config')
var Q = require('./queue')
var Iternio = require('./iternio')
var Logger = U.Logger

// Module state: true while a bulk request is in flight.
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
 * Sends single telemetry data to the ABRP (A Better Routeplanner) API.
 * Only used in oneTime()
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
 */
function sendTelemetry(telemetry) {
  Logger.info('Sending telemetry to ABRP', telemetry)
  var url =
    Iternio.apiUrl('tlm/send') +
    '&token=' +
    encodeURIComponent(Cfg.token()) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))

  // Perform the HTTP request
  HTTP.Request({
    url: url,
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200 && Iternio.isApiOk(response.body)) {
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
  var url = Iternio.apiUrl('tlm/bulk')

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
        if (response.statusCode === 200 && Iternio.isApiOk(response.body)) {
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

module.exports = {
  sendTelemetry: sendTelemetry,
  sendBulkTelemetry: sendBulkTelemetry,
  createBulkPost: createBulkPost,
}
