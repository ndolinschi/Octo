# Monorepo — agent instructions

This repository is an **apps-directory monorepo**. Applications live under `apps/`. There are no shared libraries yet.

| App | Path | Stack | Notes |
| --- | --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust (crate `octo`) | HTTP proxy + autoroute; only app today |

Future apps (including a non-Rust frontend) go under `apps/<name>/` with their own toolchain. Do not invent shared crates until something is actually shared.

## Layout

```text
/
  Cargo.toml              # Cargo workspace (Rust members only)
  rust-toolchain.toml
  .cargo/config.toml      # SQLX_OFFLINE for the workspace
  AGENTS.md               # this file
  apps/router/            # Octo proxy application
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

## Editor

Open the **monorepo root** (folder with the workspace `Cargo.toml`) so rust-analyzer sees the workspace. Extension hint: `.vscode/extensions.json` → `rust-lang.rust-analyzer`.

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

- Do not put application source back at the repo root; new code for the proxy goes in `apps/router/`
- Do not add empty `packages/` or shared crates “for later”
- Do not commit `target/`, local secrets, or skip verification when skills require it
