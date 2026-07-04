// Event wiring + control flow: PubSub subscriptions, vehicle on/off callbacks,
// GPS-time gating, and the send() on/off switch. Owns subscriptions/isActive/
// time-valid state.
var U = require('./util')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
var Tlm = require('./telemetry')
var Certs = require('./certs')
var Logger = U.Logger

// Module state owned here.
var subscriptions = {};
var isActive = false;
var isSampling = false;
var _isTimeValid = false;

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

/**
 * Handles the event when the vehicle is switched on.
 * Logs an informational message and sends an initial telemetry update to the queue.
 * Subscribes to the 'ticker.1' event to queue telemetry if necessary.
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOn() {
  Logger.info('Vehicle switched on...');
  isSampling = true;
  Q.setSampleInterval(Cfg.sampleInterval());
  Q.enqueue(Q.roundTelemetry(Met.createTelemetry()));   // full bookend, rounded
  subscribe('ticker.1', Q.sample);
}

/**
 * Handles vehicle off / charge stop. Unsubscribes the per-second sampler and
 * enqueues a final full bookend forced to a coherent parked state (speed/power 0,
 * is_parked true, is_charging/is_dcfc false).
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOff() {
  Logger.info('Vehicle switched off...');
  isSampling = false;
  unsubscribe('ticker.1');
  var snap = Q.roundTelemetry(Met.createTelemetry());
  snap.speed = 0;
  snap.power = 0;
  snap.is_parked = true;
  snap.is_charging = false;
  snap.is_dcfc = false;
  Q.enqueue(snap);                                       // forced parked bookend
}

/**
 * Whether a telemetry session should be live, as a LEVEL: the vehicle is on
 * (driving) or charging. The four session events (vehicle.on/off,
 * charge.start/stop) are edges of these two independent states, so no single
 * edge can decide on its own — e.g. a charge.stop while the driver has already
 * powered up must NOT end the session.
 */
function isVehicleActive() {
  return Boolean(OvmsMetrics.Value('v.e.on')) || Boolean(OvmsMetrics.Value('v.c.charging'));
}

/**
 * Single handler for all four session events (and the cold-boot check): re-reads
 * the level and starts/stops the sampler only on an actual session transition.
 * isSampling makes overlapping edges idempotent — on + charging subscribes the
 * per-second sampler exactly once, and a charge.stop while still driving is a
 * no-op instead of killing the sampler mid-drive.
 */
function updateSamplingState() {
  var shouldSample = isVehicleActive();
  if (shouldSample && !isSampling) {
    callbackVehicleOn();
  } else if (!shouldSample && isSampling) {
    callbackVehicleOff();
  }
}

/**
 * Manages subscribing or unsubscribing to vehicle state events based on the provided parameter.
 *
 * If subscribing, it registers the level-based session handler for the four
 * vehicle state events and applies the current level (covering a (re)boot
 * mid-session, when the on/charge.start edges have already fired). If
 * unsubscribing, it removes all subscriptions it created and ends any live session.
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
    subscribe('vehicle.type.set', Met.overrideMetricMap);
    subscribe('ticker.10', Tlm.sendBulkTelemetry)
    Tlm.setSendInterval(Cfg.sendInterval());
    subscribe('vehicle.on', updateSamplingState);
    subscribe('vehicle.charge.start', updateSamplingState);
    subscribe('vehicle.off', updateSamplingState);
    subscribe('vehicle.charge.stop', updateSamplingState);

    updateSamplingState();

  } else {
    unsubscribe('vehicle.on');
    unsubscribe('vehicle.charge.start');
    unsubscribe('vehicle.off');
    unsubscribe('vehicle.charge.stop');
    // Symmetric teardown: without these, every send(0)/send(1) cycle stacked an
    // extra ticker.10 / vehicle.type.set subscription.
    unsubscribe('vehicle.type.set');
    unsubscribe('ticker.10');
    if (isSampling) {
      callbackVehicleOff();
    }
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
    _isTimeValid = true;  // Mark the time as valid
    Logger.debug('GPS time is valid, unsubscribing from ticker.1');

    // Unsubscribe from the ticker.1 event once the time is valid
    unsubscribe('ticker.1');

    // Proceed with startup
    send(true);
  } else {
    Logger.debug('Invalid GPS time, skipping telemetry processing.');
  }
}

/**
 * Controls the sending of data based on the provided `shouldSend` flag.
 * @param {boolean} shouldSend - Indicates whether to start or stop sending data.
 */
function send(shouldSend) {
  // Check if config is valid
  if (!Cfg.validate()) return;

  // Check if time is valid
  if (!_isTimeValid) {
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
 * Whether GPS time has become valid (gates all sending).
 */
function isTimeValid() {
  return _isTimeValid
}

/**
 * Whether the plugin is actively wired to vehicle events / sending.
 */
function active() {
  return isActive
}

/**
 * Re-reads the cadence config keys and applies them, so a `config set` of
 * usr abrp.sample_interval / send_interval takes effect on the next tick
 * (no session restart). Fired on OVMS `config.changed`, which carries no key,
 * so both are re-read unconditionally.
 */
function applyIntervals() {
  Q.setSampleInterval(Cfg.sampleInterval());
  Tlm.setSendInterval(Cfg.sendInterval());
}

/**
 * Startup wiring: apply vehicle overrides and wait for valid GPS time.
 */
function startup() {
  Met.overrideMetricMap()
  Certs.bootstrap()
  subscribe('ticker.1', checkTime)
  subscribe('config.changed', applyIntervals)
}

module.exports = {
  subscribe: subscribe,
  unsubscribe: unsubscribe,
  send: send,
  checkTime: checkTime,
  manageVehicleStateEvents: manageVehicleStateEvents,
  callbackVehicleOn: callbackVehicleOn,
  callbackVehicleOff: callbackVehicleOff,
  isTimeValid: isTimeValid,
  isActive: active,
  startup: startup,
  applyIntervals: applyIntervals,
}
