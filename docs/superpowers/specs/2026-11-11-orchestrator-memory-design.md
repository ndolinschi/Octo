# Orchestrator memory — design

**Date:** 2026-11-11 · **Status:** approved to build after R1 (owner: "one orchestrator may manage a project for
months; it must not just work with the raw messages we send; at the moment a message arrives it should remember
what it needs — a detail map per task, the last five messages, files it can save and search")
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md) (notes, compaction),
[`2026-11-10-subscription-agents-design.md`](./2026-11-10-subscription-agents-design.md) (ACP orchestrator, recap)

## Today

The orchestrator's context is the whole transcript until it overflows, then a compaction summary plus the tail.
Notes are the only durable memory and are sent in full with every request. An ACP orchestrator that cannot
`session/load` gets the last ≤ 40 texts. Nothing can be searched; a detail from week one survives only if the
summary happened to keep it.

## What others do (orchestrator's own research, 2026-11-11)

Read from vendor docs and one paper; search-result summaries, not re-verified line by line.

| Source | What it does | What we take |
| --- | --- | --- |
| Anthropic context management (memory tool + context editing) | A file directory the model reads and writes with `view / create / str_replace / insert / delete / rename`, stored by the client; stale tool results are cleared from context near the limit. Anthropic reports 39% better agent performance with both, 29% with clearing alone | The same six file commands (models already know them); **clearing old tool results inside a turn** before summarising anything |
| Claude Code project memory | An index file always in context, topic files loaded on demand | Index in context, files on demand |
| Letta (MemGPT) | Small always-visible *blocks* the agent edits; *recall* = raw history, searchable; *archival* = processed facts, searchable; "sleep-time" agents do the memory work off the main agent's path | Three stores with the same split; **memory upkeep by the side model after the turn**, not by the orchestrator during it |
| LongMemEval (ICLR 2025) | Long histories cost long-context models 30–60% accuracy; indexing by **extracted facts** beats indexing raw text (+4 pts recall, +5 pts answers); **time-aware** retrieval fixes temporal questions; systems fail on *knowledge updates* and on *saying "I don't know"* | Facts as index keys; dates on everything and date filters; superseding instead of overwriting; an explicit "nothing found" |
| SQLite FTS5 | `unicode61` splits Cyrillic into words but does no Russian stemming (`porter` is English only); `trigram` matches substrings in any script at ~2–3× index size and needs ≥ 3 characters | Two indexes: `unicode61` for exact words, `trigram` for inflected Russian and partial identifiers |

## Principles

1. **Nothing is lost, little is carried.** Every message stays verbatim in the project database. What changes is what
   is *sent to the model*: a bounded working set, with the rest one search away.
2. **Exact where exactness matters.** A task record keeps the user's wording for things that must not be paraphrased
   (names, numbers, paths, commands, acceptance criteria) as quotes with the source message id; the rest is digested.
3. **The user can see and correct it.** Memory is files and records in the project, shown in the UI, editable and
   deletable. Each turn records what was put into context.
4. **Per project, local, no secrets.** Stored in the project's data directory; values from the secret store are
   redacted before anything is written or indexed.
5. **The orchestrator thinks about the task, not about filing.** Upkeep (digesting a turn into its task record,
   extracting facts) is done by the side model after the turn. The orchestrator's tools are for the cases where it
   knows something is worth keeping or needs something back.
6. **Newer wins, older stays.** A fact that changes ("the port is 8791 now") supersedes the old one, which is kept
   with its date and marked superseded — so "what did we decide in October?" still has an answer.

## M1 — store, tools, search (harness)

- **Task records** (the "detail map per task"). Table `tasks`: id, title, status (`open`, `done`, `dropped`),
  `goal`, `constraints[]`, `acceptance[]`, `quotes[]` (`{text, message_id}`), `decisions[]`, `outcome`, `files[]`,
  `facts[]` (`{text, date, message_id, superseded_by?}` — short standalone statements: "CI runs on Rust 1.88",
  "the owner tests on Linux"), `message_ids[]`, timestamps. The harness opens a record when a user message starts a turn (or attaches the message
  to the open task the orchestrator names). Tool `task_update {id?, title?, status?, goal?, add_constraints?,
  add_acceptance?, add_quotes?, add_decisions?, outcome?, files?}`. **After every turn the side model digests it** (one call, capped
  input, off the request path; a failure only logs): fills what the orchestrator left empty, adds facts and quotes,
  and marks a fact superseded when a new one contradicts it. It never deletes and never rewrites what the
  orchestrator or the user wrote. With no side model, the first 400 characters of the request become the goal and
  nothing else is extracted.
