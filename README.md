# Octo

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/octo-dark.png">
  <img alt="Octo: a project's session with the agent's work, the changed files beside it and the session tree in the sidebar" src="./docs/images/octo-light.png">
</picture>

_The desktop app on demo data (`?demo=1`)._

Octo is a desktop app that runs coding agents inside your project folders: its own agent loop on a model API key, and
other agent programs such as Claude Code on your subscription, side by side. You see what the agent does, approve or refuse
its edits and commands, review the changes and revert them, and keep working in several sessions at once. Everything runs on
your computer; the only traffic that leaves it is the calls to the models or agents you chose.

**Status:** built from source (there are no signed releases yet), and verified with a mock model, scripted agents and
Chromium on Linux. It has not been run on macOS in a release build, or with most real agent programs; what was and was not
verified is written down in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#status). No licence has been chosen yet.

**Using Octo:** the [user guide](./docs/user-guide/README.md) (install, first run, projects, approvals, privacy,
troubleshooting, shortcuts).

The repository is an apps-directory monorepo with shared frontend packages. There are three parts to know:

- the **harness** (`apps/harness`, Go): the local project server. It holds projects, runs the agents, keeps each project's
  history in its own SQLite file, and speaks HTTP and server-sent events on `127.0.0.1`.
- the **desktop app** (`apps/desktop` with `packages/ui` and `packages/agent-client`): the window you use. A Tauri shell starts
  the harness (and, if you switch it on, the router) and shows the shared React UI. `apps/web` is the same UI for a paired phone.
- the **router** (`apps/router`, Rust; optional): a proxy that picks cheaper models for easy work and keeps a spend budget.
  The app works without it.

| App / package | Path | Description |
| --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust HTTP proxy for OpenAI / Anthropic / OpenRouter, plus an autoroute model ladder, a price rule, a routing decision for delegated tasks, budgets and a SQLite call history |
| **harness** | [`apps/harness/`](./apps/harness/) | Go project server (`harness serve`): one orchestrator per project (built-in Messages loop or an ACP agent such as Claude Code on a subscription), nested sub-agents, per-project SQLite, memory, changes / approvals / queue, file API, plugins, settings, `harness doctor` |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Tauri 2 shell for the shared UI; starts the harness and the optional router as sidecars |
| **ui** | [`packages/ui/`](./packages/ui/) | Shared React UI (`@octo/ui`) for the desktop app and the mobile web client |
| **agent-client** | [`packages/agent-client/`](./packages/agent-client/) | Harness bridge client (`@octo/agent-client`): HTTP + SSE, state reducer, message-port bridge |
| **web** | [`apps/web/`](./apps/web/) | Mobile web client (`@octo/web`): the same UI on a phone, served by the harness through Remote access |

## Documentation

| Guide | Contents |
| --- | --- |
| [docs/user-guide/README.md](./docs/user-guide/README.md) | End-user guide: install, first run, working with an agent, Remote access, privacy and data, troubleshooting, shortcuts |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System overview: parts, process diagram, data locations, flows, environment variables, status, specs index |
| [docs/superpowers/HANDOVER.md](./docs/superpowers/HANDOVER.md) | Current state, working rules, next steps |
| [AGENTS.md](./AGENTS.md) | Monorepo map + how agents should work here |
| [apps/router/README.md](./apps/router/README.md) | Octo user guide (curl, Claude Code, history) |
| [apps/router/docs/README.md](./apps/router/docs/README.md) | Product docs index |
| [apps/harness/docs/README.md](./apps/harness/docs/README.md) | Harness product docs index |
| [apps/desktop/docs/architecture.md](./apps/desktop/docs/architecture.md) | Desktop shell + UI boundaries |
| [apps/desktop/README.md](./apps/desktop/README.md) | Run, install, sidecars, quit and kill behaviour |
| [docs/superpowers/specs/](./docs/superpowers/specs/) | Design contracts with "As built" notes (listed in docs/ARCHITECTURE.md) |
| [apps/router/AGENTS.md](./apps/router/AGENTS.md) | Router operational notes for contributors / agents |

## Quick start (router)

```bash
git submodule update --init --recursive
cargo build -p octo
cd apps/router && cargo run
```

Default listen address: `127.0.0.1:8080`. Full setup, config, and examples: [`apps/router/README.md`](./apps/router/README.md).

## Try it in two minutes (no API key)

You need Node 22+, pnpm 10+ and Go 1.26+ (`bash scripts/install-go-toolchain.sh` installs the pinned Go on Linux).

```bash
git submodule update --init --recursive
pnpm install
pnpm dev:all -- --mock      # harness + a mock model + the UI, in a browser; Ctrl+C stops all three
```

Open the UI address the script prints (`http://localhost:1420` when the default ports are free). Create a project on any
folder, send a message, and the mock model answers (the words `quick`, `[write]` and `[acp]` in a message trigger scripted
behaviour; see `apps/harness/docs/memory.md` and `docs/superpowers/HANDOVER.md`). `?demo=1` on the UI address shows demo data
without any backend. If a default port (8790, 8791, 8792, 1420) is taken the script moves on to the next free one and prints the
final addresses; `OCTO_DEV_PORT_BASE=N` moves all four to a range starting at N.

```bash
pnpm dev:all                # harness without the mock model: add an API key or an agent in Settings
pnpm dev:all -- --router --mock   # also the Octo router in front of the harness
pnpm install:app            # build the harness and router sidecars and the Tauri app, then install it (macOS, Linux)
```

### UI tab feature flags (`@octo/ui`)

`@octo/ui` gates dock tool tabs behind UI-only feature flags (`DEFAULT_TAB_FLAGS` in `packages/ui/src/lib/tabFlags.ts`):

- **Disabled by default (`false`):** `sessions` (the `Sessions` dock tool tab and top-bar `Sessions` button/picker), `agents`, `notes`, `details`, `usage`, `memory`.
- **Enabled by default (`true`):** `files`, `browser`, `terminal`, `processes`, `changes`, `review`, `side`.

Left-sidebar project sessions (`SessionTree`), `/new`, session switching, `session:<id>` conversation tabs, sub-agent transcript tabs (`agent:<id>`), `/remember`, and Settings (`Usage and budget`, `Memory`) remain active. These flags are purely client-side in `@octo/ui` and do **not** alter `apps/harness` endpoints, background memory extraction, usage recording, or `@octo/agent-client`. Override in dev/tests via `?tabs=all`, `?tabs=none`, or `?tabs=sessions,usage` (or `OctoApp`'s `tabs` prop).

## Development

Rust workspace root is this directory (`Cargo.toml` members = `apps/router`). Prefer:

```bash
cargo test -p octo
cargo clippy -p octo --all-targets -- -D warnings
```

Run the binary from `apps/router` (or set `OCTO_CONFIG`) so the split `config/` TOML files load from the process cwd.
