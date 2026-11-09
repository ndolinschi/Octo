# Octo monorepo

Apps-directory monorepo with shared frontend packages.

| App / package | Path | Description |
| --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust HTTP proxy for OpenAI / Anthropic / OpenRouter, plus an autoroute model ladder |
| **harness** | [`apps/harness/`](./apps/harness/) | Go Anthropic Messages agent loop (local + remote tools, SQLite sessions) |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Tauri shell for the shared UI (local tools via future harness bridge) |
| **ui** | [`packages/ui/`](./packages/ui/) | Shared React UI (`@octo/ui`) for desktop and future web |
| **web** (planned) | [`apps/web/`](./apps/web/) | Future static host — remote tools on Claude infra |

## Documentation

| Guide | Contents |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | Monorepo map + how agents should work here |
| [apps/router/README.md](./apps/router/README.md) | Octo user guide (curl, Claude Code, history) |
| [apps/router/docs/README.md](./apps/router/docs/README.md) | Product docs index |
| [apps/harness/docs/README.md](./apps/harness/docs/README.md) | Harness product docs index |
| [apps/desktop/docs/architecture.md](./apps/desktop/docs/architecture.md) | Desktop shell + UI boundaries |
| [docs/superpowers/specs/2026-11-09-desktop-ui-design.md](./docs/superpowers/specs/2026-11-09-desktop-ui-design.md) | Shared UI / desktop / web design |
| [apps/router/AGENTS.md](./apps/router/AGENTS.md) | Router operational notes for contributors / agents |

## Quick start (router)

```bash
git submodule update --init --recursive
cargo build -p octo
cd apps/router && cargo run
```

Default listen address: `127.0.0.1:8080`. Full setup, config, and examples: [`apps/router/README.md`](./apps/router/README.md).

## Development

Rust workspace root is this directory (`Cargo.toml` members = `apps/router`). Prefer:

```bash
cargo test -p octo
cargo clippy -p octo --all-targets -- -D warnings
```

Run the binary from `apps/router` (or set `OCTO_CONFIG`) so the split `config/` TOML files load from the process cwd.
