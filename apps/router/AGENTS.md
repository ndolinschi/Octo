# Octo (router) — agent instructions

Operational instructions for the **router** app at `apps/router/` in the monorepo. Repo-wide map: **[`../../AGENTS.md`](../../AGENTS.md)**.

Product docs (architecture, routes, autoroute, history, config, **works / gaps**): **[docs/README.md](./docs/README.md)**. Shortcut: [ARCHITECTURE.md](./ARCHITECTURE.md) → `docs/architecture.md`. Keep this file operational (how to run, configure, test, and what not to break).

## Project

**Octo** is a Rust **HTTP proxy** (Axum 0.8, Tokio 1) in a single application crate (`octo`), edition **2021**, packaged as the monorepo app **`apps/router`**. It exposes provider-shaped routes on a local bind address and forwards requests upstream with streaming responses. **`/autoroute/*`** adds session-aware model ladder routing (JEV, sticky, stall, budget) and body hygiene (`strip_fields`, `require_parameters`) before OpenRouter.

| Local route | Upstream (defaults in `config/`) |
| --- | --- |
| `POST /v1/chat/completions` (and OpenAI-compat aliases below) | Direct OpenAI **or** OpenRouter, selected per request |
| `POST /v1/decisions` (+ OpenRouter aliases) | OpenRouter alpha Decisions |
| `POST /v1/messages` (+ aliases below) | Direct Anthropic **or** OpenRouter Messages API, selected per request |

**OpenAI-compatible chat (same JSON body):** upstream is chosen by **path alias**, then JSON `"type"` / `"octo_provider"`, then **`[llm.chat].backend`** (default `openai`). Values: `OPEN_AI`, `OPENAI`, `OPENROUTER`, `openrouter`, etc. Octo strips those fields before upstream.

**Anthropic Messages API (same JSON body):** upstream is chosen by **path alias**, then JSON `"type"` / `"octo_provider"`, then **`[llm.messages].backend`**. Shipped **`config/llm.toml`** sets **`openrouter`** (Claude Code + Bearer → OpenRouter Messages). If the `[llm.messages]` section is omitted entirely, Rust serde defaults to **`claude`** (direct Anthropic, `x-api-key`). Values: `claude`, `anthropic`, `openrouter`, etc. Octo strips selector fields before upstream.

**Path aliases (provider pinned by URL):**

| Alias paths | Provider |
| --- | --- |
| `/openai/completions`, `/openai/v1/chat/completions` | OpenAI |
| `/openrouter/completions`, `/openrouter/v1/chat/completions` | OpenRouter chat |
| `/claude/messages`, `/claude/v1/messages`, `/anthropic/messages`, `/anthropic/v1/messages` | Anthropic (direct) |
| `/openrouter/messages`, `/openrouter/v1/messages` | OpenRouter Messages API |
| `/openrouter/decisions`, `/openrouter/v1/decisions` | OpenRouter Decisions |

Config primary paths (`chat_completions_path`, `messages_path`, `decisions_path`) still apply; default chat path uses body/path selection above.

User-facing curl examples and model samples: [README.md](./README.md).

## Environment setup

After clone, from the **monorepo root**, initialize vendored skills:

```bash
git submodule update --init --recursive
```

