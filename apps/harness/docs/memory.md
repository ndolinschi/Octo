# Orchestrator memory (M1, M2, M4)

Design: [`docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md`](../../../docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md). M1 is the store, the tools, the search and the API; M2 (below) is how the orchestrator's context is built from it, off by default (`memory.context: "full"`).

Code: `internal/memory` (service: limits, redaction, tools, digest, search shaping), `internal/projectstore/{tasks,search,memory_testing}.go` (SQL, FTS5), `internal/orchestrator/memory_tools.go` (tools, post-turn digest), `internal/project/memory.go` and `internal/bridge/memory.go` (API).

## What is stored

- **Task records** (`tasks`). Made at the END of a turn that did work or set a goal (M6, below), never when a request arrives; `goal_by` is `digest`, `orchestrator` or `rule` (the request minimally rewritten without a model; `harness` only on old tasks that the clean-up kept). Fields: `status` (`open`, `done`, `dropped`), `goal`, `constraints[]`, `acceptance[]`, `quotes[] {text, message_id}`, `decisions[]`, `outcome`, `files[]`, `facts[] {id, text, date, message_id, superseded_by?}`, `message_ids[]`, timestamps, and since M6 `state_summary`, `open_questions[]`, `unfinished`, `closed_reason?`, `session_id?`, `exchange_ids[]`. Limits: title 120, goal 1000, outcome 2000, an item 500 characters, 50 items per list, 200 facts.
- **Memory files**: markdown, path of at most 80 characters ending in `.md`, at most 64 kB, at most 500 files. **Decision (the spec said "files under {project}/memory/"):** they live in `project.sqlite` (`memory_files`), not on disk, so a write and its index entry are one transaction and path confinement cannot be got wrong. `INDEX.md` is generated from the summaries on `view`; it cannot be written.
- **Search index**: `search_docs` plus two FTS5 tables (`search_u` `unicode61 remove_diacritics 2`, `search_t` `trigram`), filled in the same transaction as the write. Documents: each task record, each fact, each memory file, and every user and assistant message text of the project (tool output is not indexed). A database that predates the index (schema 1) is indexed at its first open (a migration to schema 2; M2 below made the schema version 3: the memory setting and the context receipts; the live-activity work made it 4: the agent's `plan`).

The SQLite driver (modernc) has FTS5 and both tokenizers; tested. `unicode61` folds case in Cyrillic but does no Russian stemming.

## Search

`memory_search {query, in?: ["tasks","facts","files","messages"], after?, before?, limit?}`; API `GET /v1/projects/{pid}/memory/search?q=&in=facts,messages&after=&before=&limit=`.

1. The query is split into words. **Exact index**: all words as whole words (case-insensitive). **Trigram index**: each word's *stem* as a substring: a word of 5 to 7 characters loses its last 2, a longer one its last 3, a shorter one is used whole (so "бюджета" and "бюджетом" find "бюджет"; a Russian ending longer than 3 letters is not covered). Exact hits come first, then the trigram ones.
2. If all words match nothing and there are several, the significant words (at least 4 characters, not a stop word) are tried with "any", and a document is kept only if at least half of them occur in it.
3. A hit is `{kind: task|fact|file|message, id, title, snippet (at most 300 characters around the match), date, superseded?, message_id? (the message a fact came from), task_id?}`; at most 10. **Superseded facts come after current ones**; `after` is inclusive and `before` exclusive on the date of the document (the message time, the fact date, the task's last update, the file's last write); both take `YYYY-MM-DD` or a timestamp.
4. With no hit the result is `{hits: [], message: "nothing in memory matches"}`; the tool says so verbatim so the model can answer "I don't know" instead of guessing.

`recall_message {id}` returns `{id, role, agent_id, date, text, truncated}`: the message text exactly as stored (text blocks joined by a newline), cut at 8 kB on a character boundary with `truncated: true`.

## Tools (built-in orchestrator and, over the harness MCP server, an ACP orchestrator)

| Tool | Does |
| --- | --- |
| `task_update {id?, title?, status?, goal?, add_constraints?, add_acceptance?, add_quotes?, add_decisions?, outcome?, files?}` | Updates this turn's record (or the open task named by `id`: the message is attached to it and the harness-opened record is dropped if untouched). Lists only grow. A quote must be an exact substring of the user's request, else the call is refused. Sets `auto: false`, and `goal_by: "orchestrator"` when it sets the goal. |
| `memory {command: view|create|str_replace|insert|delete|rename, path, ...}` | The semantics of Anthropic's memory tool. `create` needs a one-line `summary` and refuses an existing path; `str_replace` needs exactly one occurrence; `view /memories` lists files with their summaries; `view` of a file numbers its lines (`view_range`). Paths are confined (no `..`, no hidden or empty segments, no backslash, a leading `/memories/` is accepted). |
| `memory_search`, `recall_message` | As above. |

Refusals are tool errors the model can read (`is_error`), never failures of the turn. The orchestrator's system prompt (and the ACP briefing) names the tools in one sentence.

## The post-turn digest

After a **completed** turn the harness makes one call to the project's side model (fast tier by default, `models.side` overrides), with no tools, capped input (the request up to 6 000 characters, the reply up to 4 000, the record so far, and up to 20 current facts of other tasks), off the request path in a goroutine under the orchestrator's wait group; a failure only logs (`memory digest failed`). Its usage is recorded with `role: "digest"` (not in the agent's token totals). It returns JSON: goal, constraints, acceptance, quotes, decisions, outcome, facts `{text, supersedes}`. Applied by `ApplyDigest`, which **only fills and adds**: the goal is replaced only while it is the harness's fallback or an earlier digest's; the outcome only while empty; lists grow, deduplicated; a quote is kept only if it occurs in the user's request; a fact that duplicates a current one is skipped; a fact with `supersedes` marks the best matching current fact (same text, else at least half the words in common, in this task or any other) `superseded_by` the new one, which keeps its text and date. Nothing the user or the orchestrator wrote is changed or deleted. M6: with no side model (no API key) an ACP orchestrator that did work is asked for the digest in its live session instead (see below); otherwise a minimal record is built from the facts the harness has.

## API and events

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/tasks` | `{ "tasks": Task[] }`, newest update first |
| GET | `/v1/projects/{pid}/memory` | `{ files: [{path, summary, size, created_at, updated_at}], index }` (the generated INDEX.md text) |
| GET | `/v1/projects/{pid}/memory/{path...}` | the file with `content` |
| PUT | `/v1/projects/{pid}/memory/{path...}` | body `{content, summary?}` (the summary is required for a new file) → the file; `400` for an invalid path, size, count |
| DELETE | `/v1/projects/{pid}/memory/{path...}` | `204`, `404` |
| GET | `/v1/projects/{pid}/memory/search?q=...` | `{hits, message?}` |

Events: `task.updated {task}` (or `{task_id, deleted: true}` when a harness-opened record was merged into another task), `memory.updated {path, deleted?, renamed_from?}`.

## Secrets

Everything that is stored or indexed passes the project's secret redactor first: task fields, facts, digest output, memory files (the tool and the API), the summaries, the search query, and the text of messages when they are indexed (the index holds `[secret]` where a stored secret value was). A test puts a secret value into a user request, task_update, a digest, a memory file and the API, then scans the task records, the file list and index, every file, every search result for several queries, and the raw index tables. **Not covered:** the transcript itself keeps the user's own message as typed (existing behaviour; a key typed into the composer is the UI's to catch), and a secret the agent re-encodes.

## Context assembly (M2)

Project setting `memory: {context: "full" | "window", recent_exchanges: 1..20 (default 5)}` (create and `PATCH`, partial updates merge; project JSON always has it, `full` and 5 for projects that predate it). **`full` is the default and is today's behaviour** (the whole transcript after the latest compaction summary). Switching in either direction changes only what the next request is built from; no message, task, fact or file is touched.

**Window mode** (built-in orchestrator; sub-agents and side questions are never affected). The orchestrator's request is assembled, each block capped in tokens (four characters a token), stable blocks first:

| Block (receipt name) | Cap | Content |
| --- | --- | --- |
| briefing, project brief, pinned notes | as today | the system prompt, unchanged |
| `memory_index` | 1 500 | "only the recent exchanges are shown; use memory_search / recall_message" plus the memory files with their summaries |
| `open_tasks` | 3 000 | open task records newest first (id, title, goal, constraints, acceptance, decisions, quotes with their message ids), then done tasks of the last 7 days as one line each |
| `recent_window` | 12 000 | the last N user messages **verbatim** each with the orchestrator's replies, every tool call reduced to one line (`[called spawn_agent <title>: <first 120 characters of the result>]`); a message over its share of the cap is cut with `…[cut]`; the window shows **at least the last N exchanges and advances N at a time** (between N and 2N-1 exchanges, see below) |
| `facts` | 1 500 | current (not superseded) facts of open tasks, newest first, with dates |
| `current_turn` | none | the current user message and everything after it, verbatim |

Messages: the `memory_index` block is a text block at the front of the first user message (merged into the first window message, so roles alternate); the `open_tasks` and `facts` blocks (which change every turn) are text blocks in front of the current user message, after the window. The receipt lists the blocks in that order: `memory_index`, `recent_window`, `open_tasks`, `facts`, `current_turn`.

**The window steps (live run 2).** With k earlier exchanges and N = `recent_exchanges` the window starts at exchange `0` while k <= N, else at `N * floor((k - N) / N)`: it holds N to 2N-1 exchanges, and its first exchange stays the same for N turns in a row. Each message is cut to a fixed share of the cap (sized for 2N-1 exchanges), so its text never changes either. Everything before the current turn is therefore byte for byte what the previous request carried until the window steps, which is what a provider's prompt cache needs (a window that slid one exchange per request changed the first message every time: on a real caching provider `window` cost 15% more than `full`, with 2.2 times the uncached input). `window` stays opt-in. A test (`TestWindowAdvancesInStepsSoThePrefixStaysTheSameBetweenSteps`) checks the prefix over 11 turns: identical between steps, changed exactly at the two steps. Older history is not sent at all; an earlier compaction summary is ignored in this mode (compaction by the router inside the running turn still works). Exchange = a user message with text plus everything until the next one.

**Tool-result clearing, in both modes.** Before each request of the **orchestrator's** loop, when system + tools + messages are estimated above 60% of the model's window, tool results older than the last 5 are replaced, in the copy that is sent, by `[cleared: read_file src/x.go, 412 lines]` (tool name, its path/command/title/query, size in lines or bytes). Stored messages are never changed. It happens before any compaction is considered and is idempotent (a stub stays a stub). The window is the configured one (`HARNESS_CONTEXT_WINDOWS`); **the table is empty by default, so 200 000 tokens is assumed** for this purpose. Sub-agents do not clear.

**ACP orchestrators.** A *new* session's first prompt (recap) uses the same assembly in window mode (rendered as text: memory, tasks, `## Recent exchanges`, facts), replacing the "last 40 texts" recap; `full` keeps the recap. A *live* session owns its context and is not rewritten: in window mode each request carries, in front of the user request, the open task records whose `updated_at` is after the session's last turn (except this request's own record). The session is told nothing when nothing changed.

**Context receipt.** Each orchestrator turn stores a receipt, `GET /v1/projects/{pid}/turns/{turnId}/context` (turn id = the id of the user message that started it; `404` for turns from before receipts, which is what an upgraded project has for its old turns):

```json
{ "turn_id": 412, "mode": "window", "recent_exchanges": 5,
  "blocks": [ {"name": "memory_index", "tokens": 120, "cap": 1500, "count": 3, "ids": ["notes/arch.md", "..."]},
              {"name": "open_tasks", "tokens": 840, "cap": 3000, "count": 4, "ids": ["tsk_..."]},
              {"name": "recent_window", "tokens": 5300, "cap": 12000, "count": 5, "ids": ["<first message id of each exchange>"]},
              {"name": "facts", "tokens": 210, "cap": 1500, "count": 9, "ids": ["tsk_.../f2"]},
              {"name": "current_turn", "tokens": 31, "cap": 0, "count": 1, "ids": ["412"]} ],
  "total_tokens": 6501, "caps_total": 18000, "message_count": 13, "cleared_calls": 0, "created_at": "..." }
```
It describes the **first request of the turn** (tool rounds add to the current turn; `cleared_calls` is updated as requests clear results). `full` mode has one block, `history` (tokens, message count). A live ACP session's receipt has `changed_tasks` and `current_turn`. `GET /v1/projects/{pid}/context` (the size breakdown) shows the assembled window in window mode.

## Not built (M3)

The UI view, embeddings, cross-project memory.

## Task records over a turn (live run 2; replaced by M6 below where they differ)

- **`files`** is filled from the turn's tool calls: `read_file`/`write_file` paths of the built-in tools, and for ACP the locations of `read`, `edit`, `delete` and `move` tool calls (relative to the project folder when inside one), at most 50 per record.
- **Russian search.** A third FTS5 index, `search_s`, holds every document as stems: the Russian Snowball algorithm (pure Go, `projectstore/stem_ru.go`, no module), ё folded to е, and the fleeting о/е before a final consonant dropped (so `скобок` and `скобками` share a stem). Queries are stemmed the same way and the stem index is searched after the exact index and before the trigram one, so `калькуляторами` finds `калькулятор`, `скобками` finds `скобок`, `молдове` finds `Молдовы` and `Кишинев` finds `Кишинёв`. Only words with Cyrillic letters are stemmed. A database from before schema 5 is indexed when it opens.

## Notes as Markdown with descriptions (M5)

A project note is a Markdown document with front matter (`title`, `description` of at most 200 characters, `tags`,
`pinned`, and the harness's `id`, `created_at`, `updated_at`, `last_read_at`, `read_count`). The orchestrator's prompt holds
only an index, `id · title — description [tags]`, within 1 500 tokens (pinned first, then the most recently read or
changed; the rest as "N more notes — use search_notes"), plus pinned notes whole (at most 3, 2 000 characters together).
Tools: `read_note {id}`, `search_notes {query, limit?}`, `write_note {id?, title, description, body, tags?}` (refused in ask
and plan modes). API: `GET/POST /v1/projects/{id}/notes`, `GET/PATCH/DELETE .../notes/{nid}`, `GET .../notes/{nid}/export`;
create and update take fields or `markdown`; a parse error is a 400 with the line. Full contract: the M5 section of
`docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md`.
## Sessions: what was asked and what was answered (M4)

Code: `internal/projectstore/{sessions,migrate_v12_sessions}.go` (SQL, schema 12), `internal/memory/sessions.go` (service), `internal/orchestrator/exchanges.go` (the post-turn write), `internal/bridge/memory_sessions.go` (API).

- **An exchange is written for every finished orchestrator turn**, completed, failed or stopped, right after the turn settles and before the digest (not by it, so it needs no side model). It holds the request as typed and the final answer: the last assistant text of the turn read from the stored messages (tool chatter is not part of it; for a failed or stopped turn, what had been said so far; empty when nothing was). Both pass the secret redactor. The answer is cut at 64 KiB on a character boundary, `answer_truncated: true` and the text ends with `[answer cut: it was longer than 64 KiB]`. A turn is recorded once: a retry of a failed turn replaces its record in place (same `id`).
- **Fields filled from the turn:** `model` (the orchestrator's model or ACP agent as the agent row shows it after the turn), `duration_ms` (from the request message's time), `files` (distinct paths of the changes ledger for the turn, at most 50), `agents` (titles of the sub-agents created during the turn), `tokens` and `cost_usd` (the usage rows since the request, the agents' own and the router's classifier calls, not digest or side calls; flat-rate rows add tokens but no cost; `cost_usd` is `null` when no cost was reported), `task_id` (the turn's task record when it still exists).
- **Sessions.** The first exchange opens a session titled with the request's first line (80 characters). The next one joins the latest session unless it is closed or ended more than **6 hours** before the request started, then it opens a new one. A session is closed by `/clear` and by a rewind that cut every request (reason `clear` / `rewind`). Exchanges survive both, as the record. Hook for `/clear`: `(*memory.Service).StartSession(ctx, "clear")` (the orchestrator's `Memory(ctx, pid)` returns the service); it closes the latest open session, does nothing when none is open, and publishes `memory.updated {session_boundary}`.
- **Back-fill.** Opening a database older than schema 12 builds sessions and exchanges from the orchestrator's stored messages (rewound ones left out): each user message with text starts an exchange, the last assistant text before the next one is its answer, `failed` when there is none, `stopped` when that message was cut short; `model` is the orchestrator's current model, `files` come from the ledger, tokens, cost and sub-agents stay empty. Sessions follow the 6 h rule, and a `/clear` found in the stored compactions also ends a session (its summary stays on it).
- **Search** indexes each exchange (title = the request's first line, body = request and answer) in all three FTS5 indexes, Russian stems included. `in` takes `exchanges`; with `in` empty exchange hits are included and a message hit that an exchange hit already shows (the request or the answer message) is dropped.
- **Forget** deletes the texts and the search entries and leaves a marker; recording the same turn again does not bring it back.
- **The orchestrator** reads it with `recall_message` `{exchange_id}` (request and answer, each cut at 8 kB, `truncated`) or `{session_id}` (the first 40 exchanges, request cut at 200 and answer at 300 characters, with the exchange ids). In window mode the memory index block, and in the ACP recap of a new session, carry a three-line pointer to the session before the current one (title, date, count, id, how to recall). Full mode keeps the whole transcript and adds the pointer only to the ACP recap.

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/memory/sessions?limit=&before=` | `{ "sessions": Session[] }`, newest first; `limit` 1 to 200 (default 50); `before` is a `started_at` to page from; `400` for a bad limit |
| GET | `/v1/projects/{pid}/memory/sessions/{sid}` | `{ "session": Session, "exchanges": Exchange[] }` in order; `404` for an unknown session |
| DELETE | `/v1/projects/{pid}/memory/exchanges/{eid}` | `204`; `404` for an unknown exchange |

```json
{ "id": "ses_...", "title": "Harden the login flow", "started_at": "2026-11-12T09:00:00.000Z",
  "ended_at": "2026-11-12T09:41:12.000Z", "exchanges": 5, "open": true, "reason": "clear" }
```
`exchanges` counts exchanges that were not forgotten; `open` is true for the latest session while it is not closed (a session that merely went quiet for 6 h is still `open` until the next request starts another); `reason` is present only on a closed one.

```json
{ "id": "exc_...", "session_id": "ses_...", "turn_id": 412, "message_id": 418,
  "request": "Напиши калькулятор", "answer": "Готово ...", "answer_truncated": false,
  "status": "completed", "started_at": "2026-11-12T09:00:00.000Z", "duration_ms": 18000,
  "model": "claude-sonnet-4", "files": ["src/calc.ts"], "agents": ["Test writer"],
  "tokens": { "input": 4210, "output": 880 }, "cost_usd": 0.0522, "task_id": "tsk_..." }
```
`turn_id` is the user message that started the turn (what the chat scrolls to), `message_id` the assistant message that answered (0 when none did), `status` is `completed`, `failed` or `stopped`, `task_id` is omitted when there is none. A failed exchange recorded by schema 15 or later also has `"error": {"code", "message", "hint"?}`: the catalogue error the turn ended with (`turn_interrupted` for a turn closed by recovery after a crash), redacted like the texts, so a reloaded conversation can say why it failed; `interrupted: true` marks that case too. Older failed exchanges have no `error`. A forgotten exchange keeps its `id`, `session_id`, `turn_id`, `status` and `started_at`, has `"removed": true` and empty `request`, `answer`, `files`, `agents`.

Search hit of an exchange: `{"kind": "exchange", "id": "<exchange id>", "session_id": "ses_...", "title": "<first line of the request>", "snippet": "...", "date": "<started_at>", "message_id": <turn_id>, "task_id"?}`.

Events: `memory.updated {session_id, exchange_id}` when an exchange is recorded, `{session_id, exchange_id, deleted: true}` when one is forgotten, `{session_boundary: "clear"|"rewind", session_id, previous_session_id}` when a session is closed. The schema version is **15** (sessions, exchanges: `migrate_v12_sessions.go`; 10 is notes, 11 attachments; 13 is project sessions, see `sessions.md`; 14 is the M6 task fields, below; 15 is parallel sessions, `sessions.md`; the next free one is 16). A memory session is a main session of `sessions.md`; the 6 h rule applies only to exchanges recorded without a session. Since schema 15 several main sessions record exchanges at the same time: an exchange joins the session of its turn's user message, and its tokens, cost and sub-agents are those of its own session's agents only. Memory modes per session (`read`, `off`) are a later phase: every session reads and writes project memory (`on`).

## A task is work, not every request (M6)

Spec: the M6 section of the memory design. Nothing is opened when a request arrives; `SettleTurn` (`internal/memory/turntask.go`) decides when the turn ends. Every turn leaves its exchange (M4); a task is made or joined only when:

- the turn **did work**, from facts the harness has without a model: a changes-ledger entry, a state-changing command (a command that is not on the read-only allow-list of `ReadOnlyCommand`; for an ACP agent only a command the agent states in `rawInput`), a sub-agent spawned, a plan produced (plan mode, an approved plan carried out, an ACP plan of 2+ entries); or
- the orchestrator called `task_update` (that creates the record); or
- the digest states a goal with at least one constraint, acceptance criterion, decision or open question.

A question that was only answered makes no task. The digest's facts of such a turn go to the `Remembered` record (still searchable); items remembered with `remember` during a turn that makes a task move onto it.

- **Joining.** The digest's `continues` (a task of the same session, not dropped), else a task of the same session with the same normalised title. A task of another session is never joined; a repeat never makes a second task with the title.
- **Closing.** Digest `goal_met: true` closes it (`closed_reason: "goal met"`); no verdict and nothing unfinished closes it as `"turn completed"`; `goal_met: false`, open questions or a reply ending in "?" keep it open and `unfinished`; a failed turn leaves it open (state says so); a cancelled one drops it (`"stopped"`); `/clear` closes open tasks that are not `unfinished` (`"cleared"`) and carries the rest by title; 7 days without activity drops an open task (`"dropped: no activity"`; checked when a turn starts and when the list is read).
- **A task is never only its goal.** `goal` is the digest's rewrite, else `projectstore.GoalFromRequest` (first line/sentence, fillers like "please", "can you", "пожалуйста" removed, capitalised, 160 characters); `state_summary` is the digest's, else `Did: changed 2 files (a, b); delegated to 1 sub-agent (X).`; `files` are the ledger paths then the files the tool calls touched.
- **Digest sources.** The side model when the built-in loop can run. Otherwise, for an ACP orchestrator, only after a turn that did work: one prompt in the live session (`askACPDigest`, 30 s, answered by a handler that stores nothing, refuses permissions and file access, so it is never a user turn; the next turn waits for it). Failure, refusal or non-JSON falls back to the harness's facts.
- **Subjects.** A fact from the digest has `about` = the digest fact's own `about` (optional), else its task's title (not in the `Remembered` record), so the Knowledge view groups what the harness learnt by the work it came from.
- **API.** `GET .../tasks` is unchanged but each task also has `state_summary`, `open_questions`, `unfinished`, `closed_reason?`, `session_id?`, `exchange_ids`.
- **Schema 14** (`migrate_v14_tasks.go`): the three columns, and once, for a database stamped below 14: tasks with no constraint, acceptance, decision, fact or file (except `Remembered`) are removed with their search entries (their exchanges stay, detached); tasks with the same title created the same day are merged into the oldest; a kept raw-request goal is rewritten; closed tasks get a reason. Counted and logged (`memory M6 clean-up`). Before it touches anything it writes `project.sqlite.pre-m6` (`VACUUM INTO`; a numbered name if one exists; no backup when there is nothing to change); restore by replacing `project.sqlite` with it while the harness is stopped.

