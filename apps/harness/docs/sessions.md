# Project sessions

A project holds **sessions**: conversations with the orchestrator (`kind: "main"`) and one session per sub-agent the
orchestrator spawned (`kind: "agent"`). Since schema 15 (parallel sessions, phase 1) **every main session is addressable and
independent**: it has its own root agent, conversation, turn slot, queue, approvals and forms, ACP process and MCP token, and
several main sessions of one project can run turns at the same time, within the running caps. Exactly one main session is the
**default**: it takes what is sent to the project without a session (`POST /messages` and the other project routes below).

Parallel sessions and worktrees (phase 1 built; a session can be moved into a new git worktree (`POST /sessions/{sid}/worktree`; its body is `{base_ref, carry_changes}`); no
coordination tools, every session's memory mode is `on`). Code: `internal/projectstore/{project_sessions,
migrate_v13_sessions,migrate_v15_parallel_sessions,queue,session_settings}.go`, `internal/orchestrator/{orchestrator,queue,slots,
sessions,clear,recover}.go`, `internal/project/{sessions,parallel}.go`, `internal/bridge/sessions.go`.

All routes are under `/v1/projects/{id}` unless they start with `/v1/sessions`. Errors have the usual shape
`{"error": {"code", "message", ...}}` (`errors.md`).

## Root agents

Every main session runs on its own **root agent** (an agents row with `parent_id: null` and `session_id` = the session). Its
sub-agents carry the same `session_id`. Messages, compactions, the `/clear` carry-over, partials, context receipts, usage and the
kept ACP session are keyed by agent, so a root per session keeps each session's conversation apart. The default session's root
is the project's `orchestrator_agent_id` (`GET /projects/{id}`); it changes when the default changes, and `project.updated` is
published then. `GET /agents` lists every root; `GET /agents/{aid}/messages` works for any root.

## Session JSON

```json
{ "id": "ses_...", "kind": "main", "title": "Plan the release", "state": "idle", "model": "claude-sonnet-4",
  "started_at": "...Z", "last_activity_at": "...Z", "exchanges": 3, "children": 2, "default": true, "current": true,
  "archived": false, "root_agent_id": "agt_...", "workspace": {"id": "shared", "kind": "shared", "title": "Main checkout"},
  "memory": "on", "memory_inherited": true, "mode": "", "queued": 0, "queue_paused": false,
  "needs_you": false, "pending_approvals": 0, "pending_inputs": 0, "can_message": true }
{ "id": "ses_...", "kind": "agent", "parent_session_id": "ses_...", "agent_id": "agt_...", "turn_id": 412,
  "title": "Map the repository layout", "state": "working", "model": "claude-haiku", "started_at": "...", "last_activity_at": "...",
  "exchanges": 0, "children": 0, "default": false, "current": false, "archived": false, "mode": "", "queued": 0,
  "queue_paused": false, "needs_you": false, "pending_approvals": 0, "pending_inputs": 0, "can_message": false,
  "message_blocked": { "code": "steer_unsupported", "message": "..." } }
