# Parity features (B1–B7)

Contract: [`docs/superpowers/specs/2026-11-12-parity-backlog.md`](../../../docs/superpowers/specs/2026-11-12-parity-backlog.md).
Scripted check: `bash apps/harness/scripts/e2e-parity.sh` (mock model, scripted ACP agent, a local HTTP server; not part of CI).

## B1 — instruction files

The built-in loop (the built-in orchestrator and built-in sub-agents) reads the project's `AGENTS.md` and `CLAUDE.md`
(both, `AGENTS.md` first, when both exist) and puts them in its system prompt.

- **Which directories.** The root of every project folder, always. Besides that, the directories between a root and the
  files the agent's task names: for a sub-agent the files named in its task text, for the orchestrator's turn the files
  named in the user's request. A word counts as a file when, read as a path (absolute inside a folder, or relative to a
  folder, a trailing `:line` is dropped), it exists. At most 24 paths are looked at. Order: roots in folder order, then
  deeper directories; the nearest directory comes last, and where two files disagree the later one wins (the prompt says so).
- **Caps.** 32 kB per file; a longer file is cut and ends with
  `[... truncated by the harness: the file is larger than its 32 kB cap ...]`. 64 kB for the set: when it does not fit,
  the nearest files are kept whole and the farthest are cut or dropped.
- **Fresh.** Read from disk at the start of every request (turn) and for every sub-agent; a file added, edited or
  deleted is picked up by the next request. A file reached through a symlink that leaves the folder is skipped.
- **Prompt position.** Right after the project briefing, before the rest of the system prompt (and before the project
  notes block), so the prompt-cache prefix before it stays identical and the part after it only changes when a file
  does. Within a turn the system prompt is fixed.
- **Secrets.** Every stored secret value is replaced by its redaction marker before the text enters the prompt.
- **Receipt.** `GET /v1/projects/{id}/turns/{turn}/context` lists a block (only when at least one file was found):

  ```json
  {"name":"instructions","tokens":412,"cap":0,"count":2,"ids":["main:AGENTS.md","main:pkg/AGENTS.md"],
   "files":[{"path":"main:AGENTS.md","size":812,"used":812,"truncated":false},
            {"path":"main:pkg/AGENTS.md","size":210000,"used":32768,"truncated":true}]}
  ```

  `path` is `<folder label>:<path relative to the folder>`; `size` is the file on disk, `used` the bytes the agent got.
- **ACP agents** read their own instruction files; the harness adds nothing to their prompts. The receipt of an ACP-run
  turn carries `"instructions_note": "the agent reads its own instruction files"` and no `instructions` block. (An ACP
  turn in `full` memory mode now also gets a receipt, with no blocks, so that this note has somewhere to live.)

Code: `internal/instructions` (reading, caps, order), `internal/orchestrator/instructions.go` (per-agent cache, prompt
section, receipt block).

## B2 — edit, glob, web_fetch

Registered by `internal/tools/local` (`edit`, `glob`, both in `AllTools`) and `internal/tools/webfetch`.
The orchestrator now has `list_dir`, `read_file`, `edit`, `glob` (plus its note, memory, input and delegation tools);
sub-agents have everything plus `write_file` and `bash`. An ACP-run orchestrator is offered none of `edit`, `glob`,
`web_fetch` over MCP (the agent has its own).

- `edit {path, old_string, new_string, replace_all?, folder?}`: exact string replacement in an existing text file (at most
  4 MB, no NUL bytes). Errors (tool error results, the file untouched): empty or identical strings, no match, more than one
  match without `replace_all`, path outside the folder (traversal, absolute path, symlink out), missing or non-text file.
  It goes through the same approval and change recording as `write_file` (source `write_file`): the approval card carries
  `detail.patch` (a unified diff, cut at 20 kB) next to `detail.diff` `{added, removed}`; `write_file` approvals carry `patch` too.
  An edit that would fail raises no approval.
- `glob {pattern, path?, folder?}`: doublestar patterns (`**`, `*`, `?`, `[a-z]`, `{a,b}`), relative to `path`; results are
  paths relative to the folder, sorted, at most 200 (then a notice). In a git work tree the list is `git ls-files` (tracked
  and untracked files that `.gitignore` does not exclude), elsewhere a walk that skips `.git`, `node_modules`, `target`,
  `__pycache__`, `.venv`, `venv`, `.cache`. Symlinks are neither followed nor listed; `path` and the pattern cannot leave the folder.
