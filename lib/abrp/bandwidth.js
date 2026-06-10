// Bandwidth accounting (Tier 1): tallies app-layer request/response bytes per
// phase (driving / charging / idle) plus a request count. RAM-only — resets on
// reboot; read via abrp.info(). The byte figures are an application-layer
// estimate (request line + body + a fixed header allowance); they exclude
// TLS/TCP framing and the per-connection handshake, so they are a floor to
// reconcile against the carrier bill, not the billed total.

function emptyBucket() {
  return { up: 0, down: 0, reqs: 0 }
}

// Module state: per-phase counters. This module is the only one that mutates it.
var stats = {
  driving: emptyBucket(),
  charging: emptyBucket(),
  idle: emptyBucket(),
}

/**
 * Classifies a telemetry point into a bandwidth phase bucket: 'charging' when
 * is_charging, 'driving' when explicitly moving (is_parked === false), else
 * 'idle' (parked heartbeat/bookend, or an unknown/missing-field point).
 */
function classify(point) {
  if (point && point.is_charging) {
    return 'charging'
  }
  if (point && point.is_parked === false) {
    return 'driving'
  }
  return 'idle'
}

/**
 * Records one completed request's bytes against the phase of `point`. `up` and
 * `down` are app-layer byte counts computed by the caller (it owns the URL,
 * body, and response). Call only for requests that received a response — an
 * offline modem sends nothing and consumes no bandwidth.
 */
function record(point, up, down) {
  var b = stats[classify(point)]
  b.up += up
  b.down += down
  b.reqs += 1
}

/**
 * Returns a fresh copy of the per-phase counters plus a computed `total`. Safe
 * to retain: later record() calls do not mutate a returned snapshot.
 */
function snapshot() {
  var out = { total: emptyBucket() }
  var keys = ['driving', 'charging', 'idle']
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]
    out[k] = { up: stats[k].up, down: stats[k].down, reqs: stats[k].reqs }
    out.total.up += stats[k].up
    out.total.down += stats[k].down
    out.total.reqs += stats[k].reqs
  }
  return out
}

/**
 * Zeroes all counters.
 */
function reset() {
  stats.driving = emptyBucket()
  stats.charging = emptyBucket()
  stats.idle = emptyBucket()
}

module.exports = {
  classify: classify,
  record: record,
  snapshot: snapshot,
  reset: reset,
}
