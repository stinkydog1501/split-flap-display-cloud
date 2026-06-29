'use strict';

/**
 * Application configuration loaded from environment variables.
 *
 * Everything that affects runtime behaviour MUST be set via env so the same
 * container image can run unchanged in dev and behind Cloudflare in prod.
 */

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name}=${v} is not a valid integer`);
  }
  return n;
}

const PUBLIC_BASE_URL = str('PUBLIC_BASE_URL', '');
const GOOGLE_CALLBACK_URL = str('GOOGLE_CALLBACK_URL', '');

const config = {
  port: int('PORT', 3000),
  nodeEnv: str('NODE_ENV', 'development'),
  sessionSecret: str('SESSION_SECRET', ''),
  cookieSecure: bool('COOKIE_SECURE', false),

  google: {
    clientId: str('GOOGLE_CLIENT_ID', ''),
    clientSecret: str('GOOGLE_CLIENT_SECRET', ''),
    callbackUrl:
      GOOGLE_CALLBACK_URL ||
      (PUBLIC_BASE_URL
        ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/google/callback`
        : ''),
  },

  // Comma-separated list of allowed Google account emails, lower-cased for matching.
  // Empty list = nobody allowed (safe default — fail closed).
  allowedEmails: str('ALLOWED_EMAILS', '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  mqtt: {
    brokerUrl: str('MQTT_BROKER_URL', 'mqtt://rpi41.local:1883'),
    topic: str('MQTT_TOPIC', 'splitflap/splitflap/set'),
    username: str('MQTT_USERNAME', ''),
    password: str('MQTT_PASSWORD', ''),
    clientId: str('MQTT_CLIENT_ID', 'splitflap-display-cloud'),
  },

  maxMessageLength: int('MAX_MESSAGE_LENGTH', 64),
  logLevel: str('LOG_LEVEL', 'info'),
};

function validate() {
  const missing = [];
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.google.callbackUrl) {
    missing.push('GOOGLE_CALLBACK_URL (or PUBLIC_BASE_URL)');
  }
  if (config.allowedEmails.length === 0) {
    // We don't make this fatal — dev may want to log in before populating the list —
    // but log a loud warning. The check happens at request time too.
    // eslint-disable-next-line no-console
    console.warn(
      '[config] ALLOWED_EMAILS is empty — no one will be able to sign in.',
    );
  }
  if (missing.length) {
    throw new Error(
      `[config] Missing required env vars: ${missing.join(', ')}. ` +
        `Copy .env.example to .env and fill them in.`,
    );
  }
}

module.exports = { config, validate };