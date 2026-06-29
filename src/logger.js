'use strict';

/**
 * Tiny structured logger. Avoids pulling in a logging library — three levels
 * are enough for a service this size, and stderr/stdout lines are easy to ship
 * to any aggregator later.
 */

const { config } = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, meta) {
  if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  };
  // Single-line JSON; Cloudflare's logpush / Docker / journald all parse it.
  (level === 'error' ? process.stderr : process.stdout).write(
    JSON.stringify(entry) + '\n',
  );
}

module.exports = {
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
};