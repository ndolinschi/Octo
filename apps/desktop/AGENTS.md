# `@octo/desktop` — agent instructions

Host for the shared UI: a Vite app (`src/`) inside a Tauri 2 shell (`src-tauri/`). It contains wiring only —
screens live in [`packages/ui`](../../packages/ui/AGENTS.md), the bridge client in
[`packages/agent-client`](../../packages/agent-client/AGENTS.md). Architecture: [`docs/architecture.md`](./docs/architecture.md).

## What belongs here

- `src/main.tsx` mounts; `src/App.tsx` chooses a bridge (HTTP at `resolveBridgeUrl()`, or the demo bridge for
  `?demo=`) and renders `OctoApp` with `shell="desktop"`.
- Anything that needs the OS (`@tauri-apps/*`: file pickers, opening files, window chrome) is implemented here and
  passed to the UI as `HostCapabilities`. It never goes into `packages/ui`.
- `src/styles.css` imports Tailwind and then `@octo/ui/styles.css`.
- `src-tauri/` is Rust and Tauri configuration only.

Keep logic out of components: selection logic (query parameters → bridge options) should be a pure function.

## Commands

```bash
pnpm install
pnpm --filter @octo/desktop dev        # http://localhost:1420 (add ?demo=1 for demo data)
pnpm --filter @octo/desktop lint       # tsc --noEmit && eslint . (also type-checks the UI sources it imports)
pnpm --filter @octo/desktop build
node scripts/check-bundle-size.mjs     # from the repo root, after the build
cd apps/desktop/src-tauri && cargo check
pnpm --filter @octo/desktop tauri dev  # needs the OS prerequisites for Tauri
```

The Tauri shell has not been exercised in the recent UI work (only the browser host); say so if you rely on it.
The desktop app does not start the harness: run `harness serve` yourself (see `apps/harness/README.md`).
Do not share SQLite or config files with the harness or the router.
