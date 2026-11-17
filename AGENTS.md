# Monorepo — agent instructions

This repository is an **apps-directory monorepo**. Applications live under `apps/`. Shared frontend code lives under `packages/`.

| App / package | Path | Stack | Notes |
| --- | --- | --- | --- |
| **router** (Octo) | [`apps/router/`](./apps/router/) | Rust (crate `octo`) | HTTP proxy + autoroute: model ladder, price rule, routing decision for delegated tasks, budgets, SQLite call history |
| **harness** | [`apps/harness/`](./apps/harness/) | Go 1.26+ | Project-based agent harness: `harness serve` bridge, orchestrator (built-in loop or an ACP agent) + sub-agents, per-project SQLite, memory, v7 changes / approvals / queue / forms, file API, plugins (language servers, ACP agents, tool servers), settings, `harness doctor` |
| **desktop** | [`apps/desktop/`](./apps/desktop/) | Vite + React + Tailwind 4 (Tauri 2 shell, crate `octo-sidecar`) | Host for the shared UI; the shell starts the harness and the optional router as sidecars (`?demo=1` for demo data) |
| **ui** | [`packages/ui/`](./packages/ui/) | React | Shell-agnostic UI (`@octo/ui`): sidebar, tab workspace, chat, Monaco editor with comments and LSP |
| **agent-client** | [`packages/agent-client/`](./packages/agent-client/) | TypeScript | Bridge HTTP + SSE client, state reducer, message-port bridge, file/plugin/LSP methods (`@octo/agent-client`) |

**System overview** (parts, process diagram, data locations, main flows, where to look, every environment variable, status, specs index): [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). **Current state and next steps:** [`docs/superpowers/HANDOVER.md`](./docs/superpowers/HANDOVER.md).

**Web** host: [`apps/web/`](./apps/web/) — the mobile web client (`@octo/web`): the same UI, served by the harness through Remote access (`apps/harness/docs/remote-access.md`, spec `2026-11-14-remote-access-mobile-design.md`). Do not invent other shared packages until something is actually shared twice.

## Layout

```text
/
  Cargo.toml              # Cargo workspace (Rust members: apps/router only)
  package.json            # pnpm workspace root
  pnpm-workspace.yaml
  AGENTS.md               # this file
  ARCHITECTURE.md         # pointer to the architecture docs
  docs/ARCHITECTURE.md    # the system overview: parts, flows, data, env vars, status, specs index
  docs/superpowers/       # HANDOVER.md (state and next steps), specs/, research/, plans/
  apps/router/            # Octo proxy
  apps/harness/           # Go agent harness (own go.mod); scripts/ has the e2e scripts
  apps/desktop/           # Vite host + Tauri shell; src-tauri/sidecar is the octo-sidecar crate
  apps/web/               # mobile web client (@octo/web), served by the harness through Remote access
  packages/ui/            # shared React UI
  packages/agent-client/  # harness bridge client (HTTP + SSE, reducer, message-port bridge)
  scripts/                # dev.sh, build-sidecar.sh, install.sh, test-dev-sh.sh, install-go-toolchain.sh, checks
  .cursor/                # skills + rules
  .claude/rules/          # typescript.md (same text as .cursor/rules/octo-typescript.mdc)
  .github/workflows/      # CI: ci.yml (router), harness.yml (Go), desktop.yml (frontend, cargo check/test of the shell)
```

## Router (Octo)

Operational detail: **[`apps/router/AGENTS.md`](./apps/router/AGENTS.md)**. Product docs: [`apps/router/docs/README.md`](./apps/router/docs/README.md).

```bash
git submodule update --init --recursive
cargo build -p octo
cargo test -p octo
cargo clippy -p octo --all-targets -- -D warnings
cargo fmt --check
cd apps/router && cargo run
```

## Harness (Go)

Product docs: [`apps/harness/docs/README.md`](./apps/harness/docs/README.md). Cursor rules: `.cursor/rules/octo-go.mdc`, `go-pr-checklist.mdc`, `verify-go.mdc`.

