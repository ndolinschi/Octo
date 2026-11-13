# Project sessions

A project holds **sessions**: conversations with the orchestrator (`kind: "main"`) and one session per sub-agent the
orchestrator spawned (`kind: "agent"`). Exactly one main session is **current**: it takes what is typed in the project's
composer. Spec: `docs/superpowers/specs/2026-11-12-project-sessions-design.md`. Code:
`internal/projectstore/{project_sessions,migrate_v13_sessions}.go` (store, schema 13), `internal/orchestrator/sessions.go`
(new, resume, stop, messages, reports), `internal/project/sessions.go`, `internal/bridge/sessions.go`.

All routes are under `/v1/projects/{id}`. Errors have the usual shape `{"error": {"code", "message"}}`.

## Session JSON

```json
{ "id": "ses_...", "kind": "main", "title": "Plan the release", "state": "idle", "model": "claude-sonnet-4",
  "started_at": "...Z", "last_activity_at": "...Z", "exchanges": 3, "children": 2, "current": true, "archived": false,
  "can_message": true }
{ "id": "ses_...", "kind": "agent", "parent_session_id": "ses_...", "agent_id": "agt_...", "turn_id": 412,
  "title": "Map the repository layout", "state": "working", "model": "claude-haiku", "started_at": "...", "last_activity_at": "...",
  "exchanges": 0, "children": 0, "current": false, "archived": false, "can_message": false,
  "message_blocked": { "code": "steer_unsupported", "message": "..." } }
```

- `state`: `working` (a turn runs in the current main session, or the agent runs), `waiting` (a main turn waits for an
  approval or a form), `idle`, `failed`, `stopped`. A main session's idle/failed/stopped is the outcome of its newest
  exchange; an agent session's follows its agent (`completed` is `idle`, `cancelled` is `stopped`).
- `title`: the first request's first line (80 characters) until the person edits it; an edited title is kept.
- `turn_id`: the user message of the turn that spawned an agent session; absent when the migration could not tell.
- `summary` (main, optional): what a `/clear` wrote when it ended the session.
- `can_message` / `message_blocked {code, message}`: main session: `can_message` is true for the current one, else
  `not_current` ("Resume this session to continue it"). Agent session: true while a built-in agent runs (steer) or when a
  finished agent can continue; otherwise the reason: `steer_unsupported` (an ACP agent is running), `not_running`,
  `not_continuable` (no stored conversation, no kept ACP session, agent unavailable), `builtin_loop_unavailable`.

## Routes

| Route | Result |
| --- | --- |
| `GET /sessions?kind=&state=&archived=&limit=&before=` | `{"sessions": [...]}` newest first (by `started_at`). `archived`: omitted/`false` hides archived, `true` only archived, `all` both. `limit` 1..200 (default 50), `before` a `started_at`. An empty main session is listed only while current. Agent sessions of rewound agents are not listed. 400 `invalid_request` for a bad `kind`, `state`, `archived` or `limit`. |
| `GET /sessions/{sid}` | `{"session", "exchanges": [...memory exchange shape...], "children": [session...], "agent"?: Agent}`; a main session has exchanges and children, an agent session its `agent` row (task, result, usage). 404. |
| `GET /sessions/{sid}/messages` | `{"messages", "compactions", "conversations"}` of that session: a main session's own orchestrator messages (with the compactions inside it and the clear that started it as its `conversations` marker), an agent session's messages. |
| `GET /agents/{aid}/messages?session_id=` | The same as above for the orchestrator `aid`: only that main session's part of the transcript. Without the parameter: unchanged (everything, with `/clear` markers). Messages carry `session_id`. |
| `POST /sessions` `{title?}` | 201 `{"session"}`: a new main session made current, the old one summarised and kept (this is `/clear`; `POST /clear` also creates one). 409 `turn_in_progress`. |
| `POST /sessions/{sid}/resume` | 200 `{"session"}`. Makes a main session current (unarchives it). Resuming the current one is a no-op. 409 `turn_in_progress`, 409 `not_main_session`, 404. |
| `PATCH /sessions/{sid}` `{title?, archived?}` | 200 `{"session"}`. 400 for neither field or an empty title; 409 `current_session` when archiving the current main session. |
| `DELETE /sessions/{sid}` | 204. Only a session that is not the current main one and has nothing running (it or a child agent). A main session: its exchanges (and their search entries), its messages, compaction rows and agent sessions go (their agents are hidden like a rewound one). An agent session: its transcript goes. 409 `current_session`, 409 `session_running` (it or a child runs). |
| `POST /sessions/{sid}/stop` | 200 `{"session"}`. The current main session: cancels the running turn. An agent session: cancels that agent only (the delegation returns "sub-agent stopped by the user" to the orchestrator). 409 `not_running`. |
| `POST /sessions/{sid}/messages` `{text, report_to_parent?}` | 202 `{"outcome": "steered"\|"continued", "session"}` (agent sessions only). 409 `not_agent_session` (a main session's messages use `POST /messages`), `steer_unsupported`, `not_running`, `not_continuable`, `builtin_loop_unavailable`; 400 for empty text. |

## Events

- `session.created {session}`: a new main session (new session, `/clear`) or a sub-agent's session.
- `session.updated {session}`: state, title, archive or counts changed; the current main session is announced when a turn starts
  and when it ends; an agent session follows `agent.updated`. `{session_id, deleted: true}` after a delete (one per removed session).
- A new (or `/clear`ed) session is announced after the clear released the project's turn slot, so its `state` is `idle`, never `working`: `working` comes from a running turn only.
- `session.current {session_id, previous_session_id}`: another main session became current (resume, new session, `/clear`).
- `memory.updated {session_id, deleted: true}` after a main session is deleted.

## Resume

Every orchestrator message and compaction row carries its main session. The built-in loop builds a request from the
current session's messages after its newest compaction or carry-over (a `/clear` carry-over belongs to the session it
starts), so resuming session A shows the model A's conversation and not the other sessions'. New messages join the
current session. An ACP orchestrator: the agent's own session id is kept per session; resume ends the live agent
process and the next turn calls `session/load` with the kept id when the agent advertised `loadSession`, else (or when the load
fails) opens a new agent session with the briefing and a recap built from that session's stored messages. Resuming and
creating a session are refused (409 `turn_in_progress`) while a turn runs; turns of different main sessions never run at the
same time (one queue per project). A conversation is one session until `/clear` or a new session: the 6 h rule of the
memory sessions only splits exchanges that were recorded without a session (old data, unit tests).