- **Memory files.** Markdown files under `{project}/memory/` (name ≤ 80 chars, file ≤ 64 kB, ≤ 500 files). One tool
  `memory {command: view | create | str_replace | insert | delete | rename, path, …}` with the semantics of
  Anthropic's memory tool (paths confined to the directory; traversal refused), plus a required one-line `summary` on
  `create`. `memory/INDEX.md` is generated by the harness from the summaries, never written by the model. Existing notes
  stay as they are: short, pinned, always in context. Memory files are the long form: only their index is in context.
- **Search.** `memory_search {query, in?: ["tasks","facts","files","messages"], after?, before?, limit?}` over two
  SQLite FTS5 indexes (`unicode61` and `trigram`; results merged, exact-word hits first) of task records, facts,
  memory files and all user/assistant texts of the project (tool output excluded). A message is also found through
  the facts and quotes extracted from it. Returns ≤ 10 hits: kind, id, title, snippet (≤ 300 chars), date, and
  `superseded` where it applies; an empty result says "nothing in memory matches" so the model can say so instead of
  guessing. `recall_message {id}` returns one message verbatim (≤ 8 kB, with
  `truncated`). Index updated in the same transaction as the write.
- **API:** `GET /v1/projects/{id}/tasks`, `GET/PUT/DELETE …/memory/{name}`, `GET …/memory`, `GET …/memory/search?q=`;
  events `task.updated`, `memory.updated`.
- **ACP orchestrator:** the same tools over the harness MCP server.

## M2 — context assembly

Per request the harness builds the orchestrator's context from blocks, each with a token cap, in this order (stable
blocks first so the prompt cache holds):

| Block | Cap (default) |
| --- | --- |
| Briefing, project brief, pinned notes | as today |
| Memory index: file names + summaries | 1 500 tokens |
| Open task records (newest first; done tasks of the last 7 days as one line each) | 3 000 tokens |
| Recent window: the last **5** user messages verbatim with the orchestrator's replies (tool output reduced to one line per call) | 12 000 tokens |
| Current facts (not superseded) of open tasks, newest first, each with its date | 1 500 tokens |
| The current turn; once it passes 60% of the window, tool results older than the last 5 calls are replaced by a one-line stub (`[cleared: read_file src/x.go, 412 lines]`) before any summarising | — |

Older history is not sent; the briefing says so and names `memory_search` / `recall_message`. Project setting
`memory: { context: "window" | "full", recent_exchanges: 5 }`; **`full` stays the default until the M2 acceptance run
passes**, then new projects get `window`. Compaction remains for the current turn only. An ACP orchestrator's recap
for a new session is this same assembly (replacing "last 40 texts"); a live ACP session is not rewritten — the agent
owns its context — but gets the tools and, on each request, the open task records that changed since its last turn.

Each turn stores a **context receipt**: block names, token counts, ids included.

## M3 — UI

Project "Memory" view: tasks (status, goal, quotes linking to the original message, decisions, outcome), memory
files (view, edit, delete), search box, and per turn "what the orchestrator had in front of it" from the receipt.

## Acceptance

- M1: a Russian query in a different case form finds the message ("бюджета" finds "бюджет"); a superseded fact is
  returned marked and after the current one; a date filter excludes what is outside it; the digest never changes text
  written by the orchestrator or the user; unit tests for tools, limits, redaction; search finds a detail from a 300-turn scripted history; verbatim
  recall is byte-exact; deleting a file removes it from the index.
- M2: with 300 scripted turns the request size stays under the sum of the caps; a scripted orchestrator answers a
  question about turn 12 by searching; a five-message window is exactly five; cache-read share on the mock does not
  drop below the `full` mode's by more than 10 points; receipts match what was sent.
- Not verifiable here: whether real models use search when they should — the owner's long-running project is the
  test; the receipt view is how to judge it.

