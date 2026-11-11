# Orchestrator memory (M1, M2)

Design: [`docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md`](../../../docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md). M1 is the store, the tools, the search and the API; M2 (below) is how the orchestrator's context is built from it, off by default (`memory.context: "full"`).

Code: `internal/memory` (service: limits, redaction, tools, digest, search shaping), `internal/projectstore/{tasks,search,memory_testing}.go` (SQL, FTS5), `internal/orchestrator/memory_tools.go` (tools, post-turn digest), `internal/project/memory.go` and `internal/bridge/memory.go` (API).

## What is stored

- **Task records** (`tasks`). Opened by the harness when a user message starts a turn: title = the first 80 characters, goal = the first 400 characters (`goal_by: "harness"`, the fallback when nothing digests the turn), `auto: true`. Fields: `status` (`open`, `done`, `dropped`), `goal`, `constraints[]`, `acceptance[]`, `quotes[] {text, message_id}`, `decisions[]`, `outcome`, `files[]`, `facts[] {id, text, date, message_id, superseded_by?}`, `message_ids[]`, timestamps. Limits: title 120, goal 1000, outcome 2000, an item 500 characters, 50 items per list, 200 facts.
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

After a **completed** turn the harness makes one call to the project's side model (fast tier by default, `models.side` overrides), with no tools, capped input (the request up to 6 000 characters, the reply up to 4 000, the record so far, and up to 20 current facts of other tasks), off the request path in a goroutine under the orchestrator's wait group; a failure only logs (`memory digest failed`). Its usage is recorded with `role: "digest"` (not in the agent's token totals). It returns JSON: goal, constraints, acceptance, quotes, decisions, outcome, facts `{text, supersedes}`. Applied by `ApplyDigest`, which **only fills and adds**: the goal is replaced only while it is the harness's fallback or an earlier digest's; the outcome only while empty; lists grow, deduplicated; a quote is kept only if it occurs in the user's request; a fact that duplicates a current one is skipped; a fact with `supersedes` marks the best matching current fact (same text, else at least half the words in common, in this task or any other) `superseded_by` the new one, which keeps its text and date. Nothing the user or the orchestrator wrote is changed or deleted. With no side model (the built-in loop unavailable, e.g. an ACP-only setup) nothing is digested and the record keeps the fallback goal.

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

## Task records over a turn (live run 2)

- **Trivial exchanges leave no record.** The harness still opens a record when a request arrives (so `task_update` without an id has something to edit), but when the turn ends an untouched record whose turn made no tool call and answered in at most 400 characters is deleted. With the digest on, the digest decides first: the record is kept only if the digest found a fact, decision, quote, constraint or acceptance criterion in the exchange; with the digest off it goes at once. A record the orchestrator edited (`task_update`) is never deleted.
- **A follow-up joins its task.** The digest prompt lists up to 6 earlier tasks (the open ones and the 3 most recently finished) and the digest may answer `continues: <task id>`. The turn's message then joins that task, the turn's own untouched record is deleted, the digest is merged into the task, which is closed again with the new outcome.
- **A finished turn closes its task.** Completed: status `done`, `outcome` filled (the digest's, else the first 300 characters of the reply) unless something else set one. Cancelled: `dropped`. Failed: left open. A user or the orchestrator can reopen a task (`status: open`).
- **`files`** is filled from the turn's tool calls: `read_file`/`write_file` paths of the built-in tools, and for ACP the locations of `read`, `edit`, `delete` and `move` tool calls (relative to the project folder when inside one), at most 50 per record.
- **Russian search.** A third FTS5 index, `search_s`, holds every document as stems: the Russian Snowball algorithm (pure Go, `projectstore/stem_ru.go`, no module), ё folded to е, and the fleeting о/е before a final consonant dropped (so `скобок` and `скобками` share a stem). Queries are stemmed the same way and the stem index is searched after the exact index and before the trigram one, so `калькуляторами` finds `калькулятор`, `скобками` finds `скобок`, `молдове` finds `Молдовы` and `Кишинев` finds `Кишинёв`. Only words with Cyrillic letters are stemmed. A database from before schema 5 is indexed when it opens.
