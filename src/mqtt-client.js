'use strict';

/**
 * MQTT publisher for the split-flap display.
 *
 * We keep a single long-lived MQTT connection inside the process and publish
 * each user message to the configured topic. The display firmware subscribes
 * to `splitflap/{mdns}/set` (see SplitFlapDisplay::writeString in the firmware
 * repo) and renders the payload verbatim. Long messages are chunked on-device
 * with word-aligned windows and a 1500ms dwell between frames.
 *
 * Design notes
 * ------------
 * - The container talks outbound only — no listener port. Combined with the
 *   Cloudflare Tunnel front door, the home network stays unexposed.
 * - Auto-reconnect with exponential back-off is provided by the mqtt.js
 *   client itself; we just log transitions.
 * - We never queue messages while disconnected. If the broker is down we
 *   surface the error to the API caller; queueing would silently swallow
 *   out-of-order sends and confuse users.
 */

const mqtt = require('mqtt');
const { config } = require('./config');
const log = require('./logger');

let client = null;
let connected = false;

function connect() {
  if (client) return client;

  const opts = {
    clientId: config.mqtt.clientId,
    reconnectPeriod: 5_000, // ms between reconnect attempts
    connectTimeout: 10_000, // give up on the first try after 10s
    clean: true,
    protocolVersion: 4, // MQTT 3.1.1 — the broker is mosquitto on the Pi
  };
  if (config.mqtt.username) {
    opts.username = config.mqtt.username;
    opts.password = config.mqtt.password;
  }

  log.info('mqtt.connect', {
    broker: config.mqtt.brokerUrl,
    topic: config.mqtt.topic,
    clientId: config.mqtt.clientId,
  });

  client = mqtt.connect(config.mqtt.brokerUrl, opts);

  client.on('connect', () => {
    connected = true;
    log.info('mqtt.connected');
  });

  client.on('reconnect', () => {
    log.warn('mqtt.reconnect');
  });

  client.on('close', () => {
    if (connected) log.warn('mqtt.close');
    connected = false;
  });

  client.on('offline', () => {
    if (connected) log.warn('mqtt.offline');
    connected = false;
  });

  client.on('error', (err) => {
    // mqtt.js will try to reconnect after errors; just log.
    log.error('mqtt.error', { message: err.message, code: err.code });
  });

  return client;
}

/**
 * Publish a message to the configured topic.
 *
 * Resolves with nothing on success, rejects with an Error on failure. The
 * caller should treat the rejection as a 502 to the HTTP layer.
 *
 * @param {string} message — already validated against the display alphabet.
 * @param {string} userEmail — for logging only.
 * @returns {Promise<void>}
 */
function publish(message, userEmail) {
  const c = connect();
  return new Promise((resolve, reject) => {
    // If we're not currently connected, fail fast rather than queue.
    if (!connected) {
      // Give it one short tick in case the connection just landed.
      c.once('connect', () => doPublish(c, message, userEmail, resolve, reject));
      // Safety timeout — if we never connect, fail rather than hanging.
      setTimeout(() => {
        if (!connected) {
          reject(new Error('MQTT broker not reachable'));
        }
      }, 3_000);
      return;
    }
    doPublish(c, message, userEmail, resolve, reject);
  });
}

function doPublish(c, message, userEmail, resolve, reject) {
  // QoS 1: at-least-once delivery. Retain=false: the display only cares about
  // new messages; retaining the last-pushed string would cause the firmware to
  // re-render it on every reconnect, which we don't want.
  c.publish(
    config.mqtt.topic,
    message,
    { qos: 1, retain: false },
    (err) => {
      if (err) {
        log.error('mqtt.publish.failed', {
          user: userEmail,
          message: message.slice(0, 32),
          error: err.message,
        });
        reject(err);
        return;
      }
      log.info('mqtt.publish.ok', {
        user: userEmail,
        topic: config.mqtt.topic,
        length: message.length,
      });
      resolve();
    },
  );
}

function disconnect() {
  if (!client) return;
  try {
    client.end(true);
  } catch (_) {
    /* ignore */
  }
  client = null;
  connected = false;
}

module.exports = { connect, publish, disconnect };