# `@octo/desktop` — agent instructions

Host for the shared UI: a Vite app (`src/`) inside a Tauri 2 shell (`src-tauri/`). It contains wiring only —
screens live in [`packages/ui`](../../packages/ui/AGENTS.md), the bridge client in
[`packages/agent-client`](../../packages/agent-client/AGENTS.md). Architecture: [`docs/architecture.md`](./docs/architecture.md); the whole system and where data lives: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## What belongs here

- `src/main.tsx` mounts; `src/App.tsx` is wiring only. `usesHostBridge(search, env, isTauri)` (`src/bridgeChoice.ts`, pure,
  unit-tested) decides: only inside Tauri, not `?demo=`, and no `VITE_HARNESS_BRIDGE_URL`. If true, `HostedApp`
  (`src/HostedApp.tsx`, lazy, loaded only inside Tauri) shows `HostStatus` until the shell's harness answers, then
  `BridgeShell` plus a one-line `HostNotice`; otherwise `BridgeShell` directly. `BridgeShell` (`src/BridgeShell.tsx`) =
  `chooseBridge(search, env, hostUrl?)` → `useBridge` (`src/useBridge.ts`; the demo is loaded from `@octo/ui/demo` with
  `import()` so a normal start never downloads it) → `OctoApp` with `shell="desktop"`.
- Anything that needs the OS (`@tauri-apps/*`: file pickers, opening files, window chrome) is implemented here and
  passed to the UI as `HostCapabilities`. It never goes into `packages/ui`.
- `src/styles.css` imports Tailwind and then `@octo/ui/styles.css`.
- `src-tauri/` is Rust and Tauri configuration only.
- macOS traffic lights: the numbers live in `src/windowChrome.ts` (`MAC_LIGHTS_X` = the sidebar's glyph column 24, `MAC_LIGHTS_Y` 22 with `MAC_LIGHTS_CENTER_OFFSET` -2 so the
  lights' centre is the 40px row's centre line, `MAC_INSET_START` derived = 86) and in `src-tauri/tauri.macos.conf.json` (a test keeps them equal). Preview in a browser:
  `?demo=1&titlebar=mac` (dev server only; `mac-fullscreen` for the collapsed inset), then `node apps/desktop/scripts/traffic-lights.mjs` (Playwright, dev server on `--url`) asserts the centre
  line, the glyph column and the 4px gap. Change a number in both places and run both.

