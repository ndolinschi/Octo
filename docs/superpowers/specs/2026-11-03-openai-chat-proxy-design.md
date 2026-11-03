# OpenAI chat completions proxy — design

**Date:** 2026-11-03  
**Status:** approved

## Intent and why

Add a **simple HTTP pass-through** in the Octo Rust binary: clients call **`POST /v1/chat/completions`** on our server with the same JSON and headers they would send to OpenAI; Octo **forwards the request unchanged** to OpenAI and **streams the response back**. Traffic goes **through our system** (for future logging, policy, or routing) without storing API keys or configurable upstream URLs in this first version.

## Goals

- **`src/proxy/` module** with **Axum + Tokio**, wired from `main`.
- **Single route:** `POST /v1/chat/completions` only.
- **Transparent redirect:** forward request body as raw bytes; forward response status, relevant headers, and body (including **SSE** when `"stream": true`).
- **Pass-through auth:** forward the client’s **`Authorization`** header to upstream (client supplies `Bearer` token as in the OpenAI curl example).
- **Fixed upstream:** always `https://api.openai.com/v1/chat/completions` (constant in code, no env).

## Non-goals

- Server-side `OPENAI_API_KEY` or any secret management on the proxy.
- Configurable `OPENAI_UPSTREAM_BASE` or other upstream env vars.
- Other OpenAI routes.
- OpenAPI, request schema validation, rate limits, caching, model substitution.
- **Automated tests** for this slice (no unit/integration tests in v1).
- TLS on the proxy listen socket (plain HTTP locally; upstream HTTPS via reqwest).

## Anti-goals

- Logging or persisting full bodies or `Authorization` values.
- Rewriting or injecting auth on the server.

## Constraints

- Single crate `octo`, Rust 2021; minimal diff; `Result` / `?` in production paths.
- Dependencies: `axum`, `tokio`, `tower` / `tower-http` (trace, optional body limit), `reqwest` (rustls), `tracing`, `tracing-subscriber`.
- Before merge: `cargo fmt`, `cargo clippy -- -D warnings`, `cargo build` (no test requirement for this feature).

## Approaches considered

| Approach | Tradeoff | Decision |
|----------|----------|----------|
| Wildcard `/v1/*` | Full API, one handler | Deferred |
| **Dedicated chat completions forwarder** | Smallest change, matches scope | **Chosen** |
| Server-injected API key | Central secret | **Rejected** — user wants pass-through only |

## Architecture

```
Client  --POST /v1/chat/completions-->  Axum (octo)  --POST-->  https://api.openai.com/v1/chat/completions
        Authorization: Bearer (client)              same Authorization + body + Content-Type
        JSON body                                   response streamed back
```

### Module layout

- `src/proxy/mod.rs` — router assembly, `run(bind)` or equivalent
- `src/proxy/handler.rs` — forward handler
- `src/main.rs` — `#[tokio::main]`, tracing init, fixed bind address (builder call below)

### Configuration

**No env vars required for v1.** Listen address: hardcode **`127.0.0.1:8080`** unless we add a single optional `PROXY_BIND` later (out of scope unless requested).

### Handler behavior

1. Accept only `POST /v1/chat/completions` on the router.
2. Read body as bytes (optional reasonable size limit via tower-http).
3. Forward to upstream: copy **`Authorization`**, **`Content-Type`** (default `application/json` if absent); do not forward hop-by-hop headers.
4. `reqwest` with response streaming; map status and `Content-Type` (and other safe response headers) to the client response.
5. Upstream/network failure before response headers: **`502 Bad Gateway`** with minimal JSON error (infra only, not OpenAI error shape).

### Observability

- `tracing` at `info`: request received, upstream status, latency — no bodies, no auth header values.

## Left to the builder

- Axum 0.8 / reqwest version pins and feature flags.
- Exact body limit (e.g. 10 MiB) or none for v1.
- Replace `main` hello-world with starting the proxy server.

## Follow-ups (out of scope)

- More `/v1/*` routes, shared forward helper.
- Env for bind/upstream, server-side keys.
- Tests (wiremock integration, config tests).
- `GET /health`.
