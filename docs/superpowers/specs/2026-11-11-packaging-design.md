# Running and installing Octo — design

**Date:** 2026-11-11 · **Status:** approved to build (owner: "`ANTHROPIC_API_KEY=mock go run ./cmd/harness serve
--plugins-dir plugins-examples/subscription-agents` is not good, adapt it; we also need a script that builds the
project and puts it into Applications")

## Problems

1. `harness serve` refuses to start without `ANTHROPIC_API_KEY`, even when every model of every project is an ACP
   agent on a subscription. People type a fake key.
2. The subscription agents load only with `--plugins-dir plugins-examples/subscription-agents`, a path inside the
   source tree.
3. Running the product takes three terminals; there is no installed app. The Tauri shell is a bare window that
   expects someone else to have started the harness.

## Decisions

**P1 — no key needed to start.** `harness serve` starts without any provider key. The built-in loop is *available*
when an API key or an Octo router base URL is configured; `GET /v1/config` gains `builtin_loop: { available:
boolean, reason?: string }`. A request that needs the built-in loop while it is unavailable ends that turn (or that
sub-agent) with one clear error: "No API key is configured for the built-in agent loop. Set ANTHROPIC_API_KEY (or a
router), or choose an ACP agent for this project." Nothing else changes when a key is present.

**P2 — settings file.** At start the harness reads `{data-dir}/harness.env` when it exists (`KEY=VALUE` lines, `#`
comments; must not be group- or world-readable, else it is refused with a warning naming the fix). Values fill only
variables that are not already set in the process environment. This is where an installed app keeps
`ANTHROPIC_API_KEY`, `HARNESS_MODEL_*`, `HARNESS_CHILD_ENV_ALLOW`, the router base URL. (A Settings screen writes
it later — UI decision 43.)

**P3 — built-in agents.** The subscription-agents manifest is embedded in the binary and loaded by default as the
plugin `subscription-agents` (a directory plugin with the same name overrides it; `--no-builtin-plugins` /
`HARNESS_NO_BUILTIN_PLUGINS=1` turns it off). `plugins-examples/subscription-agents/plugin.json` stays the single
source (embedded from there, no copy). So the command is `harness serve`.

**P4 — default orchestrator without a key.** When no key and no router are configured and a project has no explicit
orchestrator, the default is the first ACP agent that is available and logged in, in the order claude-code, codex,
copilot, then the rest; none → the built-in default (whose turn then fails with the P1 message). The choice is
made when a turn starts, not stored, and is reported in `GET /v1/config` as `default_orchestrator`.

**P5 — the desktop app runs the harness.** The Tauri app bundles the `harness` binary as a sidecar and, at launch:
resolves the user's login-shell `PATH` (a GUI app on macOS does not inherit it, and the agents are `npx`, `claude`,
`copilot` …), picks a free loopback port, starts `harness serve --addr 127.0.0.1:<port> --data-dir <app data
dir>/harness` with that `PATH`, waits for `/health`, hands the URL to the UI, and stops the process (and its
children) on quit. If `VITE_HARNESS_BRIDGE_URL` / an `OCTO_BRIDGE_URL` environment variable is set it connects
there instead and starts nothing. A harness that fails to start shows a plain error screen with the log tail and
"Retry". `packages/ui` stays free of Tauri imports: the shell passes the URL through the existing bridge choice.
The window opens at 1280×800 (min 720×480), titled "Octo".

**P6 — scripts.** `scripts/dev.sh`: one command for development — builds and starts the harness (no key needed)
and the UI dev server, prints the URL, stops both on Ctrl+C; `--mock` adds the mock model. `scripts/install.sh`:
checks the toolchains (pnpm, Go, Rust; on macOS the Xcode command-line tools) and says exactly what is missing;
builds the harness for the host target, places it where Tauri expects the sidecar, runs the Tauri build, and
installs the app: macOS → `/Applications/Octo.app` (`--user` → `~/Applications`), replacing an older copy after
quitting it, ad-hoc signed (`codesign -s -`) so it opens without a developer certificate; Linux → the AppImage in
`~/.local/bin/octo` plus a desktop entry. `--no-install` only builds. Data lives outside the app bundle and
survives reinstalling.

## Acceptance

1. `harness serve` with an empty environment starts, lists the built-in agents in `/v1/plugins`, and answers
   `/v1/config` with `builtin_loop.available: false`.
2. A turn on a project with an `acp:` orchestrator (scripted agent) completes with no key anywhere; a turn that
   needs the built-in loop fails with the P1 message and no upstream call.
3. `harness.env` is read; a group-readable file is refused; process environment wins.
4. With a key set, every existing test and both e2e scripts pass unchanged.
5. `scripts/dev.sh` brings the stack up from a clean checkout and leaves no process behind on Ctrl+C (Linux,
   scripted check).
6. `cargo check` in `src-tauri` passes; unit tests for port choice, PATH resolution parsing, health wait and
   shutdown. **The built app itself (macOS bundle, install into Applications, first launch) cannot be run in the
   build environment and must be tried by the owner.**
