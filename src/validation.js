'use strict';

/**
 * Validates user input against the split-flap display's physical alphabet.
 *
 * The display modules can render:
 *   " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789':?!.-/$@#%"
 * Anything else either shows up as garbage on the device or, worse, lands on
 * an undefined glyph. We reject early at the API boundary so the user gets a
 * clean error instead of confusing display output.
 *
 * Upstream callers (Google OAuth users) are expected to type human-readable
 * strings. We do NOT silently rewrite their input — the firmware renders
 * verbatim per the splitflap-display skill's contract.
 */

const { config } = require('./config');

// The display's physical alphabet. Single source of truth — keep in sync with
// the firmware's character map.
const ALLOWED_CHARS = new Set(
  " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789':?!.-/$@#%".split(''),
);

/**
 * @param {unknown} value
 * @returns {{ ok: true, message: string } | { ok: false, error: string }}
 */
function validateMessage(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'Message must be a string.' };
  }
  // Strip trailing newline (browsers submit it from <input> -> fetch JSON if
  // anyone ever switches to a textarea; harmless for <input>).
  const message = value.replace(/\r?\n$/, '');
  if (message.length === 0) {
    return { ok: false, error: 'Message is empty.' };
  }
  if (message.length > config.maxMessageLength) {
    return {
      ok: false,
      error: `Message is too long (max ${config.maxMessageLength} characters).`,
    };
  }
  for (const ch of message) {
    if (!ALLOWED_CHARS.has(ch)) {
      return {
        ok: false,
        error: `Character "${ch}" is not supported by the display. Allowed: letters, digits, space, and '":?!.-/$@#%`.replace(
          /^./,
          (c) => c.toUpperCase(),
        ),
      };
    }
  }
  return { ok: true, message };
}

module.exports = { validateMessage, ALLOWED_CHARS };