Rust toolchain: install via [rustup](https://rustup.rs/). Verify with `cargo --version`.

Run the proxy from **this app directory** (`apps/router`) so `./config/` resolves (cwd-relative) unless overridden:

```bash
cd apps/router
cargo run
```

From the monorepo root: `OCTO_CONFIG=apps/router/config cargo run -p octo`.

Default listen address: `127.0.0.1:8080` (`[server].bind_addr`).

Vendored agent skills live at the monorepo root (after submodule init):

| Pack | Path |
| --- | --- |
| Superpowers | `../../.cursor/skills/superpowers/` |
| Ponytail | `../../.cursor/skills/ponytail/` |

### Editor

Use **rust-analyzer** in Cursor/VS Code. Open the **monorepo root** (workspace `Cargo.toml`) so the `apps/router` member is visible.

Recommended extensions (see `../../.vscode/extensions.json`):

- `rust-lang.rust-analyzer`

## Configuration

Operational defaults live under **`config/`** (one focused TOML file per area), not as literals in Rust.

| File | Contents |
| --- | --- |
| `config/server.toml` | `[server]` — `bind_addr`, `allow_remote`, `client_auth_key` |
| `config/upstream.toml` | `[upstream]` — connect and request timeouts |
| `config/limits.toml` | `[limits]` — `max_body_bytes` |
| `config/openai.toml` | `[openai]` — direct OpenAI chat URL |
| `config/openrouter.toml` | `[openrouter]` — chat/decisions/messages URLs, paths, attribution defaults |
| `config/anthropic.toml` | `[anthropic]` — messages URL, path, API version |
| `config/llm.toml` | `[llm.chat]` / `[llm.messages]` backend defaults |
| `config/decision.toml` | `[decision]` backend |
| `config/history.toml` | `[history]` — SQLite path, optional token HMAC key, `store_payloads` (default true) |
| `config/autoroute.toml` | `[autoroute]` — ladder, stall/sticky, budget, housekeeping trim, optional `provider_order`, `strip_fields`, `require_parameters`, `background_*`, `server_tool_mode` |
| `config/prices.toml` | `[prices."<slug>"]` — USD/1M token rates (all four required for estimate) + optional `billed_as` |

- **Default load:** merge present files in `./config/` (known fragment names; missing files are skipped). Run with cwd = `apps/router`.
- **`OCTO_CONFIG`:** path to another **`config/`** directory or a single legacy **`config.toml`** file (monolithic override).
- Loader: `src/config.rs` merges fragments, then maps into `Config` for `AppState`.

Section semantics (same as before, split across files above):

To use OpenRouter for chat, POST with `"type": "OPENROUTER"` or use `/openrouter/completions`. OpenRouter model slugs and Bearer keys apply on that path; direct OpenAI uses `/v1/chat/completions` (default) or `/openai/completions` with an OpenAI API key.

Do not commit API keys; clients send credentials per request (`Authorization` for OpenRouter/OpenAI-style chat and OpenRouter Messages, `x-api-key` for direct Anthropic Messages).

**Threat model:** Default `server.allow_remote = false` binds loopback only. Non-loopback binds require `allow_remote = true` **and** a non-empty `server.client_auth_key` (startup refuse otherwise). When `client_auth_key` is set, every request except `GET /health` must send matching `x-octo-key` (401 otherwise). Do not point upstream URLs at internal services you would not expose to clients holding API keys.

**Upstream timeouts:** `[upstream].request_timeout_secs` (default 600) applies to the full reqwest call including streaming response bodies; very long SSE may need a higher limit.

## Request history (SQLite)

Octo records a **side copy** of proxied chat, decisions, and messages calls. Live proxy behavior is unchanged: bytes stream to the client immediately; persistence runs asynchronously.

| Concern | Behavior |
| --- | --- |
| Database | SQLite via **sqlx** (`config/history.toml` → `database_path`, default `data/history.sqlite`) |
| Schema | `migrations/` applied at connect; offline compile uses committed **`.sqlx/`** (`SQLX_OFFLINE=true` in monorepo-root `.cargo/config.toml`) |
| Caller identity | HMAC-SHA256 of client secret (`Authorization` / `x-api-key`); raw tokens are not stored |
| Token key | `OCTO_HISTORY_TOKEN_KEY` env, `history.token_key` in config, or auto-generated `.key` beside the DB (restrictive file permissions on Unix) |
| Failure mode | If DB open/migrate fails, proxy keeps serving with history disabled |
| Insert backpressure | Up to 32 concurrent inserts; waits up to **5s** for a slot, then **drops** the row (warn log). Bursts can lose history while the proxy still succeeds. |
| Stream errors | If the upstream body stream fails after headers were sent, the client may see a truncated body; history keeps the **header status** (e.g. 200) and logs a warn with `session_id`. |
| Shutdown | Graceful drain waits for in-flight inserts (bounded queue) |

**Stored fields (metrics-focused):** kind, provider, model, optional last user message snippet, capped input/output raw capture, **`request_payload` / `response_payload`** (JSON with `provider` + nested `payload` per vendor shape), status, latency, byte sizes, token counts, **cost in micro-dollars** (`cost_micros`), plus `or_cost_micros` / `upstream_cost_micros` / `estimated_cost_micros` / `cost_source` / `is_byok` / `upstream_provider` / `trimmed_from_tokens`, plus observe-only `client_model` / `client_has_thinking` / `client_tool_names` / `bg_signal` / `hk_text_signal`. With `history.store_payloads = false`, text payload columns are omitted (NULL/blank) while metrics and observe columns remain. Prompts are not logged verbatim in tracing.

**Cost precedence:** first non-zero of upstream BYOK → OpenRouter `usage.cost` → `prices.toml` estimate (only when all four rates are present for the slug; explicit `0.0` counts); else `cost_source = "none"`. Messages-shape `input_tokens` is the uncached count (cache reads are added); chat-shape `prompt_tokens` includes cache reads (subtracted for the input rate). Budget: `session_budget_usd = 0` is off; `session_budget_action` is `downgrade` (cheapest tier by price) or `reject` (402); header `x-octo-budget-key` shares spend across sessions and is stripped before upstream. Integration tests for these fixes: `tests/cost_fixes.rs`, `tests/autoroute_retry.rs`. Harness integration (hint headers, result headers, calls endpoint, header budget, compaction trigger): [docs/autoroute.md](./docs/autoroute.md#harness-integration), `tests/harness_integration.rs`.

**session_outcomes:** async upsert from last-user `tool_result` blocks (cargo / pytest / unittest summaries), keyed by observe `session_id` (includes `#sub:{hash}` when applicable). Parses the live request even when `store_payloads = false`.

**Autoroute status:** `GET /autoroute/status` / `?session=` returns JSON for Claude Code statusline (`scripts/statusline.sh`).

**Payload modules:** `src/history/payload/` dispatches on `CallKind` + `CallProvider` (`openai_chat`, `claude`, `decision`, shared `common` for usage/SSE). OpenAI and OpenRouter **chat** share the OpenAI chat shape; **messages** calls (`CallKind::Messages`, direct Anthropic or OpenRouter) use the Anthropic messages shape; decisions use `decision.rs`.

**OpenRouter model catalog (routing):** `octo::providers::openrouter::fetch_models` GETs the public models API (`DEFAULT_MODELS_URL`), optionally with a Bearer key, and returns `OpenRouterModels { free, paid }` (`models_from_json` for tests). Free = `:free` suffix or zero prompt/completion pricing.

**Reconcile:** `python3 scripts/reconcile_costs.py data/history.sqlite [--provider-csv invoice.csv]` groups calls by day/model, maps `billed_as` from `prices.toml`, and flags `|diff| > 5%` vs the CSV.

Integration tests: `tests/history_store.rs`, `tests/history_payload.rs`, `tests/session_outcomes.rs`, `tests/select_provider.rs`. Do not add `#[cfg(test)]` modules in `src/` (see `.cursor/rules/tests-live-outside-source.mdc`).

After changing SQL or `query!` macros (cwd = `apps/router`):

```bash
export DATABASE_URL="sqlite:./prepare.db"
cargo sqlx migrate run
SQLX_OFFLINE=false cargo sqlx prepare -- --tests
```

Commit updated **`apps/router/.sqlx/`** with the code change.

## Code layout

Full map: [docs/architecture.md](./docs/architecture.md). Quick index:

| Area | Role |
| --- | --- |
| `src/main.rs` | Tracing init; calls `proxy::run()` |
| `src/config.rs` | Load TOML fragments → `Config` |
| `src/state.rs` | `AppState`: client, config, providers, `history::History`, `auto::Auto` |
| `src/routes.rs` | App router: `TraceLayer`, state |
| `src/proxy/mod.rs` | Bind, history connect, serve, graceful shutdown + history drain |
| `src/proxy/routes.rs` | Proxy + autoroute paths; `GET /health` |
| `src/proxy/handler.rs` | Thin Axum handlers; builds `CallObserve` for history |
| `src/proxy/auth.rs` | Optional `x-octo-key` gate (skip `/health`) |
| `src/proxy/autoroute/` | Autoroute handlers, status JSON, compaction glue |
| `src/proxy/error.rs` | `ProxyError` → JSON (400/413/502); Anthropic-shaped remap |
| `src/proxy/select.rs` | Chat/messages `type` / path provider resolution → `CallProvider` |
| `src/auto/` | Decide pipeline: JEV, sticky, stall, catalog, `shape()`, routing meta |
| `src/history/` | SQLite pool, HMAC token hash, async inserts, cost, session outcomes, payloads |
| `src/providers/llm/` | Wired OpenAI / OpenRouter chat / Claude messages |
| `src/providers/decision/` | OpenRouter Decisions forward |
| `src/providers/openrouter/` | Attribution + shared forward helpers |
| `src/providers/utils.rs` | Buffered POST, stream tee + history capture, allowlisted headers |

Conventions for edits: `../../.cursor/rules/octo-rust.mdc` (module boundaries, no Rust comments unless asked). Quality gates and SQLx rules below.

## Proxy behavior (agents should preserve)

- **Request bodies:** read up to `max_body_bytes`, then POST upstream; stream response bytes back.
- **Chat route:** forward `Authorization`; apply client `Referer` / `X-OpenRouter-Title` (or config defaults); default `Content-Type` to JSON if missing.
- **Decisions route:** same auth and OpenRouter attribution as chat; body forwarded unchanged to `decisions_url`.
- **Anthropic route:** forward `x-api-key`; `anthropic-version` from client or config default.
- **Response headers:** pass through a safe allowlist (`Content-Type`, `Cache-Control`, `x-request-id`, `retry-after`, `openai-*`, `x-ratelimit-*`, `anthropic-ratelimit-*`).
- **Errors:** proxy failures return JSON, not plain text. Unknown chat `type` / `octo_provider` (when the route is not path-pinned) returns **400** `invalid provider selector`.
- **History:** must not block or alter streaming; usage JSON at the end of long SSE is captured via a rolling tail buffer in `providers/utils.rs`.

## Superpowers

The monorepo includes Superpowers skills as a git submodule:

`../../.cursor/skills/superpowers/`

1. **Cursor (local IDE):** install the plugin for hooks and automatic skill bootstrap:

   ```text
   /add-plugin superpowers
   ```

2. **All agents:** project rule `../../.cursor/rules/superpowers-bootstrap.mdc` applies every session. Read skills with the `Read` tool:

   `../../.cursor/skills/superpowers/skills/{skill-name}/SKILL.md`

   Invoke `using-superpowers` at the start of work, then use process skills when relevant (`brainstorming`, `writing-plans`, `test-driven-development`, `systematic-debugging`, etc.).

User messages and this file take precedence over skills.

## Ponytail

Ponytail (“lazy senior dev”) is vendored at:

`../../.cursor/skills/ponytail/`

Project rule `../../.cursor/rules/ponytail-bootstrap.mdc` applies every session. Read the main skill before substantive coding:

`../../.cursor/skills/ponytail/skills/ponytail/SKILL.md`

Optional Cursor hooks (level switching via `/ponytail …` in chat), from the monorepo root:

```bash
node .cursor/skills/ponytail/scripts/cursor-hooks.js install --project
```

Upstream install docs: `../../.cursor/skills/ponytail/INSTALL.md` and `../../.cursor/skills/ponytail/docs/cursor-hooks.md`.

## Rust rules

Production-oriented Cursor rules from [tyrchen/cursor-rust-rules](https://github.com/tyrchen/cursor-rust-rules) are vendored under:

`../../.cursor/rules/rust/`

| Rule | Purpose |
| --- | --- |
| `rust/main.mdc` | Router for feature-specific Rust rules |
| `octo-rust.mdc` | Octo crate defaults (layout, comments, verify commands) |
| `rust-pr-checklist.mdc` | Per-PR/file checklist: types, ownership, errors, async, API |
| `verify-compiler.mdc` | Always run `cargo check -p octo` + `cargo clippy -p octo --all-targets -- -D warnings` |
| `sqlx.mdc` | `query!`, bindings, `.sqlx` offline cache, connect in `history/connect.rs` |
| `tests-live-outside-source.mdc` | Integration tests under `tests/` only |
| `subagent-models.mdc` | Cloud subagents: `grok-4.7-low` or `composer-2.5` only |

Do not fight the borrow checker; match existing style; keep diffs minimal unless the task requires more.

## Commands

From **`apps/router`** (app cwd; required for `cargo run` so `./config/` loads):

| Task | Command |
| --- | --- |
| Build | `cargo build` |
| Run | `cargo run` |
| Check | `cargo check` |
| Test | `cargo test` |
| Format | `cargo fmt` |
| Lint | `cargo clippy --all-targets -- -D warnings` |
| SQLx cache | `SQLX_OFFLINE=false cargo sqlx prepare -- --tests` (with `DATABASE_URL` + migrated DB) |

From the **monorepo root** (workspace): `cargo build -p octo`, `cargo test -p octo`, `cargo clippy -p octo --all-targets -- -D warnings`, `cargo fmt`.

Optional: `RUST_LOG=debug cargo run` for more tracing (default filter is `info`).

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push with `git push -u origin <branch>`
- Open pull requests against `main`
- Commit **`apps/router/.sqlx/`** when SQL or sqlx macros change; do not gitignore it

## What not to do

- Do not commit `target/` or local secrets (API keys in config or env files checked into git)
- Do not hardcode bind URLs, paths, or limits in Rust when they belong in `config/`
- Do not add large dependencies without a clear requirement
- Do not skip verification when a Superpowers skill requires it (tests, repro steps, etc.)
- Do not use `f64` for stored money; use `CostMicros` / `cost_micros` in the database
- Do not log raw client tokens or unbounded prompt bodies in tracing
