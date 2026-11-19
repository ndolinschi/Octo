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

## As built — P1–P6 (2026-11-11)

Verified by the orchestrator: Go gates; `harness serve` started by hand with an empty environment (11 built-in
agents listed, `builtin_loop.available: false`); `scripts/e2e-acp-orchestrator.sh` (no-key scenario);
`scripts/test-dev-sh.sh`; 42 tests of the `octo-sidecar` crate; desktop lint and tests. **Not verified:** the Tauri
glue (`src-tauri/src/lib.rs`) was not compiled here (no WebKitGTK) — CI compiles it; `install.sh` was never run on
macOS; the installed app was never launched; shellcheck was not available.

- The built-in loop counts as available when an API key, an Octo key or a non-default base URL is configured (no
  network check).
- `harness.env`: flags > process environment > file; `HARNESS_DATA_DIR` cannot come from the file.
- P4's default applies when a project's orchestrator equals the server default; an agent whose login probe has not
  answered yet is skipped, so a turn in the first seconds after start may pick the next agent.
- The sidecar is started with `std::process` in its own process group (not the shell plugin); a `harness.pid` file
  lets the next launch remove a leftover after a crash.
- Test scripts set `HARNESS_NO_BUILTIN_PLUGINS=1` so they never probe or start a real agent CLI. (One e2e run
  before this was added let the router choose `acp:claude-code` and the harness fetched the adapter with `npx`.)

## Everything from the desktop app, with no extra steps (owner, 2026-11-11)

"There must be a simple way to run everything through the desktop app without additional actions." After
`scripts/install.sh` the user opens Octo and works: no terminal, no environment variables, no config files.

**P7 — settings through the API (harness).** `GET /v1/settings` and `PUT /v1/settings` read and write
`{data-dir}/harness.env` for a fixed list of settings: provider keys (`ANTHROPIC_API_KEY`, the router's upstream
key), default models per tier and the default orchestrator, the router on/off switch and its base URL, the
child-environment allow list. Secrets are **write-only**: `GET` returns `{ set: true, hint: "…last 4" }`, never the
value; values are never logged or put in events. A write is atomic (temp file, 0600, rename). Each setting says
whether it applies at once or needs a restart; the response lists `restart_required`. Settings that can apply at
once do (models, default orchestrator, allow list); keys and the router switch need a restart of the sidecars,
which the desktop shell performs. Loopback only, and refused when the bridge was started with a remote bind.

**P8 — the router as a second sidecar (desktop).** The app bundles the `octo` router binary next to the harness.
At launch, when the router is switched on in the settings and has an upstream key, the shell starts the router on a
free loopback port with a generated client key and its data under the app data dir, waits for `/health`, and
starts the harness with `--base-url http://127.0.0.1:<port>/autoroute` and that key. Router off or no key → the
harness alone (ACP agents work; the built-in loop works when an Anthropic key is set). A router that fails to start
does not block the app: the harness starts without it and the UI shows a notice with the log tail. Both stop on
quit. `bridge_restart` restarts both with the current settings. `scripts/install.sh` and `scripts/dev.sh
--router` build and bundle the router too.

**P9 — first run and Settings in the UI.** First launch shows one screen, not a wizard: "How should Octo run
agents?" with what was found on this machine — each subscription agent with its state (ready / not logged in, with
the one-line way to log in / not installed), and "Use an API key" (a secret field, decision 43 styling). One choice
is preselected (the first ready agent); "Continue" stores it and opens Home. Nothing found and no key → the screen
says exactly what to do and re-checks when the window regains focus. Settings → "Models and keys" holds the same
controls later, plus the router switch with its key and a "Restart to apply" action when needed. In a browser
(no Tauri) the restart action is replaced by a sentence saying the server must be restarted.

