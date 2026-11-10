# Project harness — UI design

**Date:** 2026-11-10 · **Parent:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md)
**Code:** `packages/ui` (`@octo/ui`), hosted by `apps/desktop`.

## Visual spec (2026-11-10, Cursor-agent-window alignment; supersedes the first restyle)

Structure, density and conventions follow the product owner's reference screenshots of Cursor's
agent window (Claude Code desktop as a secondary reference). We match layout, proportions and
type sizes only: no Cursor name, assets, icons or CSS; lucide icons and our own neutral tokens;
no features we do not have.

### Colour tokens (`packages/ui/src/styles.css`)

Neutral greys only; no hue in chrome. Contrast is WCAG 2, measured with
a small script against every surface each token is used on; the lowest pair is listed.

| Token | Dark (default) | Light | Role |
| --- | --- | --- | --- |
| `bg` | `#161616` | `#fbfbfb` | whole app: sidebar, main area, docked pane |
| `raised` | `#212121` | `#f0f0f0` | user message, composer, inputs, read-only bar, active tab |
| `overlay` | `#1f1f1f` | `#ffffff` | dialogs, overlaid pane |
| `code-bg` | `#1c1c1c` | `#f3f3f3` | code blocks, tool detail |
| `hover` / `active` | white 5% / 8% | black 4% / 7% | row hover / selected row, pressed toggle |
| `line` / `line-strong` | white 9% / 14% | black 9% / 14% | hairlines, cards, user box, composer edge / quote bar |
| `input-border` | `#6e6e6e` (3.2:1 on `overlay`) | `#8a8a8a` (3.5:1 on `overlay`) | dialog and note inputs |
| `fg` | `#e6e6e6` (10.4:1) | `#1a1a1a` (14.3:1) | primary text |
| `fg-2` | `#a3a3a3` (5.2:1) | `#5c5c5c` (5.5:1) | secondary text; **meta on `active` rows** |
| `fg-3` | `#939393` (4.7:1) | `#666666` (4.7:1) | tertiary text, meta — never on an `active` fill (dark drops to 4.2:1 there) |
| `link` | `#6fa8ff` | `#0a5fd1` | markdown links only |
| `ok` | `#5fbf7f` | `#1a7f45` | "done" check glyph |
| `err` | `#f0726b` | `#c4312a` | failed glyph, word and error text |
| `primary` / `primary-fg` | `#e6e6e6` / `#161616` | `#1a1a1a` / `#fbfbfb` | the one filled button (send, create) |
| `focus` | white 60% | black 55% | 2px focus outline; composer focus edge (5.5:1 / 3.8:1 change vs `line`) |
| `scrim` | black 50% | black 20% | dialog and drawer backdrop |

Focused inputs switch `input-border` → `fg` (4.1:1 / 5.0:1 change). Running = neutral spinner.
No tier colours, no accent, no tinted fills.

### Type

System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
mono `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No bundled fonts.

| Role | Size / line-height | Weight |
| --- | --- | --- |
| Meta, context line, captions in cards | 12 / 16 | 400 |
| UI (rows, buttons, tabs, title bar) | 13 / 20 | 400, 500 for the title |
| Prose, tables, user message, composer, "Worked for" | 14 / 1.6 | 400 |
| Markdown h3 / h2 / h1 | 15 / 16 / 17, 1.3 | 600 |
| Sub-agent role | 14 | 600 |
| Code, tool arguments | 12 mono | 400 |

Sentence case everywhere. Durations and counts use `tabular-nums`.

### Spacing and radius

4px grid. Top bar 40px. Sidebar 260px (`w-sidebar`), action and project rows 32px.
Right pane 320px (`w-pane`), tab strip 40px (aligned with the top bar), tabs 28px, tree rows 28px.
Chat column 760px (`max-w-measure`) with 24px gutters (16px below 1000px). Composer 40px tall when one line.
Radius: `xs 4` inline code · `sm 6` buttons, rows, tabs · `md 8` user message, inputs, code ·
`lg 12` composer, delegation card, dialog. Elevation only on dialogs, the drawer and the overlaid pane.

### Component rules

- **Top bar.** Sidebar toggle (left), project name as the title (13px medium, `title` = full name),
  then on the far right: Project settings and the single side-panel toggle (pressed while open).
- **Sidebar.** Same `bg` as the app, hairline right edge. "New project" action row with a small
  leading icon; "Projects" caption with a `+` ("Add project") on the caption row; 32px project rows:
  leading glyph (neutral dot idle, spinner running), name, right-aligned relative time
  (`fg-2` on the selected row). Selected row = `active` fill, radius 6. Foot: muted "Octo" label,
  connection state only when not online, theme toggle.
- **User message.** Full column width, `raised` fill, `line` border, radius 8, left-aligned 14px.
- **Assistant.** Muted "Worked for 41s", then plain prose; tables with hairlines and a bold
  header row; inline code chips. A finished orchestrator turn ends with a muted footer: copy-reply
  icon button and "2h ago". A live turn ends with a spinner + "Working… 12s".
- **Tool calls.** One muted line per consecutive group ("Read 2 files, ran 1 command ›"), past
  tense throughout; single calls show verb · mono argument · "in {folder}". Failure: "failed" in `err`.
- **Delegations.** Bordered card (radius 12): caption row "3 agents" with "2/3 done" on the right
  while any is running; then one 32px row per agent: glyph · role · title (`fg-2`; running rows
  append their activity) · right meta `haiku-5-5 · 12s`. Failed rows add a second line with the
  error in `err` (also `aria-description`). The row is a container query: below 440px the model
  hides, the role truncates. Whole row links to the transcript.
- **Sub-agent view.** Breadcrumb, then one line: role (semibold) + title (`fg-2`) with
  `model · tier · duration · status` muted on the right (wraps beneath on narrow). Failed agents
  show the error in `err` plus "Ask the orchestrator to retry it." "Task brief" collapsed.
  Bottom: bordered `raised` read-only bar with "Back to orchestrator".
- **Right pane.** Tab strip with "Agents" and "Notes" (small leading icon, active = `raised`
  fill, no close buttons). Agents tree: one line per agent; the root shows a glyph only when not idle.
  Notes: quiet list with inline add/edit/delete.
- **Composer.** One `raised` row: textarea, muted model name, round send button (stop square while
  running). Placeholder "Message the orchestrator" when empty, "Send follow-up" once there are
  messages; the accessible name is always "Message the orchestrator". Focus = `focus` edge.
  Below the box: folder names as one muted 12px line. No attach button.
- **Errors.** Every error names a next step; Retry where possible (turn failed → resend the last
  message; project load → reload; send failed → resend the text still in the box).
- **Dialogs.** 32px inputs with `input-border`, 13px labels in `fg-2`; submit is always enabled,
  validation runs on submit, errors are linked with `aria-describedby` and the first invalid field
  takes focus. Footer wraps; outer padding 12px below 640px.
- **Empty project.** Project name, one line, three plain suggestion rows, top-aligned.
- **Motion.** Spinner and streaming caret only; both stop under `prefers-reduced-motion`, and
  jump-to-latest scrolls instantly then.

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
┌ sidebar 260 ──┬ top bar: [◧] Project name ················ [⚙][▣] ┬ pane 320 ─────────┐
│ ⊕ New project │                                                     │ ⧉ Agents  ▤ Notes │
│               │   ┌ column 760 ──────────────────────────────────┐  │ ▾ Orchestrator    │
│ Projects    + │   │ [ user message, full width                 ] │  │   ✓ Role      4s  │
│ • Project A 2h│   │ Worked for 42s                               │  │   ◌ Role      9s  │
│ ◌ Project B  …│   │ prose…  | table |  `code`                    │  │                   │
│               │   │ Read 2 files, ran 1 command ›                │  │                   │
│               │   │ ┌ 3 agents ······················ 2/3 done ┐ │  │                   │
│               │   │ │ ✓ Role  title ············ haiku-5-5 · 4s │ │  │                   │
│               │   │ └ ◌ Role  title · Reading… sonnet-5-5 · 9s ┘ │  │                   │
│               │   │ ⧉ 2h ago                                     │  │                   │
│ Octo        ☾ │   [ Send follow-up                 opus-5-5  (↑) ]  │                   │
│               │     atlas-api, atlas-web                            │                   │
└───────────────┴─────────────────────────────────────────────────────┴───────────────────┘
```

≥1100px the pane docks beside the conversation (its tab strip shares the top bar's row) and
opens by default unless closed there before. Below 1100px it overlays the conversation under the
top bar, starts closed, takes focus on open, and closes on Esc or navigation (focus returns to
the toggle). Below 1000px the sidebar is a fixed drawer with a scrim, closed by default; it
closes on navigation and Esc, and opening it closes the pane overlay so the two never stack.

## Components (`packages/ui/src/components`)

| Folder | Components |
| --- | --- |
| `primitives` | Button, IconButton, Dialog (focus trap, Esc, restore focus), Field/Input/Textarea, Tabs, Spinner, StatusIcon |
| `shell` | Sidebar (+ProjectRow, ConnectionStatus, theme toggle), TopBar, OfflineState |
| `chat` | ConversationView, Transcript (+UserPrompt, AssistantTurn, TurnFooter, TurnBanner), Markdown (+CodeBlock copy), ToolGroup, DelegationGroup/DelegationRow, Composer, ObserverBar, AgentHeader/Breadcrumb, StarterPrompts |
| `agents` | AgentsPanel (ARIA tree) |
| `notes` | NotesPanel (+NoteItem, NoteEditor) |
| `project` | ProjectHeader, ProjectDialog (create + settings + delete), NoProjectsHero |

`app/` holds `OctoApp` (props: `bridge`, `bridgeUrl`, `shell`, `demo?`), `AppShell` (sidebar
inline/drawer) and `ProjectWorkspace` (top bar, conversation, docked/overlay pane).

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
- **Composer.** Auto-grow to 40% viewport, refit on width changes (ResizeObserver); Enter sends,
  Shift+Enter newline; Send ↔ Stop in place.
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
| Turn failed / cancelled | One line under the last turn: "Turn failed." in `err`, the error, a next step and Retry (resends the last message) |
| Project failed to load | Message, next step, Retry (reloads the project) |
| Sub-agent failed | Row: second line with the error; transcript header: error + "Ask the orchestrator to retry it." |
| Sub-agent pending | Row from `tool_use.input` with "starting" until `agent.created` arrives |

## Demo mode

`?demo=1` → `createDemoBridge()` (in-memory `Bridge`): a finished project (parallel + nested
delegations, tools, notes, table/code answer), a live project replaying a scripted turn, and an
empty project. `?demo=empty` starts with no projects. Sending a message in demo runs a short scripted turn.