- `web_fetch {url}`: only registered when the project setting `network` is `"on"` (default `"off"`; `PATCH /v1/projects/{id}`
  `{"network": "on"}`; `network_private: true` lets it reach private and loopback addresses). One GET, http and https, no
  credentials in the URL, no cookies, no proxy, no headers or body from the project; a URL that holds a stored secret is refused.
  Private, loopback, link-local (cloud metadata included), multicast, CGNAT and reserved addresses are refused on the address
  actually connected to (so DNS cannot slip one in) and on every redirect (at most 5). 15 s timeout, 200 kB of body
  (a cut is marked), text types only (`text/*`, JSON, XML, JavaScript, YAML); HTML is converted to plain text with its
  title first. In a supervised project every fetch is an approval (`kind: "network"`, `detail.url`, grant key per host).
  Project JSON gained `network` and `network_private`.

## B4 — allow always, deny with a reason

Answer `POST /v1/projects/{id}/approvals/{aid}` with `decision: "allow_always"` (optional `match`) to allow the request and save
a rule. Every approval now carries `tool` (`bash`, `write_file`, `edit`, `web_fetch`, `acp:<kind>`) and, when a rule can be saved,
`suggested_rule: {tool, match, exact}`. Rules are stored in the project database (schema 7, table `approval_rules`) and checked
before asking, for the built-in loop and for ACP permission requests, so a rule applies at once and deleting it applies at once.

- Command rules (`bash`, ACP requests with a command): `match` is the first words of the command; the command is split like a
  POSIX shell (quotes, escapes). A command with any control operator (`; & | && ||`), redirection, subshell, `$` expansion,
  backtick, comment, line break, leading `VAR=value` or unterminated quote is **never** covered by any rule, and never gets a
  suggested rule (`allow_always` on it answers 422 `no_rule`, the approval stays pending). The suggestion is two words for
  programs with subcommands (`git status`, `pnpm test`, three for `pnpm run <script>`) and a prefix rule (`exact: false`: it
  also covers `pnpm test --filter ui`, not `pnpm testing`); for everything else, and for `pnpm exec`, `go run`, `npx`, `bash -c`
  and other launchers, the whole command and `exact: true` (it covers that command only). A `match` the client sends must be
  the first words of the command and cover it (400 `invalid_request` otherwise); a launcher can only be allowed whole.
- File rules (`write_file`, `edit`, ACP edits inside a folder): `match` is a doublestar glob on the path relative to the folder
  (any folder); the suggestion is the exact path. An override must cover the request, stay inside the folder (no `..`, no leading `/`).
- `web_fetch` rules: `match` is a host glob (suggestion: the host).
- `GET /v1/projects/{id}/approval-rules` → `{"rules": [{"id","tool","match","exact","created_at"}]}`;
  `DELETE /v1/projects/{id}/approval-rules/{rid}` → 204 (404 `not_found`). Events `approval_rule.created {rule}` and
  `approval_rule.deleted {id}`.
- A deny's `note` reaches a built-in agent as the tool error `Denied by the user: <note>` (`Denied by the user.` without one) and
  an ACP agent's `fs/write_text_file` as the same text in its JSON-RPC error. The ACP permission outcome has no reason field in
  the protocol (only a selected option or cancelled), so the agent gets the reject option, not the note.

## B3 — modes: agent, ask, plan

Project field `mode` (`"agent"` default, `"ask"`, `"plan"`; POST/PATCH `/v1/projects`, returned in the project JSON) and a per-turn
override: `POST /v1/projects/{id}/messages {"text": "...", "mode": "plan"}` (400 `invalid_request` for another value; a queued message
keeps its mode, `queue` entries carry `mode` when one was chosen). The turn's mode applies to that turn only; the project's stays.

- **Tool gate (built-in loop, and the harness tools an ACP orchestrator calls over MCP).** In `ask` and `plan` turns the registry is
  read-only, enforced in the handlers (not by the prompt alone): `write_file` and `edit` answer a tool error
  `Refused: <what> is not allowed in <mode> mode, which is read-only. Say what you would do and ask the user to switch to Agent mode.`,
  so does `spawn_agent` (delegation), and `bash` unless the command is one simple command of a small allow-list: `ls cat head tail wc
  pwd echo grep rg find which file stat tree sort uniq diff basename dirname date du df cut tr nl`, and `git` with `status log diff
  show ls-files rev-parse blame shortlog describe ls-tree cat-file` (no `-c`, `--output`); `find -exec/-delete/-fprint`, `rg --pre`,
  `sort -o` are refused. Compound commands (`;`, `&&`, pipes, redirections, `$`) are never read-only. A refused call raises no approval.
  Notes, memory and forms still work. `web_fetch` still works when the project allows the network.
- **Prompt.** The orchestrator's system prompt says `Mode: ASK` / `Mode: PLAN` and what that allows (after the instruction files).
  For an ACP orchestrator the same sentence goes in brackets in front of the request.