## Agent sessions

Created when `spawn_agent` creates the agent (also for a delegation refused before it started), linked to the main session
of the spawning turn and to that turn.

- **While it runs**: a built-in sub-agent takes the message at its next tool boundary as a user message of its own
  transcript (`outcome: "steered"`); text that arrives after its last boundary runs as a continuation once it settled. An ACP
  agent cannot take input in a running prompt: 409 `steer_unsupported`. The agent's final report is always the delegation's
  result, so `report_to_parent` adds nothing while it runs.
- **After it finished**: a built-in agent continues from its stored messages (`outcome: "continued"`); an ACP agent is
  started again and its kept session loaded with `session/load` (refused with `not_continuable` when it did not advertise it
  or the load fails). The run is detached from any turn (a turn's end does not cancel it); changes it makes are filed under
  the turn that spawned it.
- **`report_to_parent`**: when a continuation ends with an answer, a note is queued for the main session; at the start of its
  next turn it is stored as a user message with `command: "session_report"` before the request ("Results the user collected
  from sub-agent sessions ...") and, for an ACP orchestrator, put in the prompt. It never interrupts a running turn. The UI
  shows such a message as a quiet note.

## What carries over (`/clear` and "New session")

"New session" (`POST /sessions`) and `/clear` are one operation (`orchestrator.NewSession` calls `Clear`, `internal/orchestrator/clear.go`).
It is refused (409 `turn_in_progress`) while a turn runs. What a new session's first request is built from:

| Part | In the model's prompt? | Source |
| --- | --- | --- |
| **Summary of the session that ended** | Yes, as the first message (built-in loop) or in the first prompt (ACP). Written at the moment of the clear: by the model (fast tier), by the ACP agent in its live session (30 s), else built from the stored requests and answers ("summary unavailable"). Together with the titles of up to 5 open tasks and a pointer to `memory_search` / `recall_message` it is cut to 600 tokens (`CarryOverTokens`, `carryOver`). | `clear.go`, `history.go` (`loadHistory`), `acp_orch.go` (`recap`) |
| **Project settings**: name, description, custom instructions, folders, instruction files (built-in loop; an ACP agent reads its own), mode, access, model | Yes (system prompt / briefing) | `prompts.go` (`brief`, `orchestratorPromptParts`) |
| **Notes**: pinned notes whole (at most 3, 2 000 characters together) and an index `id · title - description` within 1 500 tokens | Yes | `prompts.go` (`notesBlock`) |
| **Remembered facts**, task records, memory files | **Not by default.** With the project setting `memory.context: "window"` the prompt also carries the memory index, the open tasks, the facts and the last exchanges (`memory.md`, M2). With the default `full` they are stored and searchable: the agent finds them with `memory_search` and `recall_message`. | `window.go`, `memory_tools.go` |
| **Earlier sessions** (exchanges, word for word) | **Not in the prompt.** Searchable (`memory_search`, `recall_message` with a session or exchange id). An ACP orchestrator in `full` mode and the `window` mode also get a three-line pointer to the previous session (title, date, count, id). | `memory/sessions.go` (`PreviousSessionPointer`) |
| **The conversation itself**: messages, tool results, approved plan text of the old session | **No.** The model starts without them; they stay in the session (Resume brings them back). | `history.go` |

Sub-agents never carry anything between sessions: each starts from its brief.

**How memory is recorded** (all automatic except the agent's own writes): after every finished turn the harness stores an
exchange (request and final answer as typed, redacted; M4) and indexes it; a task record is made when the turn did work
(M6), and a side model's digest adds facts to it (not possible without a side model or, for an ACP agent, a turn that
did work); the agent itself may call `remember` (at most 3 per turn) and `write_note`. A clear also closes finished tasks
and keeps unfinished ones open. Nothing is deleted by it.

**Deleting a session** keeps memory's task records and facts: `GET /tasks` marks a task whose session is gone with
`session_deleted: true` (computed on read, no schema change). Its exchanges and search entries are deleted with the session.

## Schema 13

`migrate_v13_sessions.go`. `sessions` gains `kind`, `parent_session_id`, `agent_id`, `state`, `model`, `title_edited`,
`archived`, `current`, `turn_id` and the kept ACP session (`acp_agent`, `acp_model`, `acp_session_id`); `messages` and
`compactions` gain `session_id`; table `session_reports`. Back-fill from 12: existing sessions are main, the newest is current,
orchestrator messages and compactions get the session whose first turn is the newest one not after them, and every sub-agent
gets an agent session linked to the session and the user message before its start time (without data, `turn_id` 0 under the
session that started before it, else the oldest).

Schema 14 (memory M6, `migrate_v14_tasks.go`) comes after this one: a database stamped 12 or 13 is migrated through 13 and then 14
(its task clean-up runs once for anything stamped below 14, after a `project.sqlite.pre-m6` backup). Task records carry the
`session_id` of the main session they started in.
