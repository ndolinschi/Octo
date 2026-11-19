# Octo Desktop

Tauri 2 shell for the shared UI (`@octo/ui`). The UI talks only to the harness bridge (`harness serve`).
UI design: [`docs/superpowers/specs/2026-11-10-project-harness-ui.md`](../../docs/superpowers/specs/2026-11-10-project-harness-ui.md).
Architecture: [docs/architecture.md](./docs/architecture.md).

## Prerequisites

- pnpm 10+ (repo root `pnpm install`)
- Rust **1.90+** for `src-tauri` (see `src-tauri/rust-toolchain.toml`)
- [Tauri OS prerequisites](https://tauri.app/start/prerequisites/) for local `tauri dev` / `tauri build`

## Commands

```bash
# from repo root
pnpm --filter @octo/desktop dev        # Vite only, http://localhost:1420
pnpm --filter @octo/desktop build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @octo/desktop tauri dev
```

## Run and install

```bash
pnpm dev:all            # browser: harness (no API key needed) + UI at http://localhost:1420; Ctrl+C stops both. A busy default port (8790, 1420, 8791, 8792) moves to the next free one and the final block lists the chosen addresses; an explicit --bridge-port / OCTO_DEV_*_PORT that is busy is an error naming the process
pnpm dev:all -- --mock  # same, plus the mock model server
pnpm dev:all -- --router --mock   # also the Octo router in front of the harness (router -> mock model); without --mock set OCTO_ROUTER_UPSTREAM_KEY
pnpm install:app        # build the harness and router sidecars + the Tauri app and install it (macOS: /Applications/Octo.app, add `-- --user` for ~/Applications; Linux: ~/.local/bin/octo)
pnpm install:app -- --no-install   # only build
pnpm --filter @octo/desktop tauri dev   # the Tauri window; builds the harness and router sidecars first (`OCTO_NO_ROUTER=1` skips the router)
```

`scripts/install.sh` checks pnpm, Node, Go and Rust (plus Xcode command-line tools on macOS, the WebKitGTK dev packages on Linux) and names everything that is
missing in one pass (without `pkg-config` the libraries cannot be probed, so they are listed as also needed, with one install command per distribution). On Linux `--no-install` prints the path of the AppImage. On macOS it quits a running Octo, replaces the installed copy, ad-hoc signs it (`codesign -s -`) and clears the quarantine flag. Your data lives outside the app
and survives reinstalling.

## Bridge

Inside the Tauri app the shell starts the bundled harness itself: it picks a free loopback port, resolves your login-shell `PATH` (a GUI app does not inherit it, and
the agents are `npx`, `claude`, `copilot` ...; 3 s timeout, falls back to the inherited `PATH` plus Homebrew, `~/.local/bin`, `~/.cargo/bin`, `~/go/bin`), runs
`harness serve --addr 127.0.0.1:<port> --data-dir <app data dir>/harness`, waits up to 15 s for `/health`, and stops it (SIGTERM, then SIGKILL after 3 s, whole process group) on quit.
Output goes to `harness.log` in the app log directory (capped at 2 MiB, one `.1` file kept). A failed start shows the message, the last 20 log lines and Retry.

### The router (optional second sidecar)

The app also bundles the Octo router (`binaries/octo`, built by `scripts/build-sidecar.sh` with `cargo build --release -p octo`; `--no-router` skips it for development).
It is off by default. The shell reads three keys from `<app data dir>/harness/harness.env` (the settings file the harness owns) at every start and restart:

| Key | Meaning |
| --- | --- |
| `OCTO_ROUTER_ENABLED` | `1` starts the bundled router (default off) |
| `OCTO_ROUTER_UPSTREAM_KEY` | the provider key; without it the router is not started |
| `OCTO_ROUTER_BASE_URL` | non-empty: an external router; none is started, this URL is passed to the harness as `--base-url` (it must end in `/autoroute`) |

With the router on, the shell starts it first: on a free loopback port, with a random client key (`x-octo-key`, new every launch) and its configuration and history
database under `<app data dir>/router` (the router reads only TOML fragments from the directory `OCTO_CONFIG` names, so the shell writes `server.toml`, `limits.toml`
and `history.toml` there, the first with mode 0600). After its `/health` answers (up to 20 s) the harness starts with `--base-url http://127.0.0.1:<port>/autoroute`
and, in its environment only, `HARNESS_OCTO_KEY` (the client key) and `ANTHROPIC_API_KEY` (the upstream key: the router passes the caller's credential on to the provider).
Output goes to `router.log` beside `harness.log` (same cap). If the router cannot start the app still opens, the harness runs without it, and a one-line notice
with Details (the log tail) and Retry appears (`bridge_notices`). On quit the harness stops first, then the router; a leftover router from a crash is removed through `router.pid`.

Overrides: `OCTO_BRIDGE_URL=http://host:port` starts nothing and uses that harness; `VITE_HARNESS_BRIDGE_URL` (build time) does the same for the UI. In a browser the app connects to
`VITE_HARNESS_BRIDGE_URL` (default `http://127.0.0.1:8790`); if nothing answers it shows an offline screen with the command and keeps retrying.

### Quit, close and kill

Closing the last window ends the app on every platform: Tauri destroys the window, finds none left and raises `ExitRequested`; nothing here calls `prevent_exit`, so the run
loop ends with `RunEvent::Exit`, where the shell stops the harness (SIGTERM, 3 s, SIGKILL on its group) and then the router. Cmd+Q on macOS (the default app menu's Quit) and
the app's own quit raise the same event, so both sidecars stop there too. (macOS differs from the usual Mac convention: closing the window quits, the app does not stay in the Dock.)
On Linux, `pgrep harness` and `pgrep octo` are empty after closing the window.

If the app is killed (`kill -9`, a crash, the session being torn down) no handler runs, so the sidecars carry their own exit:

1. Primary: the shell starts each sidecar with a piped stdin that it keeps open for the child's whole life and never writes to. When the app dies, however it dies, the OS closes it and
   the sidecar sees EOF. The shell turns that mode on through the environment (`HARNESS_EXIT_ON_STDIN_CLOSE=1`, `OCTO_EXIT_ON_STDIN_CLOSE=1`, both set on both children; the harness also has
   `--exit-on-stdin-close`), so a binary that does not know the setting just ignores it and starts normally. Covered by `sidecar/tests/stdin_close.rs`, which SIGKILLs a stand-in app.
2. The children's stdout/stderr are pipes the shell reads, so a sidecar that logs gets EPIPE once the app is gone.
3. The next launch terminates a leftover `harness` / `octo` group recorded in `harness.pid` / `router.pid` (Unix only).

Agent processes the harness started live in its group and are stopped with it on a normal quit; after a kill they end when the harness exits or when their own work finishes.

## First paint and themes

`index.html` paints the window colour before any CSS or JavaScript bundle loads and sets `<html data-theme>` from the stored choice (`octo.theme`, written by the UI) or the
system theme, following later system changes; the `color-scheme` meta and the colours match the UI's `--octo-window` tokens. Do not hard-code a theme on `<html>`: the
start-up and failure screens (`HostStatus`, `HostNotice`) use the same tokens as the UI, and a fixed `data-theme="dark"` made them dark on a light system. The Tauri window sets no
`backgroundColor` or `theme` (a single colour cannot suit both), so the window follows the system theme and the page paints its own colour.

## Traffic lights and the title row (macOS)

`src-tauri/tauri.macos.conf.json` (merged over `tauri.conf.json` by `tauri dev` and `tauri build` alike; `scripts/install.sh` passes no `--config`)
sets `titleBarStyle: "Overlay"`, `hiddenTitle` and `trafficLightPosition {x: 24, y: 22}` (x: the sidebar's glyph column; y: the lights' centre lands on the row's centre line). The key is applied (tauri-utils 2.10.2
`WindowConfig::traffic_light_position`, needs Overlay and decorations), but `y` is not the lights' position: tao 0.37.2
(`platform_impl/macos/view.rs`, `inset_traffic_lights`) makes the title bar container `button height + y` tall and leaves the buttons at
their offset inside it, so the lights' centre is `y` plus a constant of the macOS version (measured -2 on a 2x screenshot: `y: 23` gave a centre 21 pt).
`src/windowChrome.ts` holds the numbers (`MAC_LIGHTS_X`, `MAC_LIGHTS_Y`, `MAC_CONTROLS_CENTER_Y = 20`, `MAC_INSET_START`); a test keeps the
config file equal to them. The shell passes the UI `chrome.controlsCenterY`, and the title row centres its controls on it.

Check on your machine (`OCTO_DEBUG_CHROME=1`):

1. Start the app with it: `OCTO_DEBUG_CHROME=1 pnpm --filter @octo/desktop tauri dev` (or run the installed binary with the variable set).
2. A 1 px magenta line crosses the window at the row's control centre (20 pt). The lights' centres, the sidebar toggle, back and forward should all sit on it.
3. If the lights are above or below the line, change `y` in `tauri.macos.conf.json` and `MAC_LIGHTS_Y` in `src/windowChrome.ts` by the offset in points (the lights move
   down as `y` grows) and restart. The configured values and the row's centre are also logged (web inspector console, and stderr as `octo chrome: ...`).

## Demo mode

Open `http://localhost:1420/?demo=1` to run against an in-memory bridge (`createDemoBridge()` from `@octo/ui/demo`, loaded only for `?demo=`)
seeded with three projects: a finished investigation, a live run that streams scripted events, and an empty
project. Messages you send in demo mode run a short scripted turn. `?demo=empty` starts with no projects. Add `&tabs=all` (or `&tabs=sessions,usage`, etc.) to enable UI tool tabs that are disabled by default in `@octo/ui` (`sessions`, `agents`, `notes`, `details`, `usage`, `memory`).
