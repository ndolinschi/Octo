# Monorepo — agent instructions

This repository is an **apps-directory monorepo**. Applications live under `apps/`. There are no shared libraries yet.

| App | Path | Stack | Notes |
| --- | --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust (crate `octo`) | HTTP proxy + autoroute |
| **harness** | [`harness/`](./harness/) | Go 1.26+ | Anthropic Messages agent client (tools, sessions) |

Future apps go under `apps/<name>/` (or a top-level module like `harness/` when intentionally separate). Do not invent shared libraries until something is actually shared.

## Layout

```text
/
  Cargo.toml              # Cargo workspace (Rust members only)
  rust-toolchain.toml
  .cargo/config.toml      # SQLX_OFFLINE for the workspace
  AGENTS.md               # this file
  apps/router/            # Octo proxy application
  harness/                # Go agent harness (own go.mod)
  scripts/                # host tooling (e.g. Go toolchain install)
  .cursor/                # skills + rules (repo-wide)
  .github/workflows/      # CI
```

## Router (Octo)

Operational detail (config, history, sqlx, what not to break): **[`apps/router/AGENTS.md`](./apps/router/AGENTS.md)**.

Product docs: [`apps/router/docs/README.md`](./apps/router/docs/README.md).

### Commands

From the **monorepo root** (preferred for CI / agents):

```bash
git submodule update --init --recursive
cargo build -p octo
cargo test -p octo
cargo clippy -p octo --all-targets -- -D warnings
cargo fmt --check
```

Run the proxy from the **app root** so `./config/` resolves (cwd-relative):

```bash
cd apps/router
cargo run
```

From the monorepo root with an explicit config path:

```bash
OCTO_CONFIG=apps/router/config cargo run -p octo
```

SQLx offline cache refresh (cwd = `apps/router`):

```bash
cd apps/router
export DATABASE_URL="sqlite:./prepare.db"
cargo sqlx migrate run
SQLX_OFFLINE=false cargo sqlx prepare -- --tests
```

Commit updated `apps/router/.sqlx/` with SQL / `query!` changes.

## Harness (Go)

Product docs: [`harness/docs/README.md`](./harness/docs/README.md). Cursor rules: `.cursor/rules/octo-go.mdc`, `go-pr-checklist.mdc`, `verify-go.mdc`.

From the monorepo root:

```bash
bash scripts/install-go-toolchain.sh   # idempotent; pins Go 1.26.x into /usr/local
cd harness
go test ./...
go vet ./...
go build -o /tmp/octo-harness ./cmd/harness
```

Do not share SQLite/config with the router. Point `ANTHROPIC_BASE_URL` at Octo when using the proxy.

## Editor

Open the **monorepo root** (folder with the workspace `Cargo.toml`) so rust-analyzer sees the workspace. For harness, open or multi-root `harness/` so gopls sees `go.mod`. Extensions: `.vscode/extensions.json` → `rust-lang.rust-analyzer`, `golang.go`.

## Skills

Vendored under `.cursor/skills/` (git submodules). Init after clone:

```bash
git submodule update --init --recursive
```

| Pack | Path |
| --- | --- |
| Superpowers | `.cursor/skills/superpowers/` |
| Ponytail | `.cursor/skills/ponytail/` |

Bootstrap rules: `.cursor/rules/superpowers-bootstrap.mdc`, `.cursor/rules/ponytail-bootstrap.mdc`.

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push: `git push -u origin <branch>`
- PRs against `main`

## What not to do

- Do not put router source back at the repo root; proxy code stays in `apps/router/`
- Do not mix harness and router persistence or config loaders
- Do not add empty `packages/` or shared crates “for later”
- Do not commit `target/`, `harness/data/`, local secrets, or skip verification when skills require it