## Open

- Embedding search. Lexical search misses paraphrase ("the money limit" vs "budget"); extracted facts narrow that
  gap but do not close it. Revisit after the owner's first month with receipts in hand.
- The digest costs one side-model call per turn; on a subscription-only setup there may be no side model. Then
  memory is what the orchestrator writes itself.
- Cross-project memory. Out for now.


---

## As built — M1 (harness)

Exact API, limits and behaviour: [`apps/harness/docs/memory.md`](../../../apps/harness/docs/memory.md). Client: `@octo/agent-client` (`Task`, `MemoryFile`, `MemoryHit`, optional `listTasks`, `listMemory`, `getMemoryFile`, `putMemoryFile`, `deleteMemoryFile`, `searchMemory`; events `task.updated`, `memory.updated`; reducer `tasks`, `memoryRevision`). **M2 and M3 are not built.** Where the text above was silent or is not what was built:

- **Memory files are rows in `project.sqlite`, not files in `{project}/memory/`** (one transaction with their index entry, no path-escape surface). Same limits (name ≤ 80 characters, ≤ 64 kB, ≤ 500 files, `.md`), `INDEX.md` generated on `view`.
- **Schema version 2** (migration from 1 builds the index from the existing messages; tested). Search tables: `search_docs` + FTS5 `search_u` (`unicode61 remove_diacritics 2`) and `search_t` (`trigram`).
- **Russian inflections** are found through the trigram index with a *stem* of the query word (2 characters off a 5 to 7 character word, 3 off a longer one). Endings longer than 3 letters are not covered; this is not stemming. `unicode61` alone fails on "бюджета" for "бюджет" (checked).
- **Search rules the spec left open**: all words (AND) first; failing that, "any of the significant words" kept only when at least half occur in the document, so a question about something absent finds nothing; exact-index hits before trigram hits; superseded facts after current ones; `after` inclusive, `before` exclusive; a fact hit carries `message_id` and `task_id`.
- **Superseding works across tasks** (a later request usually opens a new task): the digest is shown up to 20 current facts of other tasks; the older fact's `superseded_by` is `"<taskId>/<factId>"` when it lives in another task.
- **Quotes are checked**: a quote (from `task_update` or the digest) must be an exact substring of the request message, else `task_update` refuses and the digest drops it.
- **`auto` and `goal_by`** on a task record tell the digest what it may replace (the harness's fallback goal, never the orchestrator's); `task_update` with another task's `id` attaches the turn's message to it and drops the untouched record the harness opened.
- **Digest**: after completed turns only, side model (fast tier unless `models.side`), no tools, usage role `digest`, failures only log; nothing without a side model beyond the 400-character fallback goal.
- Redaction at write and index time, including the index of messages (installed before the first message of a turn is indexed); the transcript itself still holds a user's own text as typed.
- Not built: everything in M2 and M3; the spec's acceptance items for M2 are open. The mock orchestrator does not search on its own: the tests drive the tools with request markers (`[search: …]`, `[recall: id]`, `[mem-create: …]`, `[task-update: …]`) and the mock digest with `[fact: …]`, `[goal: …]`, `[quote: …]`, `[decision: …]`.


---

## As built — M2 (harness)

Details and the receipt format: [`apps/harness/docs/memory.md`](../../../apps/harness/docs/memory.md) ("Context assembly (M2)"). Client: optional `ProjectInput.memory`, `Project.memory`, `getTurnContext`, `ContextReceipt`. M3 (UI) is not built.

**Built as specified:** the setting `memory: {context, recent_exchanges}` (default `full`); window assembly with the table's blocks and caps (1 500 / 3 000 / 12 000 / 1 500 tokens), stable blocks first; the window is exactly N exchanges; tool-result clearing at 60% of the window keeping the last 5 calls, with stubs like `[cleared: read_file src/x.go, 412 lines]`, in both modes and before compaction; the ACP recap of a new session uses the assembly; a live ACP session gets the open tasks changed since its last turn; a receipt per turn.

