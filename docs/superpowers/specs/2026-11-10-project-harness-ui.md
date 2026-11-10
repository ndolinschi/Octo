# Project harness — UI design

**Date:** 2026-11-10 · **Parent:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md)
**Code:** `packages/ui` (`@octo/ui`), hosted by `apps/desktop`.

## Restyle spec (2026-11-10, supersedes the first visual pass)

The first pass was rejected as generic: a purple brand accent in chrome, coloured tier chips,
15–16px airy type, two-line delegation cards and decorative furniture. The target is the feel
of Claude Code desktop and the Cursor agent window: neutral greys, 13px chrome, 14px prose,
one line per thing, almost no colour.

### Colour tokens (`packages/ui/src/styles.css`)

Neutral greys only; no hue in chrome. Text pairs measured with WCAG 2 contrast against every
surface they render on (lowest pair listed).

| Token | Dark (default) | Light | Role |
| --- | --- | --- | --- |
| `sidebar` | `#141414` | `#f4f4f4` | left rail |
| `bg` | `#181818` | `#fbfbfb` | main area, right pane |
| `raised` | `#212121` | `#efefef` | user message, composer, inputs |
| `overlay` | `#1f1f1f` | `#ffffff` | dialogs, overlaid pane |
| `code-bg` | `#1e1e1e` | `#f4f4f4` | code blocks, tool detail |
| `hover` / `active` | white 5% / 8% | black 4% / 7% | row hover / selected row, pressed toggle |
| `line` / `line-strong` | white 8% / 14% | black 8% / 14% | hairlines / input and focus-within edge |
| `fg` | `#e6e6e6` (12.9:1) | `#1a1a1a` (15.1:1) | primary text |
| `fg-2` | `#a1a1a1` (6.2:1) | `#5c5c5c` (5.8:1) | secondary text |
| `fg-3` | `#8a8a8a` (4.6:1) | `#6b6b6b` (4.6:1) | tertiary text, meta |
| `link` | `#6fa8ff` | `#0a5fd1` | markdown links only |
| `ok` | `#5fbf7f` | `#1a7f45` | "done" check glyph |
| `err` | `#f0726b` | `#c4312a` | "failed" glyph and word |
| `primary` / `primary-fg` | `#e6e6e6` / `#141414` | `#1a1a1a` / `#fbfbfb` | the one filled button (send, create) |
| `focus` | white 55% | black 50% | 2px focus outline, 1px offset |
| `scrim` | black 50% | black 20% | dialog backdrop |

Running = neutral spinner (`fg-3`). Cancelled / idle = grey glyph. There are no tier colours,
no accent, no tinted fills.

### Type

