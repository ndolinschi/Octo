# Project sessions — design

**Date:** 2026-11-12 · **Status:** approved to build (owner: "I also want a Sessions tab for the project, to control
the project in the regular way; the orchestrator runs a separate session and it should be accessible")

## What the person gets

A project is no longer one endless conversation. It holds **sessions**, and every one of them can be opened, read,
continued and stopped the way a chat is used in any coding agent:

- the conversations the person has with the orchestrator (a new one by "New session" or `/clear`);
- the **separate sessions the orchestrator starts** for its sub-agents — each is a real session with its own
  transcript, tools and model, not a line in a summary.

## Decisions

1. **One entity.** The session of memory M4 (`2026-11-11-orchestrator-memory-design.md`) is this session. It gains:
   `kind: "main" | "agent"`, `parent_session_id` (an agent session belongs to the main session whose turn spawned
   it), `agent_id` (the harness agent it shows), `state: working | waiting | idle | failed | stopped`, `model`,
   `title` (editable), `archived`.
2. **Main sessions can be continued.** Exactly one main session is *current* (it receives what is typed in the
   project's composer). Any other can be made current: `POST /v1/projects/{id}/sessions/{sid}/resume`. The harness
   rebuilds the context from that session's stored messages (built-in loop: the stored history and its last
   compaction; ACP orchestrator: `session/load` when the agent advertises it, otherwise a new agent session with the
   recap built from the session's exchanges) and the transcript shows that session. Resuming while a turn runs is
   409 `turn_in_progress`.
3. **Agent sessions are accessible.** Opening one shows its full live transcript (thinking, tools, output), its
   task text, who started it and from which request, its model, its usage. Controls: **Stop** (already exists for
   the turn; here per agent), **Send a message** to it — allowed while it runs (steer, B6 rules) and after it
   finished when the agent can continue (ACP session still alive or loadable; built-in sub-agent: continue from its
   stored messages). The answer is reported to the orchestrator only if the person chooses "Send result to the
   orchestrator"; otherwise it stays in that session. Where continuing is impossible the composer is disabled with
   the reason.
4. **API** (all under `/v1/projects/{id}`):
   - `GET /sessions?kind=&state=&archived=&limit=&before=` → `{sessions:[{id,kind,parent_session_id?,agent_id?,
     title,state,model,started_at,last_activity_at,exchanges,children,current,archived}]}`;
   - `GET /sessions/{sid}` → the session with `exchanges` (M4 shape) and `children`;
   - `POST /sessions` `{title?}` → a new main session, made current (same effect as `/clear`);
   - `POST /sessions/{sid}/resume`, `PATCH /sessions/{sid}` `{title?,archived?}`, `DELETE /sessions/{sid}` (not the
     current one; removes its exchanges from memory and search), `POST /sessions/{sid}/stop`,
     `POST /sessions/{sid}/messages` `{text, report_to_parent?}` (agent sessions; main sessions use the project's
     existing message route);
   - events `session.created`, `session.updated`, `session.current {session_id}`.
5. **UI.**
   - A **Sessions** tab in the project (dock tab, list-detail of decision 66, view/filter tabs of decision 82):
     main sessions newest first, each expandable to the agent sessions it started; state glyph, title, last
     activity, model, "current" mark. Filters: All · Working · Mine (main) · Agents · Archived.
   - Detail = that session's transcript in the same conversation component as the project's chat, with its own
     composer when it can take a message. A session can be opened as its own dock tab ("Open in tab") so two
     sessions can be seen side by side.
   - The conversation tab's title is "Project / session title" (decision 63); the sub-agent chips in the top row
     open that agent's session; a delegation row in the transcript has "Open session".
   - Sidebar: a project with more than one session can be expanded to its recent sessions (at most five, then
     "All sessions").
   - "New session" is the first action in the tab and in the project "⋯" menu.
6. **Limits.** One current main session per project; turns of different main sessions do not run at the same time
   in the first version (the queue is per project). Agent sessions run in parallel as today.

## Acceptance

- Harness: unit tests for the session lifecycle (create, current, resume incl. ACP load / recap fallback, archive,
  delete incl. search index, agent session linked to the spawning turn, message to a running agent, to a finished
  one, refusal with the reason, `report_to_parent`), events, migration from M4; an e2e case with the scripted agent.
- agent-client: methods, types, reducer (sessions list kept in state).
- UI: view-model tests (tree of main and agent sessions, filters, current mark), Playwright walk (new session,
  resume an old one, open an agent session, send it a message, stop it), screenshots in both themes at 1440×900,
  900×600 and 390×700.
- Not verifiable here: `session/load` with real agents; whether a finished real sub-agent can be continued.

## Order

After M4 (sessions as records) and B11 (`/clear`) are merged: harness and agent-client first, then the tab.

## As built (harness and agent-client)

Exact JSON, routes, events and errors: `apps/harness/docs/sessions.md`. Decisions 1-4 and 6 are built; decision 5 (the UI) is not.

- **Entity.** Schema 13 extends the memory session (kind, parent, agent, state, model, editable title, archived, current); messages and compactions carry their main session, so context follows the session. The 6 h rule no longer splits a live conversation (a session is the model's context; splitting would drop it); it still applies to exchanges recorded without a session.
- **Resume.** Built-in: the request is rebuilt from the session's messages after its newest compaction or carry-over (tested over HTTP with the mock model answering `[ctx]` requests with the user texts it was sent). ACP: `session/load` of the agent session kept for that session when advertised, else a new agent session with a recap of that session only (fake agent knobs: `OCTO_FAKEACP_LOAD_SESSION`, new `OCTO_FAKEACP_LOAD_FAIL`).
- **Agent sessions.** Created at spawn with the spawning turn; stop per agent; steer of a running built-in agent at its next tool boundary; continue of a finished one (built-in from stored messages, ACP by `session/load`); `report_to_parent` as a `session_report` user message at the next turn. 409 codes are listed in `sessions.md`.
- **agent-client.** Optional methods `listSessions`, `getSession`, `getSessionTranscript`, `createSession`, `resumeSession`, `patchSession`, `deleteSession`, `stopSession`, `messageSession`, `getTranscript(..., {sessionId})`; `ProjectState.sessions {list, currentId}` kept by `session.*` events and `withSessions`.
- **Verified:** Go tests (`projectstore` incl. migration from 12, `memory`, `orchestrator`, `project`, `bridge` incl. new sessions tests with the mock model and the scripted ACP agent), `e2e-parity.sh` case S1, agent-client `tsc` and tests, `tsc` of `packages/ui`.
- **Not verified:** `session/load` with real agents; continuing a finished real ACP sub-agent; the demo bridge and the Sessions tab (not built); a continued agent's file changes are filed under the spawning turn (not exercised); the sessions list with more than 200 sessions.

## As built — Sessions tab (UI)

Decision 5 is built: the dock tab, the detail, the resume refetch, the entry points and the demo. Code: `packages/ui/src/components/sessions/**`
(feature), `packages/ui/src/lib/sessions/` (pure model, tested), `state/workspace/sessionsStart.ts`.

- **Tab and list.** A **Sessions** tool tab (`toolTab("sessions")`, glyph `MessagesSquare`) in the "+" picker, lazy chunks `SessionsTab` and
  `SessionPane`. `ListDetail` like Memory: left, main sessions newest first; a main session with agent sessions opens under itself
  (`ListRow expanded`, one open at a time, →/← open and close, ← on an agent row goes to its main row); `FilterTabs` All · Working · Mine ·
  Agents · Archived (counts only on Working and Archived: five counts do not fit the 280 px column); "New session" is the first control of the list
  header. Filters: `All` main sessions with their agents; `Working` working or waiting sessions (an idle main session only for its working
  agents, always open); `Mine` main sessions alone; `Agents` every agent session flat; `Archived` both kinds (the list is loaded with `archived: "all"`).
- **Row anatomies.** Main: state glyph (decision 29 ring; waiting is the needs-you mark, stopped rests like idle; the state word is in the
  title for screen readers) · title · dim "Nov 12 · 5 exchanges · Opus 5.5" · at the right of line 2 "current" or the last activity ("4:16 PM",
  "Yesterday", "Nov 9"). Agent (one step in): glyph · task title · "Nov 11 · Haiku 4.5" · last activity. Same `ListRow size="md"`, same `RowLine`
  and the same reserved "⋯" width as Memory.
- **Detail.** Header: title (inline rename: the title becomes a field, Enter saves, Esc leaves) with the dim line "Nov 11 · 3 exchanges · 4 agents · Sonnet 4";
  "⋯" (`IconMenu`): Resume (not on the current one), Rename, Open in tab, Archive / Unarchive (offered on the current one too: the refusal
  `current_session` is the explanation), Delete… (confirm dialog; not offered on the current one). Main session: its `/clear` summary in compact prose, then
  the conversation in the project chat's own `Transcript`, then "Resume this session to continue it." with the primary **Resume** (current
  one: "Open conversation"). Agent session: Stop while it works; its task, "Started by <session>" with **Open request** (scrolls the chat to
  `turn_id` when the parent is the current session, else "Open its session"), usage, the live transcript, and a composer: enabled when
  `can_message` (Enter sends; "Send result to the orchestrator" is `report_to_parent`; the outcome reads "Steered: …" / "Continued: …"), else
  disabled with `message_blocked.message` as a quiet line. Failures are `Notice`s in plain words (`lib/sessions/model.ts` `sessionErrorText`):
  `turn_in_progress`, `current_session`, `session_running`, `not_continuable`, `steer_unsupported`, `not_running`, `not_main_session`, `not_agent_session`.
- **How the transcript is shared.** The sessions feature never imports chat. `dock/TabView` defines a `TranscriptSlot` renderer that draws
  `chat/Transcript` (the very component of the conversation: same turns, tools, delegation rows, markers) and hands it to `SessionsTab` /
  `SessionPane` as a prop, the way the review receives Monaco. The messages come from the project state for the current main session and for
  agents the project lists (live, streaming), else from `getSessionTranscript`, re-read when the session's activity or state moves on.
- **After a resume.** `session.current` (and the person's own resume, applied locally) refetches the orchestrator's transcript with `{sessionId}`
  and **replaces** the conversation (new reducer action `transcript`; ids of two sessions never mix); `transcriptSession` loads by id only for a resumed
  older session, a current session that is the newest keeps loading whole with its `/clear` markers as before. A reload or reconnect keeps the resumed
  session. The conversation tab's dim part is the current session's title ("Atlas API / Напиши калькулятор…", decision 63). The person's actions also
  update `state.sessions` at once (`applySession`), so a bridge without `session.*` events (the demo's memory sessions) works.
- **Entry points.** "Open in tab": a `session:<id>` tab (`SessionPane`, tab kind `session`, `openSession` in the workspace: a new group beside the Sessions tab while
  the dock has room, else a tab next to the other open session), so two sessions sit side by side; the Sessions tab shows one while the other has its tab.
  Sidebar: a project with more than one main session gets a chevron on its row (`SidebarSessions`, lazy, mounted through the `projectExtra`
  slot that `AppShell` fills) that opens its five most recent sessions and "All sessions"/"Open Sessions"; a row opens that project's Sessions tab on that session
  (`requestSession`, held in `state/workspace/sessionsStart.ts` because the project's workspace may not be mounted yet). Memory's Sessions view: "⋯" → "Open in Sessions".
- **Demo.** `demo/sessions.ts` (UI package) and `apps/desktop/src/demo/memory.ts`: main sessions working (the current one while a turn runs) / waiting / idle / failed / stopped
  and an archived one; agent sessions that can take a message (steer while working, continue when finished), one running ACP agent that cannot
  (`steer_unsupported`), finished ones that cannot be continued (`not_continuable`); create / resume / rename / archive / delete / stop / message all work and
  emit or apply `session.*`. `?sessions=turn_in_progress|current_session|session_running|not_continuable|steer_unsupported|not_running` forces that
  error on the matching action; `?sessions=one` keeps only the current session (UI-package demo).
- **Verified.** `tsc --noEmit` (ui, desktop), eslint on every touched file (0 errors; `octo/no-native-controls` 0 in the new folder), prettier,
  `lib/sessions/model.test.ts` (12 tests: tree, filters, counts, row model, blocked reasons, error text, sidebar, transcript choice), reducer test for
  `transcript`, desktop demo tests, Playwright against the dev server in dark and light at 480 / 760 / 1440×900 panes and a 390×700 window (list with a row
  open, each filter, main detail, agent working with and without a composer, agent finished, not continuable, rename, delete confirm, each error notice),
  the sidebar expansion, resume (conversation and tab title change), two sessions side by side, and the console stayed clean.
- **Not verified / not built.** Against a real harness (`harness serve`): only the demo bridges were driven; the exact event order of a real resume is
  from `sessions.md`. The "Open request" scroll into the chat for a long conversation was not exercised in the browser. Keyboard: tab order, ↑/↓, →/←, Esc and
  Enter were exercised in code review and through the list-detail primitives, not with a screen reader. The sidebar fetches `listSessions` once per project
  row (limit 6) when it mounts and when the project's `updated_at` changes. A delegation row in the transcript has no "Open session" yet; the sub-agent chips still open
  the agent's own conversation tab.

### As built — Sessions tab, refinements (round 2)

- **Compact conversation in a narrow pane.** The detail measures itself (`useCompact`, below 420 px, the conversation's own floor) and passes `density="compact"` through
  the transcript slot. In `chat/Transcript` (an optional prop and a context field): reply prose is `proseClass("compact")`, request bubbles are `p-2 text-sm`, "Worked for" is
  `text-sm`, and the reply meta line (`TurnFooter`) is the time only with the usage in its tooltip. In every density a segment of that line is `whitespace-nowrap` and the
  usage truncates from the right ("3d ago" can no longer break). The raw agent id (`claude-code`) in that line was `useTurnLine` calling `servedModel(agent)` without the ACP
  names: it now uses `useModelNames().served(agent).name` (decision 94 e), so the chat shows "Claude Code" too.
- **Open in tab never makes a third column.** `openSession` splits only when the dock is one group (and has room); with two groups the session is a tab in the group that holds
  the Sessions tab.
- **`/clear` is not an exchange.** Demo data only: the desktop demo had a `/clear` / "Conversation cleared." exchange, now removed. The real harness never stores one: `Clear`
  (`orchestrator/clear.go`) stores a conversation boundary, and `getSessionTranscript` / `getTranscript` return it as `conversations[]` (`ConversationMarker`, `title` = the
  session that ended). A main session now starts with the quiet line "New session · earlier: <title>" (`BoundaryMarker`; the title is the harness marker's when the transcript
  has one, else the main session started just before; clicking it opens that session). `message.command` is only the slash commands of an ACP agent and `session_report` notes; those
  messages are untouched. The desktop demo's `getSessionTranscript` now sends the marker in the real shape.
- **Agent composer** is the side question's frame (`octo-composer`, send button inside, autosizing 1 to 10 lines, Enter sends, Shift+Enter breaks the line, no resize handle).
  Disabled: the frame dims and the harness's reason is its placeholder. Under it a `Checkbox` "Send result to the orchestrator" with the line "Its answer is added to the
  main conversation before the next request."
- **Delegation rows and agent chips open sessions.** `chat/DelegationGroup`: a row whose agent has a session shows an "Open session" icon button on hover, focus (always on touch);
  it selects that session in place when the transcript is inside the Sessions tab (`onOpenSession` of the slot), else it opens the Sessions tab on it (`requestSession` +
  `openTool("sessions")`). The top row's agent chips open the Sessions tab on that agent's session, "N agents" on Agents; both are limited to the agent sessions of the current main
  session ("Agents of <title> · All agents" under the filters; `requestSession(..., {filter: "agents", agentsOf})`).
- **What was added to `components/chat`** (nothing else): `Transcript` props `density?: "compact"` and `onOpenSession?: (agentId) => void`, the same two fields in
  `transcriptContext`, compact styles in `UserPrompt` / `AssistantTurn` / `TurnFooter`, the "Open session" button in `DelegationGroup`, and the `useTurnLine` label fix.
- **Found while verifying:** the queued request of `sessionsStart` was consumed in a `useState` initializer, which React runs twice in development, so the second run saw nothing:
  the tab now peeks in the initializer and clears in an effect. →/← on a main row used to choose it (opening the detail in a one-column pane); they now only fold or unfold it.
- **Verified in the browser** (Playwright, dev server, dark and light, 1440×900 window): the compact pane (363 px) has no raw id, no `/clear` request, the marker, no wrapped footer time; the
  composer grows from 22 to 44 px over two lines (Shift+Enter), `resize: none`, Enter sends; Open in tab keeps two dock groups; delegation "Open session" selects the agent session; "N agents"
  opens Agents of the current session; →/← fold and unfold, ↓ enters the agent rows, ← returns to the main row; "Open request" scrolled the chat from 2011 to 0 (turn 1 in view).
  `spacing-audit` on the three sessions scenes total=0, `width-stability` ok. Not verified: "Open request" against a long real conversation, a screen reader.
