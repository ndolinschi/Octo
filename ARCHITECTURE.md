# Octo architecture

Octo is a single Rust crate (`octo`) that runs an Axum HTTP proxy. Clients speak OpenAI-compatible chat, Anthropic Messages, or OpenRouter Decisions; Octo forwards upstream with streaming, optional SQLite history, and an **autoroute** path that picks models and reshapes bodies for Claude Code / OpenRouter.

## Runtime shape

```
Client
  │  Authorization / x-api-key / x-octo-key
  ▼
Axum router (`src/routes.rs` → `src/proxy/routes.rs`)
  ├─ GET  /health
  ├─ GET  /autoroute/status[?session=]
  ├─ POST …/chat/completions (+ path aliases)
  ├─ POST …/messages (+ path aliases)
  ├─ POST …/decisions (+ path aliases)
  └─ POST /autoroute/messages | /autoroute/chat  (model ladder)
        │
        ▼
  AppState (`src/state.rs`)
        ├─ Config (merged `config/*.toml`)
        ├─ reqwest Client
        ├─ llm::Wired / decision::Providers
        ├─ history::History (optional; soft-fail)
        └─ auto::Auto (tiers, sticky, budgets)
        │
        ├─ passthrough proxy ──► providers/* ──► upstream
        └─ autoroute ──► auto::decide ──► shape + forward / compact
```

Process entry: `src/main.rs` → `proxy::run()` (bind, history connect, serve, graceful history drain).

## Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| HTTP / proxy | `src/proxy/` | Routes, body size limits, auth (`x-octo-key`), provider selection, thin handlers, autoroute entry |
| Providers | `src/providers/` | Wire URLs from config; chat / messages / decisions forward; OpenRouter attribution; stream tee |
| History | `src/history/` | SQLite pool, HMAC token hash, async inserts, payload parsers, cost + session outcomes |
| Autoroute core | `src/auto/` | Decide (JEV + sticky + stall + budget), body shaping, catalog, routing metadata |
| Config | `src/config.rs` + `config/` | Fragment TOML merge → `Config` |

Module boundaries: keep provider wire formats in `providers/`; keep routing/decision logic in `auto/`; keep Axum types in `proxy/`. See `.cursor/rules/octo-rust.mdc`.

## Request paths

### Passthrough proxy

1. Handler reads the body up to `limits.max_body_bytes`.
2. `select` resolves chat/messages provider from path alias, then JSON `type` / `octo_provider`, then `[llm.*.backend]`.
3. Selector fields are stripped; credentials and attribution headers are forwarded.
4. Upstream response streams to the client; a rolling tail buffer captures trailing usage JSON for history.
5. History insert is async (bounded concurrency); drops under backpressure do not fail the client response.

Errors become JSON (`ProxyError`), not plain text. Anthropic-shaped routes can remap error bodies for client compatibility.

### Autoroute (`/autoroute/…`)

1. Parse JSON; derive `session_key`, client observe signals (`client_model`, thinking, tools, bg/hk patterns), and server-tool presence.
2. `auto::decide` chooses a `Turn`:
   - **Forward** — pick tier/model, apply sticky/stall/budget/JEV, `shape()` the body, POST OpenRouter Messages (or chat).
   - **Compact** — synthesize a compaction request when context is too large (messages path only).
3. `shape()` applies hygiene: strip configured Anthropic-only fields (`strip_fields`), optional `provider.require_parameters`, tool filtering, housekeeping trim, model rewrite.
4. Response streams back; history stores metrics, observe columns, optional payloads, and routing reason strings.

`GET /autoroute/status` exposes session spend / model for Claude Code statusline scripts.

## Autoroute decide pipeline (`src/auto/`)

Order of concerns inside `decide` (conceptual):

1. **Catalog / tiers** (`catalog.rs`) — free/low/mid/high ladders, context lengths, reasoning support, default strip keys, `RequireParameters`.
2. **Sticky** (`decide/sticky.rs`) — keep or bump band within a session under budget caps.
3. **Stall** (`stall.rs`) — escalate when the session looks stuck (including housekeeping-aware rules).
4. **JEV** (`jev/`) — lightweight classify / tool-need / complexity from context facts; can call OpenRouter Decisions when configured.
5. **Gate / route** (`decide/gate.rs`, `decide/route.rs`, `routing.rs`) — final model action + `RouteMeta` (reason, stripped fields, spend).
6. **Body** (`body.rs`) — `ShapePlan` → `ShapeResult` for the upstream POST.
7. **Session / metrics** — per-session choice cache, context estimates, text-as-tool-call detection.

Autoroute must not change passthrough route semantics; keep ladder and hygiene behind `/autoroute` and `config/autoroute.toml`.

## History and cost

- Schema in `migrations/`; compile-time `query!` with committed `.sqlx/` (`SQLX_OFFLINE`).
- Tokens HMAC’d; raw secrets never stored.
- Cost in **micro-dollars** (`CostMicros`); precedence: priced estimate → upstream BYOK → OpenRouter `usage.cost`.
- `session_outcomes` upserts from last-user `tool_result` blocks (cargo / pytest / unittest).
- Observe columns record client signals even when `history.store_payloads = false`.

## Auth and bind

- Default: loopback only (`allow_remote = false`).
- Non-loopback requires `allow_remote` **and** non-empty `client_auth_key`; then every route except `/health` needs matching `x-octo-key`.
- Upstream API keys remain client-supplied per request.

## Config map

| Fragment | Role |
| --- | --- |
| `server.toml` | Bind, remote, client auth |
| `upstream.toml` | Timeouts |
| `limits.toml` | Max body |
| `openai` / `openrouter` / `anthropic` | Upstream URLs and paths |
| `llm.toml` / `decision.toml` | Default backends |
| `history.toml` | SQLite + payload retention |
| `autoroute.toml` | Ladder, sticky/stall, budget, strip/require, background patterns, server tools |
| `prices.toml` | Per-slug USD/1M rates |

`OCTO_CONFIG` may point at another config directory or a legacy monolithic TOML.

## Tests and scripts

- Integration tests live under `tests/` only (no `#[cfg(test)]` in `src/`).
- Notable suites: history store/payload, session outcomes, select provider, autoroute defaults/regression, strip/require fixtures.
- Ops helpers: `scripts/statusline.sh`, `scripts/reconcile_costs.py`, Claude Code env examples under `config/`.

## Design invariants

- Streaming first: history and routing must not block or rewrite the live byte stream after headers are sent (aside from intentional autoroute body reshape before the upstream call).
- Money is integer micros, never `f64` in storage.
- Config owns URLs, paths, limits, and ladder policy — not hardcoded in handlers.
- Fail open on history connect; fail closed on remote bind without client auth.
