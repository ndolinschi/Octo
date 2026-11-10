# Octo (router)

Rust HTTP proxy (Axum) for OpenAI / Anthropic / OpenRouter, plus an **autoroute** model ladder for Claude Code.

This app lives at **`apps/router/`** in the monorepo. Crate name remains **`octo`**. Repo map: [`../../README.md`](../../README.md), [`../../AGENTS.md`](../../AGENTS.md).

## Documentation

| Guide | Contents |
| --- | --- |
| [docs/README.md](./docs/README.md) | Documentation index |
| [docs/overview.md](./docs/overview.md) | What Octo is |
| [docs/architecture.md](./docs/architecture.md) | Architecture + diagrams |
| [docs/status.md](./docs/status.md) | What works vs what does not |
| [AGENTS.md](./AGENTS.md) | Agent / contributor operational notes |

## Development

See [AGENTS.md](./AGENTS.md) for setup (Superpowers skills, Cursor Rust rules, and common commands).

```bash
# from monorepo root
git submodule update --init --recursive
cargo build -p octo
cd apps/router && cargo run
```

## Call history (SQLite)

Octo writes a **side copy** of proxied calls to SQLite (`config/history.toml` → `database_path`, default `data/history.sqlite`). Live responses still stream to the client; inserts run in the background.

- **Stored:** kind, provider, model, capped input/output, JSON `request_payload` / `response_payload`, tokens, cost (micro-dollars), latency — not raw API keys (HMAC of `Authorization` / `x-api-key`).
- **Cost:** `cost_micros` prefers estimate (`config/prices.toml`) → upstream BYOK (`cost_details`) → OpenRouter `usage.cost` → `none` (failed/no-usage rows stay honest zeros).
- **Token key:** `OCTO_HISTORY_TOKEN_KEY` env, `history.token_key` in config, or auto-generated `.key` beside the DB (Unix file permissions).
- **If the DB fails to open:** the proxy keeps serving with history disabled (see logs).
- **Outcomes:** `session_outcomes` upserts pass/fail counts from cargo/pytest/unittest tool_results (async).

Inspect the latest row:

```bash
sqlite3 data/history.sqlite "SELECT id, kind, provider, model, status FROM calls ORDER BY id DESC LIMIT 5;"
```

Reconcile daily/model costs vs a provider CSV (`date,model,requests,cost`):

```bash
python3 scripts/reconcile_costs.py data/history.sqlite --provider-csv invoice.csv
```

Manual smoke (chat + decisions + sample query): [`scripts/smoke-openrouter.sh`](scripts/smoke-openrouter.sh) (requires `OPENROUTER_API_KEY` and a running `cargo run`).

Details: [AGENTS.md](./AGENTS.md#request-history-sqlite).

## OpenAI-compatible chat (OpenAI and OpenRouter)

[`config/`](./config/) wires **direct OpenAI** (`config/openai.toml`) and **OpenRouter** (`config/openrouter.toml`). Default chat upstream when the request does not pin a provider: `config/llm.toml` → `[llm.chat].backend` (`openai` or `openrouter`).

**Pick OpenRouter** with JSON `"type": "OPENROUTER"` (or `"octo_provider"`), path `/openrouter/completions`, or set `[llm.chat] backend = "openrouter"` as the default.

### Direct OpenAI (default backend)

```bash
export OPENAI_API_KEY="sk-..."

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

### OpenRouter (explicit selection)

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "type": "OPENROUTER",
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

Same request via path alias (no `type` in body):

```bash
curl http://127.0.0.1:8080/openrouter/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "model": "anthropic/claude-3.5-sonnet",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

Optional OpenRouter attribution (overrides `config/openrouter.toml` defaults when set):

```bash
curl http://127.0.0.1:8080/openrouter/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Referer: https://myapp.example" \
  -H "X-OpenRouter-Title: My App" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Streaming works the same way: add `"stream": true` to the JSON body.

Listens on `127.0.0.1:8080` by default. Octo loads the **`config/`** directory from the process **current working directory** unless you set **`OCTO_CONFIG`** to another directory or a single TOML file. Run from `apps/router`, or point `OCTO_CONFIG` at your layout (e.g. `OCTO_CONFIG=apps/router/config` from the monorepo root).

**Security:** With `allow_remote = true`, anyone who can reach the bind address may use Octo as an unauthenticated forwarder to the URLs in config. Use loopback or a trusted network only. **`GET /health`** returns 200 when the process is up.

### Config migration from `[openai]` table name

Older configs used a TOML table named `[openai]` for **OpenRouter** URLs. Rename that table to **`[openrouter]`** and add a dedicated **`[openai]`** section for direct OpenAI (`chat_completions_url`). Chat routing uses JSON `type`, path aliases, and `[llm.chat].backend` as the default when path/body omit a provider.

## OpenRouter Decisions (alpha)

Same API key as chat. Local path defaults to `POST /v1/decisions` (upstream: OpenRouter alpha Decisions). See [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request).

```bash
curl http://127.0.0.1:8080/v1/decisions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": {"ticket": "Checkout shows a blank screen after Pay."},
    "questions": {
      "is_bug": {
        "type": "noul",
        "instructions": "Is the customer reporting broken behavior?",
        "criteria": {
          "true": "Broken or unexpected product behavior.",
          "false": "Question or feature request."
        }
      }
    }
  }'
```

## Anthropic messages proxy

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello!"}]}'
```

Anthropic upstream and defaults are in `config/anthropic.toml`.

## OpenRouter Messages (Anthropic-compatible)