- **Plan.** A completed `plan` turn stores its answer as a plan: `plan.created {plan}` event;
  `GET /v1/projects/{id}/plans/latest` → `{"plan": {"id","turn_id","text","status":"pending"|"approved","created_at","approved_at"}}` (404 `not_found` without one);
  `POST /v1/projects/{id}/plans/{planId}/approve` → 202 `{"plan": ..., "message": ...}` marks it approved (`plan.approved {plan}`) and starts an
  `agent` turn whose user message is "The plan above is approved. Carry it out." with the plan pinned in the system prompt (built-in)
  or in front of the prompt (ACP). 409 `plan_not_pending` when it was approved already, 409 `turn_in_progress` while a turn runs, 404 for an unknown id.
- **ACP orchestrator.** The agent's advertised session modes (`session/new` result `modes: {currentModeId, availableModes}`) are used
  when present: `ask` maps to a mode whose id or name contains `ask`/`read-only`, `plan` to one containing `plan`, applied with
  `session/set_mode` before the prompt; `agent` restores the mode the session started in. Whether or not the agent has such a mode,
  the harness also denies the agent's write permission requests (only `read`, `search`, `think`, `fetch` and read-only `execute` pass)
  and `fs/write_text_file` in these modes, whatever the project's access setting. Not verified against a real agent: only the scripted
  agent (`OCTO_FAKEACP_MODES=1`) advertises modes in this repository.

## B5 — rewind to a request

`POST /v1/projects/{id}/rewind {"message_id": 41, "dry_run": false}`; `message_id` is the id of one of the orchestrator's user
requests (the turn id; the `message_id` of the message list). Answer 200:

```json
{"dry_run": false, "message_id": 41, "request_text": "the request's text, for the composer",
 "files": [{"folder": "main", "path": "src/a.go", "action": "restore" | "delete", "change_ids": [12, 9]}],
 "conflicts": [], "messages_cut": 14, "agents_cut": 3, "acp_session_reset": false}
```

- **Files.** The recorded changes of that request and every later one are undone, newest change first (`files` is in that order). Per
  file the state before its oldest change in the range is put back: the stored content, or the file is deleted when the change created
  it. Before anything is touched every file must still be what the harness last left (`after_hash`; absent for a deleted file).
  Otherwise nothing at all is changed and the answer is `409 rewind_conflict` with `error.details` = the same report, `conflicts` being
  `[{"folder","path","reason"}]`, `reason` one of `modified_outside` (changed outside the harness since), `unavailable` (the earlier or
  the later content was not kept: too large, or past the 30-day retention) and `folder_missing`. `dry_run: true` returns the report
  with 200 and changes nothing, conflicts included.
- **Conversation.** Every message with that id or a later one (of every agent) is soft-deleted (`messages.rewound_at`: it stays on disk,
  it is no longer listed, sent to a model, searched or exported), sub-agents created since are hidden (`agents.rewound_at`), their
  recorded changes, the context receipts, the plans and the compactions that reach into the cut are removed, and the memory task
  records the cut turns created are dropped; a task that spans the cut keeps what is before it (message ids, quotes, facts after the cut
  are removed). Spend and usage rows stay. Events: `file.changed` per restored file (source `user`), `conversation.rewound
  {message_id, request_text}`, `context.updated`.
- **ACP orchestrator.** Its session holds the cut conversation and cannot be rewound in place: the stored session is deleted and the
  live process ended (`acp_session_reset: true`); the next turn starts a new session with the recap of what is left.
