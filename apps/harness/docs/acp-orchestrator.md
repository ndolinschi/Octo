# Orchestrator on an ACP agent

A project's orchestrator normally runs the harness's own Messages-API loop. It can instead run as an
[ACP](https://agentclientprotocol.com) agent, for example Claude Code on a subscription through its ACP adapter. Design:
[`providers.md`](./providers.md) and [`../plugins-examples/subscription-agents/README.md`](../plugins-examples/subscription-agents/README.md) (ACP agents).

## Set it

`models.orchestrator` of a project (`POST`/`PATCH /v1/projects`) or the server default (`HARNESS_MODEL_ORCHESTRATOR`) may be

- `acp:<agent-id>` or `acp:<agent-id>/<model>`, where the id is an **available** agent of a loaded plugin and the model is one its
  manifest lists (or any model id when it lists none). An unknown or unavailable agent is `400 invalid_request` with a message naming
  the agent and the available ones; the server default is checked at start-up. Any other value keeps the built-in loop.
- The tiers (`fast`, `balanced`, `deep`) take the same form: `spawn_agent` with that tier then starts that ACP agent as the
  sub-agent (the existing ACP sub-agent path, recorded as `acp:<id>[/<model>]`). `models.side` cannot be an ACP agent.

- With a router that announces `route_api`, `spawn_agent` also takes `tier: "auto"` (the default, `tier` optional), over MCP as well: the router then picks among the API tiers and the loaded ACP agents, so an ACP orchestrator's delegations are classified like any other. A chosen ACP agent is started through this same path. `models.auto_candidates` restricts the set. See the harness `README.md`, "Automatic choice of who does a task".

`GET /v1/config` lists the valid settings in `acp_orchestrators` (`value: "acp:<id>"`, `id`, `label`, `models`, `default_model`).
The orchestrator agent's `model` reads `acp:<id>[/<model>]` (the manifest default model included). Types:
`BridgeConfig.acp_orchestrators`, `AcpModelRef` in `@octo/agent-client`.

```bash
# claude-code is the entry of the built-in plugin subscription-agents (plugins-examples/subscription-agents/plugin.json)
# (command `npx -y @agentclientprotocol/claude-agent-acp`; log in once with the Claude Code CLI, `claude`)
harness serve          # the subscription agents are built in; no API key and no plugin directory needed
curl -XPOST localhost:8790/v1/projects -d '{"name":"demo","folders":[{"path":"/abs/path"}],
  "models":{"orchestrator":"acp:claude-code","fast":"acp:claude-code"}}'
```

## Without an API key

`harness serve` starts without a key; `GET /v1/config` then has `builtin_loop: {available: false, reason}`. A project whose orchestrator is still the server default runs on the first available, logged-in ACP agent (claude-code, codex, copilot, then the rest in load order; "logged in" = the login probe says so, or the agent has no probe), chosen when the turn starts and reported as `default_orchestrator`; the orchestrator agent's `model` shows `acp:<id>`. Anything that needs the built-in loop (a built-in orchestrator model, `spawn_agent` without `agent` on a built-in tier, a side question) fails with "No API key is configured for the built-in agent loop. Set ANTHROPIC_API_KEY (or a router), or choose an ACP agent for this project." and sends no request. Details: the harness `README.md`, "Running without a key, and `harness.env`".

## What happens

- **One long-lived session per main session (schema 15).** Each main session of a project has its own root agent and its own
  agent process: the session's first request starts the process (lazily) and an ACP session at the project's first folder; later
  requests of that session are further `session/prompt`s on it (same process, same session id). Two sessions of one project
  running at once are two processes. A crashed or killed process is restarted by the session's next request; a changed agent,
  model or first folder starts a new session. When more than the project's `max_running + 2` processes are alive, the least
  recently used idle one is shut down (its session resumes with `session/load` or the recap). Making another session the default
  stops nothing: each session keeps its process and its stored ACP session (on its own root agent).
- **Resume.** The session id is stored in the project database. After a restart of the process or of the harness the harness uses
  `session/load` when the agent advertised `loadSession`; otherwise (or when the load fails) it starts a new session and puts a
  **recap** before the first prompt: the latest compaction summary if there is one plus any messages stored after it, otherwise the
  last 40 user/assistant texts and answered `request_input` turns (generic tool rows left out), newest kept in order (with long
  messages middle-clipped so both the start and latest progress survive, and the most recent dropped user request pinned when verbose output
  would otherwise crowd it out), **capped at 8000 bytes** (`orchestrator.RecapCap`). A new session also gets the orchestrator
  briefing (project brief, how to use the tools, notes). Notes edited between requests are re-sent with the next one. When a user
  retries a turn that failed or was interrupted after partial progress (re-sending the same request), the prompt carries a transient
  continuation note instructing the agent to continue from where it stopped rather than starting over.
- **Idle shutdown.** A session unused for `HARNESS_ACP_IDLE` (Go duration, default `30m`) has its process shut down (the stored
  session id is kept). The processes also end on project delete and on harness shutdown; the process group is killed, so the stdio
  relay (below) goes too.
- **Harness tools over MCP.** `spawn_agent`, `save_note`, `delete_note` and `list_dir` (the built-in orchestrator's tools, minus
  `read_file`, which ACP's `fs/read_text_file` covers; there are no separate wait/collect/cancel tools, `spawn_agent` returns the
  sub-agent's report) are served by the harness as an MCP server (`octo-harness`, Streamable HTTP, `POST /mcp/v1/projects/{pid}`
  on the bridge listener) and passed in `session/new.mcpServers`. Calls run through the same registry the built-in loop uses
  (`agent.CallTool`), so handlers, limits, budget checks, events, the agents list, usage and notes are unchanged. The endpoint
  accepts only loopback peers, no foreign `Origin`, `POST`, and a per-process random 256-bit bearer token bound to the project,
  the main session and that session's root agent (`mcp.Binding{ProjectID, SessionID, AgentID}`; constant-time compare; a token of
  another project is `403`, an unknown or revoked one `401`; a binding never reaches another session's process, registry or turn:
  the handler looks the session up by the binding, never by project-wide state); the token is revoked when the process ends. Tools
  work only while a user request of that session is running.
  - Agent advertises `mcpCapabilities.http`: an `http` entry with the token in an `Authorization` header.
  - Otherwise: a `stdio` entry that runs this binary as `harness mcp-relay --url … --token-env OCTO_MCP_TOKEN`, a stdio-to-HTTP
    relay; the token is in the entry's `env`, never in argv.
  - Agent refuses MCP servers (an RPC error on `session/new` or `session/load`): the session is opened without them and works
    without harness tools; the warning `warning: ACP agent … refused the harness's MCP server …` is carried by the existing
    error channels, `turn.finished.error` (status stays `completed`) and the orchestrator agent's `error`, on every turn of that session.
