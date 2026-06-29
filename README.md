# split-flap-display-cloud

A small Google-OAuth-gated web app that lets approved users push a short
message to the home split-flap display. Designed to run as a Docker container
**behind Cloudflare Access + Cloudflare Tunnel**, so the home network is never
directly exposed to the public internet.

```
┌──────────┐   HTTPS    ┌───────────────────┐  outbound  ┌───────────────┐
│ Browser  │ ─────────▶ │ Cloudflare edge   │  tunnel    │  This app     │
│ (anyone) │            │ (Google OAuth +   │ ◀────────▶ │  (container)  │
└──────────┘            │  email allow-list)│            └──────┬────────┘
                        └───────────────────┘                   │ outbound
                                                              │ mqtt:1883
                                                              ▼
                                                     ┌────────────────┐
                                                     │ rpi41.local    │
                                                     │ (mosquitto +   │
                                                     │  split-flap)   │
                                                     └────────────────┘
```

## Features

- **Google OAuth sign-in.** Email allow-list enforced server-side after the
  Google callback returns, so Google proves identity and you decide who is
  authorized.
- **Minimal UI.** One text box + Send button, in the same spirit as
  google.com. No frontend build step.
- **Hardened HTTP layer.** Helmet CSP, secure cookies in prod, signed
  cookie-session, per-IP rate limit on send, server-side validation of the
  message against the display's physical character alphabet (uppercase A–Z,
  digits 0–9, and a small set of punctuation — see `src/validation.js`).
  Lowercase letters are rejected at the API boundary because the display
  modules physically cannot render them.
- **Outbound-only MQTT.** The container publishes to the LAN broker; nothing
  listens for inbound connections from the broker.
- **Single Docker image.** Multi-stage build on `node:20-slim`, runs as the
  unprivileged `node` user, dumb-init for clean signals, built-in
  healthcheck.

## Quick start (local dev)

```bash
cp .env.example .env
# Fill in SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS
docker compose up --build
open http://localhost:3000
```

The compose file does **not** publish a host port — to run locally you can
either:

- run `docker compose up --build` and add `ports: ["3000:3000"]` under the
  `app` service for the duration of dev, or
- put a `cloudflared` quick tunnel in front of it (`cloudflared tunnel
  --url http://app:3000`) and use that for OAuth callbacks.

## Production deploy

The intended topology:

1. **Run this container on a host on your home network** (the Pi, a NAS, or
   another small box). It only needs outbound HTTPS (Cloudflare) and outbound
   MQTT (broker).
2. **Install `cloudflared`** on the same host (or as a second container on
   the `sflap` docker network).
3. **Create a Cloudflare Tunnel** that routes a public hostname (e.g.
   `splitflap.example.com`) to `http://app:3000`.
4. **Put the hostname behind Cloudflare Access** with a "Self-hosted"
   application, "Allow" rule requiring emails to match the same allow-list as
   `ALLOWED_EMAILS`. Cloudflare then handles the Google OAuth gate at the
   edge; the app's own OAuth flow is the second line of defense.
5. **Add the OAuth callback URL** (`https://splitflap.example.com/auth/google/callback`)
   to the Authorized redirect URIs of your Google OAuth client at
   https://console.cloud.google.com/apis/credentials.

Why this works:

- The Cloudflare Tunnel only opens outbound connections from your host to
  Cloudflare's edge. Nothing in your router / firewall needs to allow inbound
  HTTPS.
- Cloudflare Access enforces Google OAuth + email allow-list at the edge
  before any request reaches the container. Requests without a valid
  Cloudflare Access JWT never reach the Node process.
- The Node process still validates Google's OAuth itself, so even if a
  Cloudflare Access misconfiguration lets a request through, the in-app check
  rejects it.

Detailed step-by-step for Cloudflare Tunnel + Access is in
[docs/cf-tunnel-access.md](docs/cf-tunnel-access.md).

## Configuration

All configuration is via environment variables. See [.env.example](.env.example)
for the full list. Required:

| Variable | Notes |
|---|---|
| `SESSION_SECRET` | ≥ 32 random bytes, base64. Used to sign the session cookie. |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | Same. |
| `GOOGLE_CALLBACK_URL` | Full URL, e.g. `https://splitflap.example.com/auth/google/callback`. |
| `ALLOWED_EMAILS` | Comma-separated. Lower-cased before comparison. |
| `MQTT_BROKER_URL` | `mqtt://rpi41.local:1883` by default. |
| `MQTT_TOPIC` | `splitflap/splitflap/set` by default. |
| `COOKIE_SECURE` | `true` in prod (HTTPS only). |

## API

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/` | none | – | 200 HTML (sign-in or app) |
| GET | `/auth/google` | none | – | 302 → Google |
| GET | `/auth/google/callback` | none | – | 302 → `/` on success, `/auth/denied` on failure |
| POST | `/auth/logout` | session | – | 302 → `/` |
| GET | `/api/me` | session | – | `{authenticated, email, maxMessageLength}` |
| POST | `/api/send` | session | `{message: "HELLO"}` | `{ok, message}` or `{error}`. Messages are uppercase-only and capped at 64 characters. |

The `POST /api/send` response is JSON with a 200 status on success and 4xx/5xx
on validation or broker errors. The frontend uses the JSON `error` field to
display an inline status message.

## Architecture notes

- **No build step on the front-end.** The HTML/CSS/JS are served as static
  files. Easier to read, easier to lock down with a strict CSP, and one less
  moving part in the container.
- **Sessions via signed cookies.** No Redis / database required. The whole
  session is the signed `sflap.sid` cookie; on each request we deserialize it
  and trust it only after the HMAC check.
- **MQTT is fire-and-forget for the API caller.** A failed publish returns
  HTTP 502 with a generic error; the broker's QoS 1 guarantees the firmware
  sees the message if it ever reconnects in time, but we don't queue.
- **Defense in depth.** Cloudflare Access for the public surface, Google OAuth
  in the app, allow-list at the app, character whitelist at the API boundary,
  rate limit at the API boundary, CSP at the browser. Removing any one of
  these should still keep you safe.

## Files

```
.
├── Dockerfile                   multi-stage build on node:20-slim
├── docker-compose.yml           single-service compose, no host ports published
├── .env.example                 template — copy to .env and fill in
├── docs/
│   └── cf-tunnel-access.md      Cloudflare Tunnel + Access walkthrough
├── public/
│   ├── app.html                 the authenticated UI (input + send)
│   ├── index.html               the unauthenticated landing
│   ├── denied.html              shown when the allow-list rejects the user
│   ├── app.js                   minimal ES2017 front-end
│   └── style.css                google.com-ish minimal styling
├── src/
│   ├── server.js                HTTP entrypoint
│   ├── auth.js                  passport-google-oauth20 wiring
│   ├── config.js                env loading + validation
│   ├── logger.js                tiny structured logger
│   ├── mqtt-client.js           mqtt.js publisher, auto-reconnect
│   └── validation.js            message whitelist + length cap
└── README.md                    this file
```

## License

MIT.