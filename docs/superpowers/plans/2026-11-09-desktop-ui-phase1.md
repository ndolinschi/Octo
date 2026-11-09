# Desktop UI Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or implement inline.

**Goal:** pnpm monorepo slice with `@octo/ui`, `@octo/agent-client`, Tauri `apps/desktop`, and CI verification without harness bridge.

**Architecture:** Shell-agnostic React in `packages/ui`; desktop imports UI + bridge URL helper; Tauri isolated under `src-tauri`.

**Tech Stack:** pnpm 10, React 19, Vite 8, Tauri 2, TypeScript 6.

**Spec:** [`../specs/2026-11-09-desktop-ui-design.md`](../specs/2026-11-09-desktop-ui-design.md)

## Global Constraints

- No `window.__TAURI__` in `packages/*`.
- Default bridge URL: `http://127.0.0.1:8790` until Phase 2.
- `cargo test -p octo` unchanged.

## Tasks

- [x] Design doc + AGENTS.md layout
- [x] Root `pnpm-workspace.yaml` + lockfile
- [x] `packages/ui` — `OctoApp` placeholder
- [x] `packages/agent-client` — `resolveBridgeUrl` + unit test
- [x] `apps/desktop` — wire workspace packages, rename product Octo Desktop
- [x] `apps/web/README.md` stub
- [x] `.github/workflows/desktop.yml`
- [x] `.cursor/rules/octo-frontend.mdc`, `apps/desktop/docs/architecture.md`

## Verify

```bash
pnpm install
pnpm --filter @octo/agent-client test
pnpm --filter @octo/desktop build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```