**Decisions where the spec was silent:**
- **Receipt API:** `GET /v1/projects/{pid}/turns/{turnId}/context` (table `context_receipts`, schema version 3), not a field of the message. It records the first request of the turn.
- **Where the blocks go:** the index and task blocks are text blocks at the front of the first user message, the facts block at the front of the current user message; the window is real messages (user text, one assistant message per exchange with its tool calls reduced to lines). Open task blocks change every turn (each request opens a record), so the cache prefix of a window-mode request is shorter than in full mode; see the recommendation.
- **Clearing applies to the orchestrator only** (sub-agents and side questions unchanged) and **assumes a 200 000-token window when none is configured** (the windows table is empty by design); stored messages are never rewritten.
- In window mode an older compaction summary is not sent; ACP live sessions in `full` mode behave as before.
- The mock orchestrator takes the request from the *last* text block of the user message (memory blocks come first), a change in `mockllm`.

**Acceptance (mock):** 300 scripted exchanges plus 60 task records with 720 facts and 50 files: the request holds under the sum of the caps plus the current turn, and exactly five earlier exchanges (`TestWindowModeSendsExactlyNExchangesWithinTheCapsAndSearchFindsTurn12`); the scripted orchestrator answers about turn 12 by searching: turn 12 is absent from the first request, present in the second; a full-mode request on the same history is more than 5 times larger; receipts match (names, ids, counts, message count, block tokens against the request text, caps); switching full to window to full loses nothing and the transcript is sent whole again; sub-agent requests are identical in both modes; clearing happens in both modes and is recorded in the receipt; ACP recap and live-session task blocks. **Cache-read share on the mock over 12 scripted turns: full 47.6%, window 54.8%**: the criterion (no more than 10 points below full) holds, but that number says little about the real API, see below.

**Recommendation: keep `full` as the default for now; do not flip it.** What the mock cannot show and why it matters:
1. **Prompt cache on the real API.** The window slides by one exchange every turn and the open-task block changes every turn, so from the first changed block onward the cached prefix is lost each turn; only the system prompt and tool definitions stay cached across turns (within one turn, with several tool rounds, the assembled prefix is reused). In `full` mode the prefix grows append-only. The mock's cache model looks back a bounded number of blocks, which makes long `full` histories look worse than they would be there (that is why window beats full on the mock). Judge it on a real router run: the usage report's cache-read tokens per turn in both modes on the same project.
2. **Whether real orchestrators search** when the answer is outside the window (the scripted one does what its markers say), and whether the digest's facts and task records are good enough to stand in for the history. Both are the owner's test; the receipt (`GET .../turns/{id}/context`) is how to judge what the model had.
3. The digest runs on the side model; with a subscription-only setup there may be none, then task records hold only the harness's fallback goal and what the orchestrator writes itself.

Criteria to flip the default: on the owner's long-running project, a week of `window` with receipts showing the model found older details by search when asked, cache-read share not clearly worse than `full`, and no case where it asked the user to repeat something said before. Until then `window` is an opt-in per project (`PATCH /v1/projects/{id}` `{"memory": {"context": "window"}}`).

**Not shown:** quality of answers with a real model in either mode; real cache behaviour; behaviour with `recent_exchanges` above the cap of the window block on very long messages (they are cut, tested only structurally); clearing against a real window size (the test uses a configured 6 000-token window); the live-session task block on a real ACP agent.


---

## As built — M3 (UI)

`packages/ui/src/components/memory/` (`MemoryView({projectId, onOpenMessage?, onOpenFile?, initialTab?, turnId?})`, `MemoryPanel` for the dock) and `packages/ui/src/lib/memory/` (task filters and fact order, receipt arithmetic, search form and hit targets, file helpers; unit tests in `memory.test.ts`). Lazy: nothing of it is in the initial bundle. Four tabs in one `Segmented`:

- **Tasks**: status filter with counts; list (status ring, title, age) and detail (goal with who wrote it, constraints, acceptance, quotes with "Open the request", decisions, facts oldest first with superseded ones struck through and a link to the replacement in the same task or another one, outcome, files).
- **Files**: list (newest first), rendered view, editor (summary + text, 64 kB limit checked before the harness says no), delete behind a confirm dialog. Creating a file is not offered.
- **Search**: query, kinds, From / Before dates; hits current-first, superseded ones struck and marked; each hit opens its task / file / request; an empty answer says "Nothing in memory matches".
- **Context**: the orchestrator's requests (from the open project's state), the receipt of the chosen one: stacked bar by block share, per block tokens, share, cap fill ("reached" in `warn`), item count and ids as chips (files, tasks, facts link into the other tabs, message ids link to the chat when the host passes `onOpenMessage`). A turn without a receipt (404) is an empty state, not an error.

