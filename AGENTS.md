# Octo — agent instructions

Instructions for AI coding agents working in this repository.

## Project

**Octo** is a Rust **HTTP proxy** (Axum 0.8, Tokio 1) in a single application crate (`octo`), edition **2021**. It exposes provider-shaped routes on a local bind address and forwards requests upstream with streaming responses.

| Local route | Upstream (defaults in `config/`) |
| --- | --- |
| `POST /v1/chat/completions` (and OpenAI-compat aliases below) | Direct OpenAI **or** OpenRouter, selected per request |
| `POST /v1/decisions` (+ OpenRouter aliases) | OpenRouter alpha Decisions |
| `POST /v1/messages` (+ Claude/Anthropic aliases) | Anthropic Messages API |

**OpenAI-compatible chat (same JSON body):** upstream is chosen by **path alias**, then JSON `"type"` / `"octo_provider"`, then **`[llm.chat].backend`** (default `openai`). Values: `OPEN_AI`, `OPENAI`, `OPENROUTER`, `openrouter`, etc. Octo strips those fields before upstream.

**Path aliases (provider pinned by URL):**

| Alias paths | Provider |
| --- | --- |
| `/openai/completions`, `/openai/v1/chat/completions` | OpenAI |
| `/openrouter/completions`, `/openrouter/v1/chat/completions` | OpenRouter |
| `/claude/messages`, `/claude/v1/messages`, `/anthropic/messages`, `/anthropic/v1/messages` | Claude |
| `/openrouter/decisions`, `/openrouter/v1/decisions` | OpenRouter Decisions |

Config primary paths (`chat_completions_path`, `messages_path`, `decisions_path`) still apply; default chat path uses body/path selection above.

User-facing curl examples and model samples: [README.md](./README.md).

## Environment setup

After clone, initialize vendored skills:

```bash
git submodule update --init --recursive
```

Rust toolchain: install via [rustup](https://rustup.rs/). Verify with `cargo --version`.

Run the proxy from the repo root (loads the **`config/`** directory unless overridden):


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

Operational defaults live under **`config/`** (one focused TOML file per area), not as literals in Rust.

| File | Contents |
| --- | --- |
| `config/server.toml` | `[server]` — `bind_addr`, `allow_remote` |
| `config/upstream.toml` | `[upstream]` — connect and request timeouts |
| `config/limits.toml` | `[limits]` — `max_body_bytes` |
| `config/openai.toml` | `[openai]` — direct OpenAI chat URL |
| `config/openrouter.toml` | `[openrouter]` — chat/decisions URLs, paths, attribution defaults |
| `config/anthropic.toml` | `[anthropic]` — messages URL, path, API version |
| `config/llm.toml` | `[llm.chat]` / `[llm.messages]` backend defaults |
| `config/decision.toml` | `[decision]` backend |

- **Default load:** merge present files in `./config/` (known fragment names; missing files are skipped). Run from repo root.
- **`OCTO_CONFIG`:** path to another **`config/`** directory or a single legacy **`config.toml`** file (monolithic override).
- Loader: `src/config.rs` merges fragments, then maps into `Config` for `AppState`.

Section semantics (same as before, split across files above):

To use OpenRouter for chat, POST with `"type": "OPENROUTER"` or use `/openrouter/completions`. OpenRouter model slugs and Bearer keys apply on that path; direct OpenAI uses `/v1/chat/completions` (default) or `/openai/completions` with an OpenAI API key.

Do not commit API keys; clients send credentials per request (`Authorization` for OpenRouter/OpenAI-style chat, `x-api-key` for Anthropic).

**Threat model:** Octo has no proxy-side authentication. Default `server.allow_remote = false` binds loopback only. If you set `allow_remote = true`, treat the bind address like an open HTTP forwarder on your network (firewall/VPN only). Do not point upstream URLs at internal services you would not expose to clients holding API keys. `GET /health` returns 200 for liveness checks only.

**Upstream timeouts:** `[upstream].request_timeout_secs` (default 600) applies to the full reqwest call including streaming response bodies; very long SSE may need a higher limit.

## Code layout

| Area | Role |
| --- | --- |
| `src/main.rs` | Tracing init; calls `proxy::run()` |
| `src/config.rs` | Load TOML → `Config` |
| `src/state.rs` | `AppState`: `reqwest::Client`, `Config`, default chat provider, `llm::Wired`, `decision::Providers` |
| `src/routes.rs` | App router: `TraceLayer`, state |
| `src/proxy/mod.rs` | Bind, serve, graceful shutdown |
| `src/proxy/routes.rs` | Proxy route paths from config; `GET /health` |
| `src/proxy/handler.rs` | Thin Axum handlers |
| `src/proxy/error.rs` | `ProxyError` → JSON `{"error":"..."}` (400/413/502) |
| `src/providers/llm/traits.rs` | `ChatCompletions` (upstream URL), `Messages` |
| `src/providers/llm/wire.rs` | Config wiring + `Providers` (OpenAI, OpenRouter, Claude) |
| `src/providers/llm/openai.rs` | Direct OpenAI chat (`OpenAI`) |
| `src/providers/llm/openrouter.rs` | OpenRouter OpenAI-compatible chat (`OpenRouter`) |
| `src/providers/llm/claude.rs` | Claude Messages forward (`Claude`) |
| `src/proxy/select.rs` | Chat `type` / path provider resolution |
| `src/providers/decision/wire.rs` | Config wiring + `Providers` |
| `src/providers/decision/openrouter.rs` | OpenRouter Decisions forward (`[decision] backend = "openrouter"`) |
| `src/providers/openrouter/attribution.rs` | Shared Referer / title defaults for OpenRouter upstreams |
| `src/providers/utils.rs` | Buffered POST proxy, streaming body, allowlisted response headers |

Conventions for edits: `.cursor/rules/octo-rust.mdc` (module boundaries, no Rust comments unless asked, fmt/clippy/test before finishing).

## Proxy behavior (agents should preserve)

- **Request bodies:** read up to `max_body_bytes`, then POST upstream; stream response bytes back.
- **Chat route:** forward `Authorization`; apply client `Referer` / `X-OpenRouter-Title` (or config defaults); default `Content-Type` to JSON if missing.
- **Decisions route:** same auth and OpenRouter attribution as chat; body forwarded unchanged to `decisions_url`.
- **Anthropic route:** forward `x-api-key`; `anthropic-version` from client or config default.
- **Response headers:** pass through a safe allowlist (`Content-Type`, `Cache-Control`, `x-request-id`, `retry-after`, `openai-*`, `x-ratelimit-*`, `anthropic-ratelimit-*`).
- **Errors:** proxy failures return JSON, not plain text. Unknown chat `type` / `octo_provider` (when the route is not path-pinned) returns **400** `invalid provider selector`.

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
- Do not hardcode bind URLs, paths, or limits in Rust when they belong in `config/`
- Do not add large dependencies without a clear requirement
- Do not skip verification when a Superpowers skill requires it (tests, repro steps, etc.)
