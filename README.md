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

Listens on `127.0.0.1:8080` by default (`OCTO_BIND_ADDR`). Upstream URLs, route paths, body size limit, and Anthropic default API version are defined in `src/config.rs` and can be overridden with `OCTO_*` environment variables (see that file for names and defaults).

## Anthropic messages proxy

```bash
curl http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-3-5-sonnet-20241022","max_tokens":1024,"system":"You are a helpful assistant.","messages":[{"role":"user","content":"Hello!"}]}'
```

Upstream defaults match the public Anthropic API; override with `OCTO_ANTHROPIC_MESSAGES_URL` and related vars in `src/config.rs`.