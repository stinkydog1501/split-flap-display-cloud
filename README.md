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

## Quick start (TL;DR)

If you already have Docker and a Google OAuth client:

```bash
git clone https://github.com/stinkydog1501/split-flap-display-cloud.git
cd split-flap-display-cloud
cp .env.example .env
# edit .env (see "Configuration" below)
docker compose up --build
```

Then continue with the [Production deploy](#production-deploy) section to put
a Cloudflare Tunnel + Access in front of the container, or follow
[docs/cf-tunnel-access.md](docs/cf-tunnel-access.md). The compose file does
**not** publish a host port — for local dev either temporarily add
`ports: ["3000:3000"]` to the `app` service, or run a `cloudflared` quick
tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
# Use the printed *.trycloudflare.com URL as PUBLIC_BASE_URL for the OAuth
# callback (and as the OAuth client's Authorized redirect URI).
```

## Building and installing

This section covers the full dependency install + build chain. Pick the path
that matches your environment.

### Path A — Docker (recommended for production and most dev)

You only need two things on the host:

| Tool | Why | Install |
|---|---|---|
| **Docker Engine 20.10+** with the Compose plugin (`docker compose`) | Builds the multi-stage image and runs the container | [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) (Debian/Ubuntu: `sudo apt install docker.io docker-compose-plugin`) |
| **Git** | Clones this repo | `sudo apt install git` |

Optional but very useful for local dev:

- `cloudflared` — for the OAuth callback URL during dev. Install on Debian /
  Ubuntu:

  ```bash
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main' \
    | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt update && sudo apt install cloudflared
  ```

  Other platforms: see [pkg.cloudflare.com](https://pkg.cloudflare.com/).

The Dockerfile itself pulls **everything else** the app needs:

- **Base image**: `node:20-slim` (Debian Bookworm + Node 20 LTS). Pinned via
  the `AS build` and `AS runtime` stages.
- **OS packages**: `dumb-init` (PID 1 / signal forwarding) and
  `ca-certificates` (TLS for the Google OAuth + MQTT endpoints). Installed in
  the runtime stage only.
- **npm dependencies** (production only — see `package.json`):
  - `express` — HTTP framework
  - `passport`, `passport-google-oauth20` — OAuth flow
  - `cookie-session` — signed session cookies (no server-side store)
  - `helmet` — security headers / CSP
  - `express-rate-limit` — per-IP rate limit on `/api/send`
  - `mqtt` — MQTT 3.1.1 client
  - `dotenv` — `.env` loader

  Total: ~136 packages. Locked via `package-lock.json` so `npm ci` is
  reproducible across machines.

Build and run:

```bash
git clone https://github.com/stinkydog1501/split-flap-display-cloud.git
cd split-flap-display-cloud
cp .env.example .env
$EDITOR .env                                # see "Configuration" below
docker compose up -d --build                # build image + start in background
docker compose logs -f app                  # tail startup logs (Ctrl-C to detach)
docker compose ps                           # confirm the container is "running"
curl -s http://127.0.0.1:3000/api/me        # should 401 (no session yet)
```

To rebuild after pulling new commits:

```bash
git pull
docker compose up -d --build
```

To stop and remove the container (image stays):

```bash
docker compose down
```

To nuke the image and force a full rebuild:

```bash
docker compose down --rmi all
docker compose build --no-cache
docker compose up -d
```

### Path B — Run directly with Node (no Docker)

Useful when developing the app itself, debugging the OAuth callback locally,
or running on a host where Docker is unavailable. You trade the isolation of
a container for a faster edit/run loop.

#### Install Node 20+

Use whichever tool fits your OS. Pick one:

```bash
# Debian / Ubuntu (Pi OS included) — NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node@20

# nvm (any Unix-y shell)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
. ~/.nvm/nvm.sh
nvm install 20
nvm use 20
```

Verify:

```bash
node --version    # v20.x or v22.x (Node 20 LTS is the floor; 22 also works)
npm --version     # 10.x
```

#### Install the npm dependencies

```bash
git clone https://github.com/stinkydog1501/split-flap-display-cloud.git
cd split-flap-display-cloud
npm ci                # if package-lock.json is committed
# or
npm install           # if you only have package.json
```

`npm ci` is preferred because it installs exactly the locked tree and fails
fast if `package-lock.json` is out of sync with `package.json`. Use plain
`npm install` only when you've intentionally edited `package.json` and want
to regenerate the lockfile (then commit the new lockfile).

#### Configure and run

```bash
cp .env.example .env
$EDITOR .env           # fill in SESSION_SECRET, GOOGLE_CLIENT_ID, etc.
npm start              # node src/server.js — same binary as in the container
```

For active development with auto-reload:

```bash
npm run dev            # node --watch src/server.js — restarts on file change
```

`--watch` ships in Node 18.11+, no `nodemon` needed.

#### Optional: set up a venv-style local node_modules prefix

If you don't want a global install on the host and don't want Docker, the
project already installs into a local `node_modules/` (gitignored). Nothing
extra to do — `npm ci` creates it on first run.

### Verifying the build

After either path, confirm the app responds:

```bash
curl -i http://127.0.0.1:3000/
# HTTP/1.1 200 OK
# Content-Type: text/html; charset=UTF-8
# Content-Security-Policy: default-src 'self'; ...
```

A 200 with the Helmet-set CSP header means Express is up, the static files
are being served, and Helmet is wired. A 401 from `/api/me` means session
middleware is working. A 302 from `POST /api/send` to `/auth/google` means
the auth gate is wired.

For a quick syntax-only check (no install):

```bash
node --check src/server.js
node --check src/auth.js
node --check src/mqtt-client.js
node --check src/config.js
node --check src/validation.js
node --check src/logger.js
```

For a Docker-side smoke test:

```bash
docker compose run --rm app node --check src/server.js
```

### What you do NOT need to install

- **No system-level MQTT broker on the host.** The app is an MQTT *client*;
  it only publishes. The broker stays on the LAN at `rpi41.local:1883`
  (configurable via `MQTT_BROKER_URL`).
- **No database, Redis, or external cache.** Sessions are signed cookies
  stored client-side.
- **No nginx / reverse proxy on the host.** Cloudflare Tunnel terminates TLS
  and proxies directly into the container on the docker network.
- **No build step for the frontend.** Plain HTML/CSS/JS; the container
  serves them as static files.

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