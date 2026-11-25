# `@octo/agent-client` — agent instructions

TypeScript client for the harness bridge (`harness serve`): types, HTTP + SSE client, the pure project-state
reducer, a message-port bridge for embedded hosts, and language-server sessions. No React, no DOM types.

## Structure (imports go down this list only)

| File                                                                              | Role                                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `types.ts`                                                                        | Wire types: `Project`, `Agent`, `Message`, events, files, plugins, usage, limits. No imports               |
| `state.ts`                                                                        | Pure reducer over bridge events: `applyEvent`, `withAgents`, `withMessages`                                |
| `bridge.ts`                                                                       | `resolveBridgeUrl` (`VITE_HARNESS_BRIDGE_URL`, then `HARNESS_BRIDGE_URL`, default `http://127.0.0.1:8790`) |
| `client.ts`                                                                       | The `Bridge` interface and `createHttpBridge`: fetch + EventSource, reconnect, error mapping               |
| `sessionBridge.ts`                                                                | `sessionBridge`: a `Bridge` addressed to one main session (parallel sessions)                              |
| `lspChannel.ts`, `lspSession.ts`                                                  | Language-server sessions over POST + SSE                                                                   |
| `messageProtocol.ts` → `messageClient.ts`, `messageServer.ts`, `messageBridge.ts` | The same `Bridge` over a `MessagePort`, with a method allow-list                                           |
| `rare.ts`, `rareNames.ts` | The less-used `Bridge` methods in a lazy chunk; `rareNames` lists what `createHttpBridge` forwards to it |
| `review.ts`, `commands.ts`, `remoteAccess.ts`, `fileBytes.ts`, `terminalSession.ts` | Pull-request review, project commands, the `/v1/remote` control routes, base64 file reads, PTY terminals |
| `readDeadline.ts` | How long a read may hold its connection before it is abandoned |
| `index.ts`                                                                        | The public API                                                                                             |

The API contract is the harness spec:
[`../../apps/harness/docs/architecture.md`](../../apps/harness/docs/architecture.md)
and the specs that extend it (code pane, workspace/plugins/ACP, usage, subscription agents, v7, router integration,
packaging, memory), with the exact HTTP shapes in `apps/harness/docs/` (`v7.md`, `memory.md`, `settings.md`,
`acp-orchestrator.md`). Types here mirror the Go JSON exactly. System overview: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

Members of `Bridge` added after the first harness version are **optional** (`getSettings?`, `putSettings?`,
`getDiagnostics?`, the v7 queue, changes, approvals, forms and secrets methods, `getTurnContext?`, the memory methods
`listTasks?`, `listMemory?`, `getMemoryFile?`, `putMemoryFile?`, `deleteMemoryFile?`, `searchMemory?`, M4: `listMemorySessions?`, `getMemorySession?`, `forgetExchange?`): a host or the
demo bridge may omit them and callers must check before calling. Parallel sessions (2026-11-14) made five members
required (every host forwards them, `BRIDGE_METHODS`): `createSession`, `setDefaultSession`, `stopSession`,
`sendSessionMessage`, `listAllSessions`; the per-session queue, context, compact, clear, rewind, plan and export routes are
optional and HTTP only. `sessionBridge(bridge, sid)` (`sessionBridge.ts`) is the same `Bridge` addressed to one main
session; the reducer keeps one `SessionSlice` per main session (`sessions.byId`) and `scopeState` reads a session's view. The reducer folds the matching events
(`queue.updated`, `approval.*`, `input.*`, `change.recorded`, `project.attention`, `secrets.changed`, `task.updated`,
`memory.updated`); `settings.changed` only advances `lastSeq` (a host refetches the settings itself).

## Rules

- A new endpoint is: type in `types.ts` → method on `Bridge` (in `client.ts`; optional unless every host must have it)
  → `createHttpBridge` → message-bridge allow-list (`messageProtocol.ts`) → tests → the UI's demo bridge
  (`packages/ui/src/demo/bridge.ts`; required for a non-optional member, or the UI will not type-check).
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
