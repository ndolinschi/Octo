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
- Event `context.updated {"project_id"}` after every turn, after a compaction (manual or automatic), after a rewind, when a project note changes and when an
  instruction file (`AGENTS.md`/`CLAUDE.md`) is written through the file API or by an agent; refetch the report.
