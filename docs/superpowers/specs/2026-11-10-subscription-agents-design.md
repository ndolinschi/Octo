# Subscription agents: GitHub Copilot, Grok, Codex — design

**Date:** 2026-11-10 · **Status:** S1 approved to build (owner: "we must support Copilot, Grok and Codex subscriptions for routing and in the harness — important for tests"); S2 and S3 designed, S3's router option needs an owner decision
**Builds on:** [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md) (ACP sub-agents), [`2026-11-10-usage-design.md`](./2026-11-10-usage-design.md)
**Research:** a sub-agent's sourced report (vendor docs, the ACP registry, and the adapters of an open-source app that drives these CLIs); not re-verified by the orchestrator. Items marked *unverified* below came from search snippets or secondary sources.

## What the vendors support

| | Copilot | Grok | Codex |
| --- | --- | --- | --- |
| Agent CLI over ACP | Native: `copilot --acp --stdio` (public preview) | Native: `grok agent stdio` | Adapter: `npx -y @agentclientprotocol/codex-acp` (bundles the Codex CLI); also `codex app-server` (JSON-RPC) and `codex exec --json` |
| Headless login on the subscription | Fine-grained PAT with "Copilot Requests" in `COPILOT_GITHUB_TOKEN` (documented) | Browser login; `XAI_API_KEY` is the documented headless path but is per-token billing, not the subscription; copying `~/.grok/auth.json` is not a documented path | `codex login --device-auth`, credentials in `$CODEX_HOME/auth.json`; OpenAI's documented CI default is an API key |
| Model / effort selection | `/model`; effort only as a start-up flag (`--effort`) | `-m`, `/model`; `grok models` lists them | Per turn over app-server; via the ACP adapter's session options |
| Limits readable by a client | Not found | Only an undocumented endpoint | `account/rateLimits/read` over app-server (documented, shape *unverified*) |
| Documented HTTP API paid by the subscription | None (GitHub Models is retired; the Copilot chat endpoint is undocumented) | None (`api.x.ai` is billed separately) | None (`api.openai.com` is billed separately) |

Consequence: **the supported way to use a subscription is to run the vendor's agent CLI**, not to send HTTP requests
on its behalf. The harness already runs ACP agents; the router is an HTTP proxy and has nothing official to proxy to.

## S1 — the three agents as sub-agents (harness; build now)

1. **Manifests.** `apps/harness/plugins-examples/subscription-agents/plugin.json` with agents `copilot`
   (`copilot --acp --stdio`), `grok` (`grok agent stdio --no-auto-update` if the flag applies to that mode), `codex`
   (`npx -y @agentclientprotocol/codex-acp`), each with a label and the env it reads. Replace the unverified
   commands in `plugins-examples/acp-agents`.
2. **Manifest additions** (backward compatible): per agent `models?: string[]` + `defaultModel?: string` +
   `modelArg?: string[]` (argument template, e.g. `["-m", "{model}"]`) for CLIs that take the model at start-up;
   `auth?: { probe: string[]; hint: string }` — a command that exits 0 when the CLI is logged in (never starts a
   session, never logs in) and a one-line hint shown when it is not; `env` values may reference the harness
   process environment as `${NAME}` (resolved at spawn; a missing variable leaves it unset, never an empty string).