System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
mono `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No bundled fonts.

| Role | Size / line-height | Weight |
| --- | --- | --- |
| Meta, labels, group captions | 12 / 16 | 400 |
| UI (rows, buttons, inputs, tabs) | 13 / 20 | 400, 500 for emphasis |
| Prose, user message, composer | 14 / 1.55 | 400 |
| Markdown h3 / h2 / h1 | 15 / 16 / 17, 1.3 | 600 |
| Sub-agent role heading | 16 / 1.3 | 600 |
| Code, tool rows | 12 mono | 400 |

Sentence case everywhere; no uppercase tracked labels. Durations and counts use `tabular-nums`.

### Spacing and radius

4px grid. Sidebar 260px, rows 28px. Header 44px. Right pane 320px, tab strip 40px, tree rows 28px.
Chat measure 700px, gutters 24px. Delegation rows 36px.
Radius: `xs 4` inline code · `sm 6` buttons, rows, tabs · `md 8` inputs, delegation list, code ·
`lg 12` composer, user message, dialog. Elevation only on dialogs and the overlaid pane
(`shadow-pop`, neutral); everything else is flat with hairlines.

### Component rules

- **Sidebar.** Wordmark "Octo" (13px semibold) + collapse button; "New project" row with `+`;
  "Projects" caption (12px `fg-3`); 28px text-only rows, age or spinner right-aligned;
  bottom row: connection state only when not online, theme toggle on the right.
- **Header.** Project name (13px medium) and icon buttons: Agents, Notes, Settings. No folders, tokens or counts.
- **User message.** `raised` box, radius 12, right-aligned, 14px.
- **Assistant.** Plain prose, no speaker label. Finished turn starts with a muted
  "Worked for 42s" line; a live turn ends with a spinner + "Working… 12s".
- **Tool calls.** One muted line per consecutive group ("Read 2 files, ran 1 command ›"),
  collapsed by default; expands to 12px mono rows that each expand to input/result.
  Failure: the word "failed" in `err`.
- **Delegations.** Hairline list, radius 8, one 36px row per agent: glyph · role · title
  (`fg-2`, truncates; running rows append their activity) · right meta `haiku-5-5 · 12s`.
  Caption "3 agents in parallel" above when more than one. Nested count "+1" in the meta.
  Whole row is a link; hover = `hover` fill.
- **Sub-agent view.** Breadcrumb (13px `fg-3`, "/" separated), role 16px semibold, title
  `fg-2`, meta line `sonnet-5-5 · balanced · 12s · done`, "Task brief" disclosure collapsed.
  Bottom bar: solid `raised` strip, "Read-only. Only the orchestrator can direct this agent."
  + text button "Back to orchestrator".
- **Right pane.** Text tabs (Agents, Notes), active = `active` fill. Agents tree: one line per
  agent — indent, chevron, glyph, role, muted duration.
- **Composer.** One `raised` box, radius 12, hairline that strengthens on focus. Footer inside:
  muted model and folder names as plain text; round `primary` send button, stop square while running.
  No helper text.
- **Dialogs.** 32px inputs, 13px labels in `fg-2`, neutral primary button, no descriptions.
- **Empty states.** One-line title, one line of secondary text, at most three quiet rows.
- **Motion.** Spinner and streaming caret only; both stop under `prefers-reduced-motion`.
- **Jump to latest.** 28px round icon button, bottom-right of the scroll area.

## Principles

1. **One conversation, many workers.** The orchestrator chat is the product. Sub-agents are
   reachable from it (delegation rows, Agents pane) but never compete with it for space.
2. **Quiet density.** 13px chrome, 14px prose, hairlines, no boxes around assistant text.
   Hierarchy comes from weight and the grey ramp, not from colour or containers.
3. **No brand colour.** Colour means state: green done, red failed, blue link. Everything else is grey.
4. **Observation is explicit.** A sub-agent transcript is read-only by construction: no
   composer, a read-only bar, a breadcrumb back to the orchestrator.
5. **Offline-first chrome.** No network fonts, no CDN; the shell renders and explains itself
   when the bridge is down.

## Layout

```text
┌ sidebar 260 ─┬ header: project name ·························· [Agents][Notes][⚙] ┬ pane 320 ──┐
│ Octo     [«] │                                                                  │ Agents Notes│
│ + New project│   breadcrumb (sub-agent only)                                    │ ▾ ✓ Orch.   │
│ Projects     │   ┌ measure 700 ───────────────────────────────┐                  │   ✓ Role 4s │
│ Project A  2h│   │                         [ user message ]   │                  │   ◌ Role 9s │
│ Project B  ◌ │   │ Worked for 42s                             │                  │             │
│              │   │ prose…                                     │                  │             │
│              │   │ Read 2 files, ran 1 command ›              │                  │             │
│              │   │ 3 agents in parallel                       │                  │             │
│              │   │ ┌ ✓ Role  title ········· haiku-5-5 · 4s ┐ │                  │             │
│              │   │ └ ◌ Role  title · Reading… sonnet-5-5 · 9s┘ │                  │             │
│           ☾  │   [ composer                         model  ● ]                  │             │
└──────────────┴──────────────────────────────────────────────────────────────────┴─────────────┘
```

Below 1100px the right pane overlays the chat; below 1000px the sidebar starts collapsed.

## Components (`packages/ui/src/components`)

| Folder | Components |
| --- | --- |
| `primitives` | Button, IconButton, Dialog (focus trap, Esc, restore focus), Field/Input/Textarea, Tabs, Spinner, StatusIcon |
| `shell` | Sidebar (+ProjectRow, ConnectionStatus, theme toggle), OfflineState |
| `chat` | ConversationView, Transcript (+UserPrompt, TurnStatus, TurnBanner), Markdown (+CodeBlock copy), ToolGroup, DelegationGroup/DelegationRow, Composer, ObserverBar, AgentHeader/Breadcrumb, StarterPrompts |
| `agents` | AgentsPanel (ARIA tree) |
| `notes` | NotesPanel (+NoteItem, NoteEditor) |
| `project` | ProjectHeader, ProjectDialog (create + settings + delete), NoProjectsHero |

`app/` holds `OctoApp` (props: `bridge`, `bridgeUrl`, `shell`, `demo?`), `AppShell` and
`ProjectWorkspace`.

State: `state/app.tsx` (bridge, health, projects, config, theme) and `state/project.tsx`
(`useReducer` over agent-client `applyEvent`/`with*`, SSE subscription, refetch on reconnect).
Routing: `lib/route.ts` — `#/p/{projectId}` and `#/p/{projectId}/a/{agentId}`.

