# Octo

Rust application crate managed with Cargo.

## Development

See [AGENTS.md](./AGENTS.md) for agent and contributor setup (Superpowers skills, Cursor Rust rules, and common commands).

```bash
git submodule update --init --recursive
cargo build
cargo run
```

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
