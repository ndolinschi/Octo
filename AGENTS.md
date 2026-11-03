# Octo — agent instructions

Instructions for AI coding agents working in this repository.

## Project

**Octo** is a Rust **HTTP proxy** (Axum 0.8, Tokio 1) in a single application crate (`octo`), edition **2021**. It exposes provider-shaped routes on a local bind address and forwards requests upstream with streaming responses.

| Local route | Upstream (defaults in `config.toml`) |
| --- | --- |
| `POST /v1/chat/completions` | [OpenRouter](https://openrouter.ai/) OpenAI-compatible API |
| `POST /v1/decisions` | OpenRouter [alpha Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request) (Jev / structured decisions) |
| `POST /v1/messages` | Anthropic Messages API |

OpenAI-style chat is **not** wired to `api.openai.com` by default: `[openrouter].chat_completions_url` points at OpenRouter so clients use OpenRouter model slugs (e.g. `openai/gpt-4o-mini`) and a Bearer OpenRouter API key. Decisions use the same key on `POST /v1/decisions` (forwarded to OpenRouter alpha Decisions). Anthropic still targets `api.anthropic.com` unless changed in config.

User-facing curl examples and model samples: [README.md](./README.md).

## Environment setup

After clone, initialize vendored skills:

```bash
git submodule update --init --recursive
```

Rust toolchain: install via [rustup](https://rustup.rs/). Verify with `cargo --version`.

Run the proxy from the repo root (reads `./config.toml` unless overridden):

```bash
cargo run
```

Default listen address: `127.0.0.1:8080` (`[server].bind_addr`).

Vendored agent skills (after submodule init):

| Pack | Path |
| --- | --- |
| Superpowers | `.cursor/skills/superpowers/` |
| Ponytail | `.cursor/skills/ponytail/` |

### Editor

Use **rust-analyzer** in Cursor/VS Code. Open the repository root (folder containing `Cargo.toml`).

Recommended extensions (see `.vscode/extensions.json`):

- `rust-lang.rust-analyzer`

## Configuration

All operational defaults live in root **`config.toml`**, not as literals in Rust.

- Override path: environment variable **`OCTO_CONFIG`** (path to another TOML file).
- Loader: `src/config.rs` (serde + `toml`); maps sections into `Config` used by `AppState`.

Typical keys:

- `[server]` — `bind_addr`
- `[limits]` — `max_body_bytes` (request body cap for proxy reads)
- `[openrouter]` — `chat_completions_url`, `chat_completions_path`, `decisions_url`, `decisions_path`, optional `http_referer` and `openrouter_title` (attribution defaults when the client omits them)
- `[llm.chat]` / `[llm.messages]` — `backend` selects implementation (`openrouter`, `anthropic`, …)
- `[decision]` — `backend` selects decision implementation (`openrouter` today; `openai` when added)
- `[anthropic]` — `messages_url`, `messages_path`, `api_version` (default `anthropic-version` when the client omits it)

To use direct OpenAI chat instead of OpenRouter, set `openrouter.chat_completions_url` to `https://api.openai.com/v1/chat/completions`.

Do not commit API keys; clients send credentials per request (`Authorization` for OpenRouter/OpenAI-style chat, `x-api-key` for Anthropic).

## Code layout

| Area | Role |
| --- | --- |
| `src/main.rs` | Tracing init; calls `proxy::run()` |
| `src/config.rs` | Load TOML → `Config` |
| `src/state.rs` | `AppState`: `reqwest::Client`, `Config`, generic `llm::Providers`, `decision::Providers` |
| `src/routes.rs` | App router: `TraceLayer`, state |
| `src/proxy/mod.rs` | Bind, serve, graceful shutdown |
| `src/proxy/routes.rs` | Proxy route paths from config |
| `src/proxy/handler.rs` | Thin Axum handlers |
| `src/proxy/error.rs` | `ProxyError` → JSON `{"error":"..."}` (400/413/502) |
| `src/providers/llm/traits.rs` | `ChatCompletionsForward`, `MessagesForward` |
| `src/providers/llm/backend.rs` | Config-selected enums + `Providers<C, M>` wiring |
| `src/providers/llm/openai.rs` | OpenRouter-shaped chat forward (implements trait) |
| `src/providers/llm/anthropic.rs` | Messages forward (implements trait) |
| `src/providers/decision/traits.rs` | `DecisionsForward` |
| `src/providers/decision/backend.rs` | Config-selected `DecisionsBackend` + `Providers<D>` |
| `src/providers/decision/openrouter.rs` | OpenRouter alpha Decisions forward (implements trait) |
| `src/providers/openrouter/attribution.rs` | Shared Referer / title defaults for OpenRouter upstreams |
| `src/providers/utils.rs` | Buffered POST proxy, streaming body, allowlisted response headers |

Conventions for edits: `.cursor/rules/octo-rust.mdc` (module boundaries, no Rust comments unless asked, fmt/clippy/test before finishing).

## Proxy behavior (agents should preserve)

- **Request bodies:** read up to `max_body_bytes`, then POST upstream; stream response bytes back.
- **Chat route:** forward `Authorization`; apply client `Referer` / `X-OpenRouter-Title` (or config defaults); default `Content-Type` to JSON if missing.
- **Decisions route:** same auth and OpenRouter attribution as chat; body forwarded unchanged to `decisions_url`.
- **Anthropic route:** forward `x-api-key`; `anthropic-version` from client or config default.
- **Response headers:** pass through a safe allowlist (`Content-Type`, `Cache-Control`, `x-request-id`, `retry-after`, `openai-*`, `x-ratelimit-*`, `anthropic-ratelimit-*`).
- **Errors:** proxy failures return JSON, not plain text.

## Superpowers

This repo includes Superpowers skills as a git submodule:

`.cursor/skills/superpowers/`

1. **Cursor (local IDE):** install the plugin for hooks and automatic skill bootstrap:

   ```text
   /add-plugin superpowers
   ```

2. **All agents:** project rule `.cursor/rules/superpowers-bootstrap.mdc` applies every session. Read skills with the `Read` tool:

   `.cursor/skills/superpowers/skills/{skill-name}/SKILL.md`

   Invoke `using-superpowers` at the start of work, then use process skills when relevant (`brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, etc.).

User messages and this file take precedence over skills.

## Ponytail

Ponytail (“lazy senior dev”) is vendored at:

`.cursor/skills/ponytail/`

Project rule `.cursor/rules/ponytail-bootstrap.mdc` applies every session. Read the main skill before substantive coding:

`.cursor/skills/ponytail/skills/ponytail/SKILL.md`

Optional Cursor hooks (level switching via `/ponytail …` in chat):

```bash
node .cursor/skills/ponytail/scripts/cursor-hooks.js install --project
```

Upstream install docs: `.cursor/skills/ponytail/INSTALL.md` and `.cursor/skills/ponytail/docs/cursor-hooks.md`.

## Rust rules

Production-oriented Cursor rules from [tyrchen/cursor-rust-rules](https://github.com/tyrchen/cursor-rust-rules) are vendored under:

`.cursor/rules/rust/`

- **Router:** `main.mdc` (applies when editing `*.rs` / `Cargo.toml`)
- **This crate:** `octo-rust.mdc` — simple binary defaults

Do not fight the borrow checker; match existing style; keep diffs minimal unless the task requires more.

## Commands

| Task | Command |
| --- | --- |
| Build | `cargo build` |
| Run | `cargo run` |
| Test | `cargo test` |
| Format | `cargo fmt` |
| Lint | `cargo clippy -- -D warnings` |

Optional: `RUST_LOG=debug cargo run` for more tracing (default filter is `info`).

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push with `git push -u origin <branch>`
- Open pull requests against `main`

## What not to do

- Do not commit `target/` or local secrets (API keys in config or env files checked into git)
- Do not hardcode bind URLs, paths, or limits in Rust when they belong in `config.toml`
- Do not add large dependencies without a clear requirement
- Do not skip verification when a Superpowers skill requires it (tests, repro steps, etc.)
