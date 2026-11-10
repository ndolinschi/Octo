# Workspace tabs, code comments, plugins (LSP) and ACP agents — design

**Date:** 2026-11-10
**Status:** approved (owner request; details decided by the orchestrating agent)
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md), [`2026-11-10-code-pane-design.md`](./2026-11-10-code-pane-design.md), [`2026-11-10-project-harness-ui.md`](./2026-11-10-project-harness-ui.md)

## Intent

Four additions that turn the app from "chat with a side pane" into a workspace:

1. **Workspace tabs** — every view is a tab; tabs can be arranged side by side.
2. **Code comments** — comment on lines in the editor and send the comments to the orchestrator.
3. **Plugins** — a manifest format for connecting local programs: language servers (LSP), agents, tool servers.
4. **ACP agents** — run local Agent Client Protocol agents (Claude Code, Gemini CLI, Codex, …) as sub-agents.

## Non-goals

- A plugin marketplace, remote installation, or plugins that run code inside the UI.
- LSP features beyond diagnostics, hover, completion and go-to-definition.
- ACP terminals, images/audio, MCP server pass-through, session loading; an ACP agent as the orchestrator.
- Persisting comment threads on the server, or replies/resolution.
- Floating/pop-out windows.

---

## 1. Plugins

A plugin is a directory with a manifest, read by the harness at startup from
`{data-dir}/plugins/*/plugin.json` and from `--plugins-dir` (repeatable). The harness
never writes plugins and has **no API to add one** — installing a plugin is a
deliberate local file operation, because a plugin names commands the harness will run.

```jsonc
{
  "name": "go-tools",                       // unique; [a-z0-9-]
  "version": "1.0.0",
  "description": "Go language server",
  "languageServers": [
    { "id": "gopls", "label": "gopls", "languages": ["go"], "command": "gopls", "args": [], "env": {} }
  ],
  "agents": [
    { "id": "claude-code", "label": "Claude Code", "command": "npx", "args": ["-y", "@zed-industries/claude-code-acp"], "env": {} }
  ],
  "toolServers": [ { "url": "http://127.0.0.1:9000" } ]   // same contract as --remote
}
```

`languages` are Monaco language ids. Ids must be unique across plugins (first wins,
later duplicates are reported). Commands resolve via `PATH` unless absolute; relative
paths resolve against the plugin directory. Example manifests live in
`apps/harness/plugins-examples/` (not loaded automatically).

API: `GET /v1/plugins` →

```ts
type Plugin = {
  name: string; version: string; description: string;
  language_servers: { id: string; label: string; languages: string[]; available: boolean }[];
  agents: { id: string; label: string; available: boolean }[];
  tool_servers: { url: string }[];
  errors: string[];                 // manifest problems, duplicate ids
};
// → { "plugins": Plugin[] }
```

`available` = the command resolves to an executable.

## 2. ACP agents

`internal/acp` is a client for the Agent Client Protocol: JSON-RPC 2.0 over the child
process's stdio, one compact JSON object per line. The harness sends `initialize`
(`protocolVersion: 1`, `clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }`,
`clientInfo`), `session/new` (`cwd` = first project folder, `mcpServers: []`), then
`session/prompt` with one text block.

`spawn_agent` gains an optional `agent` input, an enum of the available ACP agent ids
(the parameter is omitted from the tool schema when there are none). When set, the
sub-agent runs through that ACP agent instead of the built-in loop. Its `model` is
recorded as `acp:<id>`.

| ACP | Harness |
| --- | --- |
| `session/update` `agent_message_chunk` (text) | `message.delta`; accumulated into the assistant message and the final report |
| `agent_thought_chunk` | ignored |
| `tool_call` | assistant `tool_use` block (`id` = toolCallId, `name` = `kind` or `"tool"`, `input` = `{ title, raw_input?, locations? }`); `tool.started` |
| `tool_call_update` with status `completed`/`failed` | user `tool_result` block (text content and diffs flattened to text); `tool.finished` |
| `usage_update` | token counts when present |
| `session/request_permission` | answered `selected` with the first `allow_once` (else first `allow_always`) option; `cancelled` during cancellation; logged |
| `fs/read_text_file`, `fs/write_text_file` | served by `internal/files` confinement against the project folders (absolute paths outside → JSON-RPC error); writes publish `file.changed` (`source: "agent"`) |
| anything else agent→client | JSON-RPC "method not found" |
| stopReason `end_turn` | completed; `cancelled` → cancelled; others → failed with the reason |

Messages are persisted on message boundaries so the transcript API and UI need no
changes. Turn cancellation sends `session/cancel`, waits briefly, then kills the
process. A crashed or silent agent fails the sub-agent, not the parent turn. A project
without folders cannot use ACP agents.

**Trust:** ACP agents run with the user's privileges and are auto-approved for tool
permissions; that is stated in the README. File requests through the client are
confined, but the agent process itself is not sandboxed.

## 3. Language servers

