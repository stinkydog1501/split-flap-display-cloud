# Security notes

A short checklist of the security guarantees this app makes and the threats
it is NOT designed to defend against.

## What this app defends against

- **Anonymous senders.** Cloudflare Access requires a Google OAuth sign-in
  before any request reaches the container. The container's own OAuth
  requires a second Google sign-in if Access is bypassed. Both reject users
  not on the allow-list.
- **CSRF on the send endpoint.** Same-site=Lax cookies mean cross-site
  forms cannot trigger a send. The Origin header is also implicitly trusted
  via cookie scoping.
- **XSS via the message field.** The message is rendered only as plain text
  on the display. The HTML response that includes the previous message does
  not interpolate it into the DOM (it sets `textContent`).
- **Long messages / DoS via the API.** Server-side cap at `MAX_MESSAGE_LENGTH`
  characters. `express.json({ limit: '8kb' })` caps the request body. Rate
  limit at 10 sends per minute per IP. Helmet locks down CSP, framing, and
  content sniffing.
- **Network exposure.** The container has no host ports published; the only
  way traffic reaches it is over the docker network, which in production
  means via Cloudflare Tunnel. No port forwarding on the home router.
- **Cookie tampering.** Sessions are signed with HMAC-SHA256 using
  `SESSION_SECRET`. Tampered cookies are rejected.
- **Open redirects.** OAuth callbacks only redirect to fixed paths inside
  this app (`/` on success, `/auth/denied` on failure). No user-controlled
  redirect targets.
- **MQTT credential leakage.** The credentials (if any) are passed via env
  var, never logged. The structured logger logs topic name and message length
  but never the message body.

## What this app does NOT defend against

- **Compromised Cloudflare account.** If your Cloudflare account is taken
  over, the attacker can edit the Access policy and let themselves in. Use
  a hardware security key (e.g. YubiKey) as your second factor on the
  Cloudflare login.
- **Compromised Google account.** The allow-list is by email. If someone
  with an allow-listed email has their Google account hijacked, they can
  send messages. Enable Google's own 2FA / passkeys on every allow-listed
  account.
- **MQTT broker compromise.** This app publishes; it does not control the
  broker. If the broker is compromised, an attacker can spoof display
  messages. Keep the broker on a trusted LAN host with mosquitto's own auth
  and ACLs.
- **Out-of-band access to the home network.** The Cloudflare Tunnel assumes
  your LAN is otherwise unreachable from the internet. If the user has
  forwarded other ports (RDP, SSH, etc.) on the home router, this app does
  not protect those services.
- **Browser-side keyloggers.** We do not (and cannot) protect a user's
  client machine.

## Reporting vulnerabilities

If you find a bug in this stack, open an issue or a private security
advisory on the GitHub repository.