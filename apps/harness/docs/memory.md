# Orchestrator memory (M1)

Design: [`docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md`](../../../docs/superpowers/specs/2026-11-11-orchestrator-memory-design.md). M1 is the store, the tools, the search and the API. **M2 (what goes into the orchestrator's context) is not built:** today the context is unchanged (the whole transcript, notes in full); the memory is only reachable through the tools below.

Code: `internal/memory` (service: limits, redaction, tools, digest, search shaping), `internal/projectstore/{tasks,search,memory_testing}.go` (SQL, FTS5), `internal/orchestrator/memory_tools.go` (tools, post-turn digest), `internal/project/memory.go` and `internal/bridge/memory.go` (API).

## What is stored

- **Task records** (`tasks`). Opened by the harness when a user message starts a turn: title = the first 80 characters, goal = the first 400 characters (`goal_by: "harness"`, the fallback when nothing digests the turn), `auto: true`. Fields: `status` (`open`, `done`, `dropped`), `goal`, `constraints[]`, `acceptance[]`, `quotes[] {text, message_id}`, `decisions[]`, `outcome`, `files[]`, `facts[] {id, text, date, message_id, superseded_by?}`, `message_ids[]`, timestamps. Limits: title 120, goal 1000, outcome 2000, an item 500 characters, 50 items per list, 200 facts.
- **Memory files**: markdown, path of at most 80 characters ending in `.md`, at most 64 kB, at most 500 files. **Decision (the spec said "files under {project}/memory/"):** they live in `project.sqlite` (`memory_files`), not on disk, so a write and its index entry are one transaction and path confinement cannot be got wrong. `INDEX.md` is generated from the summaries on `view`; it cannot be written.
- **Search index**: `search_docs` plus two FTS5 tables (`search_u` `unicode61 remove_diacritics 2`, `search_t` `trigram`), filled in the same transaction as the write. Documents: each task record, each fact, each memory file, and every user and assistant message text of the project (tool output is not indexed). A database that predates the index (schema 1) is indexed at its first open (a migration; schema version is now 2).

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

## Not built (M2, M3)

Context assembly with caps, the recent-window and the context receipts, the `memory.context` project setting, tool-result clearing, the UI view, embeddings, cross-project memory.
