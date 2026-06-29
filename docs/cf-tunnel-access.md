# Cloudflare Tunnel + Access setup

This is the production deployment story for `split-flap-display-cloud`. The
goal is to let the public internet hit the app without ever touching your
home network's inbound firewall.

The plan:

1. Put a hostname in front of the app via Cloudflare Tunnel.
2. Put Cloudflare Access in front of that hostname with Google OAuth + an
   email allow-list.
3. The container on the home network only talks outbound.

## Prerequisites

- A domain on Cloudflare (free tier is fine). Add the site, let Cloudflare
  manage its DNS.
- A Google Cloud project so you can create OAuth credentials. You only need
  the Client ID and Client Secret — the actual OAuth dance happens at
  Cloudflare Access (one OAuth client for all your users, instead of one per
  deployment).
- `cloudflared` installed on the host running this Docker compose stack.
  Easiest: `sudo apt install cloudflared` on Debian/Ubuntu, or
  `brew install cloudflared` on macOS.
- This Docker compose stack running on the host. The container name is
  `split-flap-display-cloud` and it listens on `:3000` inside the docker
  network (no host port published).

## 1. Create a Cloudflare Tunnel

From the host:

```bash
cloudflared tunnel login
# Opens a browser, pick your Cloudflare account, authorize the cert.
cloudflared tunnel create splitflap
# Writes ~/.cloudflared/<UUID>.json and prints the Tunnel ID.
```

Add the DNS route. In Cloudflare's dashboard, or via `cloudflared`:

```bash
cloudflared tunnel route dns splitflap splitflap.example.com
# Creates a CNAME splitflap.example.com -> <UUID>.cfargotunnel.com
```

Define what the tunnel serves by writing `~/.cloudflared/config.yml`:

```yaml
tunnel: splitflap
credentials-file: /home/pi/.cloudflared/<UUID>.json

ingress:
  - hostname: splitflap.example.com
    service: http://split-flap-display-cloud:3000
  # catch-all required by cloudflared
  - service: http_status:404
```

`split-flap-display-cloud` is the docker compose service name and resolves on
the default docker network. If you ran the container with a different name,
adjust.

Run the tunnel:

```bash
cloudflared tunnel run splitflap
```

For boot-time persistence, install it as a systemd user unit (similar to the
split-flap daemon) or use the official `cloudflared service install` flow,
which registers a system-wide systemd service.

Verify from outside your network:

```bash
curl -I https://splitflap.example.com
# Should return 302 to /auth/google (Cloudflare Access) or 200 if Access is
# not yet wired up.
```

## 2. Enable Cloudflare Access

In the Cloudflare Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted.**
2. **Name:** anything, e.g. "Split-Flap Display".
3. **Domain:** `splitflap.example.com`.
4. **Identity providers:** add Google (one-time setup: Access → Settings →
   Authentication → Add new → Google → use your OAuth Client ID / Secret).
5. **Application policies:** add an Allow rule:
   - **Name:** "Approved senders"
   - **Action:** Allow
   - **Include → Emails:** one per allowed user, or a comma-separated list.
     Cloudflare matches exact emails, so the list should match
     `ALLOWED_EMAILS` in `.env`.
   - **Session duration:** 24 hours is plenty for a personal app.
6. Save. The Access JWT cookie (`CF_Authorization`) is now required on every
   request to `splitflap.example.com`.

You can also configure this with `cloudflared access` or the API, but the
dashboard is fine for one application.

Now every public request to `splitflap.example.com` is intercepted by
Cloudflare Access, which:

1. Sees no `CF_Authorization` cookie.
2. Redirects the browser to Google's OAuth consent screen.
3. On success, sets a signed JWT in the cookie and redirects back to your
   app.
4. The request then reaches the tunnel, hits the container, and (because the
   tunnel already authenticated the user) the container's own OAuth flow is
   bypassed — the user is already signed in by the time the container sees
   the request.

## 3. Two layers of auth, two purposes

This stack has **two** Google OAuth gates on purpose:

- **Cloudflare Access** authenticates the user before the request ever
  reaches your network. Without it, anyone could pound on the container and
  fill the broker with junk.
- **The container's own OAuth** is the second line of defense. If you ever
  want to bypass Cloudflare Access (e.g. for a quick local test on
  `http://localhost:3000`), the app still requires a valid Google sign-in
  before it will publish to MQTT.

If you want to skip the in-app OAuth and trust Cloudflare Access completely,
set the `ALLOWED_EMAILS` env var to the same list and let the container just
trust the Access JWT. That is a future enhancement — for now the double gate
is the safer default.

## 4. Adding and removing allowed users

Two places to update when adding or removing a user:

1. Cloudflare Access policy: Add/remove the email under
   `splitflap.example.com → Policies → Approved senders`.
2. `ALLOWED_EMAILS` in the host's `.env` file. After editing,
   `docker compose up -d` to restart the container.

Keeping both lists in sync is the operator's job. If you only update one, the
user gets partial access (Cloudflare lets them in, app rejects; or app lets
them in, Cloudflare blocks — neither is a security incident, just friction).

## 5. Verifying the deployment end-to-end

From a phone or a non-home network:

1. Visit `https://splitflap.example.com`. Cloudflare Access redirects you to
   Google's consent screen.
2. Sign in with an allow-listed Google account. You should land back on the
   app, see the input box and "Send" button.
3. Type `HELLO` (or anything up to 64 chars in the display alphabet) and
   click Send. Within ~1 second the split-flap should flip to your message.
4. Type a character the display can't render (e.g. `é`). The app rejects
   it with a clear error and never publishes.
5. Visit `/auth/logout` (or click Sign out) and verify the next request
   redirects you back to Google.

## 6. Logging and observability

The container writes structured JSON to stdout. View recent logs with:

```bash
docker compose logs -f --tail 100 app
```

In Cloudflare:

- **Zero Trust → Logs → Access** shows every authentication decision.
- **Cloudflare Tunnel → Logs** shows every tunneled request and any 5xx from
  the upstream (your container).

If the split-flap doesn't update, check in this order:

1. `docker compose logs app | grep mqtt` — did the publish land?
2. `docker compose logs app | grep mqtt.error` — broker unreachable?
3. On the Pi running the broker, `sudo journalctl -u mosquitto -n 50` —
   is the broker up?
4. `getent hosts rpi41.local` from inside the container
   (`docker compose exec app getent hosts rpi41.local`) — does mDNS
   resolve inside the docker network? If not, replace `rpi41.local` with
   the broker's IP in `MQTT_BROKER_URL`.

## 7. Hardening checklist

Before going to production:

- [ ] `COOKIE_SECURE=true` (default in `.env.example` is `false`; flip it
      when serving over HTTPS)
- [ ] `SESSION_SECRET` is a real random 32+ byte secret, not the placeholder
- [ ] `ALLOWED_EMAILS` is populated (the app logs a warning if it isn't)
- [ ] Cloudflare Access is enforcing an Allow rule (not "Bypass")
- [ ] Cloudflare Tunnel is registered as a systemd service that restarts on
      boot
- [ ] The docker compose stack is `restart: unless-stopped` (already set)
- [ ] You have a Cloudflare Tunnel route for the host so your browser's
      requests don't bypass Access (this is enforced by Access, not the
      tunnel, but it's worth double-checking)
- [ ] The Google OAuth consent screen has your branding and a privacy
      policy URL (Google requires this before you can use the OAuth client
      with anyone other than yourself)