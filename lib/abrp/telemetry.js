// Transmission: single-shot send (onetime) + bulk flush of the queue. Owns the
// in-flight guard (isSending) so overlapping bulk requests can't race.
var C = require('./constants')
var U = require('./util')
var Cfg = require('./config')
var Q = require('./queue')
var Iternio = require('./iternio')
var Bw = require('./bandwidth')
var Logger = U.Logger
var clone = U.clone

// Module state: in-flight guard + flush cadence (m.monotonic-gated).
var isSending = false
var lastFlushMono = 0
var sendInterval = C.SEND_INTERVAL_DEFAULT
var lastResult = null

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
      // Bytes crossed the wire regardless of app-level acceptance — count them.
      Bw.record(telemetry, url.length + C.BW_HTTP_OVERHEAD, (response.body || '').length)
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
 * Delta-encodes a batch of full snapshots for transmission: the first point is
 * full (a resync), each subsequent point carries utc + only the fields that
 * changed from the previous point. Does not mutate the input points.
 */
function deltaEncode(batch) {
  var out = []
  var prev = null
  for (var i = 0; i < batch.length; i++) {
    var p = batch[i]
    if (prev === null) {
      out.push(clone(p))
    } else {
      var d = { utc: p.utc }
      for (var k in p) {
        if (k !== 'utc' && p[k] !== prev[k]) { d[k] = p[k] }
      }
      out.push(d)
    }
    prev = p
  }
  return out
}

/**
 * Builds a bulk telemetry post object for the given batch (the queued points to
 * send — delta-encoded for transmission).
 */
function createBulkPost(batch) {
  return {
    data: [
      {
        token: Cfg.token(),
        tlm_list: deltaEncode(batch),
      },
    ],
  }
}

/**
 * Sets the bulk-flush interval in seconds. Called at session start; a raw 0
 * disables the gate (flush on every tick) — used by tests.
 */
function setSendInterval(n) {
  sendInterval = n
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
  var mono = OvmsMetrics.Value('m.monotonic')
  if (mono - lastFlushMono < sendInterval) {
    return // not time to flush yet
  }
  if (Q.getQueue().length === 0) {
    return // nothing to send; leave lastFlushMono unstamped so that once a flush has occurred, later data flushes promptly (the first flush after boot is gated like any other)
  }
  lastFlushMono = mono

  // Snapshot the batch now so the removal count cannot drift if more telemetry
  // is queued while the request is in flight.
  var batch = Q.snapshot(C.MAX_TELEMETRY_QUEUE_SIZE) // the whole queue (capped by MAX_TELEMETRY_QUEUE_SIZE)
  var bulkPost = createBulkPost(batch)
  var body = JSON.stringify(bulkPost)
  var url = Iternio.apiUrl('tlm/bulk')

  Logger.debug('Sending bulk telemetry to ABRP')
  isSending = true
  try {
    HTTP.Request({
      url: url,
      headers: [{ 'Content-Type': 'application/json' }],
      post: body,
      timeout: 8000, // must complete within ticker.10
      done: function (response) {
        isSending = false
        // Bytes crossed the wire regardless of app-level acceptance — count them
        // against the most recent point's phase (driving/charging/idle).
        Bw.record(batch[batch.length - 1], url.length + body.length + C.BW_HTTP_OVERHEAD, (response.body || '').length)
        if (response.statusCode === 200 && Iternio.isApiOk(response.body)) {
          Logger.debug('Bulk telemetry accepted. Removing batch from queue.')
          logTlmList(bulkPost)
          // Remove exactly the sent objects by identity, so an overflow drop that
          // shifted the queue front mid-flight can't discard never-sent points.
          Q.removeTelemetryBatch(batch)
          lastResult = { ok: true, code: response.statusCode, count: batch.length, ts: U.timestamp() }
        } else {
          Logger.warn('ABRP rejected bulk telemetry; keeping batch for retry', response)
          lastResult = { ok: false, code: response.statusCode, count: batch.length, ts: U.timestamp() }
        }
      },
      fail: function (error) {
        isSending = false
        lastResult = { ok: false, error: String(error), count: batch.length, ts: U.timestamp() }
        Logger.error('ABRP error', error)
      },
    })
  } catch (e) {
    isSending = false
    Logger.error('HTTP.Request threw synchronously', e)
  }
}

/**
 * Returns the last bulk-flush result ({ok, code|error, count, ts}) or null if no
 * flush has completed yet. Read-only; used by the web status surface.
 */
function lastSend() {
  return lastResult
}

module.exports = {
  sendTelemetry: sendTelemetry,
  sendBulkTelemetry: sendBulkTelemetry,
  createBulkPost: createBulkPost,
  setSendInterval: setSendInterval,
  lastSend: lastSend,
}
