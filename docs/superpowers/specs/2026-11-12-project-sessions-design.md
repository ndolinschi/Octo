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