3. **ACP client.** Handle what real agents do that the scripted one does not: `authenticate` when `initialize`
   advertises auth methods and the session start is refused (pick the method that needs no interaction; otherwise
   fail the sub-agent with the manifest's hint); session config options / `session/set_model` when the agent
   advertises models (use the requested model, else the manifest default); agents that reject client MCP servers
   (send none — already the case); permission requests keep today's auto-approve until v7's approvals land.
4. **`spawn_agent`** gains optional `model` for ACP agents (enum from the manifest when present). The agent's
   recorded model becomes `acp:<id>/<model>`.
5. **API.** `GET /v1/plugins` agents gain `logged_in: boolean | null` (null = no probe), `models`, `default_model`,
   `hint`. Probes run at most once a minute per agent, with a 5 s timeout, off the request path.
6. **Tests.** Unit tests with the scripted agent extended to advertise auth methods and models. **Live tests** behind
   `-tags subscription` and env switches (`OCTO_TEST_COPILOT=1`, `OCTO_TEST_GROK=1`, `OCTO_TEST_CODEX=1`): for each,
   one sub-agent run that reads a file and answers, asserting the transcript, the confined file read and a clean
   exit; skipped (not failed) when the CLI is missing or the probe says logged out. A documented `make`-style
   command and a README section "Running on subscriptions" (install, login, the PAT permission for Copilot,
   `CODEX_HOME` isolation, cost notes: Copilot premium requests, plan limits).
7. **Acceptance.** With a logged-in CLI, `[acp]`-style delegation to each agent completes through the UI; logged out,
   the Integrations view says so with the hint; the three live tests pass on a machine with the subscriptions
   (to be run by the owner or in an environment with credentials — this repository's CI has none).

## As built — agent hygiene and the ten agents (2026-11-11)

From the Synara research ([`../research/2026-11-11-synara-gap.md`](../research/2026-11-11-synara-gap.md)):

- **Environment scrub** (`internal/childenv`): ACP agents, language servers and auth probes no longer inherit the
  harness's provider keys and base URLs (`ANTHROPIC_`, `OPENAI_`, `XAI_`, `GEMINI_`, `OPENROUTER_`, `HARNESS_`,
  `*_BASE_URL`, router secrets). A manifest passes a key on purpose with `"env": {"XAI_API_KEY": "${XAI_API_KEY}"}`.
  The orchestrator's own `bash` tool still sees the full environment.
- **Auth preference**: `auth.methods` (ids, or `{id, requiresEnv}`), `auth.skip`; interactive methods (device
  pairing, terminal, browser) are never attempted unattended.
- **`{modelArgs}`** inside `args` places the model flag (Grok: before `stdio`).
- **`subscription-agents` 0.2.0** lists eleven agents: claude-code, copilot, grok, codex, cursor, opencode,
  antigravity, devin, droid, omp, pi. **Only the scripted agent has been run**; the seven new entries come from
  vendor docs, the ACP registry or secondary sources. Live tests: `OCTO_TEST_<ID>=1` with `-tags subscription`.
- Where a manifest forwards a vendor API key (Grok, Cursor, Devin, Droid), a key set in the harness environment
  wins over the cached subscription login — unset it to stay on the subscription.

**Revised the same day (external review):** the scrub is now an **allow-list** — children (ACP agents, language
servers, probes **and the `bash` tool**, which used to inherit everything) get only known-harmless variables
(paths, locale, proxy/CA, toolchain locations); any name containing KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL is
dropped. The operator passes more with `HARNESS_CHILD_ENV_ALLOW="NAME,PREFIX_*"`; a manifest's explicit `env` still
passes a key on purpose. Agent JSON gains `served_model` and `routed_tier` (the newest main-thread usage row), carried
by the existing `agent.updated`.

## S2 — the orchestrator on a subscription (design; build after S1 is proven live)

A project's `models.orchestrator` may be `acp:<agent>[/<model>]`. The orchestrator then runs as an ACP session
instead of the built-in loop. Its harness tools (`spawn_agent`, notes, project files) are exposed to it as an
**MCP server run by the harness** and passed in `session/new.mcpServers` (stdio transport spawned by the agent,
bridged to the harness over a per-session token on localhost). The agent's own file and shell tools are confined by
ACP `fs/*` handling and, from v7, by approvals. The session is kept alive across user requests (one ACP session per
project orchestrator, resumed with `session/load` when the agent supports it; otherwise the harness replays a
summary). Tiers may also map to ACP agents (`fast: acp:grok/…`), so a project can run entirely on subscriptions.
Open points: agents that refuse client MCP servers (Copilot CLI 1.0.105 was reported to reject stdio servers —
*unverified*), history replay cost, per-agent quirks. This is the largest gap against comparable tools.

### As built — S2 (2026-11-11; owner: "ACP support is very important, I will work through it")

Built in `apps/harness` (`internal/mcp`, `internal/mcprelay`, `internal/permission`, `orchestrator/acp_*.go`; guide:
`apps/harness/docs/acp-orchestrator.md`). Verified by the orchestrator: Go gates, `scripts/e2e-acp-orchestrator.sh`
(tool calls over MCP, same process and session on the second request, recovery after `kill -9`, no process left
after project delete and shutdown), `scripts/e2e-router.sh`. **Everything was run against the scripted agent only —
no real CLI, no real MCP client.**

- `models.orchestrator` and the tiers accept `acp:<id>[/<model>]` (validated; `models.side` may not);
  `GET /v1/config` lists `acp_orchestrators`.
- One ACP session per project orchestrator, started lazily, shut down after `HARNESS_ACP_IDLE` (30 min); the session
  id is stored (`acp_sessions`) and resumed with `session/load` when advertised, else a new session gets a recap
  (compaction summary, or the last ≤ 40 texts, ≤ 8000 chars).
- Harness tools reach the agent through an MCP server inside `harness serve` (`POST /mcp/v1/projects/{pid}`,
  stateless JSON, per-session bearer token, loopback and Origin checked): `spawn_agent`, `save_note`, `delete_note`,
  `list_dir`, through the same handlers as the built-in loop. HTTP entry when the agent advertises it, otherwise a
  stdio relay (`harness mcp-relay`, token in the child's env). An agent that refuses MCP servers still answers, with
  a `warning:` on the turn.
- The first prompt of a session carries the orchestrator briefing and notes (ACP `systemPrompt` is optional).
- Permission requests pass through `permission.Decide` (auto-approve today; v7 approvals plug in here).
- Open: linking an MCP `spawn_agent` call to the agent's tool-call row is a heuristic (title match within 300 ms);
  thinking and plan updates are dropped (no place in the UI yet); the warning may render as an error in the UI; a
  note edited by the user mid-turn is not announced to the agent.

## S3 — routing

"Routing" for subscriptions means choosing **which agent and model** handles a task, not proxying HTTP.

- **S3a (recommended).** The harness asks the router for a decision (`POST /v1/decisions`-style: complexity band for
  a task) and maps bands to the project's tiers, which S2 lets point at subscription agents. The router's ladder and
  classifier are reused; no subscription traffic passes through the router; cost accounting stays in the harness
  (reported by the agent where available).
- **S3b (needs an owner decision; not recommended).** A router backend that calls a vendor's private endpoint with
  the CLI's stored credentials (what community proxies do for Copilot and Codex). No vendor documents this for
  third parties; GitHub has publicly endorsed one specific third-party client, which is not a general permission;
  accounts can be rate-limited or suspended; endpoints change without notice.

## Decisions for the owner

1. S3: a or b. Default: a.
2. Grok on a subscription in automated tests has no documented headless login. Options: test Grok with an API key in
   CI and on the subscription only on a developer machine; or accept copying the CLI's credential file to the test
   runner. Default: the former.

## As built — live ACP activity (harness, decision 55 of the UI spec)

What was silent: for ACP agents the harness already published `agent_message_chunk` text and, at `tool_call`, the tool row
(`message.created` + `tool.started`, so rows did appear at the start, not at completion). It dropped `agent_thought_chunk`,
`plan`, every non-terminal `tool_call_update`, and had no notion of "what is the agent doing now". Now published (details in
`apps/harness/docs/acp-orchestrator.md`, "Live activity"):

- `message.thinking_delta {agent_id, text}` — scrubbed of secrets, never stored or indexed.
- `agent.plan {agent_id, entries}` — also stored on the agent row (`plan`; schema version 4, `agents.plan_json`; cleared when
  the next turn starts).
- `tool.updated {agent_id, tool_use_id, status?, title?, locations?, summary?}`.
- `agent.activity {agent_id, kind: thinking|tool|text|waiting_approval|idle|quiet, label, tool_use_id?}` for the built-in loop
  and ACP (orchestrator and sub-agents). `quiet` after 10 s (`Options.ACPQuietAfter`) without any session/update, permission or
  fs request; not while waiting for the user.
- `available_commands_update` and `current_mode_update` are ignored without error but count as signs of life.
- agent-client: the four event types, `Agent.plan?`, and reducer state `activity`, `thinking` (dropped at `turn.finished`),
  `plan`, and tool details merged into `activeTools`.

Verified here (scripted agent, mock model): first thought reaches an SSE subscriber within 100 ms of being sent; 20 text chunks
sent 20 ms apart arrive as 20 deltas over about 400 ms, each within 100 ms; the tool row exists 150–400 ms before it finishes; a
silent agent is reported quiet exactly once and an agent waiting for an approval never; secrets split across two thought chunks
and put in a plan never leave the harness; the built-in loop publishes the same activity kinds.

Not verifiable without the real thing: a real Claude Code may send no chunks of any kind until its answer is complete, or only
`usage_update`s, or batch its text into a few large chunks; none of that can be fixed in the harness. The wire trace
(`HARNESS_ACP_TRACE=1`, `docs/diagnostics` / R1) shows it exactly: look at the timestamps of the `session/update` lines of one
turn: no `agent_thought_chunk` or `agent_message_chunk` lines until the end means the agent itself is silent (the UI then shows
"Starting …", "Thinking…" and, after 10 s, "Still working — no output from <agent> yet"); a few chunks of many characters means
the agent batches. Whether the Claude Code adapter sends `agent_thought_chunk` and `plan` at all depends on its version and the
model's thinking setting.

## As built — providers (harness)

Decisions 53 and 58 of the UI contract, harness side (`apps/harness/docs/providers.md`). Verified against the scripted agent and fake probe commands only; no real agent CLI was run.

- `GET /v1/providers`: `api` (built-in loop, catalogue models), `router` (only when detected), then one entry per ACP agent (claude-code, copilot, grok first). States `ready`, `not_connected`, `not_logged_in`, `not_installed` (`error` reserved). Agent models are the manifest list plus the models the agent advertised, cached in `{data-dir}/agent-models.json` (no schema change); a model no longer advertised is flagged `stale`, not dropped. `suggested` is the current defaults when the API is ready, else the first ready agent (claude-code, codex, copilot, rest) in every slot.
- `providers.updated` is published on every project stream when a probe outcome, a key or default model, the advertised models or router detection changed what is ready.
- Project create: `409 no_provider` with nothing ready, new projects get `suggested`; create and patch refuse a model whose provider is not ready with `422 model_unavailable {provider, reason}` (patch checks only changed fields); reading a project never fails and lists `models_unavailable`.
- `ANTHROPIC_API_KEY` via `PUT /v1/settings` now applies at once (key read per request, built-in-loop switch swapped); `restart_required` no longer lists it. Router settings still need the desktop shell's restart.
- Retry: the UI re-posts the failed text to `POST .../messages`; the harness now reuses the stored user message when the last turn failed and nothing answered it (no duplicate row, no `message.created`). A failed turn leaves `attention: "failed"` on the project JSON and `state: "failed"` + `error` on `project.attention`; the orchestrator row stays `idle` with the error. The UI's "Retrying…" label is a UI state (see report: the banner button never resets when the retried turn fails again at once).
- The agent-model cache is fed through `Orchestrator.OnAdvertisedModels` / `AdvertisedModels` (the ACP session's `OnModels`); a user message reused by a retry keeps its original timestamp.


## As built — agent models can always be chosen

Contract: decision 58 "Revised after the owner's run of 2026-11-12" (and the "Connected means selectable" and preferences part of decision 72) of `2026-11-10-project-harness-ui.md`; feature page `apps/harness/docs/providers.md`. Built with the scripted agent (`internal/fakeacp`) and fake scripts only; no real agent CLI was run.

- **Discovery without a request.** `providers.Discovery` (on by default in `harness serve`; `HARNESS_MODEL_DISCOVERY=0` off): when an agent becomes ready, when its login changes and on `POST /v1/providers/{id}/refresh-models` the harness runs the manifest's `modelsCommand` and, when that gives nothing, starts the agent, does `initialize` + `session/new` (cwd a fresh empty temporary directory, no MCP servers), reads the models and closes it. No prompt. 20 s, one per agent at a time, once an hour unless forced, skipped while the agent has a live session (the live list is read instead). Failures are `models_error` + `models_refreshed_at` on the provider; `providers.updated` when the picture changes. Every model-list shape is read: model config option (flat and grouped), `models.availableModels`, `models` as a bare array, `_meta.models`; the scripted agent has a variant of each (`OCTO_FAKEACP_MODELS_VIA` = `models`, `config`, `config-grouped`, `models-array`, `meta`, `none`) and logs its requests (`OCTO_FAKEACP_REQUEST_LOG`) so a test can assert that no prompt was sent and the session's cwd and MCP servers.
- **Manifest.** `modelsCommand` ({command, pattern, labelGroup}), `modelLabels`, `modelsNote`, `roles`, `auth.notLoggedInExit`. Built-in: claude-code `opus`/`sonnet`/`haiku` (source `manifest`, README line "aliases accepted by the Claude Code CLI's --model flag; unverified here"), roles haiku/sonnet/opus; Grok `grok models` with a defensive per-line pattern (the real output is unverified; override it in a copied manifest). No model names for Codex or Copilot.
- **Typed models.** `PUT /v1/providers/{id}/custom-models` (`source: "custom"`, same cache file). `acp:<agent>/<anything>` is accepted for a ready agent (`ValidateACPRef` no longer compares against the list; `spawn_agent`'s model has no enum) and reaches the agent through `modelArg`, the model config option or `session/set_model` (an unlisted name is sent as typed); a refusal fails the turn with "<agent> does not accept model <name>" and a hint listing what the agent advertises (`acp.ModelError`). `ModelPattern` now allows any printable non-space character after a first letter or digit (aliases such as `opus[1m]`).
- **Connected means selectable.** A probe makes an agent `not_logged_in` only when its output matches `notLoggedInPattern` or it exits with a status in `notLoggedInExit`; a failing, timed-out, unstartable or unexpected probe leaves `login: "unchecked"` and the agent `ready`. The router's agent candidates and the default orchestrator treat an unchecked login as logged in. The cause of the owner's "Grok connected but not selectable" is not reproducible here: with the old rule any non-zero exit of `grok models` (or a probe that never answered, for the candidates) made it unavailable; the new rule cannot.
- **Preferences and roles.** `preferred_model` and `roles` per agent (`PUT /v1/providers/{id}/prefs`), resolution in the orchestrator as described in `providers.md`.

Verified: `go test -race ./...` (discovery of each shape, failures, timeout, hourly gate and force, in-use skip, models command, custom and typed models on each path, refusal message, probe outcomes, prefs and roles resolution, the HTTP endpoints). Not verified: any real CLI. Only the owner's machine can say which of the four advertise models and in which shape, what `grok models` prints, whether the Claude aliases are accepted, whether each CLI accepts a typed model, and how long the real cold start of a throw-away session takes against the 20 s limit (`npx` may need longer on first use; the error says "timed out after 20s" and a later refresh retries).

## Decision (2026-11-12) — the login probe is advisory, never a lock

Owner's live run: "Couldn't switch the model. models.orchestrator "acp:grok" cannot run: Grok is not logged in" while
Grok was logged in. A probe is a guess made earlier, by another process; the agent's own session is the truth. Rules:
1. **Fresh before refusing.** Before any request is refused for `not_logged_in` (project create/patch, model switch,
   spawn), the harness re-runs that agent's probe synchronously (at most once per 5 s per agent). A probe that now
   passes lets the request through.
2. **Negative results expire fast.** A "not logged in" result is re-probed after 15 s in the background while anything
   shows it (providers were requested in the last minute); a positive one keeps the normal interval.
3. **`POST /v1/providers/{id}/recheck`** runs the probe now and answers the provider entry ("I've logged in — check
   again" in the UI); `providers.updated` follows.
4. **Use anyway.** A refusal for `not_logged_in` carries `can_force: true`; the same request with
   `"force_unverified": true` is accepted and stored. The agent is then started normally; if it really is logged out,
   the turn fails with the agent's own error and the login hint (already built). `not_installed` can never be forced.
5. **Why, without leaking.** `harness doctor` and `GET /v1/diagnostics` say which rule decided (pattern matched /
   listed exit status / exit 0 / timeout), the exit status, the probe's duration, and the names (not values) of the
   environment variables the probe was given; with `--show-probe-output` doctor prints the first 20 lines of the
   probe's output (the owner runs it locally; never sent to a model, never in `/v1/diagnostics`).
6. **Same environment as a terminal.** The probe and the agent get the login-shell environment the desktop app
   resolves (HOME, USER, LOGNAME, XDG_*, PATH, SHELL, LANG, TMPDIR, SSH_AUTH_SOCK and on macOS `__CF_USER_TEXT_ENCODING`),
   so a credential store the CLI reads in a terminal is readable here; a test asserts each is passed when set.
Acceptance: unit tests for 1–4 with the scripted probe (logged out → log in → request passes without waiting; force
path; `not_installed` not forceable); doctor output test for 5; env test for 6; UI: the connect sheet and the model
picker's "Not connected" row offer "Check again" and "Use anyway" with one line saying what each does.

### As built — the login probe is advisory (2026-11-12, harness + agent-client + UI)

Built: rules 1 to 6 as written above. `plugins.Registry.Fresh` / `Recheck` (synchronous probe, joined with one in flight, `FreshProbeAge` 5 s), `NegativeProbeInterval` 15 s, `providers.Service.CheckFresh` / `Recheck`, `POST /v1/providers/{id}/recheck`, `can_force` on `model_unavailable`, `force_unverified` on project create and patch, probe reports with `rule`, `exit_status`, `duration_ms`, `dir`, `env_names` and `harness doctor --show-probe-output`, `__CF_USER_TEXT_ENCODING` in the child-environment allow-list. Exit 0 now always wins over `notLoggedInPattern` (a logged-out Grok, which exits 0 printing "You are not authenticated.", reads as unchecked). A built-in agent's probe runs in the user's home. Also built: `verified` / `experimental`, `unsupported` / `not_supported`, `startHint` and the start-up failure message for rejected launch arguments (`acp.ExitError` carries the first stderr line). UI: "Check again" (spinner, calls recheck) and "Use anyway" (only for `not_logged_in`, one dim line) in the connect sheet, the model picker's "Not set up" rows and the refused-switch notice; Settings → Agents "Check again" rechecks; a dim "experimental" word; a `not_supported` row only says why. Demo bridge: `?recheck=ok` makes "Check again" succeed for a logged-out agent; "Use anyway" works either way.

Verified: unit and HTTP tests with the scripted agent and fake probe scripts (logged out, log in, request passes; force path; not_installed and not_supported not forceable; doctor output; child environment; usage-error launch with an `sh` script, no real CLI). Not verified: the real `grok models` exit status and output on the owner's machine; whether the desktop shell's environment carries every variable of rule 6 on macOS (update 2026-11-13: the sidecar now forwards an allow-list of login-shell variables, see the packaging spec's "As built — login-shell environment"; verified with fake shells only; `harness doctor` lists the names child processes get); the UI in a browser.

### As built — first `spawn_agent` call, stop, change tracking (2026-11-14, harness)

From the owner's live run with Claude Code as the orchestrator (wire traces): the first `spawn_agent` call was refused
because Claude Code defers MCP tool schemas and the model guessed the arguments from the briefing, which named only
`task` and `tier`. Now the MCP `initialize` result carries `instructions` built from the live tool schemas, the briefing
names all four arguments with an example, the refusal is plain text that names what is missing and ends with example
arguments, `prompt` / `description` are accepted for `task` / `title`, and a tool result that is one fenced block is
stored without the fence. `tier` stays required without a router. A cancelled built-in turn stores the interrupted
call's result at the stop (`runTurn` calls `repairDangling` before `finishTurn`). `changes.Tracker` indexes a file with
the size and mtime read before its content, not after: a write that landed between the read and the stat was never
recorded (the cause of the flaky `TestBashChangesAreRecorded`). The Copilot login command is `copilot login`.
Details: `apps/harness/docs/acp-orchestrator.md`.

Verified: Go tests with the scripted agent (`[mcp-spawn-lazy]`, `[mcp-spawn-guess]`), a deterministic tracker test,
a real `harness serve` with the mock model for the cancel (12 s turn stored as 12 s, interruption results at the stop
time), `gofmt`, `go vet`, `go test -race ./...`. Not verified: real Claude Code showing the instructions to the model
and getting the first call right; other agents as orchestrator; the UI reload against a live harness.

### As built — Antigravity (`agy`) support (2026-11-15, harness)

Owner: "we need good agy support". Sources, read 2026-11-15: antigravity.google/docs/cli/acp, /docs/ide/extensions/acp
(flags, authMethods, capabilities, errors), /docs/cli/reference, /docs/getting-started?tab=cli (installer,
`~/.local/bin/agy`, `agy --version`), the CHANGELOG.md of google-antigravity/antigravity-cli (1.5.0 added `agy acp`;
1.5.2 cancel and permission fixes; 1.5.4 Auto mode in ACP; 1.5.8 Auto is the default mode; 1.5.9 context-window usage
and "Authentication required" fixes), the ACP registry (`antigravity-acp` 1.5.0 is a separate `agy_acp_server.par`
download). Not documented anywhere I found: `agy update`, a non-interactive sign-in status command, the text output of
`agy models`, the exact `type` of each auth method, whether agy advertises `mcpCapabilities.http` without
`--process-per-session`, terms for third-party clients.

- Manifest `antigravity`: `agy acp`; new fields `searchPaths` (`~/.local/bin`), `version` (`agy --version`, min
  1.5.0), `mcpTransport: "stdio"` (agy's HTTP MCP servers need `--process-per-session`); `auth.methods` only
  `gemini-api-key` with `requiresEnv: GEMINI_API_KEY`, `auth.skip` the Google, Enterprise, ADC and terminal sign-ins
  (the default policy would have called `authenticate` with `oauth-personal`, a browser sign-in); `auth.command`
  `agy acp --login`; `billingEnv: GEMINI_API_KEY`; the installer as install and update line; `verified` stays false.
  No login probe, no model names, no roles (none documented).
- Version check (`plugins.versioner`, like the login prober: background, every 10 min, 5 s timeout, forced by
  recheck): only a version read and lower than `min` makes the agent unavailable; providers list it `not_installed`
  with the new catalogue error `AgentTooOld` ("Antigravity 1.4.12 is too old for Octo; it needs 1.5.0 or newer.",
  the installer line, `recheck_provider`); project create/patch and an orchestrator turn refuse it with the same error (a
  sub-agent spawn gets the existing "unavailable agent" tool error; the agent is no longer offered); `harness doctor` prints
  `version:` per agent and a problem line (`AgentReport.version`, `DiagnosticsVersion` in agent-client).
- ACP client: a permission request still open when the prompt is cancelled is withdrawn (its context ends) and
  answered `cancelled`, so the agent's own `cancelled` reply is read; before, the reader stayed blocked on the approval
  card and the agent was killed after `CancelGrace` (3 s) — for every agent, not only agy. A banner or escape codes
  before `{"jsonrpc"` on the same stdout line are dropped (lines without a message were already skipped).
- Orchestrator: in a supervised project an agent whose starting mode approves its own changes (`auto`, `accept…`,
  `bypass…`, `yolo`, …) is switched to its `default` mode for Agent turns; full access keeps the agent's mode.
- Scripted agent: profile `OCTO_FAKEACP_PROFILE=agy` (`internal/fakeacp/agy.go`): `--version`, no `acp` before 1.5.0,
  a stdout banner, the five auth methods, -32000 "Authentication required" without a saved sign-in, four modes starting
  in `auto`, model and thinking-level config options, Allow/Deny permission options, `agy acp --login`.

Verified (scripted agent, fake `agy` scripts, no real agy): Go tests in `internal/acp` (`agy_test.go`: handshake
through the banner, signed out never calls `authenticate`, the default policy would try `oauth-personal`, API key and
saved sign-in, models and modes, old version, Stop during a permission request ends in < 3 s with the process alive —
fails without the fix), `internal/plugins` (version parse, too old → unavailable → recheck clears it, no guessing,
`searchPaths`, the built-in entry), `internal/orchestrator` (`agy_profile_test.go`: modes per access, signed out,
Stop during an approval; `agy_internal_test.go`), `internal/providers`, `internal/diag`, `internal/usererr`; a real
`harness doctor` with a fake `agy` (1.5.9 ready, 1.4.12 too old, found only in `~/.local/bin`); `e2e-acp-orchestrator.sh`
scenario 4 (built-in entry, fake `agy` as the only CLI on PATH: signed out → "Antigravity is not logged in.";
`agy acp --login` → request works over the stdio relay; 1.4.12 → too old after recheck). Gates: `gofmt -l` clean and `go vet ./...` clean (whole harness tree); `go test -race` passed for acp, plugins, providers, diag, usererr, cmd/harness and the agy/ACP tests of orchestrator; the full `go test -race ./...` (429 s) passed 49 packages and failed only in work in progress of a parallel executor (internal/bridge `TestUsageGroupsAcrossProjects`; orchestrator did not build then because of bridge/project form changes); orchestrator alone later: a data race in `TestLiveStreamIsNotHeldBackByASlowCheckpointWrite` (test hook `SetBeforeCheckpointWrite` vs `sink.go:170`, files untouched here) and the package exceeded a 15-minute timeout on the loaded machine; `e2e-acp-orchestrator.sh` passed (all four scenarios).
Not verified: anything on a real agy (owner's run: LIVE-CHECKLIST block "B-agy", AG1–AG15) — the version output
format, which auth methods and capabilities it really advertises, its mode ids and whether ACP sessions start in
`auto`, its model and permission option shapes, banner output, `session/load` behaviour, the UI showing "too old".

### As built — single-provider ACP session alignment & tier marks (2026-11-16, harness + UI)

When a project's orchestrator uses a subscription ACP agent (`acp:<id>[/<model>]`), Session mode keeps all sub-agent tiers on that same ACP provider so a user picking an ACP orchestrator does not silently mix providers across `fast`, `balanced`, `deep`, or side questions:

- **Harness (`apps/harness`):** `internal/project/input.go` (`alignACPSessionModels`) and `internal/project/service.go` align unspecified/cross-provider `fast`, `balanced`, `deep` (and clear a mismatched `side` override) to the orchestrator's `acp:<id>` on create/patch; `internal/orchestrator/spawn.go` falls back to an ACP orchestrator's provider when resolving sub-agent tiers without an explicit tier override. Covered by unit tests in `internal/bridge/acp_orchestrator_test.go`.
- **UI (`packages/ui`):** `lib/models.ts` (`modelsPatchForSessionChoice`) used by `ModelsSection.tsx` and `ProjectModels.tsx` updates `fast`, `balanced`, `deep` (and clears mismatched `side`) together when switching orchestrator to `acp:<id>`; `SidePanel.tsx` follows `orchestrator` when `models.side` is unset and `orchestrator` is `acp:*`; `lib/providers/markKey.ts` maps `acp:<id>/<model>` to the provider's mark for Details tier icons.

Verified: UI Vitest/Node unit tests (`models.test.ts`, `markKey.test.ts`, 851/851 total in `@octo/ui`), `pnpm lint`, `gofmt -l .`.
Not verified: `go vet` / `go test` in `apps/harness` (`proxy.golang.org` 403 on uncached `modernc.org/sqlite@v1.62.0` in this VM); real ACP agent execution on a user machine.