```

- `state`: `working` (a turn of this main session runs, or the agent runs), `waiting` (the turn waits for an approval or a form
  of this session), `queued` (a main session whose messages wait for a free slot), `idle`, `failed`, `stopped`. A main session's
  idle/failed/stopped is the outcome of its newest exchange; an agent session's follows its agent.
- `default`: the session that takes unaddressed messages; `current` is its old name, with the same value, for one release.
- `root_agent_id` (main): its root agent ("" for a session made before schema 15 that never held a message; it gets one when it is
  first addressed). `workspace`: always the shared workspace in phase 1. `memory`: `on` (modes `read`/`off` are phase 5);
  `memory_inherited`: it equals the project's default for new sessions. `mode`: the session's mode, "" for the project's.
  `model`: the session's chosen orchestrator model, else the model of its newest exchange or of its root.
- `queued` / `queue_paused`: the session's own queue. `needs_you`, `pending_approvals`, `pending_inputs`: what waits for the
  person in this session.
- `can_message` / `message_blocked {code, message}`: a main session can always take a message unless the built-in loop it needs is
  unavailable (`builtin_loop_unavailable`); `not_current` is no longer produced. Agent session: true while a built-in agent runs
  (steer) or when a finished agent can continue; otherwise `steer_unsupported`, `not_running`, `not_continuable`,
  `builtin_loop_unavailable`.

## Routes

| Route | Result |
| --- | --- |
| `GET /sessions?kind=&state=&archived=&limit=&before=` | `{"sessions"}` newest first (by `started_at`). `state` also takes `queued`. A main session without exchanges is listed while it is the default or has a root agent. |
| `GET /sessions/{sid}` | `{"session", "exchanges", "children", "agent"?}`. A failed exchange carries `error {code, message, hint?}` (`memory.md`). |
| `GET /sessions/{sid}/messages` | `{"messages", "compactions", "conversations"}`: a main session's messages (its root's), with its markers and the clear that started it. |
| `POST /sessions` | Body `{title?, workspace?: {kind: "shared"} \| {id: "shared"}, memory?: "project"\|"on"\|"read"\|"off", model?, mode?, make_default?, text?, from_session_id?, clear?}` → 201 `{"session", "message"?, "queued"?, "waiting_for"?}`. Without `clear`: an empty session (no carry-over) with its own root, **not the default unless `make_default`**. With `clear: true` it is `/clear` of `from_session_id` (absent: the default). `text` sends the first message. 404 `workspace_not_found`, 409 `worktree_unavailable` (`kind: "worktree"`: phase 3), 409 `turn_in_progress` (clear of a running session). |
| `POST /sessions/{sid}/messages` | Main session: `{text, mode?, attachments?}` → 202 `{"message"}` or 202 `{"queued", "waiting_for": "turn"\|"slot"}`; an archived session is unarchived; 409 `queue_full`, 422 `images_unsupported`. Agent session: `{text, report_to_parent?}` → 202 `{"outcome", "session"}` as before. |
| `POST /sessions/{sid}/stop` | Main session: cancels its turn (its queue is paused by the cancel). Agent session: cancels that agent only. 409 `not_running`. |
| `GET /sessions/{sid}/queue`, `DELETE /sessions/{sid}/queue`, `PATCH`/`DELETE /sessions/{sid}/queue/{qid}`, `POST /sessions/{sid}/queue/resume`, `POST /sessions/{sid}/queue/{qid}/send-now` | The queue routes for one session (`{paused, messages, session_id}`; a message of another session is 404). |
| `POST /sessions/{sid}/default` | 200 `{"session"}`: makes it the default. Nothing is stopped or rebuilt, never `turn_in_progress`; an archived session is unarchived. `session.default`, `session.current` and `project.updated` follow. `POST /sessions/{sid}/resume` is an alias. 409 `not_main_session`. |
| `PATCH /sessions/{sid}` | `{title?, archived?, memory?, model?, mode?}`; `memory`, `model` and `mode` (main sessions) apply from its next turn. 409 `current_session` when archiving the default. |
| `DELETE /sessions/{sid}` | 204. Not the default (409 `current_session`), not while it or a child runs (409 `session_running`). Its root is hidden like a rewound agent, its queue and ACP process go. |
| `DELETE /sessions` | 200 `{"deleted_sessions", "projects"}`. Deletes every session and conversation in the project and starts a fresh empty default session, keeping notes, memory, and settings. 409 `session_running` while any session in the project runs or waits. |
| `GET /sessions/{sid}/context`, `POST /sessions/{sid}/compact`, `POST /sessions/{sid}/rewind`, `GET /sessions/{sid}/plans/latest`, `GET /sessions/{sid}/export?format=md` | The project routes of the same name for one session. A rewind restores and cuts only that session's changes, messages, agents and tasks. |
| `POST /sessions/{sid}/clear` | `/clear` of that session; answers like `POST /sessions` with `clear` (201 `{"session"}` = the new session). |
| `POST /sessions/import` | Body `{"sessions": [{"provider", "id"}]}` → 200 `{"imported": [ProjectSession...], "skipped"}`. Imports conversations from local external AI CLI stores into the project; already-imported sources (tracked via `reason = "import:<provider>:<id>"`) are skipped. |
| `GET /changes?session=`, `GET /approvals?session=`, `GET /inputs?session=` | Filters; change turns, approvals and forms carry `session_id`. |
| `GET /v1/sessions?kind=main&state=&archived=&limit=&before=` | Main sessions across projects, newest activity first (`last_activity_at`; `before` pages by it), each with `project_id` and `project_name`; `limit` 1–200, default 100. |
| `DELETE /v1/sessions` | 200 `{"deleted_sessions", "projects"}`. Pre-checks all projects for any running or waiting session (`409 session_running`), then deletes every session across every project and resets each project to a single fresh empty default session. |
| `GET /v1/sessions/importable` | `{"sessions": [...]}`. Scans `~/.claude/projects`, `~/.codex/sessions` (and `archived_sessions`), `~/.gemini/tmp`, and `~/.local/share/opencode/storage` (`internal/sessionimport`), matching `cwd` against project folders and marking `already_imported`. |

**Compatibility aliases.** `POST /messages`, `POST /cancel`, `GET/DELETE /queue`, `PATCH/DELETE /queue/{qid}`,
`POST /queue/resume`, `POST /queue/{qid}/send-now` (any session's message), `POST /clear`, `POST /compact`, `POST /rewind` (the
session the request belongs to), `GET /context`, `GET /plans/latest` and `GET /export` act on the **default** session.
`POST /cancel?all=true` stops every session of the project. The UI of before schema 15 keeps working through them.

## Branches of the main checkout (UI decision 100, 2026-11-19)

The composer's branch chip and picker. Code: `internal/project/branches.go`, `internal/gitx/{switch,branches}.go`,
`internal/bridge/workspaces.go`; tests `internal/bridge/branches_test.go` (real temporary repositories), `internal/gitx/switch_test.go`.

| Route | Result |
| --- | --- |
| `GET /branches?workspace=&folder=&q=&offset=&limit=` | `{"workspace", "running_sessions", "repos": [RepoBranch]}`. One entry per git repository of the workspace's folders (absent `workspace`: `shared`, the main checkout; a worktree's id reads its own folders), in folder order; folders of one repository share an entry; folders outside git are left out (`repos: []` when none is in git). `folder` (id or label) narrows to that repository. Each entry's `branches` is a chunk (`limit` default 30, at most 100, from `offset`) of the local branches whose name contains `q` (case-insensitive; the filter runs before the 200-branch cap), the current one first, then by last commit; `total` counts the matches and `next_offset` is set while more remain. `running_sessions`: main sessions of that workspace that work or wait. Read only. 400 `invalid_request` (bad `offset`/`limit`), 404 `workspace_not_found`, 409 `not_a_git_repository` (`folder` outside git). |
| `POST /branches/switch` | Body `{branch, folder?, create?}` → 200 `{"repo": RepoBranch}` (after the switch). The main checkout's repository of `folder` (absent: the first git folder): `git switch --no-guess <branch>`, or with `create` `git switch -c <branch>` from the current commit. Refused with nothing changed, in this order: 400 `invalid_branch_name`, 409 `branch_exists` (create), 404 `branch_not_found`, 409 `checkout_in_use` (a main session of the shared workspace works or waits), 409 `uncommitted_changes` (staged or unstaged changes to tracked files; untracked files do not count), 409 `branch_switch_failed` (git refused; its text in `details`), 409 `not_a_git_repository`. The three 409s about the checkout carry `action: "use_worktree"`: the alternative is `POST /sessions {workspace: {kind: "worktree", base_ref: <branch>}}` (or `POST /sessions/{sid}/worktree {base_ref}`), which never touches the main checkout. Never forces, stashes, discards or commits. |

RepoBranch: `{folder_id, folder, folders, repo_root, repo_name, branch ("" when detached), detached, head (short commit),
dirty_files, branches: [{name, current, ahead, behind, commit: {sha, subject, date}}], total, next_offset?, truncated?}`
(`ahead`/`behind` against HEAD). No event is published: a client reads the branch again on focus, after a turn and when
its picker opens. Remote devices may read the list; the switch is denied to them (`remoteaccess/rules.go`).

`GET /workspaces` no longer hangs once a worktree workspace exists (the list queried each worktree's folders while its own
rows were still open on the store's single connection).

## Running caps and queues

- A turn starts only while the project runs fewer than `session_settings.max_running` turns (project setting, 1–8, default 3;
  `PATCH /projects/{id} {"session_settings": {"max_running": n}}`) and the harness fewer than `HARNESS_MAX_RUNNING_SESSIONS`
  (1–32, default 6). Otherwise the message waits in its session's queue with `waiting_for: "slot"` and the session is `queued`.
  Free slots go to the waiting messages in the order they were queued, across sessions and projects. Sub-agents do not count.
- Each main session has its own queue (at most 20 messages, 409 `queue_full`) and its own pause (`sessions.queue_paused`): a
  failed or cancelled turn pauses that session's non-empty queue; a crash pauses every non-empty queue.
- A turn that cannot wait in a queue (approving a plan, `/compact` sent to an agent) is 409 `session_slots_full` at the cap.
- The budget gate runs before every model request of every session; parallel requests already in flight can overshoot by one
  request per running agent. Each such request is bounded by the output cap (`architecture.md`, Budget).

## Events

Every event about a session's work carries `session_id`: `message.*`, `tool.*`, `agent.*` (and the agent row's `session_id`),
`turn.finished` (also `agent_id` = the session's root), `queue.updated`, `approval.*` and `input.*` (the items' `session_id`),
`context.updated`, `plan.*`, `conversation.*`, `session.*`. The project stream keeps one `seq`.

- `session.created {session}`, `session.updated {session}` (state, title, archive, queue, counts; `{session_id, deleted: true}`
  after a delete), `agent.created {agent}` for a new session's root.
- `session.default {session_id, previous_session_id}`, then `session.current` with the same fields (old name), then
  `project.updated {project}` (its `orchestrator_agent_id` is the new default's root).
- `project.attention` gains `sessions: [{session_id, needs_you, approvals, inputs, failed}]`; the project summary gains
  `sessions: {total, running, queued, needs_you, failed}` and `status` is `running` while any session runs.

## What carries over (`/clear`)

`/clear` of session S (`POST /clear` for the default, `POST /sessions/{sid}/clear`, `POST /sessions {clear, from_session_id}`)
creates a new main session with its own root, S's workspace and memory mode, and S's carry-over as the first thing its history
holds; the new session is the default when S was. S keeps its whole conversation and can be opened and continued. It is refused
(409 `turn_in_progress`) while S runs; other sessions are untouched. "New session" without `clear` starts empty.

| Part | In the model's prompt? | Source |
| --- | --- | --- |
| **Summary of the session that ended** | Yes, as the first message (built-in loop) or in the first prompt (ACP). Written at the moment of the clear: by the model (fast tier), by the ACP agent in its live session (30 s), else built from the stored requests and answers. With the titles of up to 5 open tasks and a pointer to `memory_search` / `recall_message`, cut to 600 tokens. | `clear.go`, `history.go`, `acp_orch.go` |
| **Project settings, notes** | Yes (system prompt / briefing) | `prompts.go` |
| **Remembered facts, task records, memory files** | Not by default; with `memory.context: "window"` yes (`memory.md`) | `window.go`, `memory_tools.go` |
| **Earlier sessions** | Not in the prompt; searchable | `memory/sessions.go` |

## ACP orchestrator

Each main session has its own agent process and MCP token (bound to the project, the session and its root;
`acp-orchestrator.md`). The agent's session id is stored on the session's root; a session's next turn continues its live process,
or uses `session/load` (when advertised) or a recap from that session's messages after the process ended.

## Agent sessions

Unchanged from schema 13: created when `spawn_agent` creates the agent, linked to the main session of the spawning turn and to
that turn; steered while a built-in agent runs, continued after it finished, `report_to_parent` leaves a note for the main
session's next turn. A sub-agent stopped with its turn has its interrupted tool calls closed with the interruption result at
the stop, and a stop kills a running `bash` command's whole process group.

## Crash recovery

At start every main session whose root was left running is closed on its own: its streamed text is kept as a stopped message, its
root is idle with the `turn_interrupted` error, its exchange is recorded `failed`, `interrupted` and with `error`; every
non-empty session queue is paused. The error's hint says whether text was kept ("What it had written before the restart is
kept" only then; "Nothing had been written yet" otherwise) and the exchange's `kept_text` says the same.

**An unanswered request is closed for the model (NEW-8).** A request whose turn ended failed, stopped or interrupted
before any assistant message is followed in storage directly by the next message. When the harness builds a model's
context it puts, after such a request, an assistant-side note: "[Octo: the request above was not carried out; <why>. Do
not do it or continue it now: answer only the message that follows. If the person wants it done, they will ask again.]"
(`orchestrator/closed.go`; `<why>` names the restart, the failure or the stop). It is added in the full history
(`loadHistory`), in the window mode's recent exchanges, and for an ACP orchestrator at the start of the next prompt
(quoting the unanswered request, which the agent may hold in its own session). The note is never stored: messages,
exchanges, search and exports are unchanged, and a client has nothing new to render. It is added only when another
message follows the request, so Retry (the same text sent again, which runs the stored request again) sends the
request alone, once.

**Session state after a turn (NEW-10).** `session.updated` is published again after `turn.finished`, with the state as it
is then (idle, failed, stopped or queued); the one published while the turn was ending still said `working`.

## Schema 15

`migrate_v15_parallel_sessions.go`. Columns: `sessions.workspace_id`, `memory_mode`, `mode`, `queue_paused`, `root_agent_id`;
`agents.session_id`; `queue.session_id`, `waiting_for`; `changes.session_id`, `workspace_id`, `attribution`;
`command_runs.workspace_id`; `plans.session_id`; `exchanges.private` (and `exchanges.error_json`, added with the table);
`search_docs.session_id`. Tables (used by later phases): `workspaces` (row `shared`), `workspace_folders`, `session_declarations`,
`file_claims`, `session_messages`. Project setting `sessions` (`session_settings` in the project JSON).

Back-fill, once, for a database stamped below 15: when any main session other than the current one holds messages, a backup
`project.sqlite.pre-v15` is written first (numbered when taken). Then, in one transaction: the current session is the default and
keeps the orchestrator row as its root; every other main session with messages gets a new root (role, model, tier copied, status
`completed`) and its messages, compactions, kept ACP session and sub-agents move to it; `agents.session_id` is filled through the
agent sessions and the parent chain; queued messages go to the default (with the project's pause); changes and plans get the
session of their turn's user message; search documents the session of their exchange or message. Usage rows are not moved.
Opening it again changes nothing. A binary of schema 14 refuses a database stamped 15 (it is left untouched); going back means
restoring `project.sqlite.pre-v15` while the harness is stopped.
