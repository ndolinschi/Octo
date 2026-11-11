# Orchestrator on an ACP agent

A project's orchestrator normally runs the harness's own Messages-API loop. It can instead run as an
[ACP](https://agentclientprotocol.com) agent, for example Claude Code on a subscription through its ACP adapter. Design:
[`../../../docs/superpowers/specs/2026-11-10-subscription-agents-design.md`](../../../docs/superpowers/specs/2026-11-10-subscription-agents-design.md) (section S2).

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

- **One long-lived session per project.** The first request starts the agent process (lazily) and an ACP session at the project's
  first folder; later requests are further `session/prompt`s on it (same process, same session id). A crashed or killed process
  is restarted by the next request; a changed agent, model or first folder starts a new session.
- **Resume.** The session id is stored in the project database. After a restart of the process or of the harness the harness uses
  `session/load` when the agent advertised `loadSession`; otherwise (or when the load fails) it starts a new session and puts a
  **recap** before the first prompt: the latest compaction summary if there is one, else the last 40 user/assistant texts (tool rows
  left out), newest kept, in order, **capped at 8000 characters** (`orchestrator.RecapCap`). A new session also gets the
  orchestrator briefing (project brief, how to use the tools, notes). Notes edited between requests are re-sent with the next one.
- **Idle shutdown.** A session unused for `HARNESS_ACP_IDLE` (Go duration, default `30m`) has its process shut down (the stored
  session id is kept). The processes also end on project delete and on harness shutdown; the process group is killed, so the stdio
  relay (below) goes too.
- **Harness tools over MCP.** `spawn_agent`, `save_note`, `delete_note` and `list_dir` (the built-in orchestrator's tools, minus
  `read_file`, which ACP's `fs/read_text_file` covers; there are no separate wait/collect/cancel tools, `spawn_agent` returns the
  sub-agent's report) are served by the harness as an MCP server (`octo-harness`, Streamable HTTP, `POST /mcp/v1/projects/{pid}`
  on the bridge listener) and passed in `session/new.mcpServers`. Calls run through the same registry the built-in loop uses
  (`agent.CallTool`), so handlers, limits, budget checks, events, the agents list, usage and notes are unchanged. The endpoint
  accepts only loopback peers, no foreign `Origin`, `POST`, and a per-session random 256-bit bearer token bound to project and
  orchestrator agent (constant-time compare; a token of another project is `403`, an unknown or revoked one `401`); the token is
  revoked when the session ends. Tools work only while a user request is running.
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
  that ignores the cancel for 3 s is killed and restarted by the next request).
- **Permissions.** `session/request_permission` goes through `permission.Decide`, today auto-approve (the first `allow_once`, else `allow_always`, else
  cancel); `fs/read_text_file` and `fs/write_text_file` are confined to the project folders. The agent's own process is not sandboxed.
- **Environment.** The agent gets the allow-listed environment (`internal/childenv`) plus the manifest `env`, never the harness's provider keys.

## The agents to start with: Claude Code, Copilot, Grok

The built-in manifest lists them first. `GET /v1/plugins` gives each `available`, `unavailable_reason`, `logged_in`, `hint` (the login instruction) and `install_hint`; `harness doctor` prints the same. The texts below are what the manifest says; **none of these CLIs was run by the author** (see "Not verified").

| Agent | Install | Log in | Limits |
| --- | --- | --- | --- |
| `claude-code` | Node.js (the adapter runs through `npx`) and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code` | run `claude` and type `/login` (or `claude auth login`); the entry's login probe is `claude auth status` | the harness hides its own `ANTHROPIC_API_KEY` from the agent so the subscription is used; to bill per token on purpose add env `{"ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"}` to a copy of the entry |
| `copilot` | the GitHub Copilot CLI with `copilot` on PATH: `npm install -g @github/copilot` (Node.js 22 or newer, a Copilot plan) | run `copilot` and type `/login`, or start the harness with `COPILOT_GITHUB_TOKEN` set to a fine-grained token with the "Copilot Requests" permission | no login probe: the first failed turn says what to do |
| `grok` | the Grok CLI with `grok` on PATH (from x.ai); the entry's command line (`grok agent stdio`) is unverified against a real install | run `grok login` (browser) | an `XAI_API_KEY` in the harness environment is forwarded to Grok and **switches it to per-token billing**; unset it to stay on the subscription |

The wording is in `plugins-examples/subscription-agents/plugin.json` (`install` and `auth.hint` per entry); copy the plugin to change it.

## A failure is never silent

Every way an ACP agent can fail ends the turn (orchestrator) or the sub-agent (a tool error to the orchestrator) with a message that says what to do:

| Failure | Message carries |
| --- | --- |
| program missing | `start ACP agent "x": ...` and the manifest's `unavailable_reason` / install hint in `/v1/plugins` |
| not logged in, `authenticate` refused | `acp.ErrAuthRequired` plus the manifest's login hint |
| MCP servers refused | warning: the session works without harness tools, "update the agent, or choose another one as orchestrator" |
| crash or exit mid-turn | the exit and the agent's stderr tail (secrets scrubbed) |
| `stopReason` refusal, max_tokens, max_turn_requests, unknown | "the agent declined the request; rephrase it or use another agent" (and so on) plus the login hint |
| ends the turn with no text and no tool call | "the agent returned nothing (no text and no tool calls); if it is not logged in: <hint>"; this is a failed turn, never a success |

## Diagnostics and the wire trace

- `harness doctor [--data-dir D] [--json]` and `GET /v1/diagnostics` report: version, Go, OS, data dir, the PATH child processes get, the names (never values) of provider and router variables that are set, the built-in loop and router state (base URL without credentials or query), and per agent: resolved command or "not found", each `requires` command, the login probe (doctor runs it now: exit status only, its output is discarded; the endpoint reports the cached background result), the hints, and a problems list. The endpoint adds the last 200 log lines (scrubbed of tokens, keys, passwords, URL credentials) and the trace files. A test feeds secret-looking environment, URL and log content and asserts none appears.
- **Wire trace.** `HARNESS_ACP_TRACE=1`, or the setting of the same name (`PUT /v1/settings`, takes effect for sessions that start afterwards). One JSON-lines file per agent process under `{data-dir}/traces/` (`<time>-<agent>-<n>.jsonl`, mode 0600): `{t, dir: "client->agent" | "agent->client" | "agent-stderr" | "meta", msg | text}`. Redacted before writing: values under keys named like a secret (key, token, secret, password, credential, authorization, cookie), the value of env and header entries (`{name, value}`) with an upper-case env name or a secret-like name, `Bearer`/`Basic` credentials, the agent's environment values from the manifest, the MCP bearer token the harness issued, project secret values, and `key=value` text in free-form lines. A file is capped at 5 MB (the oldest half is dropped, with a marker line) and at most 20 files are kept. Prompt text and file contents are in the trace (it is the wire): read it before sending it.

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

Text chunks are published as they arrive (no batching at all, so well inside the 50 ms bound); with no stored secret nothing is held back, with one at most its length minus one byte, until the next chunk or the end of the message. `available_commands_update` and `current_mode_update` are ignored without error.

The scripted agent has markers for these flows: `[live]` (thought, plan, a tool with title/status updates, 20 text chunks 20 ms apart, each carrying its send time), `[slow-tool]`, `[quiet]`, `[secret-thought:VALUE]`. Tests measure the first event reaching an SSE subscriber within 100 ms of the agent sending it and the 20 chunks arriving over about 400 ms.
