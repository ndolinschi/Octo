# OpenAI chat proxy implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or implement task-by-task.

**Goal:** Axum proxy on `127.0.0.1:8080` forwarding `POST /v1/chat/completions` to OpenAI with pass-through auth and streaming.

**Architecture:** `src/proxy/` handler reads raw body + `Authorization`/`Content-Type`, `reqwest` POST to fixed upstream URL, stream bytes back.

**Tech Stack:** axum 0.8, tokio, reqwest, tower-http trace.

**Spec:** `docs/superpowers/specs/2026-11-03-openai-chat-proxy-design.md`

## Global Constraints

- No env vars; upstream `https://api.openai.com/v1/chat/completions`; bind `127.0.0.1:8080`.
- No tests in v1; run `cargo fmt`, `clippy -D warnings`, `cargo build`.

## Tasks

- [ ] Add dependencies to `Cargo.toml`
- [ ] Implement `src/proxy/handler.rs` and `src/proxy/mod.rs`
- [ ] Replace `src/main.rs` with tokio + tracing + serve
- [ ] Verify build and clippy
