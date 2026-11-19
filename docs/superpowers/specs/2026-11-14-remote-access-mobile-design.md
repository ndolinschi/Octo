# Remote access and the mobile client — design

**Date:** 2026-11-14 · **Status:** approved to build, phase 1 (owner, translated: "Make a mobile client. It will connect
to the remote app: on the PC you just switch on a 'Remote access' button and the port is opened through Cloudflare.")
**Background:** `HANDOVER.md`, "Later — Octo on iOS": iOS cannot start the harness, the agent CLIs or `bash`, so the
phone is a *client* of the harness on the owner's computer. A native build is later; the phone's client is the same UI.
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md) (bridge API),
[`2026-11-11-packaging-design.md`](./2026-11-11-packaging-design.md) (settings, sidecars, `harness.env`),
[`2026-11-10-v7-changes-queue-approvals.md`](./2026-11-10-v7-changes-queue-approvals.md) (approvals, forms),
[`2026-11-14-parallel-sessions-design.md`](./2026-11-14-parallel-sessions-design.md) (sessions the phone reads).

Marks: **(chosen by the spec)** is a choice the owner did not make, with its reason. **(verified)** / **(not verified
against the docs)** say whether a fact about Cloudflare was checked against its public documentation on 2026-11-14.

## 1. Threat model, in plain words

The harness runs commands and edits files on the owner's computer as the owner. Anyone who can drive its API can, in
a `full`-access project, make an agent run any shell command. A door to it from the internet must therefore be:
**closed by default**, **opened only by an explicit act on the computer**, **visible while open**, and **safe when the
address leaks** (it will: it is a URL in a browser history, a screenshot, a chat).