- **Transcript and events.** Text chunks stream as `message.delta` and are stored as assistant rows; tool calls (title, raw input,
  locations, status, content or diff) become tool rows with `tool.started`/`tool.finished`, exactly like ACP sub-agents; the user
  message and the final assistant text are stored as for the built-in loop. A sub-agent created by an MCP `spawn_agent` call gets
  `spawn_tool_use_id` of the agent's matching tool-call row when one can be matched by tool name. `usage_update` becomes a usage row
  with `source: "acp"` (cost only when the agent reports USD) and the context window. Thinking chunks and `plan` updates are
  published as `message.thinking_delta` and `agent.plan`, and every transition of what an agent does as `agent.activity`; see "Live activity" below.
- **Cancel.** `POST /v1/projects/{pid}/cancel` sends `session/cancel`; the turn ends `cancelled` and the session stays usable (an agent
  that ignores the cancel for 3 s is killed and restarted by the next request). A permission request still waiting for the user at that
  moment (an approval card) is withdrawn (auto-denied "the turn was cancelled") and answered `cancelled`, so the agent's own
  `cancelled` answer to the prompt is read at once; before 2026-11-15 the reader stayed blocked on the card and the agent was killed after 3 s.
- **Permissions.** `session/request_permission` goes through `permission.Decide`, today auto-approve (the first `allow_once`, else `allow_always`, else
  cancel); `fs/read_text_file` and `fs/write_text_file` are confined to the project folders. The agent's own process is not sandboxed.
