# Configuration

Operational defaults live under **`config/`** (one focused TOML file per area). Run from `apps/router`, or set **`OCTO_CONFIG`** to another directory or a legacy monolithic TOML file.

Loader: `src/config.rs` merges known fragment names; missing files are skipped.

## Fragment map

| File | Section | Purpose |
| --- | --- | --- |
| `server.toml` | `[server]` | `bind_addr`, `allow_remote`, `client_auth_key` |
| `upstream.toml` | `[upstream]` | Connect / full-request timeouts (SSE-inclusive) |
| `limits.toml` | `[limits]` | `max_body_bytes` |
| `openai.toml` | `[openai]` | Direct OpenAI chat URL |
| `openrouter.toml` | `[openrouter]` | Chat / messages / decisions URLs + paths, attribution |
| `anthropic.toml` | `[anthropic]` | Messages URL/path, default API version |
| `llm.toml` | `[llm.chat]` / `[llm.messages]` | Default backends |
| `decision.toml` | `[decision]` | Decisions backend |
| `history.toml` | `[history]` | SQLite path, token key, `store_payloads` |
| `autoroute.toml` | `[autoroute]` | Ladder, sticky/stall, budget, strip/require, observe flags |
| `prices.toml` | `[prices."<slug>"]` | USD/1M rates (four required) + optional `billed_as` |

Helpers (not loaded as Config fragments): `claude-code.env.example`, `experiments.env.example`.

## Autoroute keys (detail)

| Key | Default (shipped) | Meaning |
| --- | --- | --- |
| `low` / `mid` / `high` | DeepSWE v1.1 ladder | Slugs for bands |
| `hard_threshold` / `easy_threshold` | `0.5` | JEV band cutoffs |
| `stall_window` | `6` | Recent turns for stall detect |
| `escalate_turns` | `3` | Hold higher after stall |
| `down_confirm` | `2` | Consecutive downs before sticky drop |
| `high_allow` | `[]` | Empty = ignore client high preference |
| `session_budget_usd` | `0` | **`0` disables the spend cap entirely** (nothing is downgraded or refused). Set it to enable the budget |
| `session_budget_action` | `downgrade` | Over budget: `downgrade` routes to the cheapest tier by `prices.toml`; `reject` returns 402 `billing_error` naming budget and spend |
| `classifier_failure_tier` | `mid` | `low` \| `mid` \| `high`; tier used (and remembered) when the JEV call fails on a new session |
| `default_max_tokens` | `8192` | `max_tokens` sent upstream when the client omits it; capped by the model maximum; invalid at `0` |
| `retry_after_max_secs` | `10` | Upper bound on the `Retry-After` wait before the single retry |
| `compact_cooldown_requests` | `0` | After an unapplied compaction: `0` re-arms only when the context shrinks below the fill threshold; `N > 0` also re-arms after `N` requests |
| `housekeeping_keep_messages` | `6` | Trim retention |
| `provider_order` | `[]` | Empty = no OpenRouter pin |
| `allow_fallbacks` | `true` | Provider fallbacks |
| `strip_fields` | three Anthropic-only keys | Empty disables strip |
| `require_parameters` | `always` | `always` \| `tools_only` \| `never` |
| `background_model_patterns` | `["haiku"]` | Observe `bg_signal` |
| `background_by_client_model` | `false` | Opt-in routing like housekeeping |
| `server_tool_mode` | `passthrough` | `passthrough` \| `online_suffix` \| `reject` |

Invalid `classifier_failure_tier`, `session_budget_action`, or `default_max_tokens = 0` fail config load.

Request header `x-octo-budget-key: <key>` (autoroute routes, 1-128 printable ASCII characters) tracks spend under that key instead of the session id, so several agent sessions share one `session_budget_usd`. The header is removed before the request goes upstream. It works without a session id too; `x-octo-budget-usd` with the key lowers the budget for that key (smaller of header and `session_budget_usd`; a header budget always rejects, see [autoroute.md](./autoroute.md#harness-integration)). Spend under a key lives in memory (1 hour idle expiry) and is not restored from the database.

`prices.toml` rates were verified against the OpenRouter catalogue on 2026-11-10: [ladder-cost-check.md](./ladder-cost-check.md). At startup Octo logs a warning when the ladder is not monotonic in price (a higher tier cheaper than a lower one for a 30k in / 500 out request) and when a ladder model has no usable price entry.

## Environment

| Variable | Role |
| --- | --- |
| `OCTO_CONFIG` | Alternate config dir or single TOML |
| `OCTO_HISTORY_TOKEN_KEY` | HMAC key for token hashing |
| `DATABASE_URL` | For `cargo sqlx prepare` / migrate (dev) |
| `RUST_LOG` | Tracing filter (default `info`) |
| `OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Client-side keys for curl / Claude Code (not read by Octo server for upstream auth) |

Do not commit secrets. Clients send credentials per request.

## Claude Code wiring

Point Anthropic base URL at Octo autoroute, for example:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8080/autoroute
```

See `config/claude-code.env.example` for a fuller template (statusline, model env, disable-thinking workarounds when needed).
