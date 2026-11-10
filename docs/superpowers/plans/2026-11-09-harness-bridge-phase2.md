# Harness bridge API (Phase 2) — Plan stub

> **Superseded** by the project-based bridge in [`../specs/2026-11-10-project-harness-design.md`](../specs/2026-11-10-project-harness-design.md), which is implemented. Kept for history.

**Spec:** [`../specs/2026-11-09-desktop-ui-design.md`](../specs/2026-11-09-desktop-ui-design.md)  
**Depends on:** Phase 1 merged (`packages/ui`, `apps/desktop`).

## Goal

Add `harness serve` (or `cmd/bridge`) HTTP+SSE API so `@octo/agent-client` drives the existing Go agent loop. Desktop starts bridge with **local** tools; future web runs bridge with **remote-only** tools on Claude infra.

## Proposed endpoints (draft)

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `GET` | `/v1/sessions` | List sessions (JSON) |
| `GET` | `/v1/sessions/{id}` | Session messages |
| `POST` | `/v1/sessions` | Create session |
| `POST` | `/v1/sessions/{id}/messages` | User message → agent loop |
| `GET` | `/v1/sessions/{id}/events` | SSE: stream tokens, tool_use, done |

## Implementation sketch

1. New package `internal/bridge` in `harness/` — reuse `agent.Runner`, `store`, `tools` registry from `cmd/harness`.
2. Flags: `--addr`, `--workspace`, `--remote` (repeatable), `--tool-mode local|remote` (remote = skip local registration).
3. Wire `packages/agent-client` `BridgeClient` with fetch + EventSource.
4. `packages/ui` chat view consumes stream events.

## Verify

- Integration test: `harness serve` + `curl` POST message against mock Anthropic server.
- Desktop manual: `pnpm tauri dev` with bridge running locally.

## Non-goals

- Tauri sidecar auto-spawn (document manual start first).