- Inside Tauri the shell runs the harness (design P5). `src/hostBridge.ts` (`useHostBridge`) calls the Rust commands
  `bridge_url` / `bridge_restart` / `bridge_log_tail` (the Tauri API is `import()`ed on demand), `src/HostStatus.tsx` is the
  "Starting Octo…" / failure screen (message, last 20 log lines, Retry), and `chooseBridge(search, env, hostUrl, hostToken)` takes the URL and the API token (`bridge_url` / `bridge_restart` return `{ url, token }`; `src/hostConnection.ts` also reads an older shell's bare URL string as "no token"). In a browser dev setup the token is `VITE_HARNESS_API_TOKEN` (set by `scripts/dev.sh`; never set it for a production build, Vite would bake it in).
  In a browser nothing changes (no Tauri API is loaded).
- `src-tauri/sidecar/` is the `octo-sidecar` crate (no `tauri` dependency, so `cargo test -p octo-sidecar` runs anywhere):
  `port` (free port), `shellenv` (login-shell PATH and allow-listed environment, parsers, fallback dirs; see "Login-shell environment" below), `process` (own process group, SIGTERM, 3 s, SIGKILL; pid file for crash cleanup),
  `logfile` (capped `harness.log` / `router.log`, tail), `health` (`GET /health` wait), `settings` (the three `OCTO_ROUTER_*` keys of `{app data}/harness/harness.env`,
  tolerant parser, values never logged), `router` (the router's config fragments, generated client key, pid-file name), `bridge` (the sequence; `OCTO_BRIDGE_URL` starts nothing; a new 256-bit API token per run goes to the harness as `HARNESS_API_TOKEN` in its environment only, never an argument or the log, and to the webview in `Connection { url, token }`; `OCTO_BRIDGE_TOKEN` supplies the token of an overridden harness; the router never sees it).
  `src-tauri/src/lib.rs` is only glue: four commands (`bridge_url` and `bridge_restart` returning `{ url, token }`, `bridge_log_tail`, `bridge_notices`) and the exit hook.
- Login-shell environment (`shellenv`): one `$SHELL -ilc` run (3 s timeout) prints the PATH between markers and then `env -0` between a second pair of markers
  (NUL separated; values may hold newlines and `=`; the last complete marker pair wins). The harness gets `PATH` as before plus an allow-list of names, only when the shell has them:
  `LANG`, `LC_*`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `SSH_AUTH_SOCK`, `NVM_DIR`, `BUN_INSTALL`, `PNPM_HOME`, `VOLTA_HOME`,
  `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (and the lower-case spellings), `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `TMPDIR`, `SHELL`, `USER`, `LOGNAME`, `TERM`. `HOME` is not forwarded.
  A name containing KEY, TOKEN, SECRET, PASSWORD, PASSWD or CREDENTIAL (any case) is never forwarded, even if someone adds it to the list (tested). Provider keys still come only from `harness.env`.
  A name set in `harness.env` is not forwarded at all (the harness lets the process environment beat the file, so a forwarded value would shadow the user's); for every other name the login
  shell's value wins over the app's own, as `PATH` always did. Shell missing, failing or timing out: the old fallback PATH and nothing else. The log gets one line, `login shell environment forwarded: <names>`; values never.
  The harness's own child-environment filter (`internal/childenv`) still applies after this; `harness doctor` lists which of these names child processes get (names only).
- The router (design P8): `bridge` reads `harness.env` at every (re)start. `OCTO_ROUTER_ENABLED=1` plus `OCTO_ROUTER_UPSTREAM_KEY` starts the bundled `octo`
  binary first (free loopback port, random client key per launch, config fragments and `history.sqlite` under `{app data}/router`, `OCTO_CONFIG` the only way to
  configure it), waits for its `/health`, then starts the harness with `--base-url http://127.0.0.1:<port>/autoroute`, `HARNESS_OCTO_KEY=<client key>` and
  `ANTHROPIC_API_KEY=<upstream key>` in its environment (the router forwards the caller's credential upstream; keys never go on a command line). A non-empty
  `OCTO_ROUTER_BASE_URL` means an external router: nothing is started, the URL is passed on. A router that fails leaves the harness running without it; the failure
  is `bridge_notices()` -> `[{ kind: "router_failed", message, log_tail }]` and `src/HostNotice.tsx` shows it as one quiet line (Details = log tail, Retry = `bridge_restart`).
  Stop order is harness, then router. Tests use fake binaries (`sidecar/src/bridge_router_tests.rs`, needs `python3`; skipped without it).

Keep logic out of components: selection logic (query parameters → bridge options) is the pure `chooseBridge`; extend it with a test.

## Commands

```bash
pnpm install
pnpm --filter @octo/desktop dev        # http://localhost:1420 (add ?demo=1 for demo data)
pnpm --filter @octo/desktop lint       # tsc --noEmit && eslint . (also type-checks the UI sources it imports)
pnpm --filter @octo/desktop test       # node:test + tsx
pnpm --filter @octo/desktop build
node scripts/check-bundle-size.mjs     # from the repo root, after the build
cd apps/desktop/src-tauri && cargo check        # needs binaries/harness-<triple> and binaries/octo-<triple> (`pnpm --filter @octo/desktop sidecar`; `OCTO_NO_ROUTER=1` skips the router) and WebKitGTK on Linux
cd apps/desktop/src-tauri && cargo test -p octo-sidecar   # no WebKit needed; the router tests need python3
pnpm --filter @octo/desktop tauri dev  # needs the OS prerequisites for Tauri; builds both sidecars first (`pnpm --filter @octo/desktop sidecar`; `OCTO_NO_ROUTER=1` skips the router)
pnpm dev:all                           # from the repo root: harness + UI dev server in a browser (`-- --mock`, `-- --router`); `pnpm install:app` builds and installs the app
pnpm test:dev-sh                       # from the repo root: dev.sh comes up, answers and leaves nothing behind
```

The Tauri glue (`src-tauri/src/lib.rs`), `install.sh` on macOS and the installed app have not been run in the build environment (no WebKitGTK, no macOS): CI compiles the glue, the owner tries the app. Say so if you rely on them.
The first-run screen is the connect screen and Settings has the provider key and "Copy diagnostic report" (packaging P9, built in the UI; see `docs/ARCHITECTURE.md` status). The Tauri webview has a CSP (`tauri.conf.json`; `src/tauriCsp.test.ts`) that is not verified in the Tauri runtime. The sidecar side (settings file, router switch, restart) is built.
In a browser the app does not start the harness: run `harness serve` yourself (see `apps/harness/README.md`); inside Tauri the shell does.
Do not share SQLite or config files with the harness or the router.
