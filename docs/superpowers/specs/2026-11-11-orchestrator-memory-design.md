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

## Principles

1. **Nothing is lost, little is carried.** Every message stays verbatim in the project database. What changes is what
   is *sent to the model*: a bounded working set, with the rest one search away.
2. **Exact where exactness matters.** A task record keeps the user's wording for things that must not be paraphrased
   (names, numbers, paths, commands, acceptance criteria) as quotes with the source message id; the rest is digested.
3. **The user can see and correct it.** Memory is files and records in the project, shown in the UI, editable and
   deletable. Each turn records what was put into context.
4. **Per project, local, no secrets.** Stored in the project's data directory; values from the secret store are
   redacted before anything is written or indexed.

## M1 — store, tools, search (harness)

- **Task records** (the "detail map per task"). Table `tasks`: id, title, status (`open`, `done`, `dropped`),
  `goal`, `constraints[]`, `acceptance[]`, `quotes[]` (`{text, message_id}`), `decisions[]`, `outcome`, `files[]`,
  `message_ids[]`, timestamps. The harness opens a record when a user message starts a turn (or attaches the message
  to the open task the orchestrator names). Tool `task_update {id?, title?, status?, goal?, add_constraints?,
  add_acceptance?, add_quotes?, add_decisions?, outcome?, files?}`. If a turn ends and its record has no goal, the
  side model fills it from the turn (one call, capped input); if there is no side model, the first 400 characters of
  the request become the goal.
- **Memory files.** Markdown files under `{project}/memory/` (name ≤ 80 chars, file ≤ 64 kB, ≤ 500 files). Tools
  `memory_write {name, content, summary}`, `memory_read {name}`, `memory_list`, `memory_delete {name}`. Existing notes
  stay as they are: short, pinned, always in context. Memory files are the long form: only their index is in context.
- **Search.** `memory_search {query, in?: ["tasks","files","messages"], limit?}` over an SQLite FTS5 index of task
  records, memory files and all user/assistant texts of the project (tool output excluded). Returns ≤ 10 hits:
  kind, id, title, snippet (≤ 300 chars), date. `recall_message {id}` returns one message verbatim (≤ 8 kB, with
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
| The current turn in full | — |

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

- M1: unit tests for tools, limits, redaction; search finds a detail from a 300-turn scripted history; verbatim
  recall is byte-exact; deleting a file removes it from the index.
- M2: with 300 scripted turns the request size stays under the sum of the caps; a scripted orchestrator answers a
  question about turn 12 by searching; a five-message window is exactly five; cache-read share on the mock does not
  drop below the `full` mode's by more than 10 points; receipts match what was sent.
- Not verifiable here: whether real models use search when they should — the owner's long-running project is the
  test; the receipt view is how to judge it.

## Open

- Embedding search (FTS5 is lexical; Russian morphology is weak in it — a trigram tokenizer is the first remedy).
- Cross-project memory. Out for now.
