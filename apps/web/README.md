# `@octo/web` — the phone's client

The shared UI (`@octo/ui`) built as a static web app that the harness serves to a **paired phone** through remote access
(spec: [`docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md`](../../docs/superpowers/specs/2026-11-14-remote-access-mobile-design.md);
harness side: [`apps/harness/docs/remote-access.md`](../harness/docs/remote-access.md)). Wiring only; no Tauri.

- `src/App.tsx`: the pairing screen until the computer allows this device, then `OctoApp` (`shell="web"`) on a bridge to
  the page's own origin with the device token.
- `src/pairing.ts` (pure, tested): the code from a QR link's fragment (`#pair=…`, removed from the address bar at once),
  `POST /pair/claim`, `GET /pair/me`, the token in `localStorage` (`octo.remote.device`).
- `src/pollingEventSource.ts` (tested): project events by long poll (`GET …/events/poll`), because Cloudflare's quick
  tunnels do not carry Server-Sent Events. It is the `EventSourceLike` the agent-client accepts, so nothing else changes.
- `src/guardedFetch.ts`: a `401 device_not_paired` / `device_expired` sends the page back to pairing with
  "This phone was disconnected on your computer. Pair it again with a new code."
- `public/`: `manifest.webmanifest` (standalone, theme colours, icons from the desktop app), `theme.js` (the first-paint
  theme; the harness's CSP allows no inline script). No service worker in v1.

**Token storage.** `localStorage` of the tunnel's origin: it survives closing the browser and "Add to Home Screen". A
quick tunnel gets a new URL every time remote access is turned on, which is a new origin: the phone then pairs again (the
pairing screen says so). A named tunnel (later) keeps one address.

```bash
pnpm --filter @octo/web dev       # http://127.0.0.1:1430; with HARNESS_REMOTE_WEB_PROXY=http://127.0.0.1:1430 the harness proxies to it
pnpm --filter @octo/web build     # dist/: serve with HARNESS_REMOTE_WEB_DIR=apps/web/dist (or harness serve --remote-web-dir)
pnpm --filter @octo/web test      # pairing and the poller
pnpm --filter @octo/web lint
bash apps/web/scripts/phone-flow.sh --out /tmp/phone --theme dark   # Playwright at 390x700 against a real harness + mock model + fake cloudflared
```

Not verified: Safari/WebKit, a real phone, a real tunnel.
