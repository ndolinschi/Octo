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

`GET /v1/config` lists the valid settings in `acp_orchestrators` (`value: "acp:<id>"`, `id`, `label`, `models`, `default_model`).
The orchestrator agent's `model` reads `acp:<id>[/<model>]` (the manifest default model included). Types:
`BridgeConfig.acp_orchestrators`, `AcpModelRef` in `@octo/agent-client`.

```bash
# claude-code is the entry of plugins-examples/subscription-agents/plugin.json
# (command `npx -y @agentclientprotocol/claude-agent-acp`; log in once with the Claude Code CLI, `claude`)
harness serve --plugins-dir plugins-examples/subscription-agents
curl -XPOST localhost:8790/v1/projects -d '{"name":"demo","folders":[{"path":"/abs/path"}],
  "models":{"orchestrator":"acp:claude-code","fast":"acp:claude-code"}}'
```

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
  **ignored**: the UI has no place for them yet.
- **Cancel.** `POST /v1/projects/{pid}/cancel` sends `session/cancel`; the turn ends `cancelled` and the session stays usable (an agent
  that ignores the cancel for 3 s is killed and restarted by the next request).
- **Permissions.** `session/request_permission` goes through `permission.Decide`, today auto-approve (the first `allow_once`, else `allow_always`, else
  cancel); `fs/read_text_file` and `fs/write_text_file` are confined to the project folders. The agent's own process is not sandboxed.
- **Environment.** The agent gets the allow-listed environment (`internal/childenv`) plus the manifest `env`, never the harness's provider keys.

## Not verified

Everything above was exercised only against the scripted agent (`internal/fakeacp`) over a real stdio pipe, a real HTTP bridge and
a real relay process. **No real agent CLI was run** (Claude Code and its ACP adapter, Copilot, Grok, Codex ...): their handling of
`mcpServers`, `session/load`, the tool-call titles used to link a spawned sub-agent, and the permission and usage updates they send is
unverified. Run `scripts/e2e-acp-orchestrator.sh` for the scripted end-to-end check.
