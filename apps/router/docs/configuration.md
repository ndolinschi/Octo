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
| `low` / `mid` / `high` | Mistral ladder | Slugs for bands |
| `hard_threshold` / `easy_threshold` | `0.5` | JEV band cutoffs |
| `stall_window` | `6` | Recent turns for stall detect |
| `escalate_turns` | `3` | Hold higher after stall |
| `down_confirm` | `2` | Consecutive downs before sticky drop |
| `hold_tool_results` | `false` | Legacy: keep tier on tool-result-only turns |
| `tool_result_band` | `mid` | Target band for tool continuations (low sticky may use `low` if set) |
| `tool_result_down_confirm` | `3` (shipped) | Tool-turn down confirm; `0` uses `down_confirm` |
| `high_allow` | `[]` | Empty = ignore client high preference |
| `session_budget_usd` | `0` | `0` disables spend cap |
| `housekeeping_keep_messages` | `6` | Trim retention |
| `provider_order` | `[]` | Empty = no OpenRouter pin |
| `allow_fallbacks` | `true` | Provider fallbacks |
| `strip_fields` | three Anthropic-only keys | Empty disables strip |
| `require_parameters` | `always` | `always` \| `tools_only` \| `never` |
| `background_model_patterns` | `["haiku"]` | Observe `bg_signal` |
| `background_by_client_model` | `false` | Opt-in routing like housekeeping |
| `server_tool_mode` | `passthrough` | `passthrough` \| `online_suffix` \| `reject` |

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
