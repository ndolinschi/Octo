# Desktop app architecture

Tauri 2 **shell** for shared UI. Product screens live in [`packages/ui`](../../../packages/ui); bridge wiring in [`packages/agent-client`](../../../packages/agent-client).

## Boundaries

| Layer | Path | Responsibility |
| --- | --- | --- |
| UI | `packages/ui` | React screens — **no** Tauri APIs |
| Client | `packages/agent-client` | Bridge HTTP + SSE client, state reducer |
| Shell | `apps/desktop` | Webview host, OS integration |
| Agent | `apps/harness/` (`harness serve`) | Orchestrator + sub-agent loops, per-project SQLite |

## Data flow

```mermaid
sequenceDiagram
  participant UI as packages/ui
  participant Client as agent-client
  participant Bridge as harness serve
  participant Octo as apps/router
  UI->>Client: send message
  Client->>Bridge: HTTP plus SSE
  Bridge->>Octo: Anthropic Messages
  Bridge->>Bridge: local or remote tools
```

## Running

Desktop loads `OctoApp` with an HTTP bridge at `resolveBridgeUrl()` (default `http://127.0.0.1:8790`), or the in-memory demo bridge when the URL has `?demo=1`. Start `harness serve` manually; sidecar auto-spawn is not implemented.

## Security

When local tools are enabled via harness on desktop, **`bash`** has full user privileges — same as [`apps/harness/README.md`](../../harness/README.md). The UI must not bypass harness to run shell commands.

## Build

```bash
pnpm install
pnpm --filter @octo/desktop build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @octo/desktop tauri dev   # needs OS Tauri prerequisites
```
