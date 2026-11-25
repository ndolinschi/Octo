# Octo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/octo-dark.png">
  <img alt="Octo: a project's session with the agent's work, the changed files beside it and the session tree in the sidebar" src="./docs/images/octo-light.png">
</picture>

_The desktop app on demo data (`?demo=1`)._

**Octo is an open-source desktop app for working with coding agents: a Cursor-style experience that runs locally,
works with any model provider, and has no telemetry.**

- **Any provider.** Run coding agents you already pay for — Claude Code, GitHub Copilot, Codex, Grok, Cursor, OpenCode,
  Antigravity and more — through the [Agent Client Protocol](https://agentclientprotocol.com), or use Octo's built-in
  agent loop with your own Anthropic API key. The optional Octo router adds OpenAI / OpenRouter models and cheaper-model
  routing with a budget. Mix them side by side.
- **Local first.** Projects, sessions, history and settings live on your machine (one SQLite file per project). The only
  traffic that leaves your computer is the calls to the models or agents you chose.
- **No telemetry.** No analytics, crash reporting or update checks. See
  [Privacy and data](./docs/user-guide/privacy-and-data.md).
- **You stay in control.** See what the agent does, approve or refuse its edits and commands, review the changes and
  revert them, and keep several sessions going at once.

## Status: early and very raw

Octo is an early project. Expect rough edges, missing features, UI glitches and breaking changes between commits. There are
**no signed releases yet**: you build it from source. It is mostly exercised on Linux with a mock model and scripted
agents; macOS release builds and many real agent programs have had little or no testing, and Windows is not supported by
the installer. What has and has not been verified is written down in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#status).

Bug reports, ideas and pull requests are very welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

**License:** [MIT](./LICENSE).

## How it fits together

The repository is a monorepo with three main parts:

- the **harness** (`apps/harness`, Go): the local project server. It holds projects, runs the agents, keeps each
  project's history in its own SQLite file, and speaks HTTP and server-sent events on `127.0.0.1`.
- the **desktop app** (`apps/desktop` with `packages/ui` and `packages/agent-client`): the window you use. A Tauri 2 shell
  starts the harness (and, if you switch it on, the router) and shows the shared React UI. `apps/web` is the same UI for a
  paired phone.
- the **router** (`apps/router`, Rust; optional): a proxy that picks cheaper models for easy work and keeps a spend
  budget. The app works without it.

| App / package | Path | Description |
| --- | --- | --- |
| **harness** | [`apps/harness/`](./apps/harness/) | Go project server (`harness serve`): one orchestrator per project (built-in loop or an ACP agent), sub-agents, per-project SQLite, memory, changes / approvals / queue, file API, plugins, settings, `harness doctor` |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Tauri 2 shell for the shared UI; starts the harness and the optional router as sidecars |
| **ui** | [`packages/ui/`](./packages/ui/) | Shared React UI (`@octo/ui`) for the desktop app and the mobile web client |
| **agent-client** | [`packages/agent-client/`](./packages/agent-client/) | Harness bridge client (`@octo/agent-client`): HTTP + SSE, state reducer, message-port bridge |
| **web** | [`apps/web/`](./apps/web/) | Mobile web client (`@octo/web`): the same UI on a phone, served by the harness through Remote access |
| **router** | [`apps/router/`](./apps/router/) | Optional Rust HTTP proxy (crate `octo`) for OpenAI / Anthropic / OpenRouter with a model ladder, budgets and a call history |

## Build from source

### Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 22 or newer |
| pnpm | 10 or newer (`corepack enable`) — the repo pins `pnpm@10.33.4` |
| Go | 1.26 or newer (`bash scripts/install-go-toolchain.sh` installs the pinned toolchain on Linux) |
| Rust | the version in [`rust-toolchain.toml`](./rust-toolchain.toml) (1.90.0), via <https://rustup.rs> |
| macOS | Xcode command-line tools |
| Linux | WebKitGTK development packages (the installer prints the command for your distribution) |

### Try it in the browser, no API key needed

```bash
pnpm install
pnpm dev:all -- --mock      # harness + a mock model + the UI; Ctrl+C stops everything
```

Open the address the script prints (`http://localhost:1420` when the default ports are free), create a project on any
folder and send a message; the mock model answers. `?demo=1` on the UI address shows demo data without any backend.
If a default port (8790, 8791, 8792, 1420) is taken, the script picks the next free one; `OCTO_DEV_PORT_BASE=N` moves
all four to a range starting at N.

```bash
pnpm dev:all                      # without the mock model: add an API key or an agent in Settings
pnpm dev:all -- --router --mock   # also run the optional router in front of the harness
```

### Build and install the desktop app (macOS, Linux)

```bash
pnpm install:app   # builds the harness and router sidecars and the Tauri app, then installs it
```

Details, data locations and uninstalling: [docs/user-guide/install.md](./docs/user-guide/install.md).

### Run the tests

```bash
pnpm install && pnpm test           # TypeScript packages, desktop and web
(cd apps/harness && go test ./...)  # harness
cargo test -p octo                  # router
pnpm lint                           # ESLint + TypeScript + dependency-cycle check
```

## Documentation

| Guide | Contents |
| --- | --- |
| [docs/user-guide/](./docs/user-guide/README.md) | Install, first run, projects and sessions, approvals, Remote access, privacy and data, troubleshooting, shortcuts |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview: processes, parts, data locations, flows, module map, environment variables, status |
| [docs/SYSTEM.md](./docs/SYSTEM.md) | Runtime view: start-up and shutdown, failure modes, API by area, data model, limits, diagnostics |
| [packages/ui/COMPONENTS.md](./packages/ui/COMPONENTS.md) | UI component library, design tokens, check scripts |
| [apps/harness/docs/](./apps/harness/docs/README.md) | Harness docs |
| [apps/router/README.md](./apps/router/README.md) | Router guide |
| [AGENTS.md](./AGENTS.md) | Monorepo map and conventions (also read by coding agents working in this repo) |
| [docs/superpowers/specs/](./docs/superpowers/specs/) | Design documents with "as built" notes |

## Community

- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security policy](./SECURITY.md) — please report vulnerabilities privately, not in public issues.
