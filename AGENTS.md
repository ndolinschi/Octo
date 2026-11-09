# Monorepo — agent instructions

This repository is an **apps-directory monorepo**. Applications live under `apps/`. Shared frontend code lives under `packages/`.

| App / package | Path | Stack | Notes |
| --- | --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust (crate `octo`) | HTTP proxy + autoroute |
| **harness** | [`apps/harness/`](./apps/harness/) | Go 1.26+ | Anthropic Messages agent client (tools, sessions) |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Tauri 2 + React | Shell for shared UI (local tools via future bridge) |
| **ui** | [`packages/ui/`](./packages/ui/) | React | Shell-agnostic screens (`@octo/ui`) |
| **agent-client** | [`packages/agent-client/`](./packages/agent-client/) | TypeScript | Bridge URL + future HTTP client (`@octo/agent-client`) |

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
```

## Desktop + UI (pnpm)

Design: [`docs/superpowers/specs/2026-11-09-desktop-ui-design.md`](./docs/superpowers/specs/2026-11-09-desktop-ui-design.md). Rules: `.cursor/rules/octo-frontend.mdc`.

```bash
pnpm install
pnpm --filter @octo/agent-client test
pnpm --filter @octo/desktop build
cd apps/desktop/src-tauri && cargo check
```

Phase 1 is UI scaffold only. Harness **bridge** (`harness serve`) is Phase 2 — see [`docs/superpowers/plans/2026-11-09-harness-bridge-phase2.md`](./docs/superpowers/plans/2026-11-09-harness-bridge-phase2.md). Set `VITE_HARNESS_BRIDGE_URL` when the bridge exists (default `http://127.0.0.1:8790`).

Do not share SQLite/config between harness, router, and desktop.

## Editor

Open the **monorepo root** for rust-analyzer (Cargo workspace) and gopls (`apps/harness/go.mod`). For UI, tsserver sees `pnpm-workspace.yaml`. Extensions: `.vscode/extensions.json`.

## Skills

```bash
git submodule update --init --recursive
```

Vendored: `.cursor/skills/superpowers/`, `.cursor/skills/ponytail/`.

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push: `git push -u origin <branch>`
- PRs against `main`

## What not to do

- Do not put router source back at the repo root; proxy code stays in `apps/router/`
- Do not import Tauri APIs from `packages/ui`
- Do not mix harness and router persistence or config loaders
- Do not commit `target/`, `node_modules/`, `apps/harness/data/`, `apps/desktop/dist/`, local secrets
