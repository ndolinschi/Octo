# Octo

Rust application crate managed with Cargo.

## Development

See [AGENTS.md](./AGENTS.md) for agent and contributor setup (Superpowers skills, Cursor Rust rules, and common commands).

```bash
git submodule update --init --recursive
cargo build
cargo run
```

## OpenAI-compatible chat proxy (OpenRouter)

[`config.toml`](./config.toml) points chat completions at [OpenRouter](https://openrouter.ai/) (`https://openrouter.ai/api/v1/chat/completions`). Octo keeps the same OpenAI-style path on your server (`POST /v1/chat/completions`): send a Bearer token (your OpenRouter API key), pick any OpenRouter model slug in the JSON `model` field, and Octo forwards the request upstream.

With the server running (`cargo run`):

```bash
export OPENROUTER_API_KEY="sk-or-v1-..."

curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

Other models on the same endpoint (OpenRouter slugs):

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "model": "anthropic/claude-3.5-sonnet",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{
    "model": "google/gemini-2.0-flash-001",
    "messages": [{"role": "user", "content": "Name three primary colors."}]
  }'
```

Optional OpenRouter attribution (overrides [`config.toml`](./config.toml) defaults when set):

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Referer: https://myapp.example" \
  -H "X-OpenRouter-Title: My App" \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Streaming works the same way: add `"stream": true` to the JSON body.

Listens on `127.0.0.1:8080` by default. Edit [`config.toml`](./config.toml) for bind address, OpenRouter chat and decisions URLs/paths, default `http_referer` / `openrouter_title`, body size limit, and Anthropic settings. Use `OCTO_CONFIG` to point at a different TOML file.

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

Anthropic upstream and defaults are configured in [`config.toml`](./config.toml).