Same Anthropic Messages JSON body and streaming behavior, but upstream is OpenRouter (`messages_url` in `config/openrouter.toml`, default `https://openrouter.ai/api/v1/messages`). Use **`Authorization: Bearer $OPENROUTER_API_KEY`**. Optional `anthropic-version` header; Octo forwards it or applies the default from `config/anthropic.toml`.

Path alias (provider pinned):

```bash
curl http://127.0.0.1:8080/openrouter/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"anthropic/claude-sonnet-4","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'
```

On `POST /v1/messages`, set `[llm.messages].backend = "openrouter"` in `config/llm.toml`, or send `"type": "OPENROUTER"` in the JSON body (stripped before upstream).

### Autoroute model ladder (OpenRouter)

`config/autoroute.toml` low/mid/high defaults (`deepseek-v4.1-flash` → `minimax-m3.1-flash` → `deepseek-v4.1-flash-1017`, picked by DeepSWE v1.1 score per dollar). This applies to **all** `/autoroute` traffic, not only Claude Code experiments.

- **Provider routing:** no `provider_order` pin (OpenRouter picks the endpoint); `allow_fallbacks = true`.
- **Housekeeping trim:** long Claude Code housekeeping turns keep system/tools plus the last `housekeeping_keep_messages` (default 6); trigger becomes `housekeeping_trimmed` when shortened.
- **Permission checks:** Claude Code prompts with `Err on the side of blocking` or `<transcript>` use trigger `permission_check`, keep the session model, and skip JEV/sticky.
- **Claude Code body hygiene:** `config/autoroute.toml` → `strip_fields` (default `output_config`, `safeguards`, `context_management`; empty list = strip nothing) removes Anthropic-only keys before OpenRouter on every Forward (including passthrough); removed keys are recorded on the call as `rerouting_reason` `stripped:…` without changing `trigger`. `require_parameters` is `always` (default) | `tools_only` | `never` (invalid values fail config load). With `always`, dropping strip keys can reintroduce OpenRouter 404s (`Filter by Parameters`).
- **Prices:** fill `config/prices.toml` from the provider console; the estimate is used only when no cost is reported upstream, and only when **all four** rates (`input` / `cache_read` / `cache_write` / `output`) are present (explicit `0.0` counts). Shipped rates were checked against the OpenRouter catalogue on 2026-11-10 (`docs/ladder-cost-check.md`).
- **Budget:** `session_budget_usd` defaults to `0` = no limit. When set, `session_budget_action = "downgrade"` routes to the cheapest tier by price, `"reject"` answers 402; `x-octo-budget-key` shares one budget across sessions.
- **Observe columns (no routing change):** `client_model`, `client_has_thinking`, `client_tool_names`, `bg_signal`, `hk_text_signal` on `calls`.
- **Opt-in background routing:** `background_by_client_model = false` by default; when true, haiku-like client models use trigger `background_model` (like housekeeping).
- **Server tools:** `server_tool_mode = "passthrough"` (default) | `"online_suffix"` | `"reject"`.
- **Status:** `GET /autoroute/status?session=<id>` (or latest) for statusline JSON; see `scripts/statusline.sh`.
- **Payload storage:** `history.store_payloads = true` by default; set `false` to omit text payload columns while keeping metrics/observe/outcomes.
- **Remote bind / client auth:** non-loopback `bind_addr` requires `server.allow_remote = true` and a non-empty `server.client_auth_key`. When the key is set, clients (and `scripts/statusline.sh` via `OCTO_CLIENT_AUTH_KEY`) must send `x-octo-key`; `GET /health` stays open.

Claude Code `settings.json` status line:

```json
"statusLine": {"type": "command", "command": "/absolute/path/to/Octo/scripts/statusline.sh"}
```

### Claude Code + Octo autoroute

Claude Code reads **`ANTHROPIC_DEFAULT_*_MODEL`** and **`CLAUDE_CODE_SUBAGENT_MODEL`** (not Octo). For local experiments through **`/autoroute`**:

```bash
cp .env.example .env          # set OPENROUTER_API_KEY + ladder slugs
cargo run                     # Octo on 127.0.0.1:8080
source scripts/claude-code-env.sh
./scripts/claude-code-experiment.sh              # interactive (permission prompts)
./scripts/claude-code-experiment.sh -p "…"       # non-interactive (skips permissions)
OCTO_CC_SKIP_PERMISSIONS=1 ./scripts/claude-code-experiment.sh  # force skip
```

`.env.example` documents the Claude Code vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) aligned with the autoroute ladder. Put a **real** `OPENROUTER_API_KEY` in `.env` (not the `sk-or-v1-...` stub). `scripts/claude-code-env.sh` sources `.env`, sets **`ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`**, and **unsets `ANTHROPIC_API_KEY`**. After changing the key, always re-source the script (exporting only `OPENROUTER_API_KEY` leaves a stale auth token and causes OpenRouter 401). Defaults Haiku/Sonnet/Opus → autoroute low/mid/high (`deepseek-v4.1-flash` → `minimax-m3.1-flash` → `deepseek-v4.1-flash-1017`). An “unrecognized model” warning for OpenRouter slugs is expected. The experiment helper runs under gitignored `experiments/` with `--add-dir` on the app root (`apps/router`) and the monorepo root. Non-interactive (`-p`) defaults to `--dangerously-skip-permissions`; interactive does not unless `OCTO_CC_SKIP_PERMISSIONS=1`. Manual recipes: [`config/claude-code.env.example`](config/claude-code.env.example).
