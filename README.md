# Octo

Rust application crate managed with Cargo.

## Development

See [AGENTS.md](./AGENTS.md) for agent and contributor setup (Superpowers skills, Cursor Rust rules, and common commands).

```bash
git submodule update --init --recursive
cargo build
cargo run
```

## OpenAI chat proxy

With the server running (`cargo run`), forward chat completions through Octo (pass-through `Authorization` and JSON body):

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Listens on `127.0.0.1:8080`; upstream is `https://api.openai.com/v1/chat/completions` unless overridden with `OCTO_OPENAI_CHAT_COMPLETIONS_URL`.

## Anthropic messages proxy

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello!"}]}'
```

Upstream is `https://api.anthropic.com/v1/messages` unless overridden with `OCTO_ANTHROPIC_MESSAGES_URL`.