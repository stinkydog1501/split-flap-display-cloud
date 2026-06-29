'use strict';

/**
 * HTTP entrypoint.
 *
 * Responsibilities:
 *   - Serve a single HTML page at GET /         (the input box)
 *   - Serve a tiny static asset set             (CSS + JS)
 *   - Provide the Google OAuth dance            (/auth/google, /auth/google/callback)
 *   - Provide the authenticated send endpoint   (POST /api/send)
 *   - Provide a logout endpoint                 (POST /auth/logout)
 *   - Provide a session probe                   (GET /api/me)
 *
 * Security posture:
 *   - Helmet sets a strict CSP, X-Frame-Options DENY, no-sniff, etc.
 *   - Sessions are cookie-based (cookie-session) — no server-side store needed.
 *   - Cookies are Secure whenever COOKIE_SECURE=true (i.e. in prod).
 *   - Rate limit on /api/send is per-IP; Cloudflare's edge already rate-limits
 *     at the network layer but we add a cheap in-process guard so a single
 *     authenticated session can't flood the broker.
 */

const express = require('express');
const helmet = require('helmet');
const cookieSession = require('cookie-session');
const { rateLimit } = require('express-rate-limit');
const path = require('node:path');

const { config, validate } = require('./config');
const log = require('./logger');
const { configure: configurePassport, passport } = require('./auth');
const mqttClient = require('./mqtt-client');
const { validateMessage } = require('./validation');

function requireAuth(req, res, next) {
  if (req.session && req.session.user && req.session.user.email) {
    return next();
  }
  // For HTML requests, redirect to login. For JSON requests, return 401.
  if (req.accepts(['html', 'json']) === 'html') {
    return res.redirect('/auth/google');
  }
  return res.status(401).json({ error: 'Not signed in.' });
}

function createApp() {
  validate();

  const app = express();
  app.set('trust proxy', 1); // honour X-Forwarded-* from Cloudflare Tunnel

  // Helmet — strict CSP that allows only same-origin assets + Google's OAuth
  // endpoints. Inline styles/scripts are disabled in the frontend by design.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          // Allow Google's OAuth endpoints for the auth redirect. After login,
          // the browser is back on our origin so this is purely the bootstrap.
          formAction: ["'self'", 'https://accounts.google.com'],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: config.cookieSecure ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(express.json({ limit: '8kb' }));

  app.use(
    cookieSession({
      name: 'sflap.sid',
      keys: [config.sessionSecret],
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: config.cookieSecure, // requires HTTPS in prod
      httpOnly: true,
      sameSite: 'lax', // needed for the OAuth callback redirect
      signed: true,
    }),
  );

  configurePassport();
  app.use(passport.initialize());
  // passport.session() reads/writes req.session.user via our serialize/deserialize.
  app.use(passport.session());

  // ------------------------------------------------------------------ pages

  app.get('/', (req, res) => {
    if (req.session && req.session.user) {
      return res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
    }
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
    index: false,
    immutable: true,
    maxAge: '1h',
  }));

  // ------------------------------------------------------------------ auth

  app.get(
    '/auth/google',
    passport.authenticate('google', {
      scope: ['openid', 'email', 'profile'],
      prompt: 'select_account',
    }),
  );

  app.get(
    '/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/auth/denied' }),
    (req, res) => {
      // Stash a copy on the cookie-session payload. passport.session() will
      // already have deserialized req.user into req.session.passport.user —
      // surface it at req.session.user for the rest of the code.
      req.session.user = req.user;
      res.redirect('/');
    },
  );

  app.get('/auth/denied', (req, res) => {
    res.status(403).sendFile(path.join(__dirname, '..', 'public', 'denied.html'));
  });

  app.post('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session = null;
      res.redirect('/');
    });
  });

  // ------------------------------------------------------------------ api

  app.get('/api/me', (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ authenticated: false });
    }
    return res.json({
      authenticated: true,
      email: req.session.user.email,
      name: req.session.user.name,
      maxMessageLength: config.maxMessageLength,
    });
  });

  const sendLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10, // 10 messages per minute per IP — well above any human's typing speed
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests. Slow down.' },
  });

  app.post('/api/send', requireAuth, sendLimiter, async (req, res) => {
    const { message } = req.body || {};
    const result = validateMessage(message);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    try {
      await mqttClient.publish(result.message, req.session.user.email);
      return res.json({ ok: true, message: result.message });
    } catch (err) {
      log.error('api.send.failed', { error: err.message });
      return res
        .status(502)
        .json({ error: 'Could not reach the display. Try again.' });
    }
  });

  // ------------------------------------------------------------------ misc

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error('unhandled', { error: err.message, stack: err.stack });
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

function start() {
  const app = createApp();

  // Kick off the MQTT connection early so the first /api/send doesn't pay the
  // TCP+MQTT handshake cost. Failures are non-fatal — the API still works and
  // publish() will surface a clean error.
  try {
    mqttClient.connect();
  } catch (err) {
    log.error('mqtt.initial_connect_failed', { error: err.message });
  }

  const server = app.listen(config.port, () => {
    log.info('http.listening', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (signal) => {
    log.info('shutdown', { signal });
    mqttClient.disconnect();
    server.close(() => process.exit(0));
    // Hard exit if close hangs.
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = { createApp };