Layout: container query, list and detail side by side from 640px of view width, one column below (the detail replaces the list under a Back button). Rows are buttons with ↑/↓/Home/End. Loading, empty and error states per tab; reads re-run on `task.updated` and `memory.updated`.

Demo: `?demo=1#/p/<id>/memory` renders the view alone (route handled in `app/AppShell.tsx`, lazy, demo only). The demo's receipts now exist for every request but the oldest, the second oldest being a full-mode turn; a request made after the memory first loaded is found by re-reading the thread (the 404 gap is closed).

**Verified:** Playwright against `?demo=1` (dark and light at 1440x900, dark at 390x700, console clean): tab switching, task filter, keyboard row moves, superseded facts, file edit / save / too-large / delete with cancel and confirm, search with kinds, empty query, no-result, `?memory=fail|empty|none`. **Not verified:** against a real harness (shapes taken from the types and `memory.md`); the dock tab (not registered, see the handover for the snippet); screen-reader behaviour beyond roles and labels; the spacing audit does not reach the Memory route.

## M4 — sessions: what was asked and what was answered (owner, 2026-11-12)

Owner: "memory should contain the user's ask and the model's answer, like a session." Tasks and facts are digests;
the person also wants the plain record. Rules:
1. **An exchange is a memory record.** For every finished orchestrator turn the harness stores one exchange: the
   request as typed (redacted for stored secrets), the final answer text (the last assistant text of the turn, not
   the tool chatter), when, how long, the model or agent that answered, the outcome (completed / failed / stopped),
   files changed (count and paths, from the changes ledger), sub-agents used (names), tokens and cost, the task it
   was filed under. Nothing is summarised: the texts are kept whole (answer capped at 64 KiB with a marker).
2. **Sessions group exchanges.** A session is a run of exchanges in one conversation: it starts at project creation,
   after `/clear` (B11), after a rewind that cut everything, or after 6 h without a request; it carries a title (the
   first request's first line, trimmed to 80 characters) and its dates. Old data is back-filled from stored messages
   on migration.
3. **API.** `GET /v1/projects/{id}/memory/sessions?limit=&before=` → `{sessions:[{id,title,started_at,ended_at,
   exchanges,open}]}`; `GET …/memory/sessions/{sid}` → `{session, exchanges:[{id,turn_id,message_id,request,answer,
   answer_truncated,status,started_at,duration_ms,model,files:[…],agents:[…],tokens,cost_usd,task_id?}]}`;
   `GET …/memory/search` also searches exchanges (request and answer, same FTS5 index rules incl. Russian stemming)
   and returns hits of kind `exchange` with `session_id`. Event `memory.updated` already exists and fires.
4. **The orchestrator can read it.** `recall_message` gains `exchange_id`/`session_id` forms, and the context for a
   new session gets a three-line pointer to the previous session (title, date, how to recall it), not its text.
5. **UI.** The Memory tab opens on **Sessions** (list-detail, decision 66): sessions newest first; a session shows
   its exchanges as request → answer pairs, answers rendered as Markdown and folded after 12 lines, with the meta
   line (when, model, duration, files changed, cost) quiet under each; "Open in conversation" scrolls the transcript
   to that request; search covers them. Tasks, Facts and Files stay as further views.
6. **Privacy.** Stored locally in the project's database only; removed with the project; "Forget this exchange"
   deletes one (also from the search index) and leaves a "removed" marker in its session.
Acceptance: unit tests (exchange written once per turn incl. failed and stopped, final-answer extraction with tool
calls and sub-agents, secret redaction, session boundaries incl. the 6 h rule with an injected clock, back-fill
migration, search hits, forget); e2e case in `e2e-v7.sh` or `e2e-parity.sh`; UI tests for the view model and
screenshots. Not verified until the owner's run: answer extraction for real ACP agents' message shapes.