The harness starts a language server per editor session and relays LSP messages. No
WebSocket dependency: requests go by POST, server messages come by SSE.

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/lsp` | → `{ "servers": { id, label, languages, available }[] }` |
| POST | `/v1/projects/{pid}/lsp/{server}/sessions` | → `201 { "session_id": string, "root_uri": string, "workspace_folders": { uri, name }[] }` — spawns the server |
| POST | `/v1/projects/{pid}/lsp/sessions/{sid}/messages` | one JSON-RPC message → `202` |
| GET | `/v1/projects/{pid}/lsp/sessions/{sid}/events` | SSE, `event: message`, `data:` one JSON-RPC message; `event: exit` when the server ends |
| DELETE | `/v1/projects/{pid}/lsp/sessions/{sid}` | → `204`, kills the server |

The harness only frames (`Content-Length` on the stdio side); it does not interpret
LSP. Sessions end when deleted, when the SSE stream has been closed for 30 s, or on
shutdown. Limits: 8 sessions per project; 4 MiB per message.

`@octo/agent-client`: `listPlugins()`, `listLanguageServers(projectId)`,
`openLanguageServer(projectId, serverId) → Promise<{ rootUri, workspaceFolders, send(msg), onMessage(cb), onExit(cb), close() }>`.

UI: a small LSP client (no extra dependency) that, for an open file whose language has
an available server, performs `initialize`/`initialized`, full-document
`didOpen`/`didChange`/`didClose`, shows `publishDiagnostics` as Monaco markers, and
registers hover, completion and definition providers. Definitions inside the project
open as tabs. A quiet status in the editor header shows the server name and state
(starting / ready / failed with Retry).

## 4. Workspace tabs

The area right of the sidebar is a **dock**: groups of tabs that can be split
horizontally. Views (all are tabs):

| Tab | Notes |
| --- | --- |
| Chat | the orchestrator conversation; one per project; cannot be closed |
| Agent | a sub-agent transcript (read-only); one tab per agent |
| File | one per open file (editor) |
| Agents, Notes, Files | the tree/list tools |

- Drag a tab onto another group's tab strip to move it; drag to the left/right edge of
  a group to split. Groups resize by dragging the divider. Empty groups disappear.
- Without dragging: tab context menu and keyboard — "Move to the other side",
  "Split right", "Close", "Close others". `Ctrl/Cmd+\` moves the active tab to the
  other side; `Ctrl/Cmd+W` closes it; `Ctrl+Tab` cycles tabs in the group.
- Opening rules: delegation card / agents tree → Agent tab in the group that holds
  Chat (Alt/Option-click → the other side). File links and the Files tree → File tab
  in the side group (created if absent). Top-bar buttons open or focus Agents, Notes,
  Files in the side group.
- Default layout: Chat alone. Layout (groups, order, active tabs, sizes) persists per
  project in localStorage; invalid or stale entries are dropped silently.
- Below the docked breakpoint there is one group: every tab in a single strip.
- Routes still work: `#/p/{pid}` focuses Chat, `#/p/{pid}/a/{aid}` opens/focuses that
  agent's tab.

## 5. Code comments

- In the editor, hovering a line shows a `+` in the gutter; clicking it (or
  `Ctrl/Cmd+Alt+C` with a selection) opens an inline comment box under the line or
  selection. `Enter` adds the comment, `Shift+Enter` is a newline, `Esc` cancels.
- Pending comments render inline under their lines (edit / remove) and the range is
  marked in the gutter. They belong to the project and survive reloads (localStorage).
- The composer shows "N comments" with a popover listing them (jump to, remove).
  Sending a message attaches all pending comments and clears them; a message may be
  comments only.
- On the wire they are appended to the message text as a fenced block the model can
  read:

  ````
  ```octo-comments
  folder/path/file.ts:12-14
  > quoted line 12
  > quoted line 13
  comment text
  ```
  ````

  (at most 6 quoted lines per comment, then `> …`). The chat renders that block as a
  compact list of comment cards with file links, never as raw text.

---

## Acceptance criteria

**Plugins / ACP / LSP (harness)**
1. Manifests are loaded from the data dir and `--plugins-dir`; bad manifests and
   duplicate ids are reported in `errors` and never crash startup; there is no
   endpoint that creates or edits a plugin.
2. With a plugin agent present, `spawn_agent` exposes `agent`; a sub-agent run through
   a scripted ACP agent streams text, shows tool calls in its transcript, serves
   confined file reads/writes, and returns its final text to the parent. Paths outside
   the project are refused. Cancel stops the process. A crashing agent fails only that
   sub-agent.
3. An LSP session against a real `gopls` returns diagnostics for a Go file with an
   error, and a hover result; sessions are cleaned up on delete and on disconnect.

**Workspace (UI)**
4. Any tab can be moved to the other side by drag and by keyboard/menu; layouts
   persist per project across reloads; closing the last tab of a group removes it.
5. Chat and an agent transcript, or chat and a file, can be visible side by side.
6. Narrow widths degrade to a single tab strip with no clipped or overlapping controls.

**Comments (UI)**
7. A comment added on a line range appears inline, is counted in the composer, is sent
   with the next message in the documented format, and is rendered as a card in the
   chat; pending comments survive a reload and are cleared after sending.

**Editor intelligence (UI + harness)**
8. In a project with `gopls` available, opening a Go file with an error shows a marker
   and hovering a symbol shows its documentation.

**Finish**
9. Verified by independent reviewers on the live stack across: short and very long
   prompts in the composer and the sticky prompt, long and short project/request
   names, 1920 / 1440 / 1100 / 960 / 390 widths, dark and light. Transitions are
   smooth (no layout jumps or flicker) and respect reduced motion. No console errors.
10. All existing gates pass (Go vet/race tests, agent-client tests, UI lint, desktop build).