```bash
bash scripts/install-go-toolchain.sh
cd apps/harness
gofmt -l .
go vet ./...
go test -race ./...                # CI runs go vet, go test, go build

# Diagnostics: versions, data dir, PATH children get, each ACP agent's command and login probe, router state
go run ./cmd/harness doctor [--json] [--data-dir PATH]

# Full stack without an API key (three terminals)
go run ./examples/mockllm
ANTHROPIC_API_KEY=mock go run ./cmd/harness serve --base-url http://127.0.0.1:8791
pnpm --filter @octo/desktop dev   # from repo root, then open http://localhost:1420

# Scripted end-to-end checks (curl against a real `harness serve`; mock model, scripted ACP agent, no third-party CLI).
# Not part of CI. Every harness they start sets HARNESS_NO_BUILTIN_PLUGINS=1.
bash apps/harness/scripts/e2e-acp-orchestrator.sh    # ACP orchestrator over MCP, resume after a crash, no-key start
bash apps/harness/scripts/e2e-router.sh              # harness behind a real router (run `cargo build -p octo` first)
bash apps/harness/scripts/e2e-v7.sh                  # changes, approvals, queue, forms and secrets
bash apps/harness/scripts/test-subscriptions.sh      # LIVE: real agent CLIs on subscriptions (owner's machine only)
```

Docs of the harness's features (exact API): `apps/harness/docs/` — `architecture.md`, `settings.md`, `v7.md`, `memory.md`, `sessions.md` (project sessions: new, resume, agent sessions)
(orchestrator memory), `providers.md` (providers, models, `GET /v1/providers`), `review.md` (PR review), `acp-orchestrator.md` (ACP orchestrator, agents, diagnostics, wire trace), `errors.md` (the error catalogue: `message`, `hint`, `command`, `action`, `details`). Every variable and setting:
the table in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#environment-variables-and-settings).

## Desktop + UI (pnpm)

Design: [`docs/superpowers/specs/2026-11-10-project-harness-design.md`](./docs/superpowers/specs/2026-11-10-project-harness-design.md) (projects, bridge API) and [`2026-11-10-project-harness-ui.md`](./docs/superpowers/specs/2026-11-10-project-harness-ui.md) (UI). Rules: `.cursor/rules/octo-frontend.mdc`, `.cursor/rules/octo-typescript.mdc` (the same text for Claude: `.claude/rules/typescript.md`).

Per-module instructions: [`packages/ui/AGENTS.md`](./packages/ui/AGENTS.md) (architecture: [`packages/ui/ARCHITECTURE.md`](./packages/ui/ARCHITECTURE.md)), [`packages/agent-client/AGENTS.md`](./packages/agent-client/AGENTS.md), [`apps/desktop/AGENTS.md`](./apps/desktop/AGENTS.md).

```bash
pnpm install
pnpm lint                                  # tsc --noEmit + eslint in agent-client, ui, desktop (strict flags: tsconfig.base.json)
pnpm format:check                          # prettier + Tailwind class order; `pnpm format` rewrites
pnpm --filter @octo/agent-client test
pnpm --filter @octo/ui test
pnpm --filter @octo/desktop build
node scripts/check-bundle-size.mjs         # after the build: initial JS (gzip) within its budget
cd apps/desktop/src-tauri && cargo check   # needs binaries/harness-<triple> and binaries/octo-<triple> (bash scripts/build-sidecar.sh [--no-router]) and WebKitGTK on Linux
cd apps/desktop/src-tauri && cargo test -p octo-sidecar   # port, login-shell PATH, health, log cap, process-group stop, harness.env parsing, harness + router start order with fake binaries (no WebKit needed)
pnpm dev:all                               # scripts/dev.sh: harness (no key needed) + UI dev server; Ctrl+C stops both; `-- --mock` adds the mock model, `-- --router` runs the Octo router in front of the harness (needs `OCTO_ROUTER_UPSTREAM_KEY` or `--mock`)
pnpm install:app                           # scripts/install.sh: build harness + router sidecars and the Tauri app, install (macOS /Applications, Linux ~/.local/bin/octo); `-- --user`, `-- --no-install`
pnpm test:dev-sh                           # scripts/test-dev-sh.sh: dev.sh comes up, answers, leaves no process after SIGINT (Linux/macOS); `-- --router --mock` also checks the router
pnpm test:scripts                          # the layer-imports ESLint rule tests (`pnpm test` runs package tests and these)
node packages/ui/scripts/spacing-audit.mjs --url http://localhost:1420   # needs a dev server and Playwright; must print total=0
```

