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

## Bridge

The app connects to `VITE_HARNESS_BRIDGE_URL` (default `http://127.0.0.1:8790`). Start the bridge first:

```bash
cd apps/harness && go run ./cmd/harness serve
```

If nothing answers, the app shows an offline screen with the command and keeps retrying.

## Demo mode

Open `http://localhost:1420/?demo=1` to run against an in-memory bridge (`createDemoBridge()` from `@octo/ui/demo`, loaded only for `?demo=`)
seeded with three projects: a finished investigation, a live run that streams scripted events, and an empty
project. Messages you send in demo mode run a short scripted turn. `?demo=empty` starts with no projects.
