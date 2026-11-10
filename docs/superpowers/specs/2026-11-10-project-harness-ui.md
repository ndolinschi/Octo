# Project harness — UI design

**Date:** 2026-11-10 · **Parent:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md)
**Code:** `packages/ui` (`@octo/ui`), hosted by `apps/desktop`.

## Principles

1. **One conversation, many workers.** The orchestrator chat is the product. Sub-agents are
   reachable from it (delegation cards, Agents panel) but never compete with it for space.
2. **Calm density.** 13px chrome, 14.5px prose, hairline borders, no boxes around assistant text.
   Hierarchy comes from type weight and the text ramp, not from colour or containers.
3. **One accent, one moving thing.** Iris is used for focus, the primary action and *live*
   work. Only running things animate (status pulse, label shimmer, streaming caret).
4. **Observation is explicit.** A sub-agent transcript is read-only by construction: no
   composer, a persistent observer bar, a breadcrumb back to the orchestrator.
5. **Offline-first chrome.** No network fonts, no CDN; the shell renders and explains itself
   when the bridge is down.

## Tokens (`packages/ui/src/styles.css`)

Runtime variables live on `:root[data-theme]`; `@theme inline` exposes them as Tailwind utilities.

| Token | Dark (default) | Light | Use |
| --- | --- | --- | --- |
| `bg` | `#111113` | `#fbfbfa` | main area |
| `sidebar` | `#0b0b0d` | `#f3f3f1` | left rail |
| `raised` | `#18181b` | `#ffffff` | cards, inputs, composer |
| `overlay` | `#1c1c20` | `#ffffff` | dialogs, popovers |
| `hover` / `active` | white 4% / 7% | black 4% / 6% | row states |
| `line` / `line-strong` | white 7% / 12% | black 8% / 13% | hairlines |
| `fg` / `fg-2` / `fg-3` | `#ededf0` / `#a5a5ae` / `#7f7f89` | `#18181b` / `#52525b` / `#6b6b75` | text ramp (all ≥ 4.5:1 on bg) |
| `accent` | `oklch(.74 .14 285)` iris | `oklch(.52 .19 285)` | focus, primary, running |
| `ok` / `err` / `muted` | green 155 / red 25 / fg-3 | darker variants | completed / failed / cancelled |
| `tier-fast/balanced/deep` | sky 225 / amber 75 / rose 350, chroma ≈ .09 | same hues, darker | tier badge dot + text |

Radii: `xs 4` (badges) · `sm 6` (buttons, rows) · `md 8` (inputs, cards) · `lg 12` (composer,
dialogs). Spacing: Tailwind 4px scale; chrome rows 28–32px; content measure `--measure: 720px`.
Type: Inter (local) → system UI stack; JetBrains Mono → `ui-monospace`. Sizes 11 / 12 / 13 / 14.5 / 16 / 20.
Elevation: border + `shadow-pop` (two soft layers) for dialogs only.

## Layout

```text
┌ sidebar 248 ─┬ header: name · folder chips · tokens · running · [Agents][Notes][⚙] ┬ panel 320 ┐
│ ◆ Octo   [+] │                                                                    │ Agents|Notes│
│ search (>6)  │   breadcrumb (sub-agent only)                                      │ tree / list │
│ ● Project A  │   ┌ measure 720 ─────────────────────────────┐                     │             │
│   Project B  │   │ user bubble (right)                      │                     │             │
│              │   │ Orchestrator  prose…                     │                     │             │
│              │   │ ▸ 3 tool calls                           │                     │             │
│              │   │ ┌ 2 agents in parallel ───────────────┐  │                     │             │
│              │   │ │ role · title  status tier tokens    │  │                     │             │
│              │   └──────────────────────────────────────────┘                     │             │
│ ● bridge  ☾  │   composer / read-only bar                                          │             │
└──────────────┴────────────────────────────────────────────────────────────────────┴─────────────┘
```

