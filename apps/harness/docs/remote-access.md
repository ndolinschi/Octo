# Remote access (a paired phone through Cloudflare)

Spec: [`docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md`](../../../docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md).
Code: `internal/remoteaccess` (wired in `cmd/harness/remote.go`), errors in `internal/usererr/catalogue_remote.go`.

Remote access is **off after every start**. When the owner turns it on, the harness opens a second listener on
loopback (`HARNESS_REMOTE_ADDR`, default a free port on `127.0.0.1`) and runs Cloudflare's
`cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<that port>` (a *quick tunnel*: no account, a random
`https://<words>.trycloudflare.com` URL that changes on every start). Only that listener is reachable through the
tunnel; the main bridge port never is.

## What the tunnel listener serves

| Path | Who | What |
| --- | --- | --- |
| `GET /health` | anyone | `{ok, version}` |
| `POST /pair/claim` | anyone | `{code, name}` → `201 {device_id, name, token, status: "pending"}`; the token is never shown again |
| `GET /pair/me` | a device token (pending or active) | `{device_id, name, status, read_only, permissions}` |
| `/v1/**` | an **active** device token in `Authorization: Bearer` | the bridge API through the allow-list (`internal/remoteaccess/rules.go`) |
| `GET /v1/projects/{pid}/events/poll` | an active device | long-poll events (below) |
| any other `GET` | anyone | the web app from `HARNESS_REMOTE_WEB_DIR` (unknown paths without an extension get `index.html`), proxied to `HARNESS_REMOTE_WEB_PROXY` in development, else a short "not installed" page (503) |

- The local API token (`HARNESS_API_TOKEN`) is an unknown device token here: `401 device_not_paired`.
- `?token=` is refused (`401 query_token_refused`): tokens in URLs end up in logs.
- A path that is not canonical, or that hides `/` as `%2F`, is refused (400) or redirected to its canonical form.
- Every request arrives from `cloudflared` on `127.0.0.1`, so nothing here trusts the peer address. The MCP routes are not
  mounted, and the routes that check for loopback (settings, folder dialog) are refused by the allow-list.
