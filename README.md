# Octo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/octo-dark.png">
  <img alt="Octo project view with agent output, changed files and the project sidebar" src="./docs/images/octo-light.png">
</picture>

**Octo is an open-source, local-first coding-agent workspace: a Cursor-style UI on your machine, with the models, subscriptions and agent CLIs you already use. No telemetry built into Octo itself.**

## Status

Early and rough. Build from source; there are **no published release binaries** in this repository. The tree is under active development and things break between commits. Most automated checks run against Linux with a mock model and scripted agents; other platforms and real agent installs are unevenly exercised. What is and is not verified is summarized in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#status).

## What works in the default UI

Some experimental panels are behind feature flags and off by default.

- **Local projects** and conversation history (harness SQLite).
- **`@` mentions** for files and paths in the composer.
- **Model picker** wired to `GET /v1/providers`.
- **Command palette** (`Ctrl/Cmd+K`).
- **Add to chat** (`Ctrl/Cmd+L`) and **inline edit** (`Ctrl/Cmd+I`) from the code editor.
- **Side questions** (Side tab) that stay out of the main agent thread.
- **Changes** and **review** tabs for diffs and pull-request review.
- **Ask first** as the default permission mode for new projects on `harness serve` (`supervised`; see [`apps/harness/docs/v7.md`](./apps/harness/docs/v7.md)).
- **Provider and API settings** in the app.

## Models and agents

The harness exposes providers documented in [`apps/harness/docs/providers.md`](./apps/harness/docs/providers.md):

| Kind | Id | Role |
| --- | --- | --- |
| Built-in loop | `api` | Anthropic Messages API (or a compatible base URL / key you configure) |
| Optional proxy | `router` | Appears when an Octo router answers its health check |
| Local server | `ollama` | When `HARNESS_OLLAMA_BASE_URL` points at a reachable Ollama |
| ACP agents | see below | One entry per agent in the built-in plugin manifest |

**Built-in ACP agent entries** (from [`apps/harness/plugins-examples/subscription-agents/plugin.json`](./apps/harness/plugins-examples/subscription-agents/plugin.json)): `claude-code`, `copilot`, `grok`, `codex`, `cursor`, `opencode`, `antigravity`, `devin`, `droid`, `omp`, `pi`. In that manifest, **`verified: true` only for `claude-code`, `copilot`, and `grok`**; the others are documented launch lines that are not marked verified. You can add or override agents with local plugin manifests ([`apps/harness/docs/providers.md`](./apps/harness/docs/providers.md)).

The optional **router** (`apps/router`, Rust crate `octo`) is an HTTP proxy for OpenAI / Anthropic / OpenRouter with budgets and routing; the desktop app can start it as a sidecar. See [`apps/router/README.md`](./apps/router/README.md).

## Architecture

Monorepo layout:

| Part | Path | Stack |
| --- | --- | --- |
| Harness | [`apps/harness/`](./apps/harness/) | Go — project server, orchestrator, ACP agents, SQLite |
| Desktop | [`apps/desktop/`](./apps/desktop/) | Tauri 2 + React — hosts the UI, starts harness (and optional router) |
| Web client | [`apps/web/`](./apps/web/) | Same UI for mobile remote access through the harness |
| UI | [`packages/ui/`](./packages/ui/) | Shared React shell (`@octo/ui`) |
| Bridge client | [`packages/agent-client/`](./packages/agent-client/) | HTTP + SSE client (`@octo/agent-client`) |
| Router | [`apps/router/`](./apps/router/) | Optional Rust proxy (`octo`) |

Processes, data locations, env vars and diagrams: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Runtime behavior: [`docs/SYSTEM.md`](./docs/SYSTEM.md).

## Quickstart

### Prerequisites

| Tool | Where defined |
| --- | --- |
| Node.js 22+ | Used by `package.json` / workspace |
| pnpm 10+ (`pnpm@10.33.4` pinned) | [`package.json`](./package.json) `packageManager` |
| Go 1.26+ | [`apps/harness/go.mod`](./apps/harness/go.mod) — `bash scripts/install-go-toolchain.sh` installs the pinned toolchain on Linux |
| Rust 1.90.0 | [`rust-toolchain.toml`](./rust-toolchain.toml) |
| Linux / macOS | WebKitGTK dev packages on Linux for the Tauri shell (see [`docs/user-guide/install.md`](./docs/user-guide/install.md)) |

### Try the UI without a real API key

```bash
pnpm install
pnpm dev:all -- --mock
```

Opens the Vite dev server (default `http://localhost:1420` when ports are free) plus a harness with the mock model. `?demo=1` shows in-memory demo data with no backend.

Other root scripts from [`package.json`](./package.json): `pnpm dev:all`, `pnpm dev:all -- --router --mock`, `pnpm install:app`, `pnpm lint`.

### Build the router

```bash
cargo build -p octo
```

### Run tests

```bash
pnpm test
cargo test -p octo
cd apps/harness && go test ./...
```

More commands: [`AGENTS.md`](./AGENTS.md).

## Privacy

Data stays on your machine unless you call a model, agent, optional router upstream, Remote access, or other features you turn on. [`docs/user-guide/privacy-and-data.md`](./docs/user-guide/privacy-and-data.md) lists paths, retention and what can leave the host.

**No Octo telemetry:** [`docs/user-guide/privacy-and-data.md`](./docs/user-guide/privacy-and-data.md) says the codebase has no built-in analytics, crash reporting or update checks. You still choose what leaves your machine: providers, agents, the optional router, `gh` for review, Remote access, and other options you turn on.

## Documentation

| Guide | Contents |
| --- | --- |
| [docs/user-guide/](./docs/user-guide/README.md) | Install, shortcuts, privacy, troubleshooting |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview and status |
| [docs/SYSTEM.md](./docs/SYSTEM.md) | Runtime API and diagnostics |
| [packages/ui/COMPONENTS.md](./packages/ui/COMPONENTS.md) | UI components and tokens |
| [apps/harness/docs/](./apps/harness/docs/README.md) | Harness reference |
| [apps/router/README.md](./apps/router/README.md) | Router guide |
| [AGENTS.md](./AGENTS.md) | Monorepo map for contributors and coding agents |

## Community and license

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security](./SECURITY.md) — report vulnerabilities privately
- [MIT](./LICENSE)