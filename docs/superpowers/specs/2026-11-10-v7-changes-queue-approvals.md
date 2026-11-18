# v7 — changes per turn, message queue, approvals

**Date:** 2026-11-10 · **Status:** approved scope and order (owner); details decided by the orchestrating agent; **harness side built (2026-11-11); the UI side is tracked in the UI spec**: see "As built — v7 (harness)" at the end and `apps/harness/docs/v7.md`
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md), [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md), [`2026-11-10-project-harness-ui.md`](./2026-11-10-project-harness-ui.md)
**Why these three:** [`../research/2026-11-10-t3code-gap.md`](../research/2026-11-10-t3code-gap.md)

Build order: 1 → 2 → 3. Each is harness → client → UI, with its own acceptance criteria and commit.

## Non-goals

Git integration (commits, branches, PRs), checkpoints / rewind of files, per-agent worktrees, approvals for the
built-in read-only tools, steering a running model call mid-stream.

---

## 1. Changes per turn and a diff view

**Intent.** After a turn, the user sees what changed on disk and can read each change — without git.

**Harness.** Every successful agent write (built-in `write_file`, ACP `fs/write_text_file`) records a change with
the content before and after. Snapshots are stored in the project database (content-addressed, deduplicated,
text only, ≤ 2 MiB each — the file API's limit; larger or binary files record the change without a diff).

```sql
CREATE TABLE blobs (hash TEXT PRIMARY KEY, content BLOB NOT NULL);          -- sha256 of content
CREATE TABLE changes (
  id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL,                         -- id of the orchestrator's user message that started the turn
  agent_id TEXT NOT NULL, folder TEXT NOT NULL, path TEXT NOT NULL,
  before_hash TEXT, after_hash TEXT,                                        -- NULL before = created; NULL after never (no delete tool)
  added INTEGER, removed INTEGER,                                           -- line counts; NULL when no diff is available
  created_at TEXT NOT NULL
);
```

| Method | Path | Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/changes?turn=` | `{ "turns": TurnChanges[] }` (newest first; `turn` narrows to one) |
| GET | `/v1/projects/{pid}/changes/{cid}` | `ChangeDetail` |
| POST | `/v1/projects/{pid}/changes/{cid}/revert` | → `FileStat`; writes `before` back (deletes a created file); `409 file_changed` if the file no longer equals `after` |

```ts
type FileChange = {
  id: number; turn_id: number; agent_id: string; folder: string; path: string;
  kind: "created" | "modified"; added: number | null; removed: number | null; created_at: string;
};
type TurnChanges = { turn_id: number; files: FileChangeSummary[]; added: number; removed: number };
// one entry per file per turn: first `before` to last `after`, with the ids of the underlying changes
type FileChangeSummary = Omit<FileChange, "id" | "agent_id"> & { change_ids: number[]; agent_ids: string[] };
type ChangeDetail = FileChange & { before: string | null; after: string | null; diff_available: boolean };
```

New SSE event `change.recorded` `{ seq, turn_id, change: FileChange }`. Retention: blobs referenced by no change
are deleted; changes older than 30 days lose their blobs (the row stays, `diff_available: false`).

**UI.** (a) Under a finished turn that changed files: a card "N files changed" with `+added −removed` totals,
one 28px row per file (glyph, name, muted folder path, `+a −r` in tabular numerals, `ok` / `err` colours) and
"Review" (opens the first diff). (b) A **Diff tab** (`diff:{turnId}\0{folder}\0{path}`): Monaco diff editor
(inline under 900px of width, side by side above), breadcrumb row like the file view, prev / next file in the
turn, "Open file", "Revert this change" (confirm; explains the 409 case). (c) Details → Files and Home → "files
written" read `/changes` instead of scanning transcripts. (d) Code comments work in the diff's modified side and
attach to the file as usual.

**Acceptance.** 1. A turn in which two agents write three files (one twice) yields one card with three rows and
correct line counts; the diff shows first-before → last-after. 2. A created file shows as all-added; revert
removes it. 3. Revert restores the previous content on disk; if the file changed since, it is refused with a
clear choice. 4. ACP agent writes are recorded the same way. 5. Binary / over-limit writes list without a diff.
6. Existing projects open after the migration; turns before it simply have no card. 7. All gates.

## 2. Message queue (send while a turn runs)

**Intent.** The user can keep typing while the orchestrator works; nothing is lost and nothing interleaves.

**Harness.** `POST /v1/projects/{pid}/messages` while a turn is running no longer returns 409: the message is
queued (persisted, FIFO, at most 20, each ≤ the normal message limit) and returns `202 { "queued": QueuedMessage }`.
When the turn ends (completed, failed or cancelled) the next queued message starts a new turn automatically;
after a failed or cancelled turn the queue **pauses** (it does not auto-run on top of an error) until resumed.

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/queue` | → `{ "paused": boolean, "messages": QueuedMessage[] }` |
| PATCH | `/v1/projects/{pid}/queue/{qid}` | `{ "text" }` → `QueuedMessage` |
| DELETE | `/v1/projects/{pid}/queue/{qid}` | → `204` |
| POST | `/v1/projects/{pid}/queue/resume` | → `202` |
| POST | `/v1/projects/{pid}/queue/{qid}/send-now` | → `202`; cancels the running turn, then runs this message first |

`QueuedMessage = { id: string; text: string; created_at: string }`. SSE: `queue.updated` `{ seq, paused, messages }`.
Cancel (`/cancel`) stops the turn and pauses the queue; it never drops queued messages. Full queue → `409 queue_full`.

**UI.** While a turn runs the composer stays enabled: Enter queues ("Queued" hint), the Stop button stays.
Queued messages appear as a stack above the composer (one 28px row each: text truncated, Edit, Remove, "Send now"),
collapsible past three ("3 queued"). Paused state: "Queue paused after a failed turn" + Resume / Clear. Pending
code comments attach to the message at the moment it is queued. The floating composer shows the same count chip.

**Acceptance.** 1. Three messages sent during a turn run in order, each as its own turn, none lost across a
harness restart. 2. Editing and removing a queued message works; "Send now" cancels the running turn and runs
that message next. 3. After a failed turn the queue is paused and resumes only on request. 4. The 21st message
is refused with a visible reason. 5. All gates.

## 3. Approvals (Supervised / Full access)

**Intent.** The user decides whether agents may change things without asking. Today everything is auto-approved,
including ACP agents' permission requests.

**Model.** A project has `access: "supervised" | "full"` (default `full` for existing projects — no behaviour
change on upgrade; new projects default to `supervised`). In supervised mode these need approval: built-in
`write_file` and shell commands, ACP `session/request_permission`, ACP `fs/write_text_file`. Reads never ask.
An approval request blocks only the agent that raised it; siblings keep running.

```ts
type Approval = {
  id: string; agent_id: string; turn_id: number;
  kind: "write" | "command" | "acp";
  title: string;                       // "Write src/auth/refresh.ts", the command line, or the ACP tool title
  detail: { folder?: string; path?: string; diff?: { added: number; removed: number }; command?: string;
            options?: { id: string; label: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" }[] };
  created_at: string;
};
```

| Method | Path | Body → Response |
| --- | --- | --- |
| GET | `/v1/projects/{pid}/approvals` | → `{ "approvals": Approval[] }` (pending only) |
| POST | `/v1/projects/{pid}/approvals/{id}` | `{ "decision": "allow" \| "allow_for_turn" \| "deny", "option_id"?: string, "note"?: string }` → `204` |

`allow_for_turn` approves the same kind (and, for commands, the same program) from the same agent for the rest of
the turn. A denial returns a tool error to the agent with the user's note, so it can adapt. Pending approvals are
denied when the turn is cancelled and survive a UI reload (not a harness restart: the turn itself does not).
SSE: `approval.requested` `{ seq, approval }`, `approval.resolved` `{ seq, id, decision }`. `PATCH /v1/projects/{pid}`
accepts `access`.

**UI.** The composer footer gets an access selector next to the model ("Supervised" / "Full access", with a
one-line explanation in its menu). A pending approval renders in the **orchestrator chat** at the bottom of the
live turn — also when a sub-agent raised it (with the agent's role and a link to its tab): title, the diff
preview or command in mono, and Allow / Allow for this turn / Deny (Deny can take a note). Keyboard: focus moves
to the card when it appears unless the user is typing; `Enter` allows, `Esc` leaves it pending. The sidebar
project row and the floating composer show a "needs approval" state (`warn` dot / chip); the delegation row of a
waiting agent says "Waiting for approval". Agent tabs stay read-only: they show the pending request but the
buttons live in the orchestrator chat and in a pinned bar at the top of that agent's tab.

**Acceptance.** 1. Supervised: a sub-agent's write pauses that agent, shows a card in the orchestrator chat with
the diff, Allow lets it finish, Deny makes the agent receive an error and continue. 2. Allow for this turn stops
further prompts of the same kind from that agent in that turn only. 3. An ACP agent's permission request shows
its options and the chosen one is returned to it; with Full access behaviour is exactly as today. 4. Cancelling
the turn clears pending approvals. 5. Existing projects keep Full access after the migration. 6. All gates.

---

## Sequencing notes

- 1 before 3: the approval card reuses the change/diff machinery for write previews.
- 2 is independent of 1 and 3 on the harness side; UI work on the composer overlaps with 3 (access selector), so
  the UI parts of 2 and 3 are built by one agent.
- Each part: harness (Sonnet) → client (Sonnet) → UI (Opus) → independent review → live run on the mock stack.


---

## As built — v7 (harness)

Exact API, limits and configuration: [`apps/harness/docs/v7.md`](../../../apps/harness/docs/v7.md). Client: `@octo/agent-client` (`types.ts`, `state.ts`, optional `Bridge` members). What differs from, or fills a gap in, the text above:

**Changes.**
- Beyond `write_file` and ACP `fs/write_text_file`, changes made by a `bash` call and by an ACP agent's own tools are found by before/after snapshots of the project folders (`source: bash | acp_turn`; the others `write_file | acp_fs`). `kind` gained `deleted` (`after_hash` null), and a change carries `note` (why there is no diff: `binary | too_large | no_preimage | pruned`) and `source`.
- Pre-images: a copy of each text file up to 1 MiB in the project data dir (256 MiB per project), refreshed between calls; the diff blob store is the `blobs` table (text, 2 MiB). Walk cap 20 000 files per folder; git work trees use `git ls-files --exclude-standard`. Details and what is not detected: v7.md.
- `GET /changes` leaves out files created and deleted again or changed back. The revert response is `FileStat` plus `deleted: true` for a removed created file; `409 revert_unavailable` is new (content before not kept).
- Retention (30 days) runs after each turn and at start-up.
- Fix (2026-11-18): a revert is recorded. Before, `POST /changes/{cid}/revert` changed the disk and stored nothing, so a reverted file stayed in `GET /changes`, the Changes list, the turn's card and the "N changed files" count. Now the revert is stored as the inverse of the change in the same turn (same agent, source and session; `tool_use_id: "revert:<cid>"`) and published as `change.recorded`, which the views already reload on; the net summary then leaves out a file that is back to its content before the turn (created and removed, or changed back), and a partial revert of a file changed several times keeps the rest. Verified: `TestRevertedFilesLeaveTheChanges` and the new list assertion in `TestChangesPerTurnAcrossAgents` (failed before), and a Playwright run against a live harness with the scripted ACP agent (list empty, count gone). Not verified: a revert while an agent's snapshot window is open in the same folders (that window still attributes on-disk changes to the agent, a known limit in v7.md).

**Approvals.**
- `access` default for projects created without it is the server's `HARNESS_DEFAULT_ACCESS`, `full` for `harness serve` until the UI shows approval cards, then it flips to `supervised` (the spec's "new projects supervised"); `HARNESS_DEFAULT_ACCESS=supervised` works now. Library embedders and the Go tests default to `full`. Existing projects are `full`. `scripts/e2e-router.sh` and `scripts/e2e-acp-orchestrator.sh` set `HARNESS_DEFAULT_ACCESS=full` (kept explicit; harmless now that it is the default).
- Scope labels and "Allow all" (2026-11-18, QA: after "Allow all for this request" the same agent still asked to run `echo`). The text above defines `allow_for_turn` as one kind (and program) from one agent, and the harness did exactly that; the labels claimed more. Now: the per-card button names its scope ("Allow edits for this request", "Allow echo commands for this request", "Allow fetches from <host> for this request"; tooltip "Allows <agent>'s … until this request finishes; anything else still asks"), and the resolved line says the same ("Allowed edits for this request"); a memory prompt has no such button. A new decision `allow_all_for_turn` backs the group card's "Allow all for this request": it grants every further request of the turn, any agent, any kind (built-in, ACP `request_permission`, ACP `fs/write_text_file`, memory prompts), and ends with the turn. Verified: `approval/grants_test.go`, bridge `TestAllowForTurnIsPerKind` / `TestAllowAllForTurnCoversEveryFurtherPrompt`, orchestrator `TestACPAllowAllForTurnCoversTheNextPromptOfAnotherKind` (fakeacp `[perm] [fswrite]`), `lib/v7/v7.test.ts`, and a live run on the mock stack in the browser. Not verified with a real ACP agent.
- Gap filled (unattended): an unanswered request is denied after `HARNESS_APPROVAL_TIMEOUT` (default 30 minutes).
- ACP: the card is `kind: "acp"` with the agent's options, command and first location; an allowed `request_permission` for an edit also covers the `fs/write_text_file` that follows (one card per edit); `allow_for_turn` is per tool kind; reads and searches are never asked. The `Approval` has `agent_label`; project JSON has `needs_you`, `pending_approvals`, `pending_inputs`; event `project.attention` was added.
- Fix (2026-11-18): an ACP card now carries the turn's `session_id` like a built-in card. Without it the card was dropped by `GET /approvals?session=` (what the client loads after a reload or an SSE reconnect) and not counted in the session's `needs_you`, so after a reload the card was gone while the turn kept waiting. Verified: `TestACPApprovalBelongsToItsMainSession` (bridge, ACP orchestrator), the session assertion in `TestACPPermissionRequestBecomesAnApprovalAndAllowReachesTheAgent` (ACP sub-agent), and a Playwright reload against a live harness with the scripted ACP agent.

**Queue.**
- `DELETE /queue` (clear) was added; `POST /messages` answers `202 {queued}` (the old `409 turn_in_progress` is gone for this route). A message sent while no turn runs starts a turn even when the queue is paused. After a restart a non-empty queue is paused. `turn.finished` is published after the turn's slot is released.

**Forms and secrets (decision 43).**
- Tool `request_input` for built-in agents (every depth) and the MCP tool list; `/inputs`, `/secrets` as in v7.md; events `input.requested`, `input.resolved` (non-secret values included, secret ids only as `provided`), `secrets.changed`.
- A secret field's id is the secret's name; values under 4 bytes are refused. Use: `bash` `env` and `spawn_agent` `env` with `secret:<name>` references only. Not built: secrets for an ACP orchestrator's own process, remote tool server headers (no header settings exist).
- Everything stored or sent passes a redactor; see v7.md for what is and is not covered.
