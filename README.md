# Octo

Rust application crate managed with Cargo.

## Development

See [AGENTS.md](./AGENTS.md) for agent and contributor setup (Superpowers skills, Cursor Rust rules, and common commands).

```bash
git submodule update --init --recursive
cargo build
cargo run
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

Listens on `127.0.0.1:8080` by default. Octo loads the **`config/`** directory from the process **current working directory** unless you set **`OCTO_CONFIG`** to another directory or a single TOML file. Run from the repo root, or point `OCTO_CONFIG` at your layout.

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

### Autoroute model ladder (Mistral)

`config/autoroute.toml` low/mid/high defaults are now **Mistral** (`ministral-8b-2512` → `mistral-small-3.1-24b-instruct` → `devstral-2512`), replacing the previous Gemma / DeepSeek / Haiku-latest ladder. This applies to **all** `/autoroute` traffic, not only Claude Code experiments.

- **Provider pin (opt-in):** `provider_order = []` / `allow_fallbacks = true` by default. A commented Mistral example is in the same file. Pinning does **not** choose BYOK vs OpenRouter-paid (account setting).
- **Housekeeping trim:** long Claude Code housekeeping turns keep system/tools plus the last `housekeeping_keep_messages` (default 6); trigger becomes `housekeeping_trimmed` when shortened.
- **Permission checks:** Claude Code prompts with `Err on the side of blocking` or `<transcript>` use trigger `permission_check`, keep the session model, and skip JEV/sticky.
- **Claude Code body hygiene:** autoroute `shape` drops Anthropic-only `output_config` / `safeguards` before OpenRouter. Those fields plus `provider.require_parameters` otherwise 404 Mistral (`Filter by Parameters`).
- **Prices:** fill `config/prices.toml` from the provider console so estimates can win over `usage.cost` when set.

### Claude Code + Octo autoroute (Mistral tiers)

Claude Code reads **`ANTHROPIC_DEFAULT_*_MODEL`** and **`CLAUDE_CODE_SUBAGENT_MODEL`** (not Octo). For local experiments through **`/autoroute`**:

```bash
cp .env.example .env          # set OPENROUTER_API_KEY + Mistral ladder
cargo run                     # Octo on 127.0.0.1:8080
source scripts/claude-code-env.sh
./scripts/claude-code-experiment.sh              # interactive (permission prompts)
./scripts/claude-code-experiment.sh -p "…"       # non-interactive (skips permissions)
OCTO_CC_SKIP_PERMISSIONS=1 ./scripts/claude-code-experiment.sh  # force skip
```

`.env.example` documents the Claude Code vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) with the Mistral ladder. Put a **real** `OPENROUTER_API_KEY` in `.env` (not the `sk-or-v1-...` stub). `scripts/claude-code-env.sh` sources `.env`, sets **`ANTHROPIC_AUTH_TOKEN=$OPENROUTER_API_KEY`**, and **unsets `ANTHROPIC_API_KEY`**. After changing the key, always re-source the script (exporting only `OPENROUTER_API_KEY` leaves a stale auth token and causes OpenRouter 401). Defaults Haiku/Sonnet/Opus → autoroute low/mid/high (`ministral-8b` → `mistral-small-3.1` → `devstral`). An “unrecognized model” warning for OpenRouter slugs is expected. The experiment helper runs under gitignored `experiments/` with `--add-dir` on the repo root. Non-interactive (`-p`) defaults to `--dangerously-skip-permissions`; interactive does not unless `OCTO_CC_SKIP_PERMISSIONS=1`. Manual recipes: [`config/claude-code.env.example`](config/claude-code.env.example).