Below 1100px the right panel overlays the chat; below 1000px the sidebar starts collapsed.

## Components (`packages/ui/src/components`)

| Folder | Components |
| --- | --- |
| `primitives` | Button, IconButton, Dialog (focus trap, Esc, restore focus), Field/Input/Textarea, Tabs, StatusDot/StatusIcon/StatusLabel, TierBadge |
| `shell` | Sidebar (+ProjectRow, ConnectionStatus, theme toggle), OfflineState, OctoMark |
| `chat` | ConversationView, Transcript (+UserPrompt, TurnBanner), Markdown (+CodeBlock copy), ToolGroup/ToolRow, DelegationGroup/DelegationCard, Composer, ObserverBar, AgentHeader/Breadcrumb, StarterPrompts |
| `agents` | AgentsPanel (ARIA tree) |
| `notes` | NotesPanel (+NoteItem, NoteEditor, AuthorBadge) |
| `project` | ProjectHeader, ProjectDialog (create + settings + delete), NoProjectsHero |

`app/` holds `OctoApp` (props: `bridge`, `bridgeUrl`, `shell`, `demo?`), `AppShell` and
`ProjectWorkspace`.

State: `state/app.tsx` (bridge, health, projects, config, theme) and `state/project.tsx`
(`useReducer` over agent-client `applyEvent`/`with*`, SSE subscription, refetch on reconnect).
Routing: `lib/route.ts` — `#/p/{projectId}` and `#/p/{projectId}/a/{agentId}`.

## Interaction rules

- **Transcript grouping.** Messages are split into turns at user *text* messages. Tool-result-only
  user messages are never shown; results are paired to their `tool_use` by id.
  Consecutive ordinary tool calls collapse into one "N tool calls" row (expanded while one runs).
  `spawn_agent` calls in one assistant message render as one delegation group.
- **Delegation card.** role · title · status · tier+model · live duration · tokens · `+N` nested;
  finished cards show a two-line excerpt of `result` (or `error`). Click / Enter opens the
  child transcript. The child's output is *not* repeated in the parent beyond that excerpt.
- **Tool row.** icon · verb · key argument (path / command / title) · status. Expand shows input
  and result in mono, capped height. Errors use `err` text + icon, no red fills.
- **Composer.** Auto-grow to 40% viewport; Enter sends, Shift+Enter newline; Send ↔ Stop in place.
  Context line: folder chips + orchestrator model. Offline → disabled with the reason inline.
- **Scroll.** Stick to bottom only while the user is within 80px of it; otherwise show
  "Jump to latest".
- **Agents panel.** Full tree; depth ≥ 2 nodes start collapsed with a `+N` badge; current agent
  highlighted; selection navigates. Arrow keys move, Enter opens, ←/→ collapse/expand.
- **Notes.** Separate tab; author badge (Orchestrator / You); inline add/edit/delete with confirm.
- **Theme.** Dark is the designed default; first run follows `prefers-color-scheme`; toggle persists in
  `localStorage` (guarded).

## States

| State | Treatment |
| --- | --- |
| Bridge checking | Skeleton sidebar, no spinners |
| Bridge offline | Full-area panel: what happened, `harness serve` command (copy), Retry; sidebar shows red dot |
| No projects | Hero with mark, one-line pitch, three-step explainer, "Create project" |
| New project | Starter prompts that explain delegation; composer focused |
| Turn running | Send→Stop; orchestrator label shimmers; running cards pulse their dot |
| Turn failed / cancelled | Quiet banner under the last turn with the error text |
| Sub-agent pending | Card from `tool_use.input` with "Starting" until `agent.created` arrives |

## Demo mode

`?demo=1` → `createDemoBridge()` (in-memory `Bridge`): a finished project (parallel + nested
delegations, tools, notes, table/code answer), a live project replaying a scripted turn, and an
empty project. Sending a message in demo runs a short scripted turn.
