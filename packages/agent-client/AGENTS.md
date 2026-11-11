# `@octo/agent-client` — agent instructions

TypeScript client for the harness bridge (`harness serve`): types, HTTP + SSE client, the pure project-state
reducer, a message-port bridge for embedded hosts, and language-server sessions. No React, no DOM types.

## Structure (imports go down this list only)

| File | Role |
| --- | --- |
| `types.ts` | Wire types: `Project`, `Agent`, `Message`, events, files, plugins, usage, limits. No imports |
| `state.ts` | Pure reducer over bridge events: `applyEvent`, `withAgents`, `withMessages` |
| `bridge.ts` | The `Bridge` interface and `resolveBridgeUrl` |
| `client.ts` | `createHttpBridge`: fetch + EventSource, reconnect, error mapping |
| `lspChannel.ts`, `lspSession.ts` | Language-server sessions over POST + SSE |
| `messageProtocol.ts` → `messageClient.ts`, `messageServer.ts`, `messageBridge.ts` | The same `Bridge` over a `MessagePort`, with a method allow-list |
| `index.ts` | The public API |

The API contract is the harness spec:
[`docs/superpowers/specs/2026-11-10-project-harness-design.md`](../../docs/superpowers/specs/2026-11-10-project-harness-design.md)
and the specs that extend it (code pane, workspace/plugins/ACP, usage). Types here mirror the Go JSON exactly.

## Rules

- A new endpoint is: type in `types.ts` → method on `Bridge` → `client.ts` → message-bridge allow-list
  (`messageProtocol.ts`) → tests → stub in `packages/ui/src/demo/bridge.ts` (the UI will not type-check without it).
- The reducer stays pure and total: unknown events only advance `lastSeq`.
- Platform access (`fetch`, `EventSource`) comes in through options; no globals beyond the default wiring.
- Every change ships with `node:test` tests next to the file. Coding rules:
  [`.cursor/rules/octo-typescript.mdc`](../../.cursor/rules/octo-typescript.mdc).

```bash
pnpm --filter @octo/agent-client test
pnpm --filter @octo/agent-client lint          # tsc --noEmit (no DOM lib) && eslint . (no react / @octo/ui / @tauri-apps imports)
pnpm --filter @octo/agent-client format:check
pnpm --filter @octo/ui lint            # catches a Bridge change the demo bridge does not implement
```