- **Refusals.** 409 `turn_in_progress` while a turn runs; 400 `invalid_request` when the id is not a visible user request of the
  orchestrator (an unknown id, a cut one, a sub-agent's message); 404 for an unknown project.

## B6 — steer a running turn

`POST /v1/projects/{id}/queue/{qid}/send-now` with an optional body `{"interrupt": true}`.

- **Built-in turn, no body (the new default).** The turn is not cancelled. The queued message moves to the front of the queue and
  is injected as a user message at the turn's next tool boundary: after the current round of tool results is stored, before the
  next model request. Answer `202 {"steered": true}`. When the turn takes it: the message leaves the queue (`queue.updated`), is
  stored as a user message of the orchestrator's conversation (`message.created`, role `user`, after the tool-result message), and
  `message.steered {"queue_id": "q_..", "text": ".."}` is published. A message deleted from the queue meanwhile is skipped, one
  that was edited is sent as edited. If the turn ends without another tool call, nothing was injected: the message is still first in
  the queue and runs as the next turn, as usual. Only the orchestrator's own loop is steered (sub-agents are not).
- **ACP orchestrator turn.** `409 steer_unsupported`: the ACP schema in this repository (`internal/acp`) has no way to add input to a prompt
  turn that is running (only `session/cancel`), so none is invented. The turn is untouched; send the message again with
  `{"interrupt": true}` (or wait for the turn to end, the message is queued).
- **`{"interrupt": true}` (the previous behaviour).** The running turn is cancelled (the queue is not paused by that) and the message runs
  first. Answer `202 {}`. With no turn running, send-now starts the message at once, with or without the flag.
- 404 `not_found` for an unknown queued id.

## B7 — history and context

- **`POST /v1/projects/{id}/compact`** — compacts the orchestrator's conversation now: one call of the side model (`models.side`, role `compact` in
  the usage rows) summarises it, the summary is stored as a compaction, and the next request sends it in place of the messages it covers (they stay
  in the transcript and on disk). Answer 200 `{"upto_message_id", "at", "summary_tokens", "message_count", "manual": true}`. 409 `turn_in_progress`
  (a turn runs; the project's turn slot is held while it compacts), 409 `nothing_to_compact` (fewer than two messages since the last compaction),
  409 `compact_unsupported` (ACP orchestrator: the agent compacts itself; memory mode `window`: no history is sent), 409 `builtin_loop_unavailable`.
- **The marker.** `GET /v1/projects/{id}/agents/{aid}/messages` returns `compactions: [{"upto_message_id", "at", "summary_tokens", "label": "history compacted",
  "manual": bool, "message_count": n}]` (`message_count` for manual ones). The marker belongs between message `upto_message_id` and the next. Events:
  `agent.compacted {agent_id, upto_message_id, summary_tokens, at, manual, message_count?}` (now for the router's automatic compaction too, `manual: false`).
- **`GET /v1/projects/{id}/export?format=md`** — `text/markdown`, attachment named after the project. `# <project>`, then per request `## Request N · <time>`
  with the text, `### Answer` with the assistant's text, and each tool call one line: ``- `bash` `git status` → ok: first 100 characters of the result``
  (`→ error: ...` when it failed; the key is the title, command, path, pattern, query, url or task). `> History compacted ...` lines mark compactions.
  Messages hidden by a rewind are left out; every stored secret value is replaced by its marker. Other `format` values: 400.
- **`GET /v1/search?q=&limit=`** (global) — past requests (the orchestrator's user messages; not answers, not sub-agent tasks) of every project, found
  with the memory search index (exact words first, then substrings and stems, then newest first). `{"results": [{"project_id", "project_name", "message_id",
  "snippet", "date"}]}`, `limit` default 20, at most 50; 400 without `q`. Rewound requests are not found.

### The context report (additive to `GET /v1/projects/{id}/context`)

The existing fields are unchanged: `agent_id, model, window_tokens, used_tokens, estimated, parts` (`?agent=<id>` still picks a sub-agent). New:

```json
{"source": "harness", "window": 200000, "window_source": "default", "reserved_tokens": 8192, "free_tokens": 190123,
 "compacted_at": "2026-11-12T10:00:00.000Z",
 "categories": [{"id": "system", "label": "Briefing", "tokens": 376}, {"id": "instructions", "label": "Project instruction files", "tokens": 169},
                {"id": "tools", "label": "Tool definitions", "tokens": 1446}, {"id": "notes", "label": "Project notes", "tokens": 16},
                {"id": "memory", "label": "Memory", "tokens": 0}, {"id": "messages", "label": "Conversation", "tokens": 783},
                {"id": "tool_results", "label": "Tool results", "tokens": 0}, {"id": "summary", "label": "Compacted summary", "tokens": 0},
                {"id": "current_request", "label": "Current request", "tokens": 59}],
 "last_request": {"input": 1850, "cached": 1200, "output": 140}}
```

- `source: "harness"` for the built-in loop: the categories come from the same pieces that build the next request (the system prompt split into briefing
  and the B1 instruction files, the tool definitions of the agent's registry, the notes block, the stored conversation, with the window mode's memory
  blocks as `memory`, the latest user request as `current_request`, the latest compaction's summary), measured with the harness's one estimator
  (characters / 4), then scaled so that they sum to `used_tokens` exactly (the same scaling `parts` has). `used_tokens` is the model's last reported
  input size when there is one (`estimated: false`), else the estimate. Categories are always all listed, zero included, in this order.
- `window` is the size `free_tokens` is computed from: the model's configured window (`HARNESS_CONTEXT_WINDOWS`; `window_source: "configured"`), else
  **200,000, the same default tool-result clearing assumes (`window_source: "default"`)**. `window_tokens` stays null in that case, as before.
  `free_tokens = max(window - used_tokens - reserved_tokens, 0)`; `reserved_tokens` (8192) is the room kept for the answer.
- `last_request`: the newest main-thread usage row of the orchestrator: `input` everything it read (uncached + cache reads + cache writes), `cached` the
  cache-read part, `output` the answer; null before any request.
- `source: "agent"` for an ACP orchestrator: `used_tokens`/`window` are what the agent reported (`usage_update` used / size; `window_source: "agent"`,
  `window` null when it reported no size), `categories` is `[]`, nothing is invented.
#### Itemised report (decision 88, additive)

Every category gains `items`; the report gains `not_loaded`, `buffer_tokens` and `largest_messages`. Nothing above changes, except that two categories were
added to the fixed list (`mcp_tools` after `tools`, `agents` after `memory`; both 0 with `items: []` when there is nothing) and that `system` no longer
counts the delegation note (that is `agents`). Order: system, instructions, tools, mcp_tools, notes, memory, agents, messages, tool_results, summary, current_request.

```json
{"categories": [
  {"id": "system", "label": "Briefing", "tokens": 376, "items": [
     {"id": "system:guidance", "label": "Role and working guidance", "tokens": 290, "loaded": true, "estimated": true},
     {"id": "system:brief", "label": "Project brief", "tokens": 60, "loaded": true, "estimated": true},
     {"id": "system:custom", "label": "Custom instructions", "tokens": 26, "loaded": true, "estimated": true}]},
  {"id": "instructions", "label": "Project instruction files", "tokens": 169, "items": [
     {"id": "instructions:main:AGENTS.md", "label": "main:AGENTS.md", "tokens": 169, "group": "main", "path": "main:AGENTS.md", "loaded": true, "actions": ["open"], "estimated": true}]},
  {"id": "tools", "label": "Tool definitions", "tokens": 1446, "items": [
     {"id": "tool:spawn_agent", "label": "spawn_agent", "tokens": 410, "group": "Harness tools", "loaded": true, "estimated": true}]},
  {"id": "mcp_tools", "label": "MCP tools", "tokens": 120, "items": [
     {"id": "tool:ops.local:9100:deploy", "label": "ops.local:9100 · deploy", "tokens": 120, "group": "ops.local:9100", "server": "ops.local:9100", "loaded": true, "estimated": true}]},
  {"id": "notes", "label": "Project notes", "tokens": 16, "items": [{"id": "note:note_x", "label": "Plan", "tokens": 12, "loaded": true, "estimated": true}]},
  {"id": "memory", "label": "Memory", "tokens": 76, "items": [
     {"id": "memory:memory_index", "label": "Memory index", "tokens": 64, "group": "Memory", "loaded": true, "estimated": true},
     {"id": "memory:open_tasks", "label": "Open tasks", "tokens": 12, "group": "Memory", "loaded": true, "estimated": true}]},
  {"id": "agents", "label": "Sub-agent definitions", "tokens": 80, "items": [
     {"id": "agent:fake", "label": "Fake fake", "tokens": 10, "group": "External agents", "loaded": true, "estimated": true},
     {"id": "agent:note", "label": "How to delegate to external agents", "tokens": 70, "loaded": true, "estimated": true}]},
  {"id": "messages", "label": "Conversation", "tokens": 783, "actions": ["compact"], "items": [
     {"id": "messages:user", "label": "User requests", "tokens": 400, "group": "Conversation", "loaded": true, "estimated": true},
     {"id": "messages:assistant", "label": "Assistant text", "tokens": 380, "group": "Conversation", "loaded": true, "estimated": true},
     {"id": "messages:tool_calls", "label": "Tool calls", "tokens": 3, "group": "Conversation", "loaded": true, "estimated": true},
     {"id": "messages:thinking", "label": "Thinking", "tokens": 0, "group": "Conversation", "loaded": true, "estimated": true}]},
  {"id": "tool_results", "label": "Tool results", "tokens": 700, "items": [
     {"id": "tool_results:read_file", "label": "read_file", "tokens": 700, "group": "Tool results", "loaded": true, "estimated": true}]},
  {"id": "summary", "label": "Compacted summary", "tokens": 0, "items": []},
  {"id": "current_request", "label": "Current request", "tokens": 59, "items": [{"id": "current_request", "label": "Current request", "tokens": 59, "loaded": true, "estimated": true}]}],
 "not_loaded": [{"id": "memory_file:/memories/arch.md", "label": "/memories/arch.md", "tokens": 1000, "group": "Memory files", "path": "/memories/arch.md", "loaded": false, "actions": ["open"], "estimated": true}],
 "buffer_tokens": 0,
 "largest_messages": [{"message_id": 14, "role": "user", "tokens": 700, "preview": "[result] package main package main package main ..."}]}
```

- **Sums.** The items of a category add up to its `tokens` exactly (largest remainder, largest first, zero rows dropped except the three message kinds); the
  categories add up to `used_tokens`. A category with tokens and nothing to weigh is one row with the category's own id.
- **Estimated vs reported.** `used_tokens` is the model's report when `estimated` is false; every category and item figure is the harness's estimate
  (characters / 4) scaled to it, so each item says `estimated: true`. `largest_messages[].tokens` and `not_loaded[].tokens` are raw unscaled estimates
  (in no sum). `thinking` is 0: the built-in loop never asks for thinking. `buffer_tokens` is 0: the router decides when to compact and the harness knows
  no threshold (show no buffer row for 0).
- **Rows.** `tools`: one per built-in tool (`group: "Harness tools"`). `mcp_tools`: tools of plugin tool servers and `--remote` servers, `server` and `group`
  = the server's host (sub-agents only; the orchestrator is not offered them). `instructions`: one per file by `path` (`<folder label>:<relative path>`).
  `notes`: one per note today (extension point `notesItems()`). `memory` (window mode): index, open tasks, current facts. `agents`: the delegation note and one
  row per available external agent. `messages`: user requests / assistant text / thinking / tool calls (the latest request and the memory blocks have their own
  categories). `tool_results`: by the tool's name. `system`: project brief, custom instructions, pinned plan, mode note, the rest. `messages.actions` is
  `["compact"]` for the built-in orchestrator in `full` mode.
- **`largest_messages`**: up to five, largest first: stored messages after the latest compaction (the latest request excluded), size counting text, tool calls
  and tool results, `preview` at most 80 characters on one line. In the window mode the messages sent are reduced exchanges, so an exchange's request (id of
  its first message) and answer (id of its last) are ranked instead.
- **`not_loaded`**: memory files (read with the memory tool), up to 50, largest first; orchestrator only.
- **ACP orchestrator (`source: "agent"`).** Without a usage report: `categories: []` as before (`not_loaded` still lists memory files). With one
  (`estimated: false`): only what the harness sends is itemised: `system` (the briefing of a fresh session), `mcp_tools` (the harness's tools as server
  `octo-harness`), `notes`, `memory` (window mode), `agents`; plus one category `agent` ("Inside the agent — not itemised by <Agent>") with one row
  `agent:inside` holding the rest of the reported total. If the harness's estimate exceeds the report it is scaled down and the `agent` row is omitted.

- Event `context.updated {"project_id"}` after every turn, after a compaction (manual or automatic), after a rewind, when a project note changes and when an
  instruction file (`AGENTS.md`/`CLAUDE.md`) is written through the file API or by an agent; refetch the report.

## B11 — slash commands, ours and the agent's

Spec: `docs/superpowers/specs/2026-11-12-parity-backlog.md` (B11 and its revision "/clear tidies, it does not forget").

### `GET /v1/projects/{id}/slash-commands`

```json
{"octo": [{"name": "compact", "description": "Summarise the conversation so far to free context", "available": false,
           "reason": "the agent does not advertise a compact command: it compacts its own context", "endpoint": "POST /v1/projects/{id}/compact"},
          {"name": "mode", "description": "Set the mode of the next requests", "args": "ask|plan|agent", "available": true, "endpoint": "PATCH /v1/projects/{id} ..."}],
 "agent": {"id": "claude", "label": "Claude Code", "pending": true,
           "commands": [{"name": "web", "description": "Search the web", "input_hint": "query"}]}}
```

- `octo` lists, in menu order: `compact, clear, mode, model, rewind, export, review, context, memory, settings, remember, help`. `args` is an argument
  hint, `endpoint` what a client calls to run it (`{id}` = project id). `available: false` carries `reason`: `compact` is unavailable for an ACP
  orchestrator whose agent has not advertised a command named `compact` (or has not advertised anything yet), and in the window memory mode.
- `agent` is `null` for the built-in loop. For an ACP orchestrator it holds what the agent advertised with `available_commands_update` (read in every shape
  the schema and looser agents use: `input: {hint}`, `input` as a string, `hint` / `inputHint` / `input_hint`, a leading `/`, bare names; entries without a
  name are dropped, repeated names keep the first). `pending: true` (and an empty list) until the agent has sent a list in this project; the harness never starts a
  session only to read it. The last list is kept per project and plugin agent, also after the process idles out; `/clear` forgets it.
- Event `slash_commands.updated {"project_id"}` when the list changes (also to or from pending).

### Running commands

- A user message whose first token is an Octo command (`/compact`, `/clear now`, `/remember x`, ...; case-insensitive) is refused: `400
  {"error":{"code":"octo_command","message":"/clear is an Octo command and is not sent as a message: call POST /v1/projects/{id}/clear (the project id replaces {id})"}}`.
  Nothing is stored. The same check applies to editing a queued message. A name that both Octo and the agent have is the Octo one.
- A message that starts with an advertised agent command (ACP orchestrator, not an Octo name) passes through: the prompt sent to the agent is exactly the text
  (`/web rust ownership`: agents take a command only when the prompt starts with it; on a new session the briefing waits for the next request) and the stored
  user message has `"command": "web"`. An unknown `/text` is ordinary text; the built-in loop has no agent group.
- `POST /v1/projects/{id}/compact`: built-in loop as before (200 `CompactResult`). ACP orchestrator whose agent advertises `compact`: `/compact` is sent to it as a turn,
  `202 {"sent_to_agent": true, "message": {..., "command": "compact"}}`; otherwise 409 `compact_unsupported`; 409 `turn_in_progress` for a running turn.

### `POST /v1/projects/{id}/clear`

`/clear` tidies the project; it deletes nothing (messages stay stored, searchable and exportable).

```json
{"conversation_id": "conv_x", "upto_message_id": 41, "at": "2026-11-12T10:00:00.000Z", "title": "first request of the session",
 "summary": "## Asked ...", "summary_source": "model", "session_id": "ses_new", "previous_session_id": "ses_old"}
```

`session_id` / `previous_session_id` (memory M4, absent when the memory service could not record the boundary): the memory session the next request joins (empty,
not listed until its first request) and the one that ended, which keeps `summary` / `summary_source` on its record (`GET …/memory/sessions/{sid}`, `session.summary`).

- The model's history starts over from a **carry-over of at most 600 tokens** (characters / 4), in order: the summary written at clearing time (Asked, Done,
  Decisions, Unfinished, Files), the titles of the open tasks (at most 5), and the pointer to `memory_search` / `recall_message`. It is stored with the boundary.
  Instructions, notes, facts and memory files are untouched; open task records stay open.
- `summary_source`: `model` (built-in loop: one fast-tier call, usage role `summary`), `agent` (ACP: the live session is asked for it in one prompt, 30 s, not a
  user turn, nothing stored), `stored` (a fallback, or an empty session: the newest compaction summary plus the last three requests, with the start of their final
  answers for an ACP orchestrator, no model). An ACP session that is not live is never started for this.
- ACP: the session is dropped; the next one starts with the carry-over as its recap. The context report starts over (no `compacted_at`, the agent's own
  `context_used` forgotten). The window memory mode sends the carry-over as the first message too.
- `GET .../agents/{aid}/messages` gains `"conversations": [{"conversation_id", "upto_message_id", "at", "label": "New session · earlier: <title>", "title", "summary"
  (the carry-over), "summary_source"}]`; a client shows the transcript from the last boundary on, under the label. The Markdown export has a `> New session · earlier: <title>`
  marker between the two sessions.
- Events: `conversation.cleared {project_id, conversation_id, upto_message_id, at, title, summary, summary_source}`, `context.updated`, and for an ACP orchestrator `slash_commands.updated`.
- 409 `turn_in_progress` while a turn runs (the turn slot is held while the summary is written; a message sent meanwhile is queued).
- No memory-executor session ids exist in this base: `conversation_id` is the boundary's id and the response has no `session_id` / `previous_session_id`.

### `remember` and the facts endpoints

- Tool `remember {text, kind: "fact"|"decision"|"preference"|"todo", about?}` for the orchestrator and every built-in sub-agent, and over the harness MCP server for an ACP
  orchestrator. It stores a dated fact in the turn's task record (a record named `Remembered` outside a turn) with `kind`, `about`, `remembered_by` (the agent id, `user` for
  `/remember`) and the source turn (`message_id`); an item with the same `kind` and `about` supersedes the earlier one (it stays, marked `superseded_by`); the same text twice is
  stored once. At most 3 per turn across the turn's agents: the fourth is a tool error (`at most 3 items can be remembered in one turn; ...`). Allowed in ask and plan modes
  (it writes no file). The briefings say when to use it. Events: `task.updated`, and `fact.remembered {task_id, fact, turn_id, agent_id}` (show "Remembered: ..." with Undo).
- `POST /v1/projects/{id}/facts {"text", "kind"?: "fact", "about"?}` → 201 `{"task_id", "fact"}` (what `/remember <text>` calls); 400 `invalid_request` for empty text or an unknown kind.
  `DELETE /v1/projects/{id}/facts/{task_id}/{fact_id}` → 204 (the undo; facts it had superseded become current again; event `fact.forgotten {task_id, fact_id}`); 404 `not_found`.

### Schema 9

`messages.command`, `compactions.cleared` / `conversation_id` / `summary_source` / `title` (a clear is a compaction row whose summary is the carry-over). Migration test from schema 8:
`internal/projectstore/schema9_test.go`.
## B13 — the side question runs on what the project runs on

`POST /v1/projects/{id}/side {"text"}` → 202 `{side_id, message}`; the answer arrives as events. What answers:

1. `models.side` when set (a Messages API model, a tier name, or `acp:<agent>[/<model>]`; same validation as the other model settings, 422
   `model_unavailable` / 400 for an unknown agent).
2. Else, when the orchestrator is an ACP agent: **that agent**, in its **own process and own ACP session** (never the orchestrator's session, so it
   works while the orchestrator's turn runs and cannot disturb it), started in the project's first folder with no harness MCP tools. The harness
   rejects every permission request that is not read/search/think/fetch (edits, commands, deletes), answers every `fs/write_text_file` with an error,
   and puts the session into the agent's own ask / read-only mode when it advertises one (`session/set_mode`).
3. Else the Messages API with `models.side`, else the project's fast tier (unchanged).

The session is kept for follow-ups (a follow-up prompt is just `Side question: …`; the first prompt carries the briefing, a recap of the orchestrator's
conversation and any earlier side exchanges). It is closed by `DELETE /side` (clear), when the project is deleted, at shutdown, and after **15 minutes
without a question** (`Options.SideIdle`, injectable `Options.Clock`); the next question then starts a fresh session with the stored side exchanges in
its first prompt.

Errors (synchronous, nothing stored): **409** `{"error":{"code":"no_provider","message":"Nothing can answer a side question. Connect a provider in Settings, or choose a side model."}}` (with a named agent that cannot run: `Nothing can answer a side question: unknown or unavailable ACP agent "x". Connect …`). The UI shows one "Connect a provider" button; there is no
environment-variable text. Failures while answering arrive as `side.error`.

Events (all carry `side_id`): `side.delta {text}` (streamed answer, secrets scrubbed), `side.thinking {text}` (ACP reasoning, never stored),
`side.activity {kind: thinking|tool|text, label, tool_use_id?}` (the same labels as `agent.activity`), `side.tool {tool_use_id, title?, kind?, status?}`
(a tool call of the agent started / changed), `side.done {message}`, `side.error {error, code?, hint?}` (`error: "cancelled"` after stop or clear; `code:
"no_provider"` when the agent or key went away mid-way; `hint` is the agent's login hint).

`POST /v1/projects/{id}/side/stop` → 204: stops the running question (`side.error` "cancelled", its question is removed) and **keeps** the side
conversation and the agent session. Usage rows of a side answer have `role: "side"` (`source: "acp"` for an agent, with the agent's own tokens and,
for a subscription agent, `flat_rate`).

UI: show `side.activity`/`side.thinking` like the live activity of the main conversation; Stop calls `/side/stop`; the model control writes
`models.side` (PATCH project); on 409 `no_provider` show the connect-a-provider button.

## B12 — attach images

- `POST /v1/projects/{id}/attachments` — multipart (part `file`, its file name is kept) or the raw bytes with any `Content-Type` (`?name=` optional).
  **201** `{id, media_type, bytes, width, height, name?, created_at}`. The type is decided by **sniffing the content** (PNG, JPEG, GIF, WebP; the header
  and the file name are ignored): anything else is **415** `unsupported_media_type`; more than **5 MB** is **413** `attachment_too_large`; empty is 400.
  The id is `att_` + 24 hex digits of the SHA-256: the same image is stored once (uploading it again renews its age). The harness does not downsize.
- `GET /v1/projects/{id}/attachments/{id}` — the bytes with the sniffed `Content-Type` (bearer header like every `/v1` route, so fetch and make a blob URL).
- `POST …/messages {"text", "mode"?, "attachments":["att_…"]}`: at most **8**, no duplicates; unknown id **404** `attachment_not_found`; bad id/too many
  400. Blank text with images becomes "Look at the attached image(s).". A message queued behind a running turn keeps its images:
  `queued.attachments` and every entry of `GET …/queue`. Send-now without `interrupt` on a queued message with images is **409** `steer_unsupported`
  (images cannot be injected mid-turn); with `interrupt` it runs.
- **Built-in loop:** the stored user message becomes image blocks (base64 source) in the order attached, then the text. **ACP agent:** `image` content
  blocks (`{type:"image", data, mimeType}`) before the text in `session/prompt`, only when the agent advertised `agentCapabilities.promptCapabilities.image`;
  otherwise **422** `{"error":{"code":"images_unsupported","message":"<Agent> does not accept images. …","details":{"agent":"<label>"}}}` before
  anything is stored or sent. Never silently dropped.
- `GET /v1/projects/{id}` has `accepts_images`: `true` for the built-in loop, what the agent advertised once it has been started, **`null` before that**
  (the first message with images then starts the agent just to ask and is refused with 422 if it cannot; afterwards the field says `false`). It is on the
  project, not on the `/v1/providers` entry (that file belongs to the providers work).
- Messages: the transcript carries `{type:"image", attachment_id, media_type, width, height, name?}` blocks (no bytes) in the user message. Images stay
  in context until compaction, which summarises from `[image: name, WxH]` placeholders (the summary also holds the model's own earlier description); an
  image whose bytes are gone degrades to the same placeholder. Window-mode memory keeps images of the current turn only. Exchanges in memory keep ids.
- `GET …/context` adds `images` (count in the next request) and `image_tokens` (width x height / 750, at most 1 600 each), inside the messages part.
- Cleanup: attachments are removed with the project; an attachment older than 30 days that no message and no queued message refers to is deleted (at
  start and daily). Schema 11 adds the `attachments` table and `queue.attachments`.

UI: paste/drop/pick → downsize on the client (longest side 2048 px, re-encode; originals never uploaded; ≤ 8, ≤ 5 MB after) → upload → chips with
thumbnails (`GET` blob) → send `attachments`; when `accepts_images === false` say so as soon as an image is attached; on 422 `images_unsupported`
keep the draft and show the message; render `image` blocks of user messages as thumbnails.
