'use strict';

/**
 * Passport configuration for Google OAuth 2.0.
 *
 * Flow
 * ----
 * 1. User hits GET /auth/google → redirected to Google's consent screen.
 * 2. Google calls back to /auth/google/callback with an authorization code.
 * 3. Passport exchanges the code, fetches the user's profile, and runs our
 *    verify callback.
 * 4. We enforce the email allow-list HERE, not at the /auth/google step. That
 *    way Google handles the credential check (proof of identity), and we
 *    handle the authorization check (is this person on the list?). Failing
 *    authorization is a 403, not a redirect-to-Google-again loop.
 * 5. On success we stash user.email and user.displayName on req.session and
 *    redirect to the app's main page.
 */

const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { config } = require('./config');
const log = require('./logger');

function configure() {
  passport.serializeUser((user, done) => {
    // The whole user fits in the session cookie — keep it tiny.
    done(null, { email: user.email, name: user.name });
  });

  passport.deserializeUser((user, done) => {
    done(null, user);
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
        scope: ['openid', 'email', 'profile'],
      },
      (accessToken, refreshToken, profile, done) => {
        // Google has already verified the email. We just check the allow-list.
        const email =
          (profile.emails && profile.emails[0] && profile.emails[0].value) ||
          null;
        if (!email) {
          log.warn('auth.no_email', { googleId: profile.id });
          return done(null, false, {
            message: 'Google account has no email — cannot authorize.',
          });
        }
        const lower = email.toLowerCase();
        if (!config.allowedEmails.includes(lower)) {
          log.warn('auth.not_allowed', { email: lower });
          return done(null, false, {
            message: `Access denied. ${email} is not on the allow-list.`,
          });
        }
        log.info('auth.allowed', { email: lower });
        return done(null, { email: lower, name: profile.displayName || lower });
      },
    ),
  );
}

module.exports = { configure, passport };