// Event wiring + control flow: PubSub subscriptions, vehicle on/off callbacks,
// GPS-time gating, and the send() on/off switch. Owns subscriptions/isActive/
// time-valid state.
var U = require('./util')
var Cfg = require('./config')
var Met = require('./metrics')
var Q = require('./queue')
var Tlm = require('./telemetry')
var Logger = U.Logger

// Module state owned here.
var subscriptions = {};
var isActive = false;
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
    subscribe('vehicle.type.set', Met.overrideMetricMap);
    subscribe('ticker.10', Tlm.sendBulkTelemetry)
    Tlm.setSendInterval(Cfg.sendInterval());
    subscribe('vehicle.on', callbackVehicleOn);
    subscribe('vehicle.charge.start', callbackVehicleOn);
    subscribe('vehicle.off', callbackVehicleOff);
    subscribe('vehicle.charge.stop', callbackVehicleOff);

    // Edge-triggered vehicle.on / charge.start events have already fired if the
    // module (re)booted mid-session, so check the current LEVEL of both ignition
    // and charging. Without the charging check, a reboot while parked-and-charging
    // would stay idle until the next charge.start edge. (Mirrors the proven truthy
    // v.e.on check; v.c.charging is the same boolean metric is_charging reads.)
    if (OvmsMetrics.Value('v.e.on') || OvmsMetrics.Value('v.c.charging')) {
      // Vehicle is already on or charging
      Logger.debug('Vehicle is ON or charging');
      callbackVehicleOn();
    } else {
      Logger.debug('Vehicle is OFF and not charging');
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
 * Startup wiring: apply vehicle overrides and wait for valid GPS time.
 */
function startup() {
  Met.overrideMetricMap()
  subscribe('ticker.1', checkTime)
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
  startup: startup,
}