- **Session modes.** Ask and Plan turns switch to the agent's own read-only or plan mode when it advertises one (`session/set_mode`), an
  Agent turn back to the mode the session started in. In a **supervised** project an agent whose starting mode approves its own changes
  (an id containing `auto`, `accept`, `bypass`, `yolo`, `dangerous` or `skip`: Antigravity starts in `auto`) is switched to its `default`
  mode for Agent turns, so every change reaches Octo as a permission request; a full-access project keeps the agent's mode.
- **Environment.** The agent gets the allow-listed environment (`internal/childenv`) plus the manifest `env`, never the harness's provider keys.

## The agents to start with: Claude Code, Copilot, Grok

The built-in manifest lists them first. `GET /v1/plugins` gives each `available`, `unavailable_reason`, `logged_in`, `hint` (the login instruction) and `install_hint`; `harness doctor` prints the same. The texts below are what the manifest says; **none of these CLIs was run by the author** (see "Not verified").

| Agent | Install | Log in | Limits | Accounts |
| --- | --- | --- | --- | --- |
| `claude-code` | Node.js (the adapter runs through `npx`) and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code` | run `claude` and type `/login` (or `claude auth login`); the entry's login probe is `claude auth status` | the harness hides its own `ANTHROPIC_API_KEY` from the agent so the subscription is used; to bill per token on purpose add env `{"ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"}` to a copy of the entry | several: `CLAUDE_CONFIG_DIR` |
| `copilot` | the GitHub Copilot CLI with `copilot` on PATH: `npm install -g @github/copilot` (Node.js 22 or newer, a Copilot plan) | run `copilot` and type `/login`, or start the harness with `COPILOT_GITHUB_TOKEN` set to a fine-grained token with the "Copilot Requests" permission | no login probe: the first failed turn says what to do | one only (the CLI has its own `/user switch`) |
| `grok` | the Grok CLI with `grok` on PATH (from x.ai); the entry's command line (`grok agent stdio`) is unverified against a real install | run `grok login` (browser) | an `XAI_API_KEY` in the harness environment is forwarded to Grok and **switches it to per-token billing**; unset it to stay on the subscription | one only (Octo could not confirm where Grok keeps its sign-in) |

The wording is in `plugins-examples/subscription-agents/plugin.json` (`install` and `auth.hint` per entry); copy the plugin to change it. The **Accounts** column says whether a second login of the CLI can be kept apart ([`providers.md`](providers.md#agent-accounts-2026-11-26) has the model, the routes and the full list; the harness README has the per-agent table).

## Usage limits and switching accounts (2026-11-26)

A turn (or a sub-agent) that an agent refuses because its plan's usage or rate limit is reached ends with the catalogue error `agent_limit_reached` ("<Agent> · <Account> has reached its usage limit.", action `switch_account`; [`errors.md`](errors.md#added-2026-11-26-agent-accounts-and-usage-limits)). The check runs on the error paths only (`acpFailure`, the mid-turn `agent_error` update), after the "not logged in" check and before the generic failure, and reads only the error's own fields: never answer text, and never stderr. Rules, in order (`internal/orchestrator/acp_limits.go`):

1. a structured `errorKind` of `rate_limit` in the error's `data` (read at its top level and in nested `data` / `error` objects, three levels deep). `rateLimit.resetsAt` is read when it is an RFC 3339 time or a Unix time (seconds, or milliseconds when the number is 10^12 or more; a number or a string of digits);
2. a `code`, `name`, `status` or `reason` equal to `QUOTA_EXHAUSTED` or `RATE_LIMIT_EXCEEDED` (case-insensitive; the names Gemini CLI uses);
3. HTTP status `429` (`statusCode` or `status`);
4. one of the agent's manifest `limitPatterns` (regular expressions) matching the error message or any `message` of its `data` (top level and the nested `data` / `error` objects, so a generic "Request failed" whose `data.error.message` holds the limit text matches). Built in: Claude Code (`you've hit your session limit`, `weekly limit`, `opus limit`) and Codex (`you've hit your usage limit`); no other agent has patterns.

Rules 1, 2 (`QUOTA_EXHAUSTED`) and 4 say the **plan's** limit is reached: the error reads "has reached its usage limit." and the agent's `limit` is set. A **bare** 429, or `RATE_LIMIT_EXCEEDED`, with none of those signs is a *transient rate limit*: the turn fails the same way and keeps the action `switch_account`, but the message reads "<Agent> is being rate limited." and the agent's `limit` is **not** set (nor cleared), since it usually lifts in moments. The hint names "another account" only for an agent that can keep several (`account_env` on its entry); otherwise it says to retry or pick another model (`AgentLimitReached` / `AgentRateLimited`, [`errors.md`](errors.md#added-2026-11-26-agent-accounts-and-usage-limits)).

A plan-limit match marks the agent's `limit` (`providers.md`, "Usage limits") and the next successful turn, **Check again** or the reset time clears it. Nothing is switched by the harness: the user picks another account of the agent, or another model, and the turn is sent again. A failed turn stays in the transcript, as with Retry.

**Experimental agents are not picked on their own.** An agent whose manifest says `"experimental": true` (the built-in `gemini`: no login probe, so it would count as logged in for anyone with the CLI on PATH) is left out of the orchestrator's agent list, `spawn_agent`'s `agent`, the router's `tier: auto` candidates and the no-key fallback orchestrator, exactly as a non-default account is, unless the project's models name it (`orchestrator`, `fast`, `balanced`, `deep`, `side`, `auto_candidates`; a named account of it counts). It stays in `GET /v1/providers` (`experimental: true`) and in the picker, and `suggested` never proposes it. Tests: `TestOfferedAgentsLeavesOutExperimentalOnesUnlessNamed`, `TestDefaultOrchestratorFallbackNeverPicksAnExperimentalAgent`.

**Session behaviour.** The stored ACP session lives in the CLI's own folder, so another account cannot resume it. When the project's model changes from `acp:claude-code@work/opus` to `acp:claude-code/opus`, the agent id (and so the process and the stored session row) no longer matches: the old process is closed, a new process runs `session/new` with the new account's environment, and the turn starts with the briefing plus the recap (at most 8000 characters) or the window assembly, as after any new session. Switching back later also starts a new session. A paired device cannot make the change (`PATCH /v1/projects/*` is local only); it is told to change it on the computer.

**Diagnostics.** `harness doctor` lists every account as an agent of its own, prints `account: <name> of <agent> (folder: <path>)` for those that are not the default (names and folders, never environment values) and probes each with its own environment. `--json` carries `account` on the agent report.

**Not verified** with a real CLI: where each agent reports a limit (a limit that arrives as plain answer text is not caught), the real messages, and the format of the reset time. The classifier has unit tests (`TestRPCLimitClassifier`, `TestAgentErrorLimitClassifier`, `TestLimitFailureWordingAndStickiness`) and runs end to end against the scripted agent's `[limit:rpc]` and `[limit:agent_error]` prompt markers (`scripts/e2e-accounts.sh`); the error shapes in them are written from the research of each CLI's source and documentation, not captured from a real CLI.

## Antigravity (`agy`)

Written from Google's documentation (antigravity.google/docs/cli/acp, /docs/ide/extensions/acp, /docs/cli/reference,
/docs/getting-started) and the CLI's changelog (1.5.0 to 1.5.9), read 2026-11-15; **not run with Octo** (`verified: false`).
Built-in entry `antigravity` in `plugins-examples/subscription-agents/plugin.json`:

| What | Octo does | Source |
| --- | --- | --- |
| Launch | `agy acp`; `agy` from PATH, else `~/.local/bin/agy` (the installer's folder; manifest `searchPaths`) | docs: ACP page, getting started |
| Version | `agy --version` in the background; below 1.5.0 (`acp` was added in 1.5.0) the agent is listed not installed with "Antigravity 1.4.12 is too old for Octo; it needs 1.5.0 or newer." and the installer line, before anything starts it; "Check again" re-reads it | changelog 1.5.0 |
| Old version anyway | an `agy` that rejects `acp` (`unknown command "acp"`) gives "Antigravity did not start the way Octo asked." with the start hint | launch rejection, below |
| Banner on stdout | lines that hold no JSON-RPC message are skipped; a banner or escape codes before `{"jsonrpc"` on the same line are dropped | defensive; the docs say nothing about stdout |
| Sign-in | there is no non-interactive status command, so no login probe: the login shows "unchecked" until the first session. `session/new` refused with "Authentication required" (-32000) gives "Antigravity is not logged in." with `agy acp --login` to copy and "Check again". The harness tries only `gemini-api-key`, and only when `GEMINI_API_KEY` is in agy's environment (it is hidden unless a copied entry forwards it); `oauth-personal`, `oauth-business`, `agent-platform` and `terminal-login` are never tried (browser, ADC or terminal sign-ins) | docs: authMethods table |
| Billing | flat-rate (the subscription); `GEMINI_API_KEY` forwarded on purpose switches it to per-token (`billingEnv`) | docs |
| Tool server | over the stdio relay (`mcpTransport: "stdio"`), because agy's HTTP MCP servers need `--process-per-session` | docs: flags table |
| Models | no list in the manifest (they depend on the account): discovery opens a throw-away session and reads agy's model config option; the user picks one per session (`session/set_config_option`) or types a name | docs: "Session options exposed as pickers: model, thinking level" |
| Thinking level | not set by Octo; agy keeps its own (the config option `thought_level` is ignored) | docs |
| Modes | Plan maps to agy's `plan`; agy has no ask mode, so Ask turns keep the mode and the harness denies writes; supervised projects switch agy from `auto` to `default` (see "Session modes") | changelog 1.5.0, 1.5.4, 1.5.8 |
| Permissions | agy offers Allow and Deny; Octo's card maps allow/deny onto them; Stop withdraws a waiting card and ends the turn without killing agy | docs; changelog 1.5.2 |
| Images | sent when agy advertises `promptCapabilities.image` (the docs say images and embedded resources are supported) | docs |
| Resume | `session/load` when advertised (agy supports load and resume), else the recap | docs |
| Slash commands, plan, diffs, usage | the generic paths: `available_commands_update` → the "/" menu, `plan` → the plan card, diff tool content → tool rows, `usage_update` (agy 1.5.9 sends the context window) → the context meter | docs; changelog 1.5.9 |
| Logs | agy writes its own log to `~/.gemini/antigravity-cli/log/acp-*.log`; Octo's wire trace (`HARNESS_ACP_TRACE=1`) works for agy like for any agent | docs |

Not done, on purpose: steering a running turn with a second `session/prompt` (agy supports it; Octo queues the message), elicitation
forms (agy falls back to chat), `session/resume` (load is used), `--sandbox`, `--process-per-session`, `--dangerously-skip-permissions`.
The test double is the scripted agent's agy profile (`OCTO_FAKEACP_PROFILE=agy`, `internal/fakeacp/agy.go`); live agy verification
is the owner's manual checklist (Antigravity block), not kept in the public tree.

## An agent that does not start in agent mode

When the agent process exits during `initialize` and its stderr is an argument or usage error (`unexpected argument`, `unknown option|command|flag`, `unrecognized`, `Usage:`), the turn fails with `<Label> did not start in agent mode: its command \`<cmd args>\` was rejected ("<first stderr line, at most 200 characters, redacted>").` and the hint says the version may not support the Agent Client Protocol or uses a different flag, with the manifest's optional `startHint` first (antigravity: update `agy`). The raw `acp initialize: acp: connection closed` chain is never shown.

### Changing an agent's launch arguments

Built-in agents come from the embedded `subscription-agents` plugin. To change one, copy `apps/harness/plugins-examples/subscription-agents/` to `{data-dir}/plugins/subscription-agents/` (a plugin directory of the same name replaces the built-in one), edit `plugin.json` and restart the harness. For example, an agent whose CLI wants `serve --stdio` instead of `acp`:

```json
{ "id": "cursor", "label": "Cursor", "command": "cursor-agent", "args": ["serve", "--stdio"], "verified": true }
```

`args` replaces the launch arguments as a whole; `{modelArgs}` as an element marks where the model argument goes. Check `harness doctor` afterwards: the agent is listed without `experimental` once the entry says `"verified": true`.

## A failure is never silent

Every way an ACP agent can fail ends the turn (orchestrator) or the sub-agent (a tool error to the orchestrator) with a plain message, a hint and a button code (see [`errors.md`](errors.md); the technical text, such as the exit status and stderr tail, is the `details`). The "Message carries" column below names the technical content, now found in `details`:

| Failure | Message carries |
| --- | --- |
| program missing | `start ACP agent "x": ...` and the manifest's `unavailable_reason` / install hint in `/v1/plugins` |
| not logged in, `authenticate` refused | `acp.ErrAuthRequired` plus the manifest's login hint |
| MCP servers refused | warning: the session works without harness tools, "update the agent, or choose another one as orchestrator" |
| crash or exit mid-turn | the exit and the agent's stderr tail (secrets scrubbed) |
| `stopReason` refusal, max_tokens, max_turn_requests, unknown | "the agent declined the request; rephrase it or use another agent" (and so on) plus the login hint |
| mid-turn `agent_error` | auth/`401`/`ProviderAuthError` maps to `AgentNotLoggedIn` (`details` carries the error + login hint + trailing stderr); `MessageAbortedError` is ignored so cancel stays `cancelled`; other errors map to `AgentFailed` (unless followed by text or tool calls) |
| usage or rate limit of the plan reached | `AgentLimitReached` (`agent_limit_reached`, action `switch_account`), details: the agent's own text; see "Usage limits and switching accounts" |
| ends the turn after reasoning only | `AgentNoAnswer` (`agent_no_answer`, `"<Agent> stopped before writing an answer."`, `action: "retry"`), with reasoning notice + trailing stderr in `details` |
| ends the turn with no text and no tool call | `AgentSilent` (`"<Agent> answered with nothing."`, `action: "recheck_provider"`), with login hint + redacted trailing stderr in `details`; never a success |
| `/compact` on an ACP agent | advertises `clientCapabilities.session.compaction`; handles `compaction_update`, `compaction_summary_chunk`, and `_meta["opencode/compaction"]`, records a manual compaction marker (`agent.compacted` `manual: true`, falling back to recent-message recap when summary is empty), surfaces compaction failures as `AgentFailed`, and routes failed `/compact` retries via `POST /compact` even before commands re-advertise after restart |

## Diagnostics and the wire trace

- `harness doctor [--data-dir D] [--json]` and `GET /v1/diagnostics` report: version, Go, OS, data dir, the PATH child processes get, the names (never values) of provider and router variables that are set, the names of the login-shell variables the desktop app forwards that child processes get (`shell_env_set`), the built-in loop and router state (base URL without credentials or query), and per agent: resolved command or "not found", each `requires` command, the login probe (doctor runs it now: exit status only, its output is discarded; the endpoint reports the cached background result), the hints, and a problems list.
  Since 2026-11-19 the problems list also has every plugin error, `plugin <name> (<manifest path>): <error>` (a manifest that is
  not valid JSON, an agent without an id or a command, a duplicate; also as `plugin_problems: [{plugin, manifest, error}]`),
  and, while the built-in loop has a key, the model API is probed (`GET <base>/v1/models` with the key, 1.5 s, the timeout
  of the Ollama reachability probe): `model_api: {state, detail}` with `reachable`, `unreachable` (nothing answered) or
  `unauthorized` (401/403); the last two are problems. Text output: `  model API: unreachable (nothing answered at
  http://127.0.0.1:9799 within 1.5s: … connection refused)`. The endpoint adds the last 200 log lines (scrubbed of tokens, keys, passwords, URL credentials) and the trace files. A test feeds secret-looking environment, URL and log content and asserts none appears.
- **Wire trace.** `HARNESS_ACP_TRACE=1`, or the setting of the same name (`PUT /v1/settings`, takes effect for sessions that start afterwards). One JSON-lines file per agent process under `{data-dir}/traces/` (`<time>-<agent>-<n>.jsonl`, mode 0600): `{t, dir: "client->agent" | "agent->client" | "agent-stderr" | "meta", msg | text}`. Redacted before writing: values under keys named like a secret (key, token, secret, password, credential, authorization, cookie), the value of env and header entries (`{name, value}`) with an upper-case env name or a secret-like name, `Bearer`/`Basic` credentials, the agent's environment values from the manifest, the MCP bearer token the harness issued, project secret values, and `key=value` text in free-form lines. A file is capped at 5 MB (the oldest half is dropped, with a marker line) and at most 20 files are kept. Prompt text and file contents are in the trace (it is the wire): read it before sending it.

## The first `spawn_agent` call and deferred tool schemas (2026-11-14)

Claude Code defers MCP tool schemas (its tool search): the model can call `spawn_agent` knowing only the tool's name. In
the owner's wire trace the first call carried `task` and `tier` only — the two arguments the briefing named — and was
refused; the retry, made after Claude Code attached the schema to the refusal, succeeded. What the harness does about it:

- The MCP server returns `instructions` in `initialize`: every tool with its required arguments (type, enum,
  description), the optional ones, and a full `spawn_agent` example. With a router, `tier` is optional and `auto` is offered.
- The briefing names all four arguments (`role`, `title`, `task`, `tier`) with an example.
- A refusal is plain text: what is missing ("Missing: role, title.") or which tier is unknown, "No sub-agent was
  started.", each argument, and `Example arguments: {…}` as valid JSON.
- `prompt` is accepted for `task` and `description` for `title` when the real field is empty. `tier` has no default
  without a router.
- An ACP tool result that is exactly one fenced code block is stored as its body (the agent's adapter adds the fence).
- A cancelled built-in turn stores the interrupted tool call's result at the stop, not at the next request, so the
  history and the turn's duration match what was seen live.

The scripted agent replays the sequence: `[mcp-spawn-lazy]` (arguments from the instructions) and `[mcp-spawn-guess]`
(task and tier only, then one retry from the refusal's example). Not verified: that real Claude Code shows the server
instructions to the model while tools are deferred, and that its first call is then right.

## Not verified

Everything above was exercised only against the scripted agent (`internal/fakeacp`) over a real stdio pipe, a real HTTP bridge and
a real relay process. **No real agent CLI was run** (Claude Code and its ACP adapter, Copilot, Grok, Codex ...): their handling of
`mcpServers`, `session/load`, the tool-call titles used to link a spawned sub-agent, and the permission and usage updates they send is
unverified. Run `scripts/e2e-acp-orchestrator.sh` for the scripted end-to-end check.

## Live activity (decision 55)

An agent at work is never just a spinner. For ACP orchestrators, ACP sub-agents and the built-in loop alike the project stream carries:

- `agent.activity {agent_id, kind, label, tool_use_id?}` on every transition. `kind` is `thinking` (before each model request / ACP "Thinking"), `tool` (label from the tool: "Reading src/x.go", "Writing a.txt", "Listing the project folder", "Running `pnpm test`", `Searching for "budget"`, "Delegating: title"; for ACP built from the call's kind, title and first location, paths shown relative to the project folder; a later `tool_call_update` with a new title refreshes it), `text` ("Writing", first streamed token), `waiting_approval` ("Waiting for your approval" for an approval card or ACP permission request, "Waiting for your answer" for a form), `idle` (the agent's run ended) and `quiet`. The same state twice in a row is one event. `quiet` is sent once when nothing at all (no session/update of any kind, no permission or fs request) arrived from an ACP agent for 10 s after the prompt was sent (not while the process starts and the session opens, and not while a tool call is open) (`Options.ACPQuietAfter`; not while it waits for the user); its label is the agent's id and the UI says "Still working — no output from <agent> yet". The first event of an ACP run, "Starting <agent>", is sent before the process has said anything.
- `message.thinking_delta {agent_id, text}`: the agent's reasoning. Scrubbed with the same stream scrubber as text (holds back at most the longest stored secret's length minus one byte, nothing when there are no secrets), never stored, not in messages, not indexed.
- `agent.plan {agent_id, entries:[{content, status, priority}]}`: the agent's whole plan each time; the latest is on the agent row as `plan` (null when none; cleared when the next turn starts; schema version 4).
- `tool.updated {agent_id, tool_use_id, status?, title?, locations?, summary?}`: what a `tool_call_update` changed. The tool row itself (`message.created` with the `tool_use`, and `tool.started`) is published when the agent announces the call, not when it ends (this was already so; it is now tested with a 400 ms tool).

**Tool timings (2026-11-22, for the UI's sub-agent run card).** Every agent's sink (built-in loop and ACP alike, orchestrator
and sub-agents) times each tool call from `ToolStarted` to its result: `tool.started` carries `started_at` (RFC 3339, UTC),
`tool.finished` carries `duration_ms`, and the stored `tool_result` block of `GET …/messages` (and of `message.created`) carries the
same `duration_ms`. The figure is kept beside the content, in the `messages.tool_ms` column (a JSON object `{tool_use_id: ms}`,
added when missing; an older binary ignores it, so the schema version stays 15), never inside `content_json`, which is replayed to
the model. The built-in loop publishes `tool.finished` before it stores the batch's results, an ACP agent stores the result first;
whichever comes first measures and the other reuses the figure, so the event and the stored row agree. Results stored before this
change, and synthetic ones (a dangling call closed after a crash), have no `duration_ms`: a client shows no time rather than a guess.
Code: `orchestrator/sink.go` (`settleTool`), `projectstore/messages.go` (`SetToolDurations`, `ApplyToolDurations`). Tests:
`orchestrator/tool_timing_test.go` (built-in loop with sub-agents; ACP with a 400 ms call stored before it finishes),
`projectstore/tool_timing_test.go`.

Text chunks are published as they arrive (no batching at all, so well inside the 50 ms bound); with no stored secret nothing is held back, with one at most its length minus one byte, until the next chunk or the end of the message. `current_mode_update` is ignored without error (`available_commands_update` feeds the "/" menu).

The scripted agent has markers for these flows: `[live]` (thought, plan, a tool with title/status updates, 20 text chunks 20 ms apart, each carrying its send time), `[slow-tool]`, `[quiet]`, `[secret-thought:VALUE]`. Tests measure the first event reaching an SSE subscriber within 100 ms of the agent sending it and the 20 chunks arriving over about 400 ms.