Acceptance: (7) settings round-trip with secrets never returned or logged, atomic write, restart flags; (8) unit
tests for the two-sidecar start order, the router-failure path and shutdown; a scripted Linux check that
`scripts/dev.sh --router` brings up router, harness and UI and leaves nothing behind; (9) the first-run screen in
every state in the demo (`?demo=1&firstrun=…`), decision 42's bar. The installed macOS app remains for the owner
to try.

## As built — login-shell environment (2026-11-13)

Cause suspected for "Grok is not logged in" in the app while logged in from a terminal: the sidecar passed only `PATH`, so the agent CLI (and its probe) missed `LANG`/`LC_*`, `XDG_*`, `SSH_AUTH_SOCK`, tool homes, proxy and CA settings, `TMPDIR`. Built in `octo-sidecar` (`shellenv`, `bridge`): the one login-shell run that yields `PATH` also prints `env -0` between markers; an allow-list of names is forwarded (list in `apps/desktop/AGENTS.md`); names with KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL are never forwarded, enforced in code regardless of the list; a name set in `harness.env` is not forwarded (the harness's process environment beats the file); otherwise the login shell's value wins over the app's own; shell failure or timeout gives exactly the earlier fallback. The log has one names-only line. Harness: `BUN_INSTALL` and `VOLTA_HOME` added to the child-environment allow-list (they were dropped there), and `harness doctor` / `GET /v1/diagnostics` gain `shell_env_set` (names only).

**Verified:** `cargo test -p octo-sidecar` with fake login shells (banner, NUL entries with newlines and `=`, deny words with a permissive list, `harness.env` precedence, no `env -0` output, hang gives the fallback), Go tests for `internal/diag` and `internal/childenv`. **Not verified:** on macOS (`env -0` there, a real zsh/fish profile, a Finder launch), and that this fixes the owner's Grok login report (the live step is B13 in `LIVE-CHECKLIST.md`). A proxy URL may carry credentials in its value; it is forwarded as the owner's terminal has it (the harness already allowed those names).

## As built — P8 (2026-11-11)

Verified: 61 `octo-sidecar` tests (fake harness/router binaries for router off, on and healthy, failing to start, never healthy, missing binary, external
URL, shutdown order, restart with a changed settings file, leftover router cleanup); `scripts/test-dev-sh.sh` and `scripts/test-dev-sh.sh --router --mock`
(router + harness + UI up, router enforces its client key, harness reports `router: true`, nothing left after SIGINT); desktop lint, format, tests, build.
**Not verified:** the Tauri glue (`bridge_notices`, the second `externalBin`) was not compiled here (no WebKitGTK); the `HostNotice` component was not looked at
in a running app; the macOS bundle and `install.sh` were not run.

- The router has no flag or environment variable for its bind address, client key or database path: only `OCTO_CONFIG` (a directory of TOML fragments; `[server]`
  and `[limits]` are required, everything else has defaults). The shell writes `server.toml` (0600), `limits.toml`, `history.toml` into `{app data}/router/config` at
  every start, with `database_path = {app data}/router/history.sqlite`.
- The router does not hold a provider key: it forwards the caller's `Authorization` / `x-api-key` upstream and gates callers with `x-octo-key`. So
  `OCTO_ROUTER_UPSTREAM_KEY` reaches the harness as `ANTHROPIC_API_KEY` (process environment beats `harness.env`), the generated client key as `HARNESS_OCTO_KEY`;
  neither is on a command line. With the router enabled but no upstream key nothing is started and no notice is shown (harness alone, as designed).
- The second binary is `binaries/octo-<triple>`, installed next to the executable as `octo`; the main binary is `octo-desktop` (Tauri uses the Cargo output name).
- `bridge_notices()` returns `[{ kind: "router_failed", message, log_tail }]` or `[]`, computed from the last start; Retry is `bridge_restart`. A router that dies after a
  successful start is not watched (the harness's calls then fail upstream); a restart fixes it.
- `scripts/build-sidecar.sh --no-router` (or `OCTO_NO_ROUTER=1`) writes an executable placeholder so `tauri-build` finds the file; a real binary is never overwritten
  by it. `scripts/install.sh` always builds the real router.

## As built — P7 (2026-11-11)

`GET` / `PUT /v1/settings` (guide: `apps/harness/docs/settings.md`). Verified by the orchestrator: Go gates, both
e2e scripts, agent-client lint and 64 tests. **Not verified:** a hand-run server with a browser or the Tauri shell;
the shell and the harness writing `harness.env` at the same moment.

- Setting ids are the variable names: `ANTHROPIC_API_KEY`, `HARNESS_MODEL_ORCHESTRATOR|FAST|BALANCED|DEEP`,
  `HARNESS_CHILD_ENV_ALLOW`, and the router group `OCTO_ROUTER_ENABLED`, `OCTO_ROUTER_UPSTREAM_KEY`,
  `OCTO_ROUTER_BASE_URL` (stored and reported by the harness, used by the shell; never passed to child processes).
- The router holds no provider key: with the bundled router on, the shell starts the harness with
  `ANTHROPIC_API_KEY` = the upstream key, so that setting reads `editable: false` with a `note` saying why.
- Models and the allow list apply at once (running turns keep what they started with); keys and the router
  settings list themselves in `restart_required` until the process is restarted.
- Refused (403) on a non-loopback bind, peer or `Host`, and for any foreign `Origin`.
- `settings.changed` (ids only) is published on every project stream — there is no global stream.
- A settings file naming an `acp:` agent that no longer exists logs a warning and falls back instead of stopping
  the server. A project created before a default change keeps its stored models.
- `Bridge.getSettings` / `putSettings` are optional interface members (the demo bridge does not have them yet).

## As built — P8b, first-run fixes (2026-11-11)

Defects from the owner's first Linux run. **Verified:** sidecar crate (fmt, clippy, 64 tests incl. `tests/stdin_close.rs`), `install.sh` prerequisite output with
and without `pkg-config` (stub PATH), `test-dev-sh.sh` (plain and `--router --mock`) with the default bridge port occupied, desktop lint/format/test. **Not verified:** the Tauri
window itself (no WebKitGTK here), light theme in a real webview, and the real harness/router honouring the stdin settings if their binaries predate them.

- A killed app no longer leaves sidecars: each is spawned with a piped, never-written stdin held open by `Sidecar`, and with `HARNESS_EXIT_ON_STDIN_CLOSE=1` and
  `OCTO_EXIT_ON_STDIN_CLOSE=1` in the environment (env form only: an older binary ignores it). Pid-file cleanup remains the second net.
- `install.sh` reports pkg-config and the Tauri libraries in one pass; `--no-install` on Linux prints the AppImage path. All icons named in `tauri.conf.json` existed; the
  PNGs were 8-bit palette images (Tauri wants RGBA), so they were regenerated from `icon.png` with `tauri icon` (works offline); `icon.icns`/`icon.ico` unchanged.
- `dev.sh` moves busy default ports (bridge, UI, mock, router) to the next free one, passes the chosen bridge to the UI, prints one block; explicit ports stay errors naming the
  process. The UI port is read from `OCTO_DEV_UI_PORT` in `vite.config.ts` (default 1420, which `tauri dev` still uses). Output produced after dev.sh signals its children is dropped.
- Host theme: `index.html` hard-coded `data-theme="dark"`, so `HostStatus`'s follow-the-system hook (which returns when a theme is set) never ran and the host screens were dark on a
  light system. Now a first-paint script plus colours and `color-scheme` meta in `index.html`; the hook is gone.
- Closing the last window exits the app (Tauri default, `prevent_exit` is never called) and `RunEvent::Exit` stops both sidecars; documented per platform in the README.

## R1 — ready for the owner's daily use (2026-11-11)

Owner: "bring the app to production so I can start using and testing it; I will test on Grok, Claude and Copilot."
The bar below is what "ready" means; anything not on it waits.

1. **The branch builds from a clean clone.** `pnpm install && pnpm lint && pnpm --filter @octo/desktop build`,
   `scripts/install.sh` and CI are green at HEAD (today HEAD has a type error in `packages/ui`; fixed with UI part 2).
2. **No terminal after install.** The app starts both sidecars, and the first-run screen (P9) lists the agents found
   on this machine with one of: ready / not logged in (+ the exact command to run) / not installed (+ what to
   install). The user picks one, or enters an API key; nothing else is needed to send the first message.
3. **The three agents the owner tests are first-class:** `claude-code`, `copilot`, `grok` are listed first, each with
   install and login instructions in the app and in `apps/harness/docs/acp-orchestrator.md`. Known vendor limits are
   stated where the user sees them (Copilot: `/login` or `COPILOT_GITHUB_TOKEN` with "Copilot Requests"; Grok: browser
   login, an `XAI_API_KEY` in the harness environment switches it to per-token billing).
4. **A failure is never silent.** Agent missing, not logged in, refused MCP servers, crashed mid-turn, router down,
   budget reached: each ends the turn with a visible message that says what happened and what to do.
5. **A problem can be reported in one step.** `harness doctor` (and the same data at `GET /v1/diagnostics`, shown in
   Settings with a "Copy report" button): versions, data dir, PATH used for children, each agent's command
   resolution, probe result and reason, router state, the last 200 log lines. An opt-in ACP wire trace
   (`HARNESS_ACP_TRACE=1` or a Settings switch; per-session file under the data dir, size-capped, values of
   environment variables and bearer tokens redacted) so a failed run with a real CLI can be diagnosed from the file.
   No secrets in either; a test asserts it.
6. **Data is safe across updates.** Migrations are forward-only and tested from the previous schema; the app never
   deletes a project database; a newer database opened by an older binary is refused with a message.
7. **A checklist the owner runs** (`docs/superpowers/LIVE-CHECKLIST.md`): install, first run, one task per agent
   (Claude Code, Copilot, Grok) as orchestrator and as sub-agent, router on/off, quit/kill, what to send back
   (the doctor report and the trace file).

Out of R1: bots, I3 savings view, signed/notarised builds, auto-update, Windows.
**What the orchestrator cannot do:** run or log in any of the three CLIs — every agent-specific path stays "not
verified" until the owner's run; R1 makes that run cheap to do and to report.


---

## As built — R1 (harness)

Details: [`apps/harness/docs/acp-orchestrator.md`](../../../apps/harness/docs/acp-orchestrator.md) (agents, failures, diagnostics, trace). Not run against any real CLI.

- **R1.3.** The built-in manifest lists `claude-code`, `copilot`, `grok` first. Each has `install` (new manifest field, `install_hint` in `GET /v1/plugins`) and `auth.hint` with the login text of R1.3 (Copilot: `/login` or `COPILOT_GITHUB_TOKEN` with "Copilot Requests"; Grok: `grok login`, `XAI_API_KEY` switches to per-token billing). The Grok command line and install text are unverified; Copilot's `npm install -g @github/copilot` and Claude's `npm install -g @anthropic-ai/claude-code` come from memory of the vendors' docs, not from a run.
- **R1.4.** `scripts` and tests cover: missing command, not logged in, authenticate refused, MCP servers refused, crash, `stopReason` refusal / max_tokens, and **no text and no tool call** (a failed turn "the agent returned nothing ...; if it is not logged in: <hint>", for an orchestrator turn and for a sub-agent). Fake agent markers: `[silent]`, `[refuse]`, `[max-tokens]`, `[crash]`. Remaining guess: the owner's silent Copilot turn was an `end_turn` with nothing in it (or a crash the harness reported but the UI did not show); if it recurs, the wire trace shows which.
- **R1.5.** `harness doctor [--json]` and `GET /v1/diagnostics` (`internal/diag`): see the doc; the log tail is a ring of the last 200 records scrubbed of credentials. The ACP wire trace (`internal/acptrace`, `HARNESS_ACP_TRACE`, also the setting `HARNESS_ACP_TRACE`, applied at once): per-process files under `{data-dir}/traces/`, 5 MB cap per file (oldest half dropped), 20 files, redaction of secret-named values, env/header pairs, bearer tokens, manifest env values, the MCP token and project secrets. Doctor runs each agent's login probe (exit status only); the endpoint does not run anything. Not in the report: environment values, file contents of the project.
- **R1.6.** `PRAGMA user_version` stamps `registry.sqlite` and every `project.sqlite` (`projectstore.SchemaVersion` was 1 when this was written; it is **3** now, after memory M1 and M2 — each bump is a forward migration with a test; databases without a stamp are older and migrate forward as before). A database stamped higher is refused before anything is changed: `... was written by a newer version of the app (database schema N, this version understands M up to): update the app; the database was left untouched` (`NewerSchemaError`; `harness serve` fails to start on a newer registry, a newer project fails to open with this message). Tests: migration from the schema of commit 20d4d6b (embedded as `testdata/project_schema_20d4d6b.sql`, with rows kept and the new tables usable), refusal of a newer project database (and that it was not touched) and of a newer registry.
- Related: the server default access of new projects is `full` until the UI ships approval cards (`HARNESS_DEFAULT_ACCESS=supervised` still works).

## As built — child processes do not outlive the harness (2026-11-19)

Terminal shells and Processes runs are session leaders; closing, stopping and shutting down signal the whole session and
every descendant (SIGHUP/SIGTERM, SIGKILL after the grace), so `sleep 777 &` and `python3 -m http.server 9790 &` started in a
terminal end with it. Children are recorded in `{data-dir}/children.json`; the next start stops the ones a SIGKILLed
instance left (only when pid and start time match). Decision: stop, not re-adopt (nothing could show their output). The
desktop's process-group stop of the harness and this agree: the group holds the harness, its children are in their own
sessions and are stopped by the harness on SIGTERM or by the next start. Verified on Linux with real processes
(`internal/proctree`, `internal/terminal`, `internal/commands` tests, and the reviewer's reproduction); macOS (`ps`-based
listing) compiled only; Windows unchanged. Details: `apps/harness/docs/architecture.md`.

## As built — one version, `--version` everywhere (2026-11-19)

One version, **0.2.0** (the highest present; this spec names no other): `apps/harness/internal/buildinfo.DefaultVersion`,
`apps/router/Cargo.toml`, `apps/desktop/package.json`, `src-tauri/Cargo.toml`, the sidecar crate, `tauri.conf.json` and
`packages/ui` (`UI_VERSION`); `TestOneVersionEverywhere` fails when one differs. The harness's version is a variable
(`buildinfo.Version`, default the constant) that `scripts/build-sidecar.sh` (and so `install.sh`) stamps with the desktop
app's version and the git commit; without a stamp the commit `go build` recorded is used. `harness --version` / `version`
print it and exit 0 (they used to print usage and exit 2); `octo --version` / `--help` print and exit 0 without starting
the proxy (they used to start it and fail on the config). `GET /health` of the harness adds `commit` and `router_version`;
Settings → About shows the harness, router (while one runs) and UI versions. Verified: `TestVersionFlag`,
`TestVersionFromHealth`, `cli::tests`, the built binaries; the About page was type-checked, not driven in a browser.

## As built — start-up messages (2026-11-19)

Non-loopback `--addr`: a WARN line, the token requirement unchanged (`TestServeWarnsOnNonLoopbackAddr`). Unwritable data
folder: `data_dir_unwritable` with the path and hint (`TestServeOnUnwritableDataDir`, on sysfs, which refuses root;
skipped where no such place exists). Migration backups: documented as kept, never deleted automatically.