## Interaction rules

- **Transcript grouping.** Messages are split into turns at user *text* messages. Tool-result-only
  user messages are never shown; results are paired to their `tool_use` by id.
  Consecutive ordinary tool calls collapse into one summary line.
  `spawn_agent` calls in one assistant message render as one delegation list.
  Turn duration = last message of the turn minus its prompt.
- **Delegation row.** Status glyph, role, title, model, live duration, `+N` nested. No excerpts
  or token counts; the child's output lives in its own transcript. Click / Enter opens it.
- **Tool line.** Summary of the group; expand shows one mono row per call (verb · argument ·
  failed); each row expands to input and result in mono, capped height.
- **Composer.** Auto-grow to 40% viewport; Enter sends, Shift+Enter newline; Send ↔ Stop in place.
  Offline → disabled with the reason as placeholder.
- **Scroll.** Stick to bottom only while the user is within 80px of it; otherwise show the
  jump-to-latest icon button.
- **Agents pane.** Full tree; depth ≥ 2 nodes start collapsed with `+N`; current agent has the
  `active` fill; selection navigates. Arrow keys move, Enter opens, ←/→ collapse/expand.
- **Notes.** Separate tab; author as plain text (Orchestrator / You); inline add/edit/delete with confirm.
- **Theme.** Dark is the designed default; first run follows `prefers-color-scheme`; toggle persists in
  `localStorage` (guarded).

## States

| State | Treatment |
| --- | --- |
| Bridge checking | Skeleton sidebar rows, "Connecting…" at the sidebar foot |
| Bridge offline | Title, one sentence, `harness serve` command (copy), Retry; sidebar foot says "Bridge offline" |
| No projects | "No projects yet", one line, "Create project" |
| New project | Project name, one line, three suggestion rows; composer below |
| Turn running | Send→Stop; spinner + "Working… 12s" under the turn; running rows show a spinner |
| Turn failed / cancelled | One line under the last turn: "Turn failed." in `err` plus the error |
| Sub-agent pending | Row from `tool_use.input` with "starting" until `agent.created` arrives |

## Demo mode

`?demo=1` → `createDemoBridge()` (in-memory `Bridge`): a finished project (parallel + nested
delegations, tools, notes, table/code answer), a live project replaying a scripted turn, and an
empty project. `?demo=empty` starts with no projects. Sending a message in demo runs a short scripted turn.
