# `@octo/desktop` — agent instructions

Host for the shared UI: a Vite app (`src/`) inside a Tauri 2 shell (`src-tauri/`). It contains wiring only —
screens live in [`packages/ui`](../../packages/ui/AGENTS.md), the bridge client in
[`packages/agent-client`](../../packages/agent-client/AGENTS.md). Architecture: [`docs/architecture.md`](./docs/architecture.md).

## What belongs here

- `src/main.tsx` mounts; `src/App.tsx` is wiring only: `chooseBridge(search, env)` (`src/bridgeChoice.ts`, pure, unit-tested:
  HTTP at `VITE_HARNESS_BRIDGE_URL`, or the demo bridge for `?demo=`) → `useBridge` (`src/useBridge.ts`; the demo is loaded
  from `@octo/ui/demo` with `import()` so a normal start never downloads it) → `OctoApp` with `shell="desktop"`.
- Anything that needs the OS (`@tauri-apps/*`: file pickers, opening files, window chrome) is implemented here and
  passed to the UI as `HostCapabilities`. It never goes into `packages/ui`.
- `src/styles.css` imports Tailwind and then `@octo/ui/styles.css`.
- `src-tauri/` is Rust and Tauri configuration only.

- Inside Tauri the shell runs the harness (design P5). `src/hostBridge.ts` (`useHostBridge`) calls the Rust commands
  `bridge_url` / `bridge_restart` / `bridge_log_tail` (the Tauri API is `import()`ed on demand), `src/HostStatus.tsx` is the
  "Starting Octo…" / failure screen (message, last 20 log lines, Retry), and `chooseBridge(search, env, hostUrl)` takes the URL.
  `usesHostBridge` (pure) decides: only inside Tauri, not `?demo=`, and no `VITE_HARNESS_BRIDGE_URL`. In a browser nothing changes.
- `src-tauri/sidecar/` is the `octo-sidecar` crate (no `tauri` dependency, so `cargo test -p octo-sidecar` runs anywhere):
  `port` (free port), `shellenv` (login-shell PATH, parser, fallback dirs), `process` (own process group, SIGTERM, 3 s, SIGKILL; pid file for crash cleanup),
  `logfile` (capped `harness.log`, tail), `health` (`GET /health` wait), `bridge` (the sequence; `OCTO_BRIDGE_URL` starts nothing).
  `src-tauri/src/lib.rs` is only glue: three commands and the exit hook.

Keep logic out of components: selection logic (query parameters → bridge options) is the pure `chooseBridge`; extend it with a test.

## Commands

```bash
pnpm install
pnpm --filter @octo/desktop dev        # http://localhost:1420 (add ?demo=1 for demo data)
pnpm --filter @octo/desktop lint       # tsc --noEmit && eslint . (also type-checks the UI sources it imports)
pnpm --filter @octo/desktop test       # node:test + tsx
pnpm --filter @octo/desktop build
node scripts/check-bundle-size.mjs     # from the repo root, after the build
cd apps/desktop/src-tauri && cargo check
pnpm --filter @octo/desktop tauri dev  # needs the OS prerequisites for Tauri
```

The Tauri shell has not been exercised in the recent UI work (only the browser host); say so if you rely on it.
The desktop app does not start the harness: run `harness serve` yourself (see `apps/harness/README.md`).
Do not share SQLite or config files with the harness or the router.
