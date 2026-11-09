# Octo monorepo

Apps-directory monorepo. Today it contains one application:

| App | Path | Description |
| --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust HTTP proxy for OpenAI / Anthropic / OpenRouter, plus an autoroute model ladder |
| **harness** | [`apps/harness/`](./apps/harness/) | Go Anthropic Messages agent loop (local + remote tools, SQLite sessions) |

There are no shared libraries yet. A future frontend (any language) should live under `apps/<name>/`.

## Documentation

| Guide | Contents |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | Monorepo map + how agents should work here |
| [apps/router/README.md](./apps/router/README.md) | Octo user guide (curl, Claude Code, history) |
| [apps/router/docs/README.md](./apps/router/docs/README.md) | Product docs index |
| [apps/harness/docs/README.md](./apps/harness/docs/README.md) | Harness product docs index |
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
