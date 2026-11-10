# Monorepo — agent instructions

This repository is an **apps-directory monorepo**. Applications live under `apps/`. Shared frontend code lives under `packages/`.

| App / package | Path | Stack | Notes |
| --- | --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust (crate `octo`) | HTTP proxy + autoroute |
| **harness** | [`apps/harness/`](./apps/harness/) | Go 1.26+ | Project-based agent harness: `harness serve` bridge, orchestrator + sub-agents, per-project SQLite, file API, plugins (language servers, ACP agents, tool servers) |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Vite + React + Tailwind 4 (Tauri 2 shell) | Host for the shared UI (talks to `harness serve`; `?demo=1` for demo data) |
| **ui** | [`packages/ui/`](./packages/ui/) | React | Shell-agnostic UI (`@octo/ui`): sidebar, tab workspace, chat, Monaco editor with comments and LSP |
| **agent-client** | [`packages/agent-client/`](./packages/agent-client/) | TypeScript | Bridge HTTP + SSE client, state reducer, message-port bridge, file/plugin/LSP methods (`@octo/agent-client`) |

**Current state and next steps:** [`docs/superpowers/HANDOVER.md`](./docs/superpowers/HANDOVER.md).

Future **web** host: [`apps/web/`](./apps/web/) (stub). Do not invent other shared packages until something is actually shared twice.

## Layout

```text
/
  Cargo.toml              # Cargo workspace (Rust members: apps/router only)
  package.json            # pnpm workspace root
  pnpm-workspace.yaml
  AGENTS.md               # this file
  apps/router/            # Octo proxy
  apps/harness/           # Go agent harness (own go.mod)
  apps/desktop/           # Tauri shell
  apps/web/               # future static web shell (README only)
  packages/ui/            # shared React UI
  packages/agent-client/  # harness bridge client (Phase 2 API)
  scripts/                # host tooling
  .cursor/                # skills + rules
  .github/workflows/      # CI
```

## Router (Octo)

Operational detail: **[`apps/router/AGENTS.md`](./apps/router/AGENTS.md)**. Product docs: [`apps/router/docs/README.md`](./apps/router/docs/README.md).

```bash
git submodule update --init --recursive
cargo build -p octo
cargo test -p octo
cargo clippy -p octo --all-targets -- -D warnings
cargo fmt --check
cd apps/router && cargo run
```

## Harness (Go)

Product docs: [`apps/harness/docs/README.md`](./apps/harness/docs/README.md). Cursor rules: `.cursor/rules/octo-go.mdc`, `go-pr-checklist.mdc`, `verify-go.mdc`.

```bash
bash scripts/install-go-toolchain.sh
cd apps/harness
go test ./...
go vet ./...

# Full stack without an API key (three terminals)
go run ./examples/mockllm
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791
pnpm --filter @octo/desktop dev   # from repo root, then open http://localhost:1420
```

## Desktop + UI (pnpm)

Design: [`docs/superpowers/specs/2026-11-10-project-harness-design.md`](./docs/superpowers/specs/2026-11-10-project-harness-design.md) (projects, bridge API) and [`2026-11-10-project-harness-ui.md`](./docs/superpowers/specs/2026-11-10-project-harness-ui.md) (UI). Rules: `.cursor/rules/octo-frontend.mdc`.

```bash
pnpm install
pnpm --filter @octo/agent-client test
pnpm --filter @octo/ui lint
pnpm --filter @octo/desktop build
cd apps/desktop/src-tauri && cargo check
```

The UI talks only to the harness bridge (`harness serve`, default `http://127.0.0.1:8790`; override with `VITE_HARNESS_BRIDGE_URL`). Open the app with `?demo=1` to run against the in-memory demo bridge with no backend.

Do not share SQLite/config between harness, router, and desktop.

## Editor

Open the **monorepo root** for rust-analyzer (Cargo workspace) and gopls (`apps/harness/go.mod`). For UI, tsserver sees `pnpm-workspace.yaml`. Extensions: `.vscode/extensions.json`.

## Skills

```bash
git submodule update --init --recursive
```

Vendored: `.cursor/skills/superpowers/`, `.cursor/skills/ponytail/`, `.cursor/skills/interfaces/` (UI review and polish: `better-interface`, `better-ui`, `better-typography`, `better-colors`, `better-layout`, `better-writing`).

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push: `git push -u origin <branch>`
- PRs against `main`

## What not to do

- Do not put router source back at the repo root; proxy code stays in `apps/router/`
- Do not import Tauri APIs from `packages/ui`
- Do not mix harness and router persistence or config loaders
- Do not commit `target/`, `node_modules/`, `apps/harness/data/`, `apps/desktop/dist/`, local secrets
