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
pnpm dev:all            # browser: harness (no API key needed) + UI at http://localhost:1420; Ctrl+C stops both
pnpm dev:all -- --mock  # same, plus the mock model server
pnpm install:app        # build the harness + the Tauri app and install it (macOS: /Applications/Octo.app, add `-- --user` for ~/Applications; Linux: ~/.local/bin/octo)
pnpm install:app -- --no-install   # only build
pnpm --filter @octo/desktop tauri dev   # the Tauri window; builds the harness sidecar first
```

`scripts/install.sh` checks pnpm, Node, Go and Rust (plus Xcode command-line tools on macOS, the WebKitGTK dev packages on Linux) and names what is
missing. On macOS it quits a running Octo, replaces the installed copy, ad-hoc signs it (`codesign -s -`) and clears the quarantine flag. Your data lives outside the app
and survives reinstalling.

## Bridge

Inside the Tauri app the shell starts the bundled harness itself: it picks a free loopback port, resolves your login-shell `PATH` (a GUI app does not inherit it, and
the agents are `npx`, `claude`, `copilot` ...; 3 s timeout, falls back to the inherited `PATH` plus Homebrew, `~/.local/bin`, `~/.cargo/bin`, `~/go/bin`), runs
`harness serve --addr 127.0.0.1:<port> --data-dir <app data dir>/harness`, waits up to 15 s for `/health`, and stops it (SIGTERM, then SIGKILL after 3 s, whole process group) on quit.
Output goes to `harness.log` in the app log directory (capped at 2 MiB, one `.1` file kept). A failed start shows the message, the last 20 log lines and Retry.

Overrides: `OCTO_BRIDGE_URL=http://host:port` starts nothing and uses that harness; `VITE_HARNESS_BRIDGE_URL` (build time) does the same for the UI. In a browser the app connects to
`VITE_HARNESS_BRIDGE_URL` (default `http://127.0.0.1:8790`); if nothing answers it shows an offline screen with the command and keeps retrying.

Not covered: if the app is killed with SIGKILL or crashes hard, nothing can stop the harness at that moment. The harness exits at its next log line (its pipe is gone), and the next launch
terminates a leftover `harness` group recorded in `harness.pid`; agent processes started by the harness can outlive it until they finish. Windows has no process-group handling here.

## Demo mode

Open `http://localhost:1420/?demo=1` to run against an in-memory bridge (`createDemoBridge()` from `@octo/ui/demo`, loaded only for `?demo=`)
seeded with three projects: a finished investigation, a live run that streams scripted events, and an empty
project. Messages you send in demo mode run a short scripted turn. `?demo=empty` starts with no projects.
