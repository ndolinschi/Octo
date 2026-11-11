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