- Headers on every answer: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy`; API, pairing and poll answers `Cache-Control: no-store`; the web app's HTML carries the CSP
  (`remoteaccess.CSP`; `img-src` allows `https:` only for an image the person loads with "Load image"; the web build
  carries the same policy as a `<meta>`, without `frame-ancestors`, which the harness test `TestWebBuildCSPIsTheHeader` keeps equal), `/assets/*` is cached as immutable. **No CORS header at all**; a preflight gets 405.

### Allow-list for devices

First match wins, anything unmatched is denied (`403 remote_forbidden`). `TestEveryBridgeRouteIsClassified` reads the
bridge's route table and fails for a `/v1` route that no rule names, so a new route is classified on purpose.

| Class | Routes | Needs |
| --- | --- | --- |
| read | `GET` config, plugins, providers, usage, limits, sessions, search, projects and every `GET /v1/projects/{pid}/…` not denied below | an active device |
| send | `POST …/messages`, `…/attachments`, `…/side`, `…/side/stop`, `DELETE …/side`; queue edits, resume, send-now (project and session forms); `POST …/sessions`, `…/sessions/{sid}/messages|resume|default` | `send` and not read-only |
| answer | `POST …/approvals/{id}`, `…/inputs/{id}`, `…/plans/{id}/approve` | `answer` and not read-only |
| stop | `POST …/cancel`, `…/sessions/{sid}/stop` | `stop` and not read-only |
| deny | settings, diagnostics, `fs/*`, `remote/*`, provider writes, project create/patch/delete, secrets, `lsp`, commands and run stops, `complete`, file writes, change revert, rewind, compact, clear, facts, memory and notes writes, approval-rule deletes, session patch/delete, every review write, `/mcp` | never |

An approval answer from a device is for that one request only: the gate reads the body of `POST …/approvals/{id}` and lets through `decision` `allow` or `deny` (with `note`); `allow_always` (a saved rule, `match`), `allow_for_turn`, `allow_all_for_turn` or an unreadable body is `403 remote_decision_forbidden` before the bridge, and the forwarded body is rebuilt from `decision` and `note`, so an ACP `option_id` (which could be the agent's own "always" option) is dropped and the harness picks the agent's allow-once or reject-once option. The UI on a device offers only those answers (`mayGrantBeyondOnce`). A read-only device (`403 remote_read_only`) gets the read class only. `HARNESS_REMOTE_ALLOW` removes a class for every
device.

### Events without SSE

Quick tunnels do not carry Server-Sent Events (Cloudflare's documentation, checked 2026-11-14), so the tunnel listener
offers `GET /v1/projects/{pid}/events/poll`:

- no `stream`: subscribes to the project and answers at once `{stream: "ps_…", events: []}`;
- `?stream=<id>&wait=<seconds>` (default and cap 25): waits for at least one event or the wait, answers
  `{stream, events: [...]}` with the same JSON objects the SSE stream carries in `data` (at most 500 per answer);
- a stream not polled for about 50 s, one the hub dropped for lagging, one of another device or project, or an unknown
  id: `410 stream_gone` (the client opens a new one and re-reads, as after an SSE reconnect). At most 8 streams per
  device; opening a ninth drops the oldest. A revoke ends the device's polls at once.

The SSE route (`GET /v1/projects/{pid}/events`) is also allowed on the listener with a header token (a named tunnel
carries SSE); browsers cannot send that header with `EventSource`, so the web client always polls.

## Pairing and devices

- `POST /v1/remote/pairing` (computer) issues a code: 8 characters of Crockford's base32 shown `ABCD-EFGH`, valid 5
  minutes, single use; a new code replaces the old. The QR link is `<url>/#pair=<code>` (the fragment never reaches a
  server). Typed codes ignore case, spaces and dashes; `O`, `I`, `L` read as `0`, `1`, `1`.
- Claims are counted per source: the address Cloudflare's edge saw (`Cf-Connecting-Ip`, set by the edge), else the peer
  address. A source's claims are spaced at least 1 s apart (`429 pairing_rate_limited`, `Retry-After: 1`); after 5 wrong
  codes that source waits 30 s, doubled by each further wrong code up to 15 min (`429 pairing_backoff`, `Retry-After`
  in seconds), and the code stays good for every other source, so a stranger with the URL cannot burn it. 200 wrong
  codes from all sources together (or more than 4096 sources) burn it (`423 pairing_locked`, even for the right code)
  until the computer issues a new one.
- A claimed device is **pending** (`403 device_pending` on `/v1`) until the computer allows it
  (`POST /v1/remote/devices/{id}/confirm`). A pending device not allowed within 5 minutes disappears; pending devices
  never survive a restart or turning remote access off.
- Tokens: `octo_dev_` + 43 base64url characters (256 random bits). Only the SHA-256 is stored, in
  `{data-dir}/remote/devices.json` (folder 0700, file 0600, atomic writes), with each device's name, status,
  read-only flag, pairing time and last use (written at most once a minute), and whether the owner acknowledged the
  first-time warning. Shared with nothing else.
- A device unused for `HARNESS_REMOTE_DEVICE_IDLE_DAYS` (default 30) is removed at its next request
  (`401 device_expired`) or by the sweep.

## Control routes (main bridge, local token)

All under `/v1/remote`, mounted with `bridge.WithMount` behind the bridge's token and CORS; every one is refused through
the tunnel.

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/remote` | `RemoteStatus` |
| POST | `/v1/remote/enable` | `{acknowledge?}` → status (`starting`, or `error` with `cloudflared_missing`); `409 remote_ack_required` the first time without `acknowledge: true` |
| POST | `/v1/remote/disable` | status `off`: the tunnel's process group and the listener are stopped, the code and pending devices dropped |
| POST | `/v1/remote/check` | looks for `cloudflared` again |
| POST / DELETE | `/v1/remote/pairing` | issue (`409 remote_off` unless on) / withdraw the code |
| POST | `/v1/remote/devices/{id}/confirm` | allow a pending device |
| PATCH | `/v1/remote/devices/{id}` | `{read_only: bool}` |
| DELETE | `/v1/remote/devices/{id}` | revoke (or deny a pending one) |
| POST | `/v1/remote/revoke-all` | remove every device and turn off |

`RemoteStatus`: `state` (`off|starting|on|error`), `url`, `connected` (cloudflared logged a registered connection),
`error {code, message, hint, command?, action?, details?}`, `listen` (the loopback address of the tunnel listener),
`cloudflared {found, path, version, install}`, `pairing {code, expires_at, link}`, `devices [{id, name, status,
read_only, paired_at, last_seen, online}]`, `online` (devices seen in the last minute), `pending`, `acknowledged`,
`permissions`, `idle_off_hours`, `web_app`.

Event: `remote.changed {state, online, pending}` on every project stream (no URL, no code); refetch `GET /v1/remote`.

## The tunnel process

Found as `HARNESS_REMOTE_CLOUDFLARED` (a path or a name), else `cloudflared` on `PATH`. The harness never downloads it; when it is missing, `cloudflared_missing` carries an install command that verifies what it installs: `brew install cloudflared` (macOS), `winget install --id Cloudflare.cloudflared` (Windows), and on Linux Cloudflare's signed apt repository (`pkg.cloudflare.com`, key `cloudflare-main.gpg`, `signed-by`), with the vendor's downloads page in `details` for other distributions. (Before 2026-11-19 the Linux line fetched `releases/latest` from GitHub with no checksum.) Run in its own process group
with the child environment filter (`internal/childenv`); its output is scanned for the first
`https://<label>.trycloudflare.com` (the API host `api.trycloudflare.com` in error lines is ignored), and
"Registered tunnel connection" sets `connected`. No URL within 30 s, or an exit, restarts it after 1, 2, 4, 8, 16 s
(at most 60 s); 5 runs in a row that fail (a run that reached a URL resets the count) give `error` `tunnel_failed` with
the last 20 output lines as `details`. A new URL after a restart withdraws the open code. Stopping: `SIGTERM` to the
group, 3 s, `SIGKILL`. Auto-off: no device request for `HARNESS_REMOTE_IDLE_OFF_HOURS` (default 8; `0` = never).

## Settings (environment or `harness.env`; not editable through the API)

| Variable | Default | Meaning |
| --- | --- | --- |
| `HARNESS_REMOTE_CLOUDFLARED` | `cloudflared` on PATH | the tunnel program |
| `HARNESS_REMOTE_ADDR` | `127.0.0.1:0` | the tunnel listener; loopback only (`127.0.0.0/8`, `::1` or `localhost`, with a port): another address (`0.0.0.0`, a LAN IP, no port) stops `harness serve` with an error naming the variable |
| `HARNESS_REMOTE_WEB_DIR` (`serve --remote-web-dir`) | none | the built web app (`apps/web/dist`) |
| `HARNESS_REMOTE_WEB_PROXY` | none | development: proxy the web app to a Vite dev server |
| `HARNESS_REMOTE_ALLOW` | `send,answer,stop` | what devices may do beyond reading (`none` = read only) |
| `HARNESS_REMOTE_DEVICE_IDLE_DAYS` | `30` | a device unused this long is removed |
| `HARNESS_REMOTE_IDLE_OFF_HOURS` | `8` | turn off after no device request this long (`0` = never) |

## Doctor

`harness doctor` prints `cloudflared: found <path> (<version>)` or `cloudflared: not found (remote access needs it:
<install line>)`; `GET /v1/diagnostics` has the same in `cloudflared`.

## Tests

`internal/remoteaccess/*_test.go` (fake `cloudflared`: `testdata/fake-cloudflared`, a bash script that prints a quick
tunnel's output; its behaviour comes from a `.mode` file beside it because the child environment is scrubbed) and
`scripts/e2e-remote.sh` (curl against a real `harness serve` with the mock model). Not verified here: a real
`cloudflared`, a real tunnel, a phone, Safari.