| Who | What they can do | Why not more |
| --- | --- | --- |
| Someone with only the URL | Load the web app's static files and a pairing page; try pairing codes at most 1 per second, 5 wrong tries burn the current code | Every API route needs a device token; the local desktop token is not accepted on the tunnel listener at all |
| Someone with the URL and a valid, *unexpired* pairing code | Claim a device, which stays **pending**: it can do nothing until the owner clicks "Allow" on the computer | Confirmation on the computer (chosen by the spec: a phished code alone is worthless) |
| Someone with a stolen **device token** (the phone's browser storage) | What that device may do (section 6): read projects and files, send messages, answer approvals and forms, stop turns — until it is revoked or expires | Revoke on the computer (one device, or "Revoke all and turn off"); tokens die after 30 days without use; turning remote access off closes the door for every token |
| Cloudflare | Sees all traffic in clear text: the tunnel terminates TLS at Cloudflare's edge, then re-encrypts to `cloudflared` | Inherent to Cloudflare Tunnel; stated in the UI's explanation. A self-hosted transport (Tailscale, WireGuard) is the answer for owners who do not accept it (open question 2) |
| A process on the computer | Unchanged from today (it can read the data folder as the same user) | Out of scope, as in `HANDOVER.md` "Security" |

Everything that arrives through the tunnel comes from `127.0.0.1` (from `cloudflared`), so **no loopback check counts on
the tunnel listener**: the MCP routes (loopback-only, per-session tokens), the settings write guard and the folder
dialog would all believe a remote caller is local. The tunnel listener therefore never mounts MCP and refuses those
routes by an allow-list, not by checking the peer.

## 2. Transport: Cloudflare Tunnel run by `cloudflared`

**v1 = a quick tunnel.** `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<remote port>`. Facts:

- No account, no domain, the visitor needs no account; the hostname is a random `https://<words>.trycloudflare.com`,
  new on every start; the URL stops working when the process stops. **(verified)**
- No uptime guarantee; "for testing and development"; **200 in-flight requests**, beyond that `429`. **(verified)**
- **Quick tunnels do not support Server-Sent Events.** **(verified)** The harness's event stream is SSE, so the tunnel
  listener adds a long-poll event route (section 4) and the web client always uses it (chosen by the spec: one transport
  for quick and named tunnels; a named tunnel may later use SSE).
- `--allowed-mail <address>` puts Cloudflare's e-mail one-time-PIN in front of a quick tunnel, interactive browsers only.
  **(verified)** Not used in v1 (open question 3); it would be a second lock, not a replacement for pairing.
- The URL is printed in a box on standard error, one line `|  https://<words>.trycloudflare.com  |`; later
  "Registered tunnel connection" lines say the edge accepted it. `--no-autoupdate` stops the binary replacing itself;
  `--metrics` binds a local metrics server (not used). **(not verified against the docs)** — the harness takes the first
  `https://<label>.trycloudflare.com` it sees on stdout or stderr, anywhere in a line, and ignores everything else.
- Cloudflare's proxy ends a request that sends nothing for about 100 s **(not verified against the docs)**: long polls
  wait at most 25 s.

**Later = a named tunnel** on the owner's own domain: the owner runs `cloudflared tunnel login` and `cloudflared tunnel
create octo` themselves; the harness only runs `cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:<port>
<name>`. Settings designed, not built: `HARNESS_REMOTE_TUNNEL=quick|named` (default `quick`),
`HARNESS_REMOTE_TUNNEL_NAME`, `HARNESS_REMOTE_HOSTNAME` (the public URL to show and to put in the QR code). A stable
hostname keeps the phone's stored token valid across restarts (section 7).

**Who starts it: the harness** (chosen by the spec: it then works with `harness serve` in development, `pnpm dev:all`
and the packaged app alike; the desktop shell knows nothing of it). Found as `HARNESS_REMOTE_CLOUDFLARED` (a path),
else `cloudflared` on `PATH` (the shell already gives the harness the login-shell `PATH`). Not installed: state
`error` with code `cloudflared_missing` and the install line for the OS — macOS `brew install cloudflared`; Linux
"download the package from Cloudflare's downloads page (github.com/cloudflare/cloudflared/releases)"; Windows
`winget install --id Cloudflare.cloudflared` — and a "Check again" button (`POST /v1/remote/check`). The harness
never downloads it.

**Lifetime.** Own process group; `SIGTERM` to the group, 3 s, `SIGKILL` (as the language servers). Stopped when remote
access is turned off and when the harness stops. An exit while on: restart after 1, 2, 4, 8, 16 s (capped at 60 s); 5
failures without ever reaching "on" in between → state `error`, code `tunnel_failed`, the last 20 output lines in
`details`. A new URL after a restart is announced (`remote.changed`), the open pairing code is withdrawn, and the
phone needs the new URL (section 7).

**State machine:** `off → starting → on(url) → off`; `starting|on → error(code) → off|starting`. `starting` until a
URL is seen (timeout 30 s → restart path). `connected` (bool) turns true at the first "Registered tunnel connection"
line and is informative only.

## 3. What the tunnel exposes

Not the main bridge port. A **second listener** on `127.0.0.1:<free port>` (`HARNESS_REMOTE_ADDR`, default
`127.0.0.1:0`), opened only while remote access is on, is the only thing `cloudflared` points at. It serves:

| Path | Who | What |
| --- | --- | --- |
| `GET /health` | anyone | `{ok, version}` (the UI's connection check) |
| `POST /pair/claim` | anyone | `{code, name}` → `201 {device_id, token, status: "pending"}` |
| `GET /pair/me` | device token (pending or active) | `{device_id, name, status, read_only, permissions}` |
| `/v1/**` | **active** device token in `Authorization: Bearer` | the bridge API through the allow-list below |
| `GET /v1/projects/{pid}/events/poll` | active device | the long-poll event route (section 4) |
| anything else, `GET` | anyone | the web app's files; unknown paths without a dot get `index.html` |

A `?token=` query parameter is **refused** on this listener (tokens in URLs land in proxy and browser logs). The local
API token is just an unknown device token here: `401 device_not_paired`.

**Allow-list for device tokens** (default **deny**; a route not in the list is refused with `403 remote_forbidden`,
so a route added to the bridge later is closed until someone classifies it; a test fails when a bridge route is not
classified):

| Class | Routes (all under `/v1`) | Permission |
| --- | --- | --- |
| read | `GET` of `config`, `plugins`, `providers`, `usage`, `limits`, `sessions`, `search`; `GET /projects` and every `GET /projects/{pid}/…` except the denied ones; the poll route | always (a device can always read) |
| send | `POST /projects/{pid}/messages`, `…/attachments`, `…/side`, `…/side/stop`; queue edits, resume, send-now (project and session forms); `POST …/sessions`, `…/sessions/{sid}/messages`, `…/resume`, `…/default` | `send` |
| answer | `POST …/approvals/{id}`, `…/inputs/{id}`, `…/plans/{id}/approve` | `answer` |
| stop | `POST …/cancel`, `…/sessions/{sid}/stop` | `stop` |
| deny | `settings`, `diagnostics`, `fs/*`, `remote/*`, provider writes, `POST/PATCH/DELETE /projects[/{pid}]` (create, access mode, budget, models, delete), `secrets`, `lsp`, `commands` and `runs`, `complete`, `files/content` writes, `changes/…/revert`, `rewind`, `compact`, `clear`, `facts`, `memory` writes, `notes` writes, `approval-rules` deletes, session `PATCH`/`DELETE`, every review write, `mcp` | never |

A **read-only** device (per-device switch) gets the read class only.

**Headers** on every answer of this listener: `Cache-Control: no-store` (API, pairing, poll; the web app's hashed
assets get `public, max-age=31536000, immutable` and `index.html` `no-cache`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
and for HTML `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none';
base-uri 'none'; form-action 'none'`. **No CORS headers at all**: the web app is same-origin, so nothing cross-origin
may call the listener. Request bodies keep the bridge's 1 MiB cap.

## 4. Events without SSE

`GET /v1/projects/{pid}/events/poll?stream=<id>&wait=<s>` (tunnel listener only). Without `stream`: subscribes to the
project's hub and answers at once `{stream, events: []}`. With `stream`: waits until at least one event or `wait`
seconds (default and cap 25) and answers `{stream, events: [<the same JSON objects SSE carries in data>]}`. A stream
not polled for about 50 s (twice the longest wait), or one that overflowed (2048 events), is dropped; polling it is `410 stream_gone`, and the client
opens a new one and re-reads (exactly what it does after an SSE reconnect: events are not replayed). At most 8 streams
per device. The web client's `PollingEventSource` implements the `EventSourceLike` the agent-client already accepts as
an option, so the client and the UI are unchanged.

## 5. Pairing

On the computer, Settings → Remote access, while on, shows the URL, a QR code and **"Add a device"**, which issues a
**pairing code**: 8 characters from Crockford's base32 (no I, L, O, U), shown `ABCD-EFGH` (40 bits); valid 5 minutes;
single use; one code at a time (a new one replaces the old). The QR code holds `<url>/#pair=<code>`: the fragment never
reaches Cloudflare or the harness's logs. Attempts: at most 1 claim per second on the listener (`429
pairing_rate_limited`, `Retry-After`), and 5 wrong codes burn the current code (`423 pairing_locked` until the owner
issues a new one; this is a denial of service an attacker with the URL can cause, accepted: it costs the owner one
click and gains the attacker nothing).

The phone opens the URL (or scans), enters the code if the fragment did not carry it, names itself (default from the
user agent: "iPhone", "Android phone", "Browser") and receives a **device token**: `octo_dev_` + 43 base64url
characters (256 random bits), returned once, never shown again. The harness stores only its SHA-256 in
`{data-dir}/remote/devices.json` (directory 0700, file 0600, atomic writes; the harness's own store, shared with nobody).
The device is **pending**; the computer shows "iPhone wants to connect — paired just now · Allow / Deny" (chosen by
the spec: confirm on the computer). A pending device that is not allowed within 5 minutes is removed. Allowed devices
are **active**.

Devices list on the computer: name, paired at, last seen, read-only switch, Revoke; and **"Revoke all and turn off"**.
Tokens are bound to nothing else in v1 (no device key, no IP binding; chosen by the spec: a phone changes networks
constantly, and binding to the browser would need WebCrypto keys the harness cannot verify without more protocol — the
trade-off is that a copied token works from anywhere until revoked). Expiry: 30 days without use
(`HARNESS_REMOTE_DEVICE_IDLE_DAYS`); "last seen" is written at most once a minute.

## 6. Permissions of a remote device

Defaults (chosen by the spec, conservative; `HARNESS_REMOTE_ALLOW`, a list of `send,answer,stop`, default all three):
read conversations, files, sessions, approvals, usage — always; **send** messages (and attachments, side questions,
queue edits, new sessions); **answer** approvals, forms and plans — the point of a phone client; **stop** turns. Never:
settings, providers, secrets, plugins, budgets, access mode, remote access itself, file writes, reverting, commands,
language servers, folder pickers. Per device: **read-only**.

Projects in `supervised` mode keep their approval cards exactly as they are; the phone answers them like the
computer. `full`-access projects are allowed (chosen by the spec: refusing would make the phone useless for most
projects today, `HARNESS_DEFAULT_ACCESS` is still `full`); the computer's status bar shows "Remote · N connected" while
any device was seen in the last 60 s, so a running remote session on a `full` project is never invisible.

## 7. The switch on the computer

Settings → **Remote access** (new section, group "App"): off by default. Turning it on the first time shows two
sentences — "Anyone who gets a device token can run agents on this computer, and Cloudflare carries the traffic in
clear text. Only pair devices you own, and turn this off when you do not need it." — and needs one confirmation;
the acknowledgement is stored by the harness (`acknowledged` in `remote/devices.json`) and enforced by it (`409
remote_ack_required` without `acknowledge: true`). **Remote access is off after every harness start** (chosen by the
spec: "auto-off when the app quits" is always on in v1). **Auto-off after N idle hours**: no device request for
`HARNESS_REMOTE_IDLE_OFF_HOURS` (default 8; 0 = never) turns it off. Status bar: "Remote" while on, "Remote · 2" with
devices seen in the last minute, a pending device makes it "Remote · allow?"; clicking it opens the section.

**Routes** (main bridge, local token only; every one refused for device tokens):

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/remote` | `RemoteStatus` |
| POST | `/v1/remote/enable` | body `{acknowledge?}` → `RemoteStatus` (`starting`); `409 remote_ack_required` |
| POST | `/v1/remote/disable` | `RemoteStatus` (`off`); the pairing code and pending devices are dropped |
| POST | `/v1/remote/check` | looks for `cloudflared` again → `RemoteStatus` |
| POST | `/v1/remote/pairing` | issues a code → `RemoteStatus` with `pairing`; `409 remote_off` when not on |
| DELETE | `/v1/remote/pairing` | withdraws the code |
| POST | `/v1/remote/devices/{id}/confirm` | pending → active |
| PATCH | `/v1/remote/devices/{id}` | `{read_only}` |
| DELETE | `/v1/remote/devices/{id}` | revoke (or deny a pending one); its open poll streams end |
| POST | `/v1/remote/revoke-all` | revoke every device and turn off |

`RemoteStatus = {state: "off"|"starting"|"on"|"error", url?, connected, error?: {code, message, hint, command?,
details?}, cloudflared: {found, path?, version?, install}, listen?, pairing?: {code, expires_at, link}, devices:
[{id, name, status: "pending"|"active", read_only, paired_at, last_seen?, online}], acknowledged, permissions,
idle_off_hours}`. **Event** `remote.changed {state, online, pending}` on every project stream (no URL, no code); the UI
refetches `GET /v1/remote`.

**Errors** (catalogue `internal/usererr`, `catalogue_remote.go`): `cloudflared_missing`, `tunnel_failed`,
`remote_ack_required`, `remote_off`, `remote_forbidden`, `remote_read_only`, `device_not_paired`, `device_pending`,
`device_expired`, `pairing_code_invalid`, `pairing_code_expired`, `pairing_locked`, `pairing_rate_limited`,
`stream_gone`, `query_token_refused`.

**Doctor:** one line, `cloudflared: found <path> (<version>)` or `cloudflared: not found (remote access needs it:
<install line>)`; `GET /v1/diagnostics` the same fields.

## 8. The mobile client

`apps/web` becomes a Vite host (the stub's README is replaced): `@octo/ui` built as a static web app, served by the
harness at the tunnel root from `HARNESS_REMOTE_WEB_DIR` (or `serve --remote-web-dir`); in development
`HARNESS_REMOTE_WEB_PROXY=http://127.0.0.1:<vite port>` proxies non-API paths to the Vite dev server. Bundling the
built files into the packaged app is a note for the packaging spec (not built). The web host never imports Tauri.

- **Start:** the pairing screen (code field, device name, "Pair"); a `#pair=` fragment fills the code and is removed
  from the address bar at once. After "Pair": "Waiting for you to allow this phone on your computer" (polls `GET
  /pair/me` every 2 s), then the app.
- **Token storage:** `localStorage` key `octo.remote.device` (chosen by the spec: it survives the browser closing and
  "Add to Home Screen"; `sessionStorage` would ask for a new code every time). It is scoped to the origin, so **a new
  quick-tunnel URL is a new origin and the phone must pair again**; the old device stays in the list until revoked or
  expired. The pairing screen says so in one line. A named tunnel removes this.
- **Revoked or expired:** any `401 device_*` answer clears the stored token and shows the pairing screen with "This
  phone was disconnected on your computer. Pair it again with a new code." A `/pair/me` check every 30 s catches it
  while nothing else is being sent.
- **App:** `OctoApp` with `shell="web"`, bridge URL = the page's origin, `fetch` and `EventSource` (the poller) passed
  as options; the narrow layout (works at 390 px). Host capability flags that hide what a device may not do (Settings
  sections, New project's folder picker) are designed as `HostCapabilities.remoteDevice` (phase 2); in phase 1 those
  screens show the harness's refusal (`remote_forbidden`) in the person's words.
- **Installable:** `manifest.webmanifest` (`name` "Octo", `display: standalone`, theme and background `#0a0a0a`, icons
  from `apps/desktop/src-tauri/icons`), `apple-mobile-web-app-capable`, `viewport-fit=cover` and safe-area insets. **No
  service worker in v1** (chosen by the spec: iOS installs to the home screen without one; a worker would cache a stale
  app across URL changes).
- **Offline:** nothing in v1; the planned client session cache is the later answer.
- **Native wrapper** (Tauri 2 iOS/Android): later; it would show this same web app and keep the token in the keychain.

## 9. Phases

1. **Harness and web host** (this pass): `internal/remoteaccess` (tunnel runner, listener, allow-list, pairing,
   devices, poller), routes, events, errors, doctor, docs; `apps/web` with the pairing client; Settings → Remote
   access and the status-bar item. Verified by Go tests with a **fake `cloudflared`** (a script printing the real
   output), `apps/harness/scripts/e2e-remote.sh` (curl), and a Playwright run of the web app at 390×700 against a real
   `harness serve` with the mock model through the second listener (no tunnel).
2. Host capability flags for devices; Settings on the phone limited to Appearance; the packaged app ships the web
   files; named tunnels (`HARNESS_REMOTE_TUNNEL=named`).
3. Native wrapper; push notifications for approvals (needs a relay: designed later).

## 10. Acceptance criteria

1. Without `enable`, no second listener exists and no `cloudflared` runs; `GET /v1/remote` says `off`.
2. `enable` without `acknowledge` the first time is `409 remote_ack_required`; with it, later `enable`s need none.
3. With the fake `cloudflared` on PATH, `enable` goes `starting → on` and `url` is the `trycloudflare.com` URL it printed.
4. The URL is found in the boxed stderr line, in a plain line, and among unrelated log lines; nothing else is taken.
5. No `cloudflared` → state `error`, code `cloudflared_missing`, an install line; `check` after installing finds it.
6. `HARNESS_REMOTE_CLOUDFLARED` (a path) wins over PATH.
7. `cloudflared` exiting while on is restarted with backoff; a new URL is announced and the pairing code withdrawn; 5
   failures in a row → `error` `tunnel_failed` with the output tail.
8. `disable` and harness shutdown stop the whole `cloudflared` process group and close the listener.
9. The tunnel listener answers the local API token with `401 device_not_paired`, and `?token=` with `401
   query_token_refused`.
10. Every route classified deny in section 3 answers `403 remote_forbidden` to an active device; a test fails when a
    bridge route is not classified.
11. A read-only device gets `403 remote_read_only` on a send/answer/stop route and `200` on reads.
12. `HARNESS_REMOTE_ALLOW` without `answer` refuses approvals for every device.
13. Pairing: a code is 8 Crockford characters, single use, expires in 5 minutes (`pairing_code_expired`), a new one
    replaces the old.
14. 5 wrong codes → `423 pairing_locked` even for the right code, until a new code is issued; more than one claim a
    second → `429 pairing_rate_limited`.
15. A claimed device is pending: `/v1/**` → `403 device_pending`; `/pair/me` → `pending`; after `confirm` it works.
16. A pending device not allowed in 5 minutes disappears.
17. The token is 256 random bits, returned once; `devices.json` holds only its SHA-256, mode 0600 in a 0700 folder.
18. Revoking a device makes its next request `401 device_not_paired` and ends its poll streams.
19. A device unused for the idle days is refused (`device_expired`) and removed.
20. "Revoke all and turn off" leaves no device and state `off`.
21. Auto-off after the idle hours with no device request.
22. The poll route returns events published after the stream was opened, waits at most `wait` seconds, and answers
    `410 stream_gone` for an unknown stream.
23. Answers of the tunnel listener carry `Cache-Control: no-store` (API), `nosniff`, `no-referrer`, the CSP on HTML,
    and no `Access-Control-*` header.
24. The local routes `/v1/remote*` need the local token and are refused (`403`) through the tunnel.
25. `harness doctor` prints the cloudflared line; diagnostics carry it.
26. `e2e-remote.sh` passes: on with the fake cloudflared, pair, confirm, API through the listener, refusals, revoke, off.
27. The web app pairs, opens a project, sends a message and sees the answer stream, answers an approval, and after a
    revoke returns to the pairing screen with the plain message (Playwright, 390×700, mock model, no tunnel).
28. Settings → Remote access shows the switch with the first-time confirmation, the URL with copy and QR, the code with
    its countdown, the allow/deny prompt, the devices with revoke, and the "not installed" row; demo data shows it.
29. The status bar shows the remote item while on, with the number of devices seen in the last minute.
30. The desktop entry bundle stays within its budget (the section lives in the lazy Settings chunk).

## 11. Risks

- **URL leak.** Expected; harmless alone (section 1). The pairing code is the short-lived secret; it never enters a URL
  path or query.
- **Phishing of the pairing page.** Someone could host a look-alike page and ask the owner for a code. The code alone is
  useless without the owner's "Allow" on the computer, which names the device and says "paired just now".
- **The tunnel provider sees everything.** Cloudflare terminates TLS; prompts, files and answers pass through it in
  clear text. Said in the first-time explanation.
- **Token theft from the phone.** `localStorage` is readable by any script on the origin; the CSP allows only the app's
  own scripts. Revoke and expiry are the remedy.
- **WebKit has never run this UI** (masks, scroll correction, composer height): Safari on iOS is the target browser and
  is not available here.
- **Quick-tunnel limits:** no SSE (handled), 200 in-flight requests, no uptime guarantee, a new URL on every start.

## 12. What only the owner can verify

A real `cloudflared` and a real quick tunnel; the URL and QR code on a real phone; Safari/WebKit and "Add to Home
Screen"; the latency of long polls through Cloudflare; Windows.

## 13. Open questions (each with the default used)

1. Confirm each new device on the computer? Default **yes**.
2. Offer a private-network transport (Tailscale) instead of Cloudflare? Default **later**; v1 is Cloudflare only.
3. Use `--allowed-mail` as a second lock? Default **no** (it needs an e-mail in the harness and breaks non-browser use).
4. Should remote access survive a restart of the app? Default **no** (off after every start).
5. May a device create projects or change a project's access? Default **no**.
6. Push notifications for approvals? Default **later** (needs a relay or APNs; phase 3).

## As built

### Phase 1 (2026-11-14): harness, web host, desktop section

Built: `apps/harness/internal/remoteaccess` (tunnel runner, state machine, second listener, allow-list, pairing, device
store, long poll, control routes), `bridge.NewAPI` / `bridge.WithMount`, `usererr/catalogue_remote.go`, the doctor and
diagnostics line, `apps/harness/docs/remote-access.md`; `apps/web` (pairing screen, poller, fetch guard, manifest);
agent-client `remoteAccess.ts` (`Bridge.remoteAccess?()`, loaded on first use to keep the entry bundle in budget);
Settings → Remote access, the status-bar item (lazy), the demo state (`?demo=1`, `&remote=on|missing`), `lib/qr.ts`.

Verified here: Go tests `internal/remoteaccess` (`-race`, `-count=3`), `internal/usererr`, `internal/diag`,
`internal/bridge`, `cmd/harness`; `scripts/e2e-remote.sh`; web tests and the Playwright run
`apps/web/scripts/phone-flow.sh` (390×700, dark and light: pairing from a QR link, waiting, allow by curl, project,
streamed answer, approval answered on the phone, revoke → pairing screen with the notice, no CSP violation); the desktop
section on demo data at 1440 and 390, dark and light. Criteria: 1–26 pass (Go tests and the e2e script; 25 by the e2e
script's doctor check), 27 pass (phone-flow), 28 pass on demo data (not against a live harness in a desktop window), 29 pass
on demo data, 30 pass (158.78 kB of 158.90 on the tree as it was).

Deviations: pending devices are kept in memory only (never written) and the acknowledgement lives in `devices.json`; poll
streams are dropped after about 50 s without a poll; `HostCapabilities.remoteDevice` is not built, so the phone shows the
Run menu and Settings sections, and the harness refuses them (`remote_forbidden`); the message-port bridge does not
forward `remoteAccess` (HTTP only); `remote.changed` is published but not in the client's event list, so the computer
polls `GET /v1/remote` (2 s on the section, 10 s for the status bar). The QR encoder was checked against the standard's
Reed-Solomon example, the format and version tables and an independent reader in its test, not against a camera.

Not verified: a real `cloudflared`, a real quick tunnel (SSE refusal, 100 s limit, latency), a real phone, Safari/WebKit,
"Add to Home Screen", Windows.

### Security review (2026-11-19)

- **Approvals from a device are once-only.** The `answer` class let `POST …/approvals/{id}` through without reading the
  body, so a paired phone could save a permanent rule (`allow_always` with any `match`) or allow everything for the turn.
  The gate now admits only `allow`/`deny` (+ `note`), refuses the rest with `403 remote_decision_forbidden`, and forwards a
  body rebuilt from those two fields (an ACP `option_id` is dropped: allow-once / reject-once). The UI hides "for this
  request", "Always allow", "Allow all for this request" and an agent's `*_always` options when `remoteDevice` is set.
  Verified: `remoteaccess` `TestRemoteApprovalAnswersAreOnceOnly` (failed before: 200 for each), `lib/remoteDevice.test.ts`,
  and the reviewer's proof against a built harness (see the review report). Not verified on a real phone.

