# Parallel sessions — design

**Date:** 2026-11-14 · **Status:** approved to build (owner, translated: "We need individual sessions per project AND
project-level ones, like the orchestrator. We cannot keep only one orchestration conversation, because many people
prefer to use sessions per project: one project with some shared memory and sessions in it. Memory can be switched on
and off." · "First projects and then sessions. Everything should be expandable. What to show is configured in
settings." · "Parallelism is important. Parallel sessions can run at the same time in different worktrees. In one
worktree there are no restrictions. But if two sessions work in one worktree they can exchange messages or get context
from each other." · "The default view: projects and sessions." · "Memory of a new session depends on the project's
settings; it must be configurable in the project.")
**Builds on:** [`2026-11-12-project-sessions-design.md`](./2026-11-12-project-sessions-design.md) (sessions as records,
one *current* main session), [`2026-11-11-orchestrator-memory-design.md`](./2026-11-11-orchestrator-memory-design.md)
(M1–M6), [`2026-11-10-v7-changes-queue-approvals.md`](./2026-11-10-v7-changes-queue-approvals.md) (changes, approvals,
queue, forms), [`2026-11-10-subscription-agents-design.md`](./2026-11-10-subscription-agents-design.md) (ACP orchestrator,
the harness MCP server), [`2026-11-10-project-harness-ui.md`](./2026-11-10-project-harness-ui.md) (decisions 1–95).
**Revises:** project-sessions decisions 2 (one current session, Resume), 5 (sidebar rows open the Sessions tab) and 6
(turns of different main sessions never run at once); UI decisions 23 (sidebar lists projects only; never the word
"session"), 26 (Home triage rows are projects) and 63 (the conversation tab is named after the project). The UI part is
recorded as UI decision 96.

Marks used below: **(chosen by the spec)** is a choice the owner did not make, with its reason in one line.

## 1. Concepts and vocabulary

- **Project.** A named set of folders with its instructions, default models and tiers, mode, access, budget, notes,
  memory store, commands, review configuration and secrets. Everything in this list stays per project.
- **Session.** A conversation with the project's orchestrator (`kind: "main"`), or a sub-agent's run (`kind: "agent"`,
  unchanged from 2026-11-12). From now on every main session is addressable and independent: it has its own
  conversation (messages, compactions, context receipts), its own **root agent** (the orchestrator agent row that runs
  it), composer state, turn slot, message queue, approvals and forms (tagged with it), model, mode, memory mode and
  workspace. Several main sessions of one project can run turns at the same time.
- **Default session.** Exactly one main session per project is the default: it receives what is sent to the project
  without a session (`POST /messages`, the "Projects" view, old clients). It replaces "current". Making another session
  the default changes where unaddressed messages go and nothing else; it never stops or rebuilds anything.
- **Workspace.** Where a session's files are. Either the **shared** workspace (the project's folders as they are on
  disk, id `shared`) or a **worktree workspace** (id `wsp_…`): one git worktree per git repository of the project's
  folders, on its own branch. Several sessions may use one workspace, shared or worktree, at the same time with no lock.
- **Memory mode** of a session: `on` (reads and writes project memory), `read` (reads, writes nothing), `off` (neither).
  The project's `memory.new_sessions` is the default for new sessions; a session can override it (section 5).
- **Coordination.** Advisory tools through which sessions that share a workspace see each other's declared plans,
  claimed and touched files, ask about them and leave notes (section 4). Never a lock.

What happens to today's operations:

| Today | From now on |
| --- | --- |
| "Resume" an older main session | Every session is open: opening it shows its conversation and its composer sends to it. `POST /sessions/{sid}/resume` stays as an alias of "make default" (no rebuild, no `turn_in_progress` refusal). |
| `/clear` and "New session" in the project | `/clear` in session S creates a new session with S's carry-over summary, S's workspace and S's memory mode, and the tab switches to it; if S was the default, the new one becomes the default. S is kept. Refused while S runs (409 `turn_in_progress`). "New session" (no source) creates an empty session without a carry-over. |
| One queue, one turn slot, one ACP process per project | One of each per session, within a running cap (section 6). |
| "Only projects" (today's behaviour) | The UI view "Projects": the project row opens the default session; nothing else changes in the harness. |

## 2. Root agent per session (the central storage choice)

Every main session gets its own root agent row (`agents.parent_id IS NULL`, new column `agents.session_id`), and its
sub-agents carry the same `session_id`. **(chosen by the spec)** Reason: messages, streaming, activity, plans, partials,
usage, context and the ACP session are already keyed by agent id in the harness and in the client, so a root per session
separates all of them without a second key. The default session's root is the project's existing orchestrator row, so
`project.orchestrator_agent_id` keeps its meaning (the default session's root). `DB.Orchestrator(ctx)` is replaced by
`DB.RootAgent(ctx, sessionID)` and `DB.DefaultSession(ctx)`.

## 3. Workspaces and worktrees

**Creation.** `POST /workspaces {title?, base_ref?, carry_changes?}` or the `workspace` field of `POST /sessions`.
For each project folder the harness resolves the git top level (`git rev-parse --show-toplevel`); folders in the same
repository share one worktree. Per repository: `git worktree add -b <branch> <dir> <base>` where

- `<dir>` is `{data-dir}/projects/{pid}/worktrees/{wid}/{repo-name}` (repo-name = the top level's base name, made unique),
  never inside the user's checkout **(chosen by the spec: review worktrees already live under the data directory)**;
- `<branch>` is `octo/<slug>-<4 hex>` (slug from the session title, else `session`; a taken name gets new hex)
  **(chosen by the spec: a fixed prefix keeps every harness branch findable and deletable)**;
- `<base>` is `base_ref` when given (a branch, tag or commit), else the base checkout's `HEAD` commit. Stored:
  `base_commit` and `base_branch` (the branch name `HEAD` pointed at, empty when detached).
- A project folder that is a subdirectory of its repository maps to the same subdirectory inside the worktree.

**Uncommitted changes in the base checkout** are not carried unless `carry_changes: true`: then the harness runs
`git stash create` in the base checkout (which leaves it untouched) and `git stash apply <sha>` in the new worktree;
untracked files are never carried. The popover shows "N uncommitted files in <folder> stay in the main checkout" with a
checkbox "Bring them along" (off by default) **(chosen by the spec: the person decides; nothing in their checkout
changes either way)**.

**Non-git folders.** A folder outside any git repository is not copied: in a worktree workspace it resolves to the
original path and is marked `shared: true`; the session's chip says "<folder> is shared with the main checkout". When no
folder is in a git repository, creating a worktree is refused (409 `worktree_unavailable`).

**Listing.** `GET /workspaces` → `{workspaces: [Workspace]}`, shared first, then worktrees newest first:

```json
{ "id": "wsp_7k2…", "kind": "worktree", "title": "Fix login", "state": "ready", "created_at": "…",
  "sessions": ["ses_…"], "running_sessions": 1,
  "folders": [{ "folder_id": "fld_…", "path": "/…/worktrees/wsp_7k2…/atlas/api", "repo_root": "/home/u/atlas",
                "branch": "octo/fix-login-3f2a", "base_branch": "main", "base_commit": "9c1e…", "shared": false,
                "ahead": 2, "dirty_files": 3 }] }
```

`state` is `ready`, `missing` (the directory is gone; found at start-up and on read) or `removed`. `ahead` and
`dirty_files` are computed on `GET /workspaces/{wid}` only (git calls), `null` in the list.

**Getting results back (v1 minimum).** (1) The branch exists in the person's repository from the first moment (a
worktree branch is an ordinary ref), so they can merge, push or review it with their own tools. (2) **Apply to main
checkout**: `POST /workspaces/{wid}/apply {dry_run?}` takes the worktree's changes against `base_commit` (commits and
uncommitted edits; untracked files that are not ignored are included through `git add -N` in the harness's own
worktree), checks them with `git apply --check` in the base checkout and, if clean, applies them as uncommitted
changes there. Nothing partial: a failed check is 409 `apply_conflict` with `details.files`. Applied files are recorded
in the changes ledger with `source: "apply"` and the asking session. **Later:** open a pull request (push the branch
and reuse `codehost`), merge or rebase onto the base branch, a commit button, review the branch in the review
workspace, automatic clean-up.

**Clean-up.** `DELETE /workspaces/{wid}?force=&delete_branch=`: 409 `workspace_in_use` while a session in it runs;
409 `workspace_dirty` with the files when it has uncommitted changes and `force` is not set; removes the worktree
(`git worktree remove`, then `git worktree prune`) and keeps the branch unless `delete_branch=true`. Sessions in a
removed workspace move to the shared workspace (their conversations stay; a quiet marker says so). Deleting a session
offers to remove its worktree when no other session uses it. Archiving keeps it. At start-up the harness runs
`git worktree prune` per repository and marks vanished directories `missing`. No time-based removal **(chosen by the
spec: losing someone's unmerged work is worse than disk use)**.

**Which workspace a thing resolves to.** Every session-scoped operation uses its session's workspace:

| Surface | Resolution |
| --- | --- |
| Built-in file tools, `list_dir`, instruction files (`AGENTS.md`, …) | the workspace's folder paths (`rt.roots()` from the workspace) |
| `bash` cwd | the workspace's first folder |
| ACP orchestrator and ACP sub-agents | `session/new` cwd = the workspace's first folder; `fs/*` confined to the workspace folders |
| Files panel, file API | `GET /files?folder=&path=&workspace=<wid>` (absent: `shared`); the UI passes the focused session's workspace |
| Language servers | `POST /lsp/{server}/sessions?workspace=<wid>` (generalises today's `?workspace=review`); one server per workspace, started lazily |
| Commands (Tests, Typecheck, Run) | `POST /commands/{name}/run {workspace_id?}`; the UI passes the focused session's workspace; `command_runs.workspace_id` |
| Changes | one tracker per workspace (today one per project); `GET /changes?session=&workspace=` |
| Review (RV1) | unchanged in v1; reviewing a session branch is listed under "Later" |

**Changes attribution.** Each change row gets `session_id`, `workspace_id` and `attribution`: `exact` (`write_file`,
`acp_fs`, `apply`), `window` (a `bash` or `acp_turn` snapshot window that no other session's window overlapped in that
workspace) or `ambiguous` (another session's window overlapped; the change is filed under the window that ended first,
as for parallel sub-agents today, and the UI says "may be from another session"). Two sessions changing one file
produce two rows, one per session; the Changes panel lists per session, and "All sessions" merges them by file.

## 4. Coordination between sessions

**Scope.** Project setting `sessions.coordination`: `workspace` (default: tools see sessions in the same workspace),
`project` (all main sessions of the project, with `same_workspace` marked) or `off` (tools not offered).
Conflict warnings (below) only ever concern sessions in the same workspace, since only they touch the same files.

**Tools.** The built-in orchestrator registry and the harness MCP server (`octo-harness`) offer the same five tools with
the same JSON schemas. They are always in the tool list while coordination is not `off`, so the list (and the prompt
cache) does not change when a second session appears **(chosen by the spec)**. Sub-agents get `list_sessions` only, and
their writes get the warnings.

| Tool | Input | Result |
| --- | --- | --- |
| `list_sessions` | `{scope?: "workspace"\|"project"}` | `{sessions: [{session_id, title, state, same_workspace, workspace: {id, kind, branch?}, plan?: {summary, steps, updated_at}, claims: [{path, intent, expires_at}], touched: [{path, kind, at}], last_request?}], self: session_id}` — other live (not archived) main sessions; `touched` = this workspace's changes by that session in the last 2 h, at most 30; `last_request` = first line, 200 characters |
| `ask_session` | `{session_id, question}` | Answered **by the harness** from the other session's state: `{answered_by: "harness", session, state, plan, claims, touched, recent_activity: [last 5 tool titles], last_request?, last_answer?: first 500 characters, note}`; `note` says "This is the session's declared and observed state, not a reply from its model. To ask its model, use message_session with reply_requested." Paths named in the question are listed first. |
| `declare_plan` | `{summary, steps?: string[], ttl_minutes?}` | Replaces this session's declaration; `{}` clears it. Summary at most 500 characters, at most 12 steps of 200. Expires `ttl_minutes` (default 120, 5–480) after its last update; cleared on archive and delete. Without a declaration, `list_sessions` shows the session's latest `agent.plan` as its plan. |
| `claim_files` | `{paths: [{path, intent: "edit"\|"create"\|"delete"}], ttl_minutes?, release?: boolean}` | Adds (or with `release` removes) advisory claims; paths are `folder/relative` like the file tools; at most 50 live claims per session; default expiry 60 minutes. |
| `message_session` | `{session_id, text, reply_requested?}` | `{delivered: "next_step"\|"next_tool_result"\|"next_turn"}`; text at most 2 000 characters. |

**Why `ask_session` does not wake the other model (chosen by the spec).** It is instant, costs no tokens, cannot
deadlock (two sessions asking each other in the same step both get answers) and never interrupts the other session's
turn. The question the owner named ("what are your plans and which files will you use") is exactly the declared plan,
claims and touched files. A question that needs the other model goes through `message_session` with
`reply_requested: true`; the other model may answer with its own `message_session`. Nothing ever blocks on a reply.

**Delivery of a `message_session` note** to session T: a built-in T that is running takes it at its next tool boundary
as a user message with `command: "session_message"` (the steer mechanism); an ACP T that is running gets it appended to
the result of the next harness MCP tool it calls (an ACP prompt cannot take input mid-turn); an idle T stores it and
puts it before the next request, like `session_report`. A note never starts a turn **(chosen by the spec: a session
must not spend tokens because another one spoke)**. Limits: 10 coordination calls of each kind per session per turn
(the 11th is a tool error), at most 5 notes delivered per step, a note to oneself or to an archived session is refused.
Loops are bounded because nothing waits and nothing starts a turn.

**Conflict warnings.** When any agent of session S writes `path` in workspace W (built-in `write_file`, ACP
`fs/write_text_file`, or a change found by a `bash`/`acp_turn` window), the harness checks: (a) a live claim on `path` by
another session in W; (b) a change to `path` by another session in W after S last read it (reads are tracked in memory
per session: built-in `read_file`, ACP `fs/read_text_file`, ACP tool calls of kind `read`). A hit appends one line to the
tool result (`[octo] src/auth.go is claimed by session "Fix login" (edit). Check with list_sessions or message_session
before continuing.` or `… was changed by session "Fix login" at 14:03, after you read it at 14:01; read it again.`).
Where a result cannot carry text (ACP `fs/write_text_file`, windows) the warning is delivered like a note. Nothing is
refused. Every warning is a coordination record.

**Records and events.** Table `session_messages` keeps asks, notes, replies and warnings. Event
`session.message {message: {id, kind: "ask"|"note"|"warning", from_session_id, to_session_id, text, answer?,
created_at, delivered_at?}}`; `session.plan {session_id, plan, claims}` when a declaration or claim changes.
`GET /sessions/{sid}/coordination` → `{plan, claims, inbox, sent}` (last 100).

**What the person sees.** A quiet one-line row (the `session_report` style, `fg-3`, no bubble) in both transcripts at
the point it happened: "Asked *Fix login* about its plan" (expands to the answer), "*Refactor auth* asked about this
session's plan", "Note from *Fix login*: …", and under a tool row "src/auth.go is claimed by *Fix login*". A session
title is a link that opens that session.

**Privacy and memory.** Coordination is about live state, not memory, so a session with memory `off` still
coordinates **(chosen by the spec)**; but `ask_session` and `list_sessions` never return `last_request` or
`last_answer` of a session whose memory mode is `read` or `off` (its words do not feed other contexts); plan, claims and
file paths are still shown. Coordination makes no model call; its only cost is the tokens of results and notes in the
receiving context, bounded by the limits above.

## 5. Memory

**Project setting.** `memory` gains `new_sessions: "on" | "read" | "off"` (default `on`, today's behaviour). The
existing `context` (`full` | `window`) and `recent_exchanges` stay project-wide.

**Per session.** `sessions.memory_mode` is fixed at creation from the request (`memory: "project" | "on" | "read" |
"off"`, where `project` copies `new_sessions`) and can be changed with `PATCH /sessions/{sid} {memory}`; it applies from
the session's next turn. Changing the project default never changes existing sessions.

| | `on` | `read` | `off` |
| --- | --- | --- | --- |
| Tools `memory_search`, `recall_message`, `memory view` | yes, all sessions' memory | yes | not offered |
| `remember`, `task_update`, `memory create/str_replace/…` | yes | refused (tool error "This session reads project memory but does not write to it.") | not offered |
| Window mode blocks (index, open tasks, facts), previous-session pointer, `/clear` carry-over | yes | yes | no (the carry-over of `/clear` from the same session is kept: it is the session's own conversation) |
| Its exchanges | recorded and indexed for search | recorded with `private = 1`, not indexed | recorded with `private = 1`, not indexed |
| Post-turn digest, task records | yes | no | no |
| Notes | read, index and pinned notes in the prompt, `write_note` | read only | pinned notes and the index stay in the prompt; `read_note`/`search_notes` yes; writes refused |

Notes stay visible to `off` sessions because they are what the person wrote down for the project, not what the harness
learnt **(chosen by the spec)**. A private exchange is shown in its own session and in the Memory → Sessions list
(marked "not shared"), never in search or in another session's context.

**Search across sessions.** Hits gain `session_id` and `session_title`; `memory_search` and
`GET /memory/search` take `session` (one session only) and `exclude_session`; `search_docs.session_id` holds the
owner session of message and exchange documents. Facts and tasks carry the session they came from (tasks already have
`session_id`).

**Migration.** Every existing session gets `memory_mode = 'on'`; projects get `new_sessions: "on"`.

## 6. Concurrency and limits

- **Turn slot per session.** `Orchestrator.turns`, `live`, `steer`, `sendNow` and the ACP host are keyed by
  `pid/sid`. `ErrTurnInProgress` is per session. `Running(pid)` means "any session runs".
- **Running cap.** A turn starts only while the project runs fewer than `sessions.max_running` turns (project setting,
  default 3, 1–8) and the harness fewer than `HARNESS_MAX_RUNNING_SESSIONS` (harness setting, default 6, 1–32).
  Otherwise the message is queued in its session with `waiting_for: "slot"` and the session's state is `queued`;
  slots are handed out in the order the waiting messages were queued, across sessions and projects. Agent sessions
  (sub-agents) do not count against the cap (they run inside a counted turn) **(chosen by the spec: 3 keeps a laptop
  responsive with ACP processes; 1 restores today's behaviour)**.
- **Queue.** Per session: at most 20 waiting messages (409 `queue_full`), paused per session (`sessions.queue_paused`)
  after a failed or cancelled turn and after a crash. `project.queue_paused` is no longer read.
- **ACP processes.** One per running or recently used session; idle shutdown as today (`HARNESS_ACP_IDLE`). When more
  than `max_running + 2` processes of a project are alive, the least recently used idle one is shut down; its session
  resumes with `session/load` or the recap.
- **Budget.** The existing gate runs before every model request of every session, so a reached budget stops all of the
  project's sessions at their next request. Parallel requests already in flight can overshoot by at most one request per
  running agent; this is accepted and documented, no reservation **(chosen by the spec: a reservation needs a price
  before the request, which flat-rate and ACP agents do not give)**.
- **Events.** Every event about a session's work carries `session_id`: `message.*`, `tool.*`, `agent.*` (the agent row
  has `session_id`), `turn.finished`, `queue.updated`, `approval.*` and `input.*` (the items have `session_id`),
  `change.recorded`, `context.updated`, `plan.*`, `conversation.*`, `session.*`. The project stream keeps one `seq`;
  events of one session are in the order they happened; nothing is promised between sessions beyond `seq` order.
- **Project status and attention.** `status` is `running` while any session runs. The summary gains
  `sessions: {total, running, queued, needs_you, failed}`; `project.attention` gains
  `sessions: [{session_id, needs_you, approvals, inputs, failed}]`. Cancelling a session's turn denies only its
  approvals and closes only its forms.
- **Crash recovery.** `RecoverInterrupted` runs per main session: each root agent left running is closed, its
  exchange recorded `interrupted`, its non-empty queue paused.

## 7. Storage: schema 15

File `apps/harness/internal/projectstore/migrate_v15_parallel_sessions.go`; `SchemaVersion = 15`. Columns are added
only when missing and tables use `IF NOT EXISTS`; the data rewrite runs once, for a database stamped below 15.

| Table | Change |
| --- | --- |
| `sessions` | `workspace_id TEXT NOT NULL DEFAULT 'shared'`, `memory_mode TEXT NOT NULL DEFAULT 'on'`, `mode TEXT NOT NULL DEFAULT ''` (empty: the project's), `queue_paused INTEGER NOT NULL DEFAULT 0`, `root_agent_id TEXT NOT NULL DEFAULT ''`; `current` now means "default" |
| `agents` | `session_id TEXT NOT NULL DEFAULT ''`; index `(session_id)` |
| `queue` | `session_id TEXT NOT NULL DEFAULT ''`, `waiting_for TEXT NOT NULL DEFAULT ''` |
| `changes` | `session_id`, `workspace_id` (default `'shared'`), `attribution` (default `'exact'`) |
| `command_runs` | `workspace_id TEXT NOT NULL DEFAULT 'shared'` |
| `plans` | `session_id TEXT NOT NULL DEFAULT ''` |
| `exchanges` | `private INTEGER NOT NULL DEFAULT 0` |
| `search_docs` | `session_id TEXT NOT NULL DEFAULT ''` |
| new `workspaces` | `id TEXT PRIMARY KEY, kind TEXT, title TEXT, state TEXT, carry_changes INTEGER, created_at TEXT, removed_at TEXT` |
| new `workspace_folders` | `workspace_id, folder_id, path, repo_root, branch, base_branch, base_commit, shared INTEGER`, primary key `(workspace_id, folder_id)` |
| new `session_declarations` | `session_id TEXT PRIMARY KEY, summary, steps_json, updated_at, expires_at` |
| new `file_claims` | `id INTEGER PRIMARY KEY, session_id, workspace_id, folder_id, path, intent, created_at, expires_at` |
| new `session_messages` | `id INTEGER PRIMARY KEY, kind, from_session_id, to_session_id, text, answer_json, reply_requested INTEGER, turn_id INTEGER, created_at, delivered_at` |
| `project_settings` | key `sessions`: `{max_running, default_workspace: "shared"\|"worktree", coordination}` |
| `project.memory_json` | gains `new_sessions` |

**Back-fill.** Before the rewrite: `VACUUM INTO project.sqlite.pre-v15` (numbered name if taken; no backup when there
is nothing to rewrite), as M6 does. Then, in one transaction: a `workspaces` row `shared`; every main session gets
`workspace_id = 'shared'`, `memory_mode = 'on'`; the current main session stays the default and its `root_agent_id` is
the existing orchestrator row; every other main session that has messages gets a new root agent row (role, model and
tier copied, status `completed`) and its messages, compactions, plans, partials and context receipts move to it (by
`messages.session_id` and turn ids); its agent sessions' agents get `parent_id` = the new root; `agents.session_id` is
filled for every agent through `sessions.agent_id` and the parent chain; queue rows go to the default session;
`changes.session_id` from the session of the turn's user message; `search_docs.session_id` from the exchange or message.
Usage rows are not moved: usage of sessions from before the upgrade stays on the default session's root, while each
exchange keeps its own tokens and cost (the per-project totals are unchanged). Logged as `parallel sessions back-fill`.

**Idempotency and downgrade.** Running the migration twice changes nothing (columns checked, the rewrite guarded by
the stamp and by `root_agent_id` already set). An older binary refuses a database stamped 15 (`NewerSchemaError`, as
today); going back means restoring `project.sqlite.pre-v15` while the harness is stopped. Worktrees on disk are not
touched by a downgrade.

## 8. Bridge API

All under `/v1/projects/{pid}`; errors have the usual shape and catalogue fields (`apps/harness/docs/errors.md`).

**Session JSON** adds: `default` (the old `current` stays as an alias with the same value for one release),
`root_agent_id`, `workspace: {id, kind, title, branch?}`, `memory: "on"|"read"|"off"`, `memory_inherited` (true while it
equals the project default it was created from), `mode`, `queued` (waiting messages), `needs_you`,
`pending_approvals`, `pending_inputs`, `plan_summary?`. `state` gains `queued`. A main session's `can_message` is true
unless the built-in loop it needs is unavailable (`builtin_loop_unavailable`); `not_current` is no longer produced.

| Route | Body → result |
| --- | --- |
| `POST /sessions` | `{title?, workspace?: {kind: "shared"} \| {kind: "worktree", base_ref?, carry_changes?} \| {id}, memory?: "project"\|"on"\|"read"\|"off", model?, mode?, make_default?, text?, from_session_id?, clear?}` → 201 `{session, message?, queued?}`. `text` sends the first message. `from_session_id` with `clear: true` is `/clear` of that session. 404 `workspace_not_found`, 409 `worktree_unavailable`, 502 `worktree_failed`. |
| `POST /sessions/{sid}/messages` | Main session: `{text, mode?, attachments?}` → 202 `{message}` or 202 `{queued, waiting_for: "turn"\|"slot"}`; an archived session is unarchived. Agent session: unchanged. 409 `queue_full`, 422 `images_unsupported`. |
| `POST /sessions/{sid}/stop` | Main session: cancels its turn and pauses its queue. Unchanged for agents. |
| `GET/DELETE /sessions/{sid}/queue`, `PATCH/DELETE /sessions/{sid}/queue/{qid}`, `POST /sessions/{sid}/queue/resume`, `POST /sessions/{sid}/queue/{qid}/send-now` | As the project queue routes today, for one session. |
| `POST /sessions/{sid}/default` | 200 `{session}`; `session.default` event. `/resume` is an alias. |
| `PATCH /sessions/{sid}` | adds `{memory?, model?, mode?}`; `model` and `memory` while the session runs apply from its next turn. |
| `DELETE /sessions/{sid}` | as today; also refused for the default (409 `current_session`, the existing code); `?remove_workspace=true` removes its worktree when nobody else uses it. |
| `GET /sessions/{sid}/context`, `POST /sessions/{sid}/compact`, `POST /sessions/{sid}/clear`, `POST /sessions/{sid}/rewind`, `GET /sessions/{sid}/plans/latest`, `GET /sessions/{sid}/export`, `GET /sessions/{sid}/coordination` | the project routes of the same name, for one session (`clear` answers like `POST /sessions` with `clear`). |
| `GET /changes?session=&workspace=`, `GET /approvals?session=`, `GET /inputs?session=` | filters; items carry `session_id`. |
| `POST /side {text, session_id?}` | the side question reads that session's conversation (absent: the default). |
| `GET /workspaces`, `POST /workspaces`, `GET /workspaces/{wid}`, `POST /workspaces/{wid}/apply {dry_run?}`, `DELETE /workspaces/{wid}?force=&delete_branch=` | section 3; 409 `apply_conflict`, `workspace_dirty`, `workspace_in_use`; 410 `workspace_missing` for a vanished directory. |
| `GET /v1/sessions?kind=main&state=&archived=&limit=&before=` | across projects, newest activity first, each with `project_id`, `project_name`; limit 1–200 (default 100). |

**Compatibility aliases (kept):** `POST /messages`, `/cancel`, `/queue*`, `/clear`, `/compact`, `/rewind`, `/context`,
`/plans/latest` and `/export` act on the **default** session; `POST /cancel?all=true` stops every session.
`GET /agents/{aid}/messages` works for any root. `session.current` is still published, after `session.default`.

**Events added:** `session.default {session_id, previous_session_id}`, `session.message`, `session.plan`,
`workspace.updated {workspace}` (created, ready, missing, removed, applied).

**Catalogue additions** (`internal/usererr/catalogue_service.go`, with samples in `TestCatalogueWording`):
`WorktreeUnavailable` ("None of this project's folders is in a git repository, so a separate worktree cannot be
made."), `WorktreeFailed` (git's text as `details`, action `retry`), `WorkspaceNotFound`, `WorkspaceMissing`,
`WorkspaceDirty` ("This worktree has uncommitted changes."), `WorkspaceInUse`, `ApplyConflict` ("Some changes do not
apply cleanly to the main checkout."), `CoordinationOff`.

## 9. Client (`packages/agent-client`)

- **Types.** `ProjectSession` gains the fields of section 8; new `Workspace`, `WorkspaceFolder`, `SessionMessage`,
  `SessionPlan`, `FileClaim`; `Agent.session_id`, `QueuedMessage.session_id`/`waiting_for`, `Approval.session_id`,
  `InputRequest.session_id`, `FileChange.session_id`/`workspace_id`/`attribution`; `ProjectInput.sessions`,
  `MemorySettings.new_sessions`; `BridgeEventType` adds the four events.
- **State.** `ProjectState` keeps agent-keyed maps (each session's root is an agent). Session-scoped parts move into
  `sessions: { list, defaultId, byId: Record<sid, SessionSlice> }`, where `SessionSlice = { rootAgentId, queue:
  {paused, messages}, lastTurn, turnOutcomes, coordination: SessionMessage[], plan?: SessionPlan }`; `currentId` stays
  as a deprecated alias of `defaultId`. Approvals and inputs stay project lists (the Home and the attention count need
  all of them) and are filtered by selectors `sessionApprovals(state, sid)`, `sessionInputs(state, sid)`.
- **Reducer.** Routes by the event's `session_id` (falling back to the agent's `session_id`, then the default session);
  `queue.updated` without `session_id` goes to the default session (an older harness). `session.default` moves
  `defaultId`; `session.message` appends to both slices.
- **Methods.** Required in `Bridge` and in `BRIDGE_METHODS` (the message-port bridge forwards them):
  `sendSessionMessage(pid, sid, text, opts)`, `stopSession` (exists), `createSession(pid, input)` with the new input, `setDefaultSession`,
  `listAllSessions(params)`. Optional, HTTP only: the per-session queue methods, `getSessionCoordination`,
  `listWorkspaces`, `getWorkspace`, `createWorkspace`, `applyWorkspace`, `removeWorkspace`; `listFiles`, `readFile`,
  `writeFile`, `createLanguageServerSession` and `runCommand` take an optional `workspaceId`. The demo bridge implements
  all required members.

## 10. UI (UI decision 96)

**Words.** "Session" is now a word of the product (revises decision 23's word rule); a project is still "a project's
orchestrator at work": each session is that orchestrator working on one line of work.

**Views.** Setting **Settings → General → "Sidebar shows"** (`Segmented`: "Projects and sessions" (default) ·
"Projects" · "Sessions"), stored as `PREFS.sidebarView` (`key("sidebarView")`, `"tree" | "projects" | "sessions"`)
**(chosen by the spec: it changes how one works, not how things look, so General rather than Appearance)**.

- **Projects and sessions** (`tree`). Sidebar is a `role="tree"`: project rows (32 px, 40 under touch, decision 29
  glyph) with a leading disclosure chevron; under an open project its main session rows one step in (16 px), 32 px:
  state glyph · title · meta (activity time, or a branch glyph for a worktree session). The project glyph summarises
  its sessions: needs you > failed > working > queued > unseen > idle; its meta is "2 running" while more than one runs.
  Open by default: the active project and any project with a working or needs-you session; the rest remember their
  state (`PREFS.sidebarOpen`). An open project shows its 5 most recently active sessions plus any working or needs-you
  ones beyond them, then "Show all (N)", which shows up to 50 in place and then "Open Sessions". A "+" icon button at
  the project row's right on hover/focus (always under touch) opens `NewSessionPopover`. Clicking a project row opens
  its last focused session (else the default) and expands it.
- **Projects** (`projects`). Today's sidebar: project rows only, the row opens the default session, `/clear` and
  "New session" replace the default as today. `SidebarSessions` (the chevron of 2026-11-12) is removed in every view.
- **Sessions** (`sessions`). A flat list of main sessions across projects, newest activity first (from
  `GET /v1/sessions`), each row glyph · title · meta "Project · 4m"; the header's "+" popover adds a Project select.

Data for rows outside the open project comes from `listAllSessions`, re-read when a project's `updated_at` moves
(the pattern of `useOrchestrators`); the open project's rows are live from its stream.

**Row menu** ("⋯", and the context menu): Rename · Make default · Open in new tab · Stop (while running) · Archive ·
Delete… · for a worktree session: Apply to main checkout… · Remove worktree…. **Keyboard:** ↑/↓ move, → opens a project
or moves into it, ← closes it or goes to its project row, Enter opens, Home/End, typing a letter jumps by title.

**`NewSessionPopover`** (`components/sessions/NewSessionPopover.tsx`, `Popover` + `FieldRow`s): Title (optional,
placeholder "From the first request") · Workspace (`Segmented`: "Main checkout" · "New worktree", plus a `Select` of
existing worktrees when there are any; for "New worktree" a base field defaulting to the current branch and the
"Bring them along" checkbox with the uncommitted count) · Memory (`Select`: "Project default (On)" · On · Read only ·
Off) · **Create** (Enter). Defaults from the project's `sessions.default_workspace` and `memory.new_sessions`.
`NewSessionButton` and its carry-over text (decision 95e) stay for `/clear`.

**Routes.** `#/p/<pid>/s/<sid>` opens a session; `#/p/<pid>` opens the project's last focused session (local), else the
default; `#/p/<pid>/a/<aid>` (agent tabs) is unchanged. `lib/route.ts` `Route` gains `sessionId`.

**Tabs.** A conversation tab is a session (`chat:<sid>`; the existing `session:<id>` tab kind of a main session becomes
this tab). Its title is the session's title, the dim part of the title bar is "Project / Session" (revises decision 63;
in the "Projects" view the tab keeps the project's name). Two sessions of one project side by side are two
conversation tabs in two dock groups. The floating composer (decision 8) sends to the focused group's session.

**Composer.** The context bar (decision 30, upper layer) shows the session chip — its title, and for a worktree the
branch glyph and name (`octo/fix-login-3f2a`) — so it is always visible which session and workspace a message goes to;
the chip's menu has Make default, Workspace details, Apply to main checkout. The composer row keeps its four controls
(decision 91). Queued messages waiting for a slot say "Waiting for a free slot (3 sessions running)".

**Status bar.** One item for the focused session's workspace: branch glyph, branch, "3 changed" (opens Changes filtered
to the session); nothing for the shared workspace.

**Transcript.** `CoordinationRow` (`components/chat/`, the quiet `session_report` style) for asks, notes and warnings
(section 4); "Changes may be from another session" marks ambiguous change rows.

**Home.** Tiles count sessions; the list's "Needs you", "Working" and "Ready to review" groups are session rows (project
as meta), "Idle" lists projects collapsed (revises decision 26). In the "Projects" view Home is as today.

**Palette.** A "Sessions" group (title, project, state glyph), the action "New session in <project>", and "Requests"
results open their session at the turn.

**Sessions tool tab** becomes the project's session manager (all, archived, agents; `Panel` frame of 95f): "Resume"
becomes "Open" (opens the session tab), "Make default" replaces "current". Filters: All · Working · Worktrees · Agents ·
Archived.

**Settings → project** (`ProjectSections`): a **Sessions** section — "Sessions running at once" (`NumberField` 1–8),
"New sessions work in" (`Segmented` Main checkout · New worktree), "Sessions coordinate" (`Select` Within a workspace ·
Across the project · Off), and under **Memory**: "New sessions" (`Segmented` On · Read only · Off). Settings → General
(harness settings): "Sessions running at once on this machine" (`HARNESS_MAX_RUNNING_SESSIONS`).

All of this uses the existing frame, list rows (32/40), the decision-29 glyph family and the tokens; nothing coloured is
added (decision 81).

## 11. Phasing

Each phase ships on its own and is verified with the mock model (`examples/mockllm`) and the scripted ACP agent
(`internal/fakeacp`); a real CLI or key is the owner's live run.

| Phase | Work | Verified here | Owner's live run |
| --- | --- | --- | --- |
| **P1 Harness: addressable, concurrent sessions (shared workspace)** | Schema 15 without workspace tables' use; root agent per session; per-session slot, queue, steer, ACP host, approvals/inputs tags; running caps; routes and aliases of section 8 except workspaces and coordination; events with `session_id`; recovery per session. Files: `projectstore/{migrate_v15_parallel_sessions,project_sessions,agents,queue}.go`, `orchestrator/{orchestrator,queue,steer,sessions,recover,acp_host,clear}.go`, `project/sessions.go`, `bridge/sessions.go`, `usererr`. | Migration tests from a 14 fixture (three main sessions, current one in the middle, agent sessions, queue, changes); two sessions' turns overlapping with a mock reply held open (a new mock marker `[hold]` released by a test hook); ACP: two sessions start two fake agent processes; cap 1 queues the second with `waiting_for: "slot"`; crash recovery of two sessions; aliases; `-race`. New `apps/harness/scripts/e2e-sessions.sh`. | Two Claude Code sessions running at once in one project. |
| **P2 Client and UI** | Types, reducer, methods, message bridge, demo bridge; sidebar tree and the three views, `NewSessionPopover` (shared only), session tabs and routes, composer chip, Home, palette, Sessions tab changes, settings. | agent-client tests (routing by `session_id`, old-harness fallback); UI view-model tests (tree, summary glyph, "Show all", views, triage); Playwright on `?demo=1` (two sessions running side by side, keyboard tree walk, each view) in dark and light at 1440×900, 900×600 and 390×700; spacing audit total=0. | The app against a real harness with two running sessions. |
| **P3 Worktrees** | Workspace tables and routes, `gitx` worktree helpers, per-workspace trackers, files, LSP and commands by workspace, apply, clean-up, attribution; UI: popover worktree options, status bar, row menu actions. | Go tests on temporary repositories: two folders in one repo, a subfolder, a non-git folder, detached `HEAD`, `carry_changes`, apply clean and conflicting, remove dirty and in use, vanished directory, prune at start; e2e case in `e2e-sessions.sh`. | A real ACP agent working inside a worktree (its cwd and its own tools). |
| **P4 Coordination** | The five tools in both registries, delivery, warnings, records, events, UI rows. | Unit tests per tool; two mock sessions in one workspace: claim then write by the other gives the warning; stale read warning; notes delivered at a tool boundary and through an MCP tool result (fake agent); per-turn limits; private sessions' text withheld; no model request is made by `ask_session` (request count). | Whether real models use the tools well. |
| **P5 Memory modes** | `new_sessions`, `memory_mode`, tool sets per mode, private exchanges, search filters, UI selects. | Tool lists per mode; a `read` session's `remember` refused; an `off` session's exchange absent from search and from another session's window blocks; migration default `on`. | — |

**Later** (not in this design's scope): pull request from a session branch, merge or rebase, a commit button, reviewing
a branch in the review workspace, model-answered `ask_session`, automatic worktree clean-up, per-session usage in the
Usage view.

## 12. Acceptance criteria

1. A database stamped 14 opens as 15; the current main session is the default and keeps the old orchestrator row as its
   root; every other main session with messages has its own root with exactly its messages and compactions.
2. Opening a migrated database a second time changes no row; `project.sqlite.pre-v15` exists after a rewrite and not
   when there was nothing to rewrite.
3. A binary with schema 14 refuses a database stamped 15 and leaves it untouched.
4. `POST /sessions` creates a session that is not the default unless `make_default`; the default does not change.
5. Two main sessions of one project run turns at the same time; each one's `message.*`, `tool.*` and `turn.finished`
   events carry its `session_id` and its root agent id.
6. A message to a session whose turn runs is queued in that session only; the other session's queue is unchanged.
7. With `sessions.max_running = 1`, a second session's message is queued with `waiting_for: "slot"`, its state is
   `queued`, and it starts when the first turn ends.
8. The harness-wide cap holds across two projects, and waiting messages start in the order they were queued.
9. `POST /messages`, `/cancel`, `/queue` and `/clear` act on the default session only; `POST /cancel?all=true` stops all.
10. Stopping one session denies only that session's pending approvals and closes only its forms.
11. Two ACP sessions run two agent processes with two MCP tokens, each bound to its own root agent; a token of one
    cannot act as the other.
12. After a simulated crash with two running sessions, both are closed `interrupted` and both non-empty queues are
    paused.
13. `/clear` in a non-default session creates a session in the same workspace with the same memory mode and leaves the
    default unchanged.
14. A worktree workspace for a project whose two folders live in one repository creates one worktree and one branch
    named `octo/<slug>-<hex>`; both folders resolve inside it.
15. A non-git folder in a worktree workspace resolves to its original path and is marked `shared`; a project with no
    git folder gets 409 `worktree_unavailable`.
16. With `carry_changes: true` the worktree has the base checkout's tracked uncommitted edits and the base checkout is
    byte-for-byte unchanged.
17. A session in a worktree reads and writes files only under the worktree paths (built-in tools, `bash` cwd, ACP cwd
    and `fs/*`).
18. `GET /files?workspace=<wid>` and an LSP session with `?workspace=<wid>` serve the worktree's files.
19. Apply to main checkout puts the worktree's changes in the base checkout as uncommitted edits; a conflicting apply
    is 409 `apply_conflict` and changes nothing.
20. Removing a dirty worktree without `force` is 409 `workspace_dirty`; with a running session it is 409
    `workspace_in_use`; after removal the branch still exists unless `delete_branch=true`.
21. A worktree whose directory vanished is `missing` after a restart, and its sessions can still be read.
22. Changes are listed per session; a change made while another session's window was open in the same workspace has
    `attribution: "ambiguous"`.
23. `list_sessions` in session A lists session B of the same workspace with B's declared plan and claims; with
    `coordination: "off"` the tools are not offered.
24. `ask_session` returns B's state without any model request and without interrupting B's turn.
25. A `message_session` note reaches a running built-in session at its next tool boundary, a running ACP session in its
    next harness tool result, and an idle session before its next request; it never starts a turn.
26. Writing a file claimed by another session in the same workspace, or changed by it since the writer read it, adds
    the warning line to the tool result and refuses nothing.
27. The 11th coordination call of one kind in a turn is a tool error; a note to oneself is refused.
28. A session with memory `read` or `off` never exposes its request or answer text through coordination tools.
29. A new session without `memory` takes the project's `memory.new_sessions`; changing the project default does not
    change existing sessions.
30. A `read` session can search project memory and its `remember` is a tool error; an `off` session is not offered the
    memory tools and its exchanges never appear in search or in another session's context.
31. Search hits carry `session_id` and `session_title`, and `session=` restricts them.
32. The sidebar's default view is "Projects and sessions"; the setting switches to "Projects" (rows open the default
    session) and to "Sessions" (flat list across projects, newest activity first).
33. The tree is fully usable with the keyboard (↑/↓/→/←/Enter) and a project shows at most 5 recent sessions plus the
    working and needs-you ones before "Show all (N)".
34. The composer always shows the session it sends to and, in a worktree, the branch.
35. Two sessions of one project can be open side by side, typing in each sends to that session, and both stream at once.
36. Home's needs-you, working and ready-to-review groups list sessions with their project as meta.
37. A coordination ask shows a quiet row in both transcripts, each linking to the other session.

## 13. Risks

- **Git worktree edge cases:** submodules are not initialised in a worktree (v1 says so in the workspace details);
  LFS files may be pointers until fetched; a branch checked out in one worktree cannot be checked out in another (the
  harness always creates new branches); hooks in the repository run in the worktree; a repository with
  `extensions.worktreeConfig` or a bare layout is untested.
- **Disk use:** each worktree is a full checkout of each repository (build outputs and `node_modules` grow per
  worktree); the workspace details show the count of worktrees; there is no automatic removal.
- **ACP agents and cwd:** some agents may read their own config relative to the repository root or keep global state
  per directory; a second process per project doubles memory and subscription rate use.
- **MCP re-entrancy:** two sessions' agents call the MCP server at once; tool handlers must take the session from the
  token binding, never from project-wide state (the `runtime` of a turn is per session).
- **Cost of cross-talk:** notes and warnings add tokens to contexts; the per-turn limits and the 2 000-character cap
  bound it, and the prompt cache is kept because the tool list never changes.
- **Budget races:** parallel requests can overshoot the budget by one request per running agent.
- **Ambiguous attribution:** snapshot windows of two sessions in one workspace cannot always tell who changed a file;
  the UI says so rather than guessing.
- **Migration rewrite:** moving messages between agent rows is the riskiest step; it is one transaction after a backup
  and is tested on a fixture with sub-agents, compactions, plans and partials.

## 14. Open questions for the owner (each with the default work proceeds with)

1. **Running caps.** Default 3 per project and 6 on the machine? *Default: yes.*
2. **Workspace of a new session.** Main checkout or a new worktree by default? *Default: main checkout (no git
   surprises for a first-time user; the project setting can flip it).*
3. **Coordination scope.** Only sessions in the same workspace, or the whole project? *Default: same workspace.*
4. **A note to an idle session.** Should `message_session` start a turn there? *Default: no, it waits for the next
   request.*
5. **Notes in a memory-off session.** Keep the project's pinned notes and the notes index in its prompt? *Default: yes.*
6. **Results back from a worktree.** Is "Apply to main checkout" plus the branch enough for v1, with the pull request
   later? *Default: yes.*

**Owner, 2026-11-14:** "Do it; decide yourself what is better." Work proceeds with every default above. One addition
by the orchestrator: because `ask_session` is answered from declared and observed state, a session's briefing tells it
to call `declare_plan` (and `claim_files` for files it is about to edit) at the start of a turn whenever another live
session shares its workspace, so the answers are not empty.

## As built

Nothing built yet.
