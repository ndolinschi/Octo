# Parity backlog — what we add after comparing with OpenCode and Cursor

**Date:** 2026-11-12 · **Status:** approved to build (owner: "check our features against OpenCode and Cursor … and add
them to us") · **Source:** research note `2026-11-12-feature-comparison.md` (not in the public tree)
(a sub-agent's report; OpenCode was run without a model, Cursor is from its public docs only).
Ideas are adapted; no code, text or assets are copied.

## Order and contracts

**B1 — the agent can read the project's instructions** (S). The built-in loop and sub-agents get the project's
instruction files in their system prompt: `AGENTS.md` (also `CLAUDE.md`) from each project folder root and, for a
file-scoped task, from the directories between the root and the files it touches; 32 kB cap per file, 64 kB in total,
nearest file last; changes are picked up on the next request; the context receipt lists them. ACP agents read their
own instruction files — we add nothing there, and say so in the UI's context view.

**B2 — real editing tools** (S). `edit` (exact string replacement, must be unique unless `replace_all`; the diff goes
to changes/approvals like `write_file`), `glob`, and `web_fetch` (text only, size-capped, off unless the project
allows network; never sends project content). Sub-agents get `edit` and `glob`.

**B3 — Ask and Plan modes** (M). Project/turn `mode`: `agent` (today), `ask` (read-only: no writes, no shell
writes, no delegation that writes), `plan` (read-only; the answer is a plan the user can approve — approval starts
an `agent` turn with the plan pinned). Enforced in the harness tool gate, not by prompt alone; for an ACP
orchestrator `ask`/`plan` map to the agent's own mode when it advertises one, else its write permissions are denied.
UI: a mode chip in the composer, `Shift+Tab` cycles.

**B4 — "Always allow" and reject with feedback** (M). Approval answers gain `allow_always` (a saved rule per project:
tool + command prefix or path glob; listed and removable in Settings) and deny keeps its note, which is given to the
agent as the reason. Needed before the default access flips to `supervised`.

**B5 — rewind to a request** (M). From any earlier request: restore the files changed since it (using the recorded
changes), cut the conversation back to it, and put its text back in the composer. One confirm that lists the files;
refused with a clear reason when a file changed outside the harness since. Memory records of the cut turns are
dropped.

**B6 — steer a running turn** (M). "Send now" on a queued message delivers it into the running turn at the next
tool boundary (built-in loop); for ACP agents only if the protocol path exists — otherwise the button says it will
be sent when the turn ends.

**B7 — context and history** (S). A visible "history compacted" marker, a manual "Compact now", the context ring's
breakdown from the receipt; export a conversation to Markdown; search past requests (palette).

**B8 — notifications** (S). Desktop notification when a project finishes, fails or needs the user while the window is
unfocused (off until the user allows it once; Settings → General).

**B9 — quick open and search in files** (S). `Ctrl/Cmd+P` file quick-open across project folders; search in files
from the palette with results that open at the line.

**B10 — skills and custom commands** (M). `SKILL.md` folders and Markdown commands from the project and the user's
config directory, listed in the `/` menu; a skill's instructions load only when used.

Later, each needs its own design: per-hunk accept/reject, a standard MCP client for user-configured servers, hooks,
inline edit in the editor, an OpenAI-compatible provider, a worktree per sub-agent, a terminal pane, remote access,
a sandbox for the shell, scheduled runs, voice, a browser tool.

## Not copied (reasons in the report)

Hosted share links, account-bound cloud agents, vendor-specific model routers.

## As built — harness part 1 (B1, B2, B4)

Full contracts and JSON shapes: `apps/harness/docs/parity.md`. Scripted check: `apps/harness/scripts/e2e-parity.sh`.

- **B1** built as specified. Detail choices: both `AGENTS.md` and `CLAUDE.md` of a directory are included (AGENTS first); "files a task names" are words of the task text that exist as paths; the receipt block `instructions` carries `files: [{path,size,used,truncated}]`; an ACP turn's receipt has `instructions_note` (an ACP turn in `full` memory mode now also stores a receipt so the note has a home). Verified: unit tests (order, nearest last, caps, fresh read, redaction, symlink escape), orchestrator tests (the rule reaches the mock model's system prompt for the orchestrator and sub-agents, after the briefing; a 200 kB file is cut with the marker; ACP prompt carries none), e2e. Not verified: a real model following the rules.
- **B2** built as specified; `network_private` (project setting, default false) is the "project setting allows" for private addresses. `web_fetch` uses no proxy (a proxy would hide the target address from the private-address check). Edits are recorded with source `write_file`. The orchestrator now has `edit` and `glob` (so it can make small edits itself); an ACP orchestrator gets none of the new tools over MCP. Verified: unit tests (traversal, symlink escape, non-unique match, gitignore, cap; SSRF table, loopback refused, redirects, no cookies/headers, timeout, size cap, HTML to text, content types), orchestrator tests, e2e. Not verified: fetching from the public internet (no network in the build environment); DNS rebinding against a real resolver (the check is on the connected address).
- **B4** built as specified, with shell-aware splitting: any compound command is never covered by a rule. Rules also cover ACP permission requests and `web_fetch` hosts. Schema 7 (`approval_rules`, `project.network`, `project.network_private`), with a migration test from schema 6. The ACP permission protocol has no field for a deny reason: the note reaches ACP agents only through `fs/write_text_file` errors. Not verified: a real ACP agent's use of its own `allow_always` options.
- Existing tests changed: denial text is now `Denied by the user: <note>`; one context-report test reports 700 tokens instead of 70 (the orchestrator's tool list grew).
- `packages/agent-client`: optional `listApprovalRules`, `deleteApprovalRule`, `allow_always` and `match` on answers, `Approval.tool/suggested_rule/detail.patch/url`, `Project.network/network_private`, events `approval_rule.created/deleted`. `ApprovalKind` does not yet list `"network"` (the UI's exhaustive switch would not compile; the UI executor adds it with the card).

## As built — harness part 2 (B3, B5, B6, B7 and the context report)

Contracts, JSON shapes and events: `apps/harness/docs/parity.md`. Scripted check: `apps/harness/scripts/e2e-parity.sh` (B1-B7).

- **B3 modes.** As specified. The orchestrator's tool gate refuses `write_file`, `edit`, `spawn_agent` and non-allow-listed `bash` in ask/plan turns (the orchestrator itself has no `bash` or `write_file`; the allow-list matters for ACP and is unit-tested). A completed plan turn stores a plan; approving it starts an agent turn with the plan pinned in the system prompt (built-in) or in front of the prompt (ACP). ACP: the agent's advertised session modes are parsed (`modes` of `session/new`) and set with `session/set_mode`; independent of that the harness denies writes in these modes. Verified with the scripted agent (`OCTO_FAKEACP_MODES=1`) only; no real agent's mode names were checked (the mapping looks for `ask`/`read-only`/`plan` in the id or name).
- **B5 rewind.** As specified; soft delete through `messages.rewound_at` and `agents.rewound_at`. Rewinding drops the cut turns' changes, receipts, plans, compactions that reach into the cut, search documents and task records (a task spanning the cut keeps what is before it). A file whose state after its last change was not kept (`after_hash` absent) counts as a conflict (`unavailable`). Spend rows are kept. Not verified: a rewind across a harness restart (the tracker's in-memory index is not used by it, but this was not exercised).
- **B6 steer.** As specified, with one detail: the injected message is a separate stored user message after the tool-result message (two consecutive user messages go to the model; the API merges them). The queued message stays in the queue until it is injected, so a turn that ends first simply runs it next. The ACP schema in `internal/acp` has only `session/cancel` for a running prompt: 409 `steer_unsupported`; `{"interrupt": true}` keeps the old cancel-and-start behaviour. The existing `send-now` test was changed to send the flag.
- **B7 history.** Manual compaction uses the side model (one call, role `compact`) and holds the project's turn slot meanwhile; not available for ACP orchestrators and the window memory mode. The "marker" is the compaction row (`label`, `manual`, `message_count` on `compactions` of the message list) rather than a separate message. Export and search as specified (search is `GET /v1/search`, global). Not verified: the quality of a real model's summary.
- **Context report (decision 65).** `GET /v1/projects/{id}/context` is extended additively (`source`, `window`, `window_source`, `reserved_tokens`, `free_tokens`, `compacted_at`, `categories`, `last_request`); the old fields are untouched. The categories are the estimator's split of the request the loop would build, scaled to `used_tokens`; the default window is 200,000 (the figure tool-result clearing uses). Tests: categories sum to `used_tokens`, the report plus the next request agrees with the next turn's receipt within the estimator's tolerance (full and window memory modes), ACP shape (`source: "agent"`, empty categories). `context.updated` is published after turns, compactions, rewinds, note changes and writes of `AGENTS.md`/`CLAUDE.md`. Not verified: that an ACP agent's `usage_update` is used/size as a real agent reports it (only the scripted agent).
- `packages/agent-client`: optional `steerQueued`, `getLatestPlan`, `approvePlan`, `rewind`, `compactNow`, `exportConversationUrl`, `searchRequests`; `mode` on `ProjectInput`/`Project`/`QueuedMessage` and as an option of `sendOrQueueMessage`; `sendQueuedNow(..., {interrupt})`; extended `ContextBreakdown` and `CompactionMarker`; the five new events (reducer no-ops).

## B11 — slash commands, ours and the agent's (owner: "support commands like /compact and the others the provider supports")

One menu in the composer, opened by `/` at the start of the text, listing two groups:
1. **Octo commands** (work with any orchestrator): `/compact` (B7; for an ACP orchestrator it is passed to the agent
   when the agent advertises its own `compact`, otherwise the row is shown disabled with the reason), `/clear` (start
   a new conversation in the project: history kept and searchable, context empty), `/mode ask|plan|agent` (B3),
   `/model <name>` (opens the model picker filtered by the text), `/rewind` (B5, opens the dialog on the last
   request), `/export` (B7), `/review [pr]` (opens the review picker or the PR), `/context` (opens the context
   popover), `/memory` , `/settings`, `/help` (this list). Each is run by the UI or the harness, never sent as text.
2. **The agent's commands** (ACP orchestrator): what the agent advertises in the session
   (`available_commands_update`: name, description, input hint), e.g. Claude Code's own commands. Choosing one sends
   `/<name> <args>` as the prompt, which is how ACP agents take them. They are listed under the agent's name with its
   mark; a name that collides with an Octo command is shown in both groups, the Octo one first.
Harness:
a. Keep the last advertised command list per ACP session; `GET /v1/projects/{id}/slash-commands` →
   `{octo:[{name,description,args?,available,reason?}], agent:{id,label,commands:[{name,description,input_hint?}]}|null}`;
   event `slash_commands.updated {project_id}`. Before the first session of an ACP orchestrator the agent list is
   empty with `pending: true`; the harness does not start a session only to read it.
b. `POST /v1/projects/{id}/clear` → 200 `{conversation_id}`: closes the open task in memory, drops the ACP session
   (next turn starts a new one without the recap), marks a boundary in the transcript ("New conversation"); 409
   `turn_in_progress`.
c. A user message that starts with `/name` where `name` is an Octo command is refused with 400 `octo_command` (the
   client must call the endpoint instead), so a command never reaches a model as text by accident; one that matches an
   advertised agent command passes through unchanged and is recorded with `command: name` on the message.
d. Built-in loop: only the Octo group.
UI: menu with keyboard (↑↓ Enter Tab Esc), fuzzy filter, descriptions, argument hint after choosing; decision 70
highlighting uses this list (known commands only); unknown `/text` is plain text and is sent as typed.
Acceptance: harness unit tests with the scripted agent advertising commands (list, update event, pass-through,
`octo_command` refusal, clear resets the session and the context report); e2e case in `e2e-parity.sh`; UI tests for
the list model (grouping, collision, disabled reason) and a Playwright walk of the menu.
Not verified until the owner's run: which commands each real agent advertises.

### B11 revision (owner, same day) — `/clear` tidies, it does not forget

Owner: "/clear should clean the chat but not delete the context: clean the user's chat and summarise. He does
tasks, /clear cleans the context and the messages on screen so it is easier to follow; and the agent, after finished
tasks or when it saw something important, may decide to remember it." This replaces rule (b)'s "context empty" and
"without the recap":
1. **What `/clear` does.** (i) The screen: the transcript starts empty under a quiet line "New session · earlier:
   <title>" that opens the previous session (M4 / project sessions). (ii) The model's context: the conversation
   history is dropped. (iii) What is carried over, in this order and within 600 tokens in total: a **summary of the
   session** written at the moment of clearing (what was asked, what was done, decisions taken, what is unfinished,
   files touched — the same shape as a compaction summary, stored on the session record and shown in the Memory
   tab), the open tasks' titles, and the pointer to recall the rest (`recall_message`, `search`). Project
   instructions, notes index, facts and memory files are untouched: they were never part of the chat.
2. **Who writes the summary.** Built-in loop: one model call with the summary prompt (fast tier, counted in usage as
   role `summary`); if it fails, the last compaction summary plus the last three request titles are used and the
   line says "summary unavailable". ACP orchestrator: the agent is asked for the summary in its live session before
   the session is dropped (one prompt, 30 s limit); on failure the harness builds it from the stored exchanges'
   requests and final answers without a model.
3. **`/clear` never deletes.** Sessions, exchanges, changes and search stay. Deleting is a separate, explicit action
   in the Sessions tab.
4. **The agent may remember.** A tool `remember {text, kind: "fact"|"decision"|"preference"|"todo", about?}` for the
   orchestrator and sub-agents (built-in tool and the harness MCP server for ACP agents). The briefing tells the
   agent when to use it: after finishing a task, when it learns something that will matter later (a constraint, a
   decision, where something lives, what failed and why), never for what is already in the instruction files, and
   at most three per turn. A remembered item is a dated fact (M1 rules: superseding, source turn), appears in the
   Memory tab with "remembered by <agent>", and the transcript shows a quiet line "Remembered: …" with Undo. The
   person can do the same from the composer: `/remember <text>`.
5. API: `POST …/clear` → `{session_id, previous_session_id, summary, summary_source:"model"|"agent"|"stored"}`;
   event `conversation.cleared {session_id, previous_session_id}`; `fact.remembered` (or the existing memory event)
   carries the turn and the agent.
Acceptance adds: summary carried into the next turn's prompt (mock model sees it and not the old messages), the 600
token bound, both fallbacks, nothing deleted (search still finds an old exchange), `remember` stores a fact with its
source and is refused in read-only modes only for `kind: todo` writes that touch files (a fact is always allowed),
the three-per-turn cap, Undo.

## B12 — attach images (owner: "I cannot attach pictures either")

1. **In the composer:** paste from the clipboard, drop onto the composer or the conversation, or "+ → Image…"
   (system file dialog through the host; the browser's file input otherwise). PNG, JPEG, WebP, GIF (first frame);
   at most 8 per message, each ≤ 10 MB before and ≤ 5 MB after the client downsizes it (longest side 2 048 px,
   re-encoded; the original is never uploaded). A chip per image with a thumbnail, its size and ×; click opens a
   preview. Screenshots pasted while a turn runs join the queued message.
2. **Harness:** `POST /v1/projects/{id}/attachments` (multipart or raw body with `Content-Type`) →
   `{id, media_type, bytes, width, height}`; stored under the project's data directory, content-addressed, removed
   with the project and when no message refers to them after 30 days; `GET …/attachments/{id}` serves it (same token
   rules as the file API). `POST …/messages` and the queue accept `attachments:[id]`.
3. **To the model.** Built-in loop: image content blocks before the text, in the order attached. ACP agent: `image`
   content blocks in `session/prompt` when the agent advertised `promptCapabilities.image`; otherwise the message is
   refused before it is sent with 422 `images_unsupported` naming the agent, and the composer says so as soon as an
   image is attached (the project's provider entry carries `accepts_images`). Never silently dropped.
4. **History and cost.** The transcript shows thumbnails in the request; images stay in context until compaction,
   which replaces each with "[image: name, WxH]" plus the model's own earlier description if any; the context report
   counts them (Messages → images). Exchanges in memory keep the attachment ids, not the bytes.
5. Other files (PDF, text) stay `@file` mentions of project files; dropping a non-image offers "Add to the project
   folder" — not built in this step.
Acceptance: harness tests (upload limits and types, message with images reaches the mock model as image blocks and
the scripted agent as ACP image blocks, refusal without the capability, compaction placeholder, cleanup); UI tests
for the attachment model (limits, downsizing decision, queue) and a Playwright walk with a pasted image.
Not verified until the owner's run: which real agents advertise `promptCapabilities.image`.

## B13 — the side question runs on what the project runs on (owner: "side question is broken")

Live: the project ran on GitHub Copilot; the side question answered "No API key is configured for the built-in
agent loop". The side question is a second, read-only conversation about the project; it must not need a different
provider than the project. Rules:
1. Default model = the project's orchestrator choice. An ACP orchestrator → the side question opens its **own**
   session with the same agent (not the orchestrator's session, so it cannot disturb a running turn), started in
   the project's folder, with the harness denying every write and command permission request and using the agent's
   read-only/ask mode when it has one (B3 rules); the session is kept for follow-ups in the same side conversation
   and closed when it is cleared or after 15 min idle.
2. The side panel has its own small model control (same picker), so a cheap API model can be chosen when one exists;
   the choice is remembered per project.
3. If nothing can answer, the panel says exactly what to do with one button (connect a provider), never an
   environment-variable instruction.
4. The side answer streams (live activity rules), can be stopped, and "Send to the orchestrator" quotes it into the
   main composer.
5. Layout (decision 64h, 67): the side conversation uses the same column, message and composer components as the
   main conversation at the side pane's width — question and answer in one column aligned with the composer's
   edges, the composer at the bottom at full pane width inset.
Acceptance: harness tests with the scripted agent (own session, writes denied, follow-up reuses the session, idle
close, runs while the orchestrator's turn is running); UI tests and screenshots.

### As built — B11 (harness and agent-client)

Contracts and exact JSON: `apps/harness/docs/parity.md` (B11). Built as revised by the owner ("/clear tidies, it does not forget").

- **Slash commands.** `GET /slash-commands`, event `slash_commands.updated`, `octo_command` refusal, agent commands recorded as `command` on the message and sent as the bare
  prompt (the briefing of a new session waits for the next request). The agent's list is read through a client callback (`acp.Spec.OnCommands`), so the list that agents send right
  after `session/new` (outside a prompt) is kept. `POST /compact` sends `/compact` to an ACP agent that advertises it (202 `sent_to_agent`). `/remember` is in the Octo list
  (endpoint `POST /facts`). A command name that is both Octo's and the agent's is Octo's; the agent's version of such a name is reachable only where an endpoint forwards it (`/compact`).
- **/clear.** A clear is a compaction row (`cleared`) whose summary is the carry-over (600 tokens at most: summary, open task titles, recall pointer), with `summary_source`, `title`,
  `conversation_id`. Built-in loop: one fast-tier model call (role `summary`); ACP: the live session is asked (30 s, no stored turn); both fall back to a stored summary
  (`summary_source: "stored"`). Transcript and export markers, `conversation.cleared`, session dropped, context report reset. Schema 9 (migration test from 8).
- **remember.** Built-in tool for the orchestrator and sub-agents (and over MCP for an ACP orchestrator), stored as a fact in the turn's task record (3 per turn, kind/about/superseding,
  `remembered_by`), `POST /facts` and `DELETE /facts/{task}/{fact}` for `/remember` and Undo, events `fact.remembered` / `fact.forgotten`.
- **agent-client.** `getSlashCommands`, `clearConversation`, `rememberFact`, `forgetFact`, `compactNow` may answer `{sent_to_agent, message}`, `command` on messages, `conversations` on the
  transcript, the four events (reducer no-ops); `packages/ui` untouched (its `tsc` passes).
- **Verified:** Go unit tests (ACP command parsing in every shape, store migration from 8, carry-over bound and order, stored summary, memory remember/supersede/undo); bridge tests with the scripted
  agent (list pending/known, update event, pass-through, refusal, `/compact` via the agent, clear with agent summary and with the stored fallback, 409 during a turn, new session without the old
  messages, search and export after clear, facts endpoints); orchestrator tests with a capturing mock model (the next request holds the carry-over and none of the old messages, model failure falls
  back to stored, the 3-per-turn cap, ask mode, undo); `e2e-parity.sh` case B11; agent-client tests.
- **Not verified:** which commands each real agent advertises, and whether a real agent writes a usable summary within 30 s; the window memory mode's carry-over is covered by code, not by a test;
  the UI (menu, marker, "Remembered" toast) is not built.
## As built — B12/B13 (harness and agent-client)

Built: B13 (own ACP session per project for the side conversation, writes and commands refused, the agent's ask mode, kept for follow-ups, closed on
clear / project delete / shutdown / 15 min idle with an injectable clock, `side.thinking|activity|tool` events, `POST /side/stop`, `models.side` may name an
ACP agent, typed 409 `no_provider`, usage rows role `side`) and B12 (attachments endpoint and store, `attachments` on messages and queue entries, image
blocks to the built-in loop, ACP `image` blocks behind `promptCapabilities.image`, 422 `images_unsupported`, `accepts_images` on the project, compaction
placeholder, context counts, 30-day cleanup). Exact JSON in `apps/harness/docs/parity.md`. Cause of the live failure: the side question always ran through
the built-in loop (`internal/orchestrator/side_run.go`, the loop's `Gate: rt.loopGate()`), which fails with `config.NoBuiltinLoopMessage` when no key is
configured, whatever the project's orchestrator was; the side route now decides first (`sideRoute` in `side_acp.go`).
Verified: Go tests with the scripted ACP agent (own pid/session, follow-up reuses it, clear and idle close, writes and commands denied, ask mode, runs
while the orchestrator hangs, stop keeps the session, `models.side` validation, 409 no_provider, usage role); attachment sniffing/limits/ids, upload
and read endpoints, image blocks reaching the mock model, ACP image blocks, 422 without the capability, queued images, cleanup, schema 11 migration from
8; agent-client tests; `scripts/e2e-parity.sh` cases for both.
Not verified: any real agent (which agents advertise `promptCapabilities.image`; Copilot's side session and ask-mode names), the UI (nothing built), a
model's actual reading of an image, WebP/GIF through a real model, `accepts_images` on the `/v1/providers` entry (left to the providers work). A
side model that is an `acp:` agent other than the orchestrator's works the same way but was only tested with the same agent. The idle close is checked
with a fake clock, not 15 real minutes.
## As built — UI for B2–B7 (and decisions 70, 81)

Code: `packages/ui/src/components/{chat,v7,project}`, pure modules `lib/{modes,modeLabels,mentions,rewind,compact,compactNow,requestSearch,download}.ts` and `lib/v7/{rules,patch,steer,steerQueue}.ts` (each with a `*.test.ts`), the demo bridge `demo/parity.ts`.

- **B3 modes.** One chip in the composer row ("Agent" / "Ask" / "Plan", its own chunk). Its menu picks the mode for the next message only; "Make X the project's default" saves it (`updateProject({mode})`); `Shift+Tab` in the text cycles it (this takes Shift+Tab away from reverse focus navigation while the text has focus; the chip and the rest of the row stay reachable). The mode resets to the default after a send; a read-only mode says so in one line above the box. Labels shed in the order tier, mode, folder, model. The chip shows only when the bridge has `approvePlan`. A plan turn ends with a plan card under its request (the plan's text, "Approve and run", "Keep editing" = Plan mode and the caret in the box); an approved plan folds to one line. `plan_not_pending` re-reads the plan and says so, `turn_in_progress` says to wait or stop. Plan cards are looked for under the newest five requests only (a plan belongs to the newest plan turn; after a reload an older approved plan is not shown).
- **B4/B2 approvals.** "Always allow this command / path / host" next to the three answers; it opens a panel with the exact suggested rule (kind, the code, what it covers) and "Save rule and allow" — nothing is saved before that. `network` cards show host, URL and the agent's reason; edit cards fold their `detail.patch` behind "Show changes". Resolved cards say "Always allowed". Saved rules are listed and removable under "Always-allowed requests" in the project settings dialog (the client exposes `listApprovalRules` / `deleteApprovalRule`).
- **B5 rewind.** "Rewind to here" on the lower edge of a request (hover or focus; always on touch; not while a turn runs). A dry run shows what is restored or deleted, how much of the conversation goes, and files that block it; on `rewind_conflict` at confirmation the dialog reads the dry run again and lists the files with reasons. After success the transcript is cut (messages, later sub-agents, plans), the request text is back in the composer, and a quiet "Rewound to here" line stays (with "· agent session reset" for an ACP orchestrator, explained in its tooltip). The marker reuses the compaction marker line.
- **B6 steer.** Queue rows have "Send now" (steer, the row stays and says "Goes in at the next step" until the turn takes it) and "Stop and send" (`interrupt: true`). For an ACP orchestrator (or a client without `steerQueued`) only "Stop and send" is shown with one reason line; a 409 `steer_unsupported` teaches the row the same. A user message that `message.steered` names shows "Sent mid-turn" in its bubble (matched by text).
- **B7.** "Compact now" shows the real result ("Compacted 28 messages into a summary of about 1.2k tokens.") or the harness's refusal in words; the marker reads "History compacted · manual" (the client's reducer drops `manual`/`label`, so the project provider re-applies them from the event). The context popover reloads on `context.updated`. "Open context details" now switches an already-mounted Memory tab (`requestMemoryView`). "Export conversation (Markdown)" in the project "⋯" menu downloads `exportConversationUrl` through an anchor (no token is added to that URL: the harness takes `?token=` on the two SSE routes only (`apps/harness/internal/bridge/auth.go`, `presentedToken`), so with an API token set the export download is refused until the harness also accepts `?token=` on `GET .../export`; the harness was not changed here). The palette has a "Past requests" group from `searchRequests` (after 200 ms and 2 characters); a result opens the project at that message.
- **Decision 70.** A layer under the text area repeats the text with transparent ink and tints `@path` mentions (needs a `/` or an extension) and the known `/commands` (`settings`, `agents`, `notes`, `files`, `details`, `comments`); only background tint, so metrics, caret, IME and undo are the browser's. Not done: `#task` references and inline code tint, the 2 000-character paste pill.
- **Decision 81.** Approval, form and plan cards, failed turns and the queue have the neutral border; the pulse and its CSS are gone; the Deny button and key hints are quiet (Deny is a text button in the error colour). `packages/ui/scripts/frame-colours.mjs` checks the demo states (approval, form, queue, rule panel, plan, failed turn; dark and light) for any border, outline or ring in the warn, error or accent token without focus or `aria-invalid`; it has `--selftest`. Still coloured: the composer's working edge (the aurora, decision 45, a gradient and not a border), and nothing in `components/review` any more: the changed-file badge and the submit error box now have the neutral border (`frame-colours.mjs` also checks the review screens).
- **Bundle.** The initial JS rose to 159.8 kB gzip with the first version and is back at 155.82 kB (budget 155.90, unchanged): the "+" menu, the mode chip, the highlight layer, the turn rail, the pinned prompt, compaction/rewind markers and plan cards are lazy chunks, and helpers shared by eager and lazy code were split so the lazy parts do not ride in the entry.
- **Demo.** `demo/parity.ts`: send "approvals demo" for an edit with patch, a web fetch and a command (each with a rule); pick Plan mode and send for a plan; Atlas API (ACP orchestrator) shows "Stop and send" only, rewinding to its newest request shows files and then a blocking `src/stale.ts`; Orbit mobile (ACP) shows the session-reset marker; Docs site (built-in loop) compacts, rewinds and steers (send "live activity please", then queue a message and press "Send now").
- **Verified** (Playwright against `?demo=1`, dark, 1440×900, and 390×700 for the composer): every flow above, console clean. Unit tests: ui 441, agent-client 109, desktop 41. `pnpm lint` 0 errors, `format:check`, `check-cycles`, spacing audit total 0, width stability ok at 1440×900 and 900×600, `frame-colours` ok.
- **Not verified.** Any real model or agent (steer, plan turns, modes, rewind of a real project, compaction quality), the downloaded file's name/headers against a real harness (the demo uses a data URL), WebKit (Tauri), light theme screenshots (only the colour audit ran in light), the keyboard-only path through the new dialogs beyond the shared Dialog/Menu primitives.