The desktop app bundles the harness and the Octo router as Tauri sidecars and starts them itself (router first, only when
switched on in `harness.env`; free loopback ports, login-shell `PATH`, `/health` waits, harness then router stopped on quit); see [`apps/desktop/AGENTS.md`](./apps/desktop/AGENTS.md). Packaging design:
[`docs/superpowers/specs/2026-11-11-packaging-design.md`](./docs/superpowers/specs/2026-11-11-packaging-design.md).

The UI talks only to the harness bridge (`harness serve`, default `http://127.0.0.1:8790`; override with `VITE_HARNESS_BRIDGE_URL`). Open the app with `?demo=1` to run against the in-memory demo bridge with no backend.

**UI tab feature flags (`packages/ui/src/lib/tabFlags.ts`):** `@octo/ui` disables six dock tool tabs by default (`DEFAULT_TAB_FLAGS`: `sessions`, `agents`, `notes`, `details`, `usage`, `memory` are `false`) while keeping the remaining tool tabs enabled by default (`files`, `browser`, `terminal`, `processes`, `changes`, `review`, `side` are `true`, including multi-instance `terminal:<id>` tabs via `` Ctrl+` `` / `` Ctrl+Shift+` ``). `sessions: false` hides only the `Sessions` dock tool tab and top-bar `Sessions` button/picker (`[data-sessions-button]`); left-sidebar project sessions (`SessionTree`), `/new`, and `session:<id>` conversation tabs stay enabled. Flags are strictly UI-only (they never disable `apps/harness` routes, memory, usage tracking, or `@octo/agent-client`) and can be overridden via `<OctoApp tabs={...} />` or `?tabs=all` / `?tabs=sessions,usage` / `?tabs=all,-notes`.

Do not share SQLite/config between harness, router, and desktop.

## Docs, specs and working rules

- `docs/ARCHITECTURE.md` is the overview and carries the specs index and the status table; `docs/superpowers/HANDOVER.md` is the
  current state, the working rules and the next steps in order.
- Specs (`docs/superpowers/specs/`) are contracts with numbered acceptance criteria; each ends with "As built" notes that say what
  was verified and what was not. Current ones beyond the UI and harness design: `2026-11-10-subscription-agents-design.md`
  (ACP agents, orchestrator on a subscription), `2026-11-10-v7-changes-queue-approvals.md`, `2026-11-11-router-harness-integration.md`,
  `2026-11-11-packaging-design.md` (settings, sidecars, installer, R1), `2026-11-11-orchestrator-memory-design.md`,
  `2026-11-11-inline-completion-design.md` (built on both sides: harness endpoint, editor provider; not verified with a real model), `2026-11-11-pr-review-design.md` (RV1 harness built; UI not built), `2026-11-11-bots-design.md` (draft). Research reports are in
  `docs/superpowers/research/`.
- A change that alters behaviour updates the spec's "As built" section (and the feature's page in `apps/harness/docs/` or the
  app's docs) in the same commit. State what was run and what was not; "not verified" is a valid entry.
- No third-party agent CLI (Claude Code, Copilot, Grok, ...) and no provider key exists in the build environment: tests use the mock
  model (`examples/mockllm`), the scripted ACP agent (`examples/fakeacp`) and the fake router; anything that needs the real thing
  is the owner's live run.

## Editor

Open the **monorepo root** for rust-analyzer (Cargo workspace) and gopls (`apps/harness/go.mod`). For UI, tsserver sees `pnpm-workspace.yaml`. Extensions: `.vscode/extensions.json`.

## Skills

```bash
git submodule update --init --recursive
```

Vendored: `.cursor/skills/superpowers/`, `.cursor/skills/ponytail/`, `.cursor/skills/interfaces/` (UI review and polish: `better-interface`, `better-ui`, `better-typography`, `better-colors`, `better-layout`, `better-writing`).

## Git

- Feature branches: `cursor/<short-description>-a705`
- Push: `git push -u origin <branch>`
- PRs against `main`

## What not to do

- Do not put router source back at the repo root; proxy code stays in `apps/router/`
- Do not import Tauri APIs from `packages/ui`
- Do not mix harness and router persistence or config loaders
- Do not commit `target/`, `node_modules/`, `apps/harness/data/`, `apps/desktop/dist/`, local secrets
