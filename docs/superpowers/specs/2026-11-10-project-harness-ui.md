# Project harness — UI design

**Date:** 2026-11-10 · **Parent:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md)
**Code:** `packages/ui` (`@octo/ui`), hosted by `apps/desktop`.

## v6 — spacing system, file view, floating composer (2026-11-10, contract)

Owner direction: paddings and margins balanced and exact; the code view works like the owner's reference agent
IDE (breadcrumb row, editor edge to edge, tree column on the right, floating composer with status chips). Match
structure, proportion and finish only — no other product's name, icons or assets, no features we do not have
(no "Changes"/diff view, no browser tab, no ports).

### Decisions

1. **Spacing scale** 2 4 6 8 12 16 20 24 32 40 (px) for every padding, margin, gap and inset in our DOM. Row heights
   come from one set: **24** (compact controls, chips), **28** (tabs, tree rows, menu rows, request rows, filter
   input), **32** (sidebar action/project rows, delegation rows, dialog inputs), **36** (group tab strip), **40**
   (header rows: chat header, file breadcrumb row, composer one-line). Window gutters are one value on all sides
   and between panels. Icon → label gap inside a row is 8 (6 in 24px chips). Exceptions must be listed in the
   audit's allow-list with a reason (Monaco internals are out of scope; text optical offsets are not exceptions).
2. **Spacing audit** `packages/ui/scripts/spacing-audit.mjs` (Playwright, against a running dev server on demo
   data): walks visible elements under the app root and fails (exit 1, JSON report) on off-scale
   padding/margin/gap/`top|right|bottom|left` of positioned elements, row heights outside the set for elements
   marked as rows (`role` row/tab/treeitem/menuitem/option, buttons in lists, `[data-row]`), unequal window
   gutters, transcript / header / composer left and right edges that differ by > 0.5px, icon–label gaps < 6 in
   rows, and overlaps between named pairs (chat header vs transcript content, Jump to latest vs text, floating
   composer vs editor text). States: chat idle and running, delegation card, file view with tree, markdown
   preview, palette, settings, narrow (960 and 390). Widths 1440 and 1100. Run before and after; target 0.
3. **Turn rail**: one marker per request in the conversation's left padding (hidden when that padding is < 24px);
   hover/focus card (first lines, state, relative time); click/Enter scrolls to the request; the request in view is
   emphasised. Never overlaps the column.
4. **File view** replaces the Files tab's tree-only view. Every File tab (and the `files` tab when no file is
   open) renders: a **40px breadcrumb row** — back / forward (walk the files viewed in this group, reopening a
   closed one), crumbs `folder › dir › file` (a dir crumb reveals it in the tree), then on the right: language
   server status / problems, Preview|Source (Markdown only), a `…` menu (Copy path, Copy relative path, Reveal
   in tree, Move to the other side) and the tree-column toggle; the **editor edge to edge** below it (no inner
   margins; Monaco padding top 8); the **tree column** on the right: hairline on its left edge, 280px default,
   resizable 200–480, collapsible; width and open state persist per project and are shared by every file view.
   The tree column's header holds the **Filter files** input (28px). The `files` tab with no file shows the same
   row (crumb = project name) and "Select a file" centred in the editor area; opening a file from it turns that tab
   into the File tab in place. The header's Files button opens/focuses that view.
5. **File-type icons**: lucide icons by extension, all `fg-3` (no per-language colours): code, JSON/config
   (json, toml, yaml, ini, lock), Markdown/text, image, stylesheet, folder / folder-open. Used in the tree, file
   tabs and crumbs.
6. **Filter files**: substring (case-insensitive) over relative paths; while active, directories are loaded
   breadth-first up to 200 directories / 5,000 entries (then a quiet "Showing matches in loaded folders" line);
   matches show their ancestors expanded, matched text in `fg` weight-neutral highlight (`hover` background);
   Esc clears; ↓ from the input enters the tree; empty result = "No files match".
7. **Markdown preview**: `.md`/`.markdown` open in Preview; the toggle switches to Source (Monaco, comments
   available) and is remembered per tab. Preview = the chat Markdown renderer, `measure` width centred, 32px top
   and bottom padding, live with the buffer (edits in Source show in Preview), relative links to project files open
   them, images are not loaded from the network.
8. **Floating composer**: when no Chat tab is visible (any group), the focused group shows a floating composer
   centred at its bottom (max 640px, 16px from the bottom and sides, `shadow-float`, radius 12) over the editor
   area (never over the tree column). Above it, 24px status chips: the turn state (spinner + "Working… 12s", or
   "Worked for 23s" / "Turn failed"), "N agents running" when any, "N comments" when pending; a chip click
   focuses Chat (comments chip opens its popover). It shares the Chat composer's draft, model and send path. The
   editor reserves room for it (Monaco bottom padding = its height + 16) so the last line is reachable.
9. **Defects to fix**: status glyph → role gap in delegation rows (8px); Jump to latest never covers text (reserve
   room / fade); read-only bar on one line down to a 280px group (truncate, then icon-only button); chat header is
   opaque and the transcript starts below it (no overlap when scrolled); Chat tab label padding symmetric; one
   selected-row shape (radius 6, same insets) across sidebar, trees, palette, menus.

### Acceptance criteria (v6)

1. `spacing-audit.mjs` exits 0 on every listed state and width; its before/after counts are recorded below.
2. A request marker click scrolls to that request; the hover card shows its first line and state; keyboard works.
3. Opening a file shows the breadcrumb row, the editor edge to edge and the tree column on the right; collapsing,
   resizing and reloading keep the column's state; back/forward walk the viewed files.
4. Typing in Filter files narrows the tree to matches with ancestors, including files in folders not yet expanded.
5. A Markdown file opens in Preview; Source shows Monaco; edits in Source appear in Preview.
6. With only a file view visible, the floating composer sends to the orchestrator; chips show the live turn;
   the editor's last line is reachable above it.
7. The four listed defects are gone (screenshots at 1440 and 1100, dark and light).
8. Gates: agent-client tests, UI lint/type-check, desktop build; no console errors; initial bundle growth recorded.

## Workspace v4 (2026-11-10; supersedes the docked/overlay side pane of v3)

Implements §4 of [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md)
plus the v3 design-review findings. Code comments, language servers and the plugins view followed in v5 (below).

### Model

```text
window ─────────────────────────────────────────────────────────────────────────────────────┐
│ sidebar │ [◧] Project name ················ [agents][notes][files] [⚙]   ← header row   │
│         │ ╭ group 1 ──────────────────────╮ 6 ╭ group 2 ──────────────────────────────╮ │
│         │ │ [Chat][Test runner •]         │ ┃ │ [Agents][refresh.ts ●][metro.config.js]│ │
│         │ │ conversation                  │ ┃ │ editor / tree / notes                  │ │
│         │ ╰───────────────────────────────╯   ╰───────────────────────────────────────╯ │
└──────────────────────────────────────────────────────────────────────── 6px margins ────┘
```

- **Layout** = ordered groups in one row: `{ groups: [{ id, tabs: TabId[], active, size }], focused }`.
  Tab ids: `chat`, `agents`, `notes`, `files`, `agent:{agentId}`, `file:{folder}\0{path}`. Pure reducers in
  `state/workspace/layout.ts` (open, close, move, split, activate, resize, parse/validate); the provider
  (`state/workspace/WorkspaceProvider.tsx`) adds persistence, routing, guards and the tab memory.
- **Groups**: sizes are fractions (flex weights); min 280px; at most 4; empty groups are removed. The
  6px gap between groups is the divider (`role="separator"`, arrows ±16px, Shift ±64, double-click = equal).
- **Opening**: delegation rows and the agents tree → Agent tab in Chat's group (Alt/Option-click → the other
  side); file links and the Files tree → File tab in the *side group* (the neighbour of Chat's group; created
  to its right at 50% for a file, 360px for a tool); header buttons → Agents / Notes / Files in the side group.
  "Other side" of group *i* = *i*+1, or *i*−1 for the last group, or a new group on the right when alone.
- **Shortcuts**: `Ctrl/Cmd+\` move active tab to the other side · `Ctrl/Cmd+W` close · `Ctrl+Tab` /
  `Ctrl+Shift+Tab` cycle in the group (capture phase, so they work inside Monaco). Tab strip: ←/→/Home/End,
  Delete closes, Shift+F10 / context-menu key opens the tab menu (Move to the other side, Split right, Close,
  Close others). Middle-click closes.
- **Persistence**: `localStorage["octo.layout.{projectId}"]` (guarded). Unknown ids, duplicates, agents that no
  longer exist, files in removed folders or gone from disk are dropped silently; Chat is always restored.
- **Routes**: `#/p/{pid}` focuses Chat; `#/p/{pid}/a/{aid}` opens/focuses that Agent tab. Focusing a Chat or
  Agent tab writes its route (so back/forward walk conversations); tool and file tabs leave the hash alone.
- **Narrow**: when the window is < 1100px or the dock is narrower than the groups' minimum widths, only the
  focused group is shown and its strip lists every tab of every group (no drag, no split; the menu offers Close /
  Close others). Groups stay mounted, so crossing the breakpoint keeps scroll positions and editors.
- **Keep-alive**: a tab's view mounts on first show and stays mounted (hidden) while it stays in its group; moving
  a tab remounts it, so conversations remember scroll position and the composer draft in a per-project tab
  memory. Each File tab owns a Monaco editor (models stay in `EditorBuffers`).
- **Drag and drop** (pointer events, 4px threshold, no layout change on start): a floating chip follows the
  pointer, the source tab dims; over a strip a 2px accent insertion bar shows the slot; over a group body the
  outer quarter on either side shows a half-width "split" zone, the middle a full "into this group" zone
  (accent 10% fill + accent 40% edge, radius 8, inset 6px). Esc or releasing outside cancels.

### Dock library decision

| Option | Initial JS (gzip) | Theming | Verdict |
| --- | --- | --- | --- |
| `dockview-core` 8.9.0 + `dockview-react` (MIT, active) | +89 kB for core alone, tree-shaken with esbuild (UMD min, no styles: 94 kB) + React adapter + ~6 kB CSS | CSS variables over its own DOM (sash, tab, drop-target classes); floating groups, popouts and grid nesting we don't need | Fails the ~70 kB budget |
| Hand-built dock (`components/dock/`) | +11.7 kB measured for all of v4 (168.55 → 180.22 kB) | Tokens only; same tab/row/focus states as the rest of the UI | **Chosen** |

The dock needs one row of groups, tabs that move between groups or split a group left/right, and resizable
dividers. That is ~800 lines of our own code and keeps every pixel on our tokens.

### Motion

| What | Enter | Exit | Reduced motion |
| --- | --- | --- | --- |
| Dialog, palette (opened by pointer) | 160ms, opacity + scale 0.98→1 + 4px rise, `cubic-bezier(0.2,0,0,1)` | 100ms opacity + scale 0.98, ease-out | opacity only (120 / 80ms) |
| Anything opened from the keyboard (Ctrl/Cmd+K, Shift+F10…) | instant (`html[data-input="keyboard"]`) | instant | — |
| Context menu | instant | instant | — |
| Drawer (sidebar) | 160ms, translateX(−12px)→0 + opacity; scrim opacity | 120ms ease-out | opacity only |
| Press (buttons, icon buttons, send) | `:active` scale 0.97, 120ms ease-out | — | none |
| Press (rows, tabs) | `:active` hover tint over the current fill, 100ms | — | same (tone) |
| Drop indicator, drag chip | 120ms fade; zone glides 120ms `cubic-bezier(0.2,0,0,1)` | removed | fade only |
| Hover fills | 100ms background-color | — | instant |
| Tabs open/close, tab switching, group split/merge | instant (no layout jump; panes keep their scroll) | instant | — |
| Theme switch | transitions suppressed for one frame | | |

Interaction transitions are ≤ 200ms and always name their properties (no `transition: all`).

### Craft rules (orchestrator addendum)

- **Meta** is laid out in columns or with spacing and tones, never joined with "·".
- **Loading** indicators (`useDelayedLoading`): nothing for loads under 200ms; once shown, at least 300ms
  (file tree folders, requests, editor, opening a file, saving).
- **Tooltips** (`components/primitives/Tooltips.tsx`): one layer fed by the `title` every control has; first after
  600ms, neighbours instantly for 400ms after; none on disabled controls; `data-shortcut` adds a `kbd` hint (also
  in palette rows and the tab menu).
- **Focus** ring = `box-shadow` on `:focus-visible` (inset for rows/tabs, `focus-inset`), so it follows the radius;
  transparent outline for forced colours. Nested radii are concentric: menu rows 4 (8−4), palette rows 4 (10−6),
  delegation rows 2 (8−6).
- **Text**: no weight change between states; tabular numerals on durations/counters; "…"; NBSP between a number
  and its noun ("2 agents"); chrome (buttons, tabs, rows, menus) is `user-select: none`, transcript and code are
  selectable; `::selection` uses the `selection` token.
- **Paths** in tooltips and long file-tab names are shortened in the middle, keeping the file name.
- **Hit areas** ≥ 24px (the tab close glyph is 16px with a 24px `::before`; dividers are the exception at 14px so
  they never cover a neighbouring panel's scrollbar).

### Review fixes folded in (v3 review)

Requests "Couldn't load" gets Retry · composer, read-only bar and transcript share both edges (symmetric scrollbar
gutter, one measure token) · sidebar keeps creation order · 24px tree chevrons that never navigate · re-tuned text
ramp (table below) · legible Monaco palette and line numbers, no needless horizontal scrollbar · Jump to latest
centred above the composer · one-line pinned prompt on short viewports · starter prompts as bordered rows · pressed
states · "Keep mine" · overlay motion · two-step heading scale (`text-title` 16/1.3, `text-heading` 14/1.4, both 600)
· "Show requests in {name}" · stacked dialog footer under 420px · note actions visible on touch and focus · one
spinner at most (the watched live turn; everything else running = static accent dot) · delegation card as
caption + status, aligned grid rows · model shown once per context (composer footer, Agent tab header, short label
on delegation rows).

## v5 — code comments, language servers, plugins (2026-11-10)

Implements §5 and the UI part of §3 of [`2026-11-10-workspace-plugins-acp-design.md`](./2026-11-10-workspace-plugins-acp-design.md).
Everything inside the editor (comment boxes, the LSP client) is in the lazily loaded Monaco chunk; the initial
bundle grew 180.89 → 188.94 kB gzip.

### Code comments

```text
  10   const token = await verifyRefresh(raw);
 ▌11 [+]if (token.revokedAt) throw …          ← hovered line: neutral full-width tint, "+" at the code's start
     ╭ 💬 Line 11 ·················· Edit Remove ╮   ← card: overlay widget over a view zone, code column → right − 12px
     │ Add a grace window here.                   │
     ╰────────────────────────────────────────────╯
  12   await db.refreshTokens.revoke(token.id);
```

- **Model** (`state/comments.tsx`, `lib/comments.ts`): `CodeComment = { id, folder, path, start, end, text, created }`
  (1-based inclusive lines), per project in `localStorage["octo.comments.{projectId}"]` (guarded; malformed entries
  dropped on load). Counts per file key feed the File tab and tree markers (`aria-description`, names unchanged).
- **Editor** (`components/files/editor/`): hovering a line tints it (`hover`) and shows an 18px filled `primary` "+"
  straddling the start of the code (code left − 4px, centred on the line; it never moves the gutter or code; it stays
  while the pointer travels onto it; tooltip to its left). "+", `Ctrl/Cmd+Alt+C` and the context menu's "Add comment"
  open the composer under the line — or under the selection when several lines are selected. Commented lines carry a
  2px `accent` rail in the line-decorations gutter and a faint accent tint (`--octo-comment-line`).
- **Boxes**: each composer/card is a Monaco *view zone* (the room) plus an *overlay widget* (the box: above the text
  layer so it takes the pointer, fixed to the viewport so horizontal scroll never clips it), one React root each.
  Left edge = code left, right edge = content right − 12px, 4px above and below. A new box is rendered and measured
  before its zone is inserted, so the code below moves once, by exactly its height. Raised surface, `line` hairline,
  radius 8, `focus` edge — the chat composer's treatment. Enter adds, Shift+Enter newline, Esc cancels.
- **Tracking**: ranges are tracked decorations; edits move comments (a deleted range collapses onto the nearest line);
  a disk reload (`buffers.replacing`) keeps line numbers.
- **Sending**: the composer footer shows "N comments" (popover grouped by file: jump, remove, Remove all); send is
  enabled with comments and no text. `prepare()` quotes the lines as they are now (open buffer, else disk) and appends
  the fenced `octo-comments` block (≤ 6 quoted lines, then `> …`; the fence grows past any backtick run in the text);
  `commit()` clears exactly those comments after the send succeeds.
- **Transcript**: `splitComments` renders the prose, then cards (path + lines link → opens the file with the range
  selected; quoted lines in mono, 3 then "Show N more lines"; the comment). Sidebar, palette and pinned prompt use
  `requestTitle`: the prose, else "N comments on {file}".

### Language servers

- `lsp/hub.ts` (main chunk) is the seam: per-file `{ status, problems, notice }` read by the File tab header with
  `useSyncExternalStore`. The client (`lsp/manager.ts`, `session.ts`, `rpc.ts`, `convert.ts`, `uri.ts`) loads with
  Monaco; `CodeProvider.startIntel` starts it, and disposes it (sessions closed) on project switch/unmount.
- One session per (project, server), started when the first model in one of its languages opens and closed when its
  last file closes. `initialize` (20s) → `initialized`; full-text `didOpen` / `didChange` (250ms debounce, flushed
  before requests) / `didClose`. Requests time out after 5s and honour Monaco cancellation (`$/cancelRequest`);
  server→client requests get null answers (configuration, registration, progress) or "method not found".
- URIs: `file:///` + folder path + relative path, each segment percent-encoded (drive letters kept); `fromFileUri`
  maps back to the deepest matching folder.
- Diagnostics → markers (owner `lsp`; error/warning squiggles in `err` / `warn`, unnecessary code faded) and the
  header's "N problems" popover (row → line). Hover, completion and definition providers are registered once per
  language and routed by model. A definition in the project opens that file as a tab at the position (editor opener);
  outside → a quiet header notice. Monaco's built-in TypeScript hover/completion/definitions are off from load (the
  worker reads its mode configuration once): intelligence comes only from the project's servers.
- Header status (`EditorStatus`): "{label}" when ready, spinner + "starting…" only after 200ms, "failed" / "stopped" in
  `err` with Retry; accessible name "Language server: {label}, {state}".
- Widgets: theme colours for hover / suggest / peek / list; radius 8, `shadow-pop`, UI type (styles.css, `:root`
  specificity because Monaco's CSS loads later). Scrollbars: 6px rounded thumb, 8px and stronger on hover/drag.

### Plugins view

Settings → Plugins (read-only `listPlugins()`): per plugin name (mono), version, description; rows for language
servers (with languages), agents and tool servers; "Available" (ok dot) / "Not found on this machine"; manifest
errors in `err`. Empty: one sentence naming `plugin.json`, `{data-dir}/plugins/` and `--plugins-dir`. The dialog is
now the 520px width.

### Review fixes (v4 review)

- **Pinned prompt**: pins only once the in-flow prompt is fully above the scroll area, and lets go as soon as the
  next prompt would reach the pinned copy's bottom (its measured height incl. the fade) — never two boxes, no ghosting.
  Fade 12px (8px on short viewports).
- **Transcript scroll**: `useNow` returned a fresh `Date.now()` on every render while idle, defeating the transcript's
  `memo` on each scroll-driven re-render. Idle clocks now tick once a minute.
- **Agents tree**: expansion and scroll live in the workspace tab memory, so moving the tab keeps them.
- **Jump to latest**: 12px above the composer on `overlay` with `shadow-pop`, over a panel-coloured fade so the content
  under it reads as fading out.
- **Demo**: `?lsp=fail-once|slow|exit`, `?plugins=none`; a scripted TS/Go language server (`demo/lsp.ts`, lazy).

## Structure v3 (2026-11-10, plan; supersedes the flat two-column layout below)

Owner verdict on v2: "still reads as a web page". The fix is structural, not cosmetic.

1. **Inset panels.** The window background *is* the sidebar. The conversation is a darker inset
   panel (1px hairline, radius 10, 6px margin top/right/bottom, flush to the sidebar); the docked
   side pane is a second inset panel 6px to its right. New token ramp: `window`, `panel`, `raised`,
   `overlay`, `hover`, `active`, `line`. Light: grey window, white panels. Monaco takes `panel`.
2. **Two-level sidebar.** Header: back / forward (`history`), search (opens the palette).
   "New project", "Projects +", then project rows with a disclosure chevron and one right-aligned
   state (spinner running · blue unseen dot · relative time). Expanded project = its requests
   (orchestrator user messages, newest first, 5 + "Show all (N)"), loaded lazily and cached by
   `updated_at`. Request click → open project and scroll to that turn; the request in view is
   marked (IntersectionObserver). Footer: "Settings" (theme System/Dark/Light, bridge URL + state).
3. **Conversation.** User box raised above the panel; the prompt of the turn being read pins to the
   top of the scroll area (overlay copy, 3-line clamp, click to expand) with a fade. Delegation card
   radius 8 with "Show in panel". One selected fill (`active`) for every list.
4. **Radii by token:** 6 controls/rows · 8 boxes/cards/inputs · 10 panels/dialogs · 12 composer.
5. **Command palette** (Ctrl/Cmd+K, sidebar search): Projects, Requests, Agents, Actions.
6. **Guards.** Switching project with unsaved editor changes asks first.
7. **Demo:** 6 projects (one running, two finishing a turn just after load so they show unseen dots,
   one with 9 requests, long names).

## Visual spec (2026-11-10, Cursor-agent-window alignment; supersedes the first restyle)

Structure, density and conventions follow the product owner's reference screenshots of Cursor's
agent window (Claude Code desktop as a secondary reference). We match layout, proportions and
type sizes only: no Cursor name, assets, icons or CSS; lucide icons and our own neutral tokens;
no features we do not have.

### Colour tokens (`packages/ui/src/styles.css`) — v3 surfaces

Neutral greys plus four state hues. Surfaces nest: the **window** (also the sidebar) holds
**inset panels** (conversation, docked side pane); **raised** boxes sit on panels; **overlay** is for
dialogs and the palette. In dark the window is *lighter* than the panels; in light the window is
grey and the panels white.

| Token | Dark (default) | Light | Role |
| --- | --- | --- | --- |
| `window` | `#1b1b1b` | `#f2f2f2` | window background = sidebar, gaps between panels |
| `panel` | `#141414` | `#ffffff` | inset panels (conversation, side pane, overlaid pane), Monaco background, inputs |
| `raised` | `#222222` | `#f5f5f5` | user message, pinned prompt, composer, read-only bar |
| `overlay` | `#232323` | `#ffffff` | dialogs, command palette |
| `code-bg` | `#1c1c1c` | `#f5f5f5` | code blocks, tool detail |
| `hover` | white 5% | black 4% | row / control hover |
| `active` | white 10% | black 7% | **the one selected fill**: sidebar rows, requests, agents tree, file tree, tabs, palette, theme radio |
| `line` | white 8% | black 9% | panel edge, hairlines, cards, user box |
| `line-strong` | white 14% | black 14% | hover edge, separators on hover |
| `fg` / `fg-2` / `fg-3` | `#f0f0f0` / `#c6c6c6` / `#a2a2a2` | `#1a1a1a` / `#424242` / `#636363` | text ramp (v4: neighbours ≥1.49:1 apart, every pair ≥4.5:1 everywhere) |
| `selection` | accent 32% | accent 20% | `::selection` |
| `drop`, `drop-edge` | accent 10% / 45% | accent 8% / 40% | dock drop zone fill / edge |
| `warn` | `#d8b07a` | `#8a5512` | warning glyphs and squiggles (v5) |
| `comment-line` | accent 8% | accent 6% | tint of commented lines in the editor (v5) |
| `accent` | `#5c9dff` | `#0a66e0` | activity: running spinners, unseen-activity dot, jump highlight |
| `link` | `#6fa8ff` | `#0a5fd1` | markdown links |
| `ok` / `err` | `#5fbf7f` / `#f6847e` | `#1a7f45` / `#b42a23` | done glyph / failed glyph and error text |
| `primary` | `#e6e6e6` on `#141414` | `#1a1a1a` on `#ffffff` | the one filled button |
| `focus`, `scrim` | white 60%, black 50% | black 55%, black 20% | focus outline, backdrops |

Measured pixels (Playwright, DPR 2, dark / light): window `#1b1b1b` / `#f2f2f2`, panel `#141414` / `#ffffff`,
user box `#222222` / `#f5f5f5`, selected sidebar row `#323232` / `#e0e0e0`, hover row `#262626`,
panel edge `#262626`, active tab on panel `#2b2b2b`.

**Contrast (WCAG 2), v4 ramp, computed from the tokens with alpha fills composited** (`scratchpad/v4contrast.py`).
Separation: dark fg/fg-2 1.50, fg-2/fg-3 1.49 (v3: 1.74 / 1.27); light 1.73 / 1.67 (v3: 1.87 / 1.46).

| Surface / state | Dark fg · fg-2 · fg-3 · err | Light fg · fg-2 · fg-3 · err |
| --- | --- | --- |
| window | 15.11 · 10.08 · 6.75 · 6.99 | 15.55 · 8.98 · 5.37 · 5.69 |
| window + hover | 13.28 · 8.86 · 5.93 · 6.14 | 14.20 · 8.20 · 4.90 · 5.20 |
| window + active | 11.25 · 7.51 · 5.02 · 5.20 | 13.31 · 7.69 · 4.59 · 4.87 |
| panel | 16.17 · 10.79 · 7.22 · 7.47 | 17.40 · 10.05 · 6.01 · 6.37 |
| panel + hover | 14.30 · 9.54 · 6.38 · 6.61 | 15.96 · 9.22 · 5.51 · 5.84 |
| panel + active | 12.25 · 8.18 · 5.47 · 5.67 | 14.87 · 8.58 · 5.13 · 5.44 |
| raised | 13.96 · 9.31 · 6.23 · 6.46 | 15.96 · 9.22 · 5.51 · 5.84 |
| overlay | 13.79 · 9.20 · 6.16 · 6.38 | 17.40 · 10.05 · 6.01 · 6.37 |
| overlay + hover | 11.92 · 7.95 · 5.32 · 5.51 | 15.96 · 9.22 · 5.51 · 5.84 |
| overlay + active | 10.13 · 6.76 · 4.52 · 4.69 | 14.87 · 8.58 · 5.13 · 5.44 |
| code | 14.95 · 9.98 · 6.68 · 6.91 | 15.96 · 9.22 · 5.51 · 5.84 |

Every pair is ≥ 4.5:1, including the selected states (the v3 exception on `overlay + active` is gone; meta on
selected rows may still use `fg-2` for emphasis).
`accent` as a non-text glyph: 6.3 / 4.7 on the window, 6.8 / 5.3 on panels.

### Type

System stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
mono `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No bundled fonts.

| Role | Size / line-height | Weight |
| --- | --- | --- |
| Meta, context line, captions in cards | 12 / 16 | 400 |
| UI (rows, buttons, tabs, title bar) | 13 / 20 | 400, 500 for the title |
| Prose, tables, user message, composer, "Worked for" | 14 / 1.6 | 400 |
| `text-title`: page / dialog-less titles, markdown h1–h2 | 16 / 1.3 | 600 |
| `text-heading`: dialog titles, sub-agent role, markdown h3–h4 | 14 / 1.4 | 600 |
| Code, tool arguments | 12 mono | 400 |

Sentence case everywhere. Durations and counts use `tabular-nums`.

### Spacing and radius

4px grid. Top bar 40px. Sidebar 260px (`w-sidebar`), action and project rows 32px.
v4: header row 40px on the window surface; group tab strip 36px, tabs 28px, tree rows 28px.
Chat column: `--spacing-measure` 720px of content plus 24px padding (16px when the conversation is under 560px, a container query); transcript, pinned prompt and composer share both edges. Composer 40px tall when one line.
Radius (tokens, nothing rounder): `xs 4` inline code · `sm 6` controls, rows, tabs · `md 8` user message,
cards (delegation), inputs, code · `lg 10` inset panels, dialogs, palette · `xl 12` composer and read-only bar.
Inset panels: 1px `line` edge, radius 10, 6px window margin top/right/bottom and between panels, flush to the
sidebar; full-bleed (no edge, no radius, no margin) below 640px. Elevation: dialogs, palette, drawer, overlaid pane.

### Component rules

- **Top bar.** Inside the conversation panel: sidebar toggle (left), project name as the title (13px medium,
  `title` = full name), then on the far right: Project settings and the single side-panel toggle.
- **Sidebar (window tone, no edge of its own).** See *Sidebar model* below.
- **User message.** Full column width, `raised` fill (lighter than the panel), `line` border, radius 8.
- **Pinned prompt.** Once a turn's prompt scrolls under the top edge, a copy pins over the top of the scroll
  area (opaque `panel` strip, 8px inset, 24px fade below; it overlays the transcript, so pinning never shifts
  content). Clamped to 3 lines; when clamped it is a button ("Expand the pinned request", `aria-expanded`).
- **Assistant.** Muted "Worked for 41s", then plain prose; tables with hairlines and a bold
  header row; inline code chips. A finished orchestrator turn ends with a muted footer: copy-reply
  icon button and "2h ago". A live turn ends with a spinner + "Working… 12s".
- **Tool calls.** One muted line per consecutive group ("Read 2 files, ran 1 command ›"), past
  tense throughout; single calls show verb · mono argument · "in {folder}". Failure: "failed" in `err`.
- **Delegations.** Bordered card (radius 8): caption row "3 agents" ("2/3 done" while any is running) and,
  right-aligned, a quiet "Show in panel" text button (opens the Agents tab; hidden while it is showing); then one 32px row per agent: glyph · role · title (`fg-2`; running rows
  append their activity) · right meta `haiku-5-5 · 12s`. Failed rows add a second line with the
  error in `err` (also `aria-description`). The row is a container query: below 440px the model
  hides, the role truncates. Whole row links to the transcript.
- **Sub-agent view.** Breadcrumb, then one line: role (semibold) + title (`fg-2`) with
  `model · tier · duration · status` muted on the right (wraps beneath on narrow). Failed agents
  show the error in `err` plus "Ask the orchestrator to retry it." "Task brief" collapsed.
  Bottom: bordered `raised` read-only bar with "Back to orchestrator".
- **Groups (v4).** Each tab group is an inset panel; its 36px strip holds compact text tabs with a kind icon
  (Chat, Agent, File, Agents, Notes, Files), active = `active` fill (`hover` fill when the group is not focused),
  close on hover/active (never Chat), grey dot = unsaved, accent dot = working agent. See *Workspace v4*.
- **Composer.** One `raised` row: textarea and a round send button (stop square while running). Footer
  line: folders on the left (pending comments will join them), the orchestrator model as a quiet label on the right. Placeholder "Message the orchestrator" when empty, "Send follow-up" once there are
  messages; the accessible name is always "Message the orchestrator". Focus = `focus` edge.
  Below the box: folder names as one muted 12px line. No attach button.
- **Errors.** Every error names a next step; Retry where possible (turn failed → resend the last
  message; project load → reload; send failed → resend the text still in the box).
- **Dialogs.** 32px inputs with `input-border`, 13px labels in `fg-2`; submit is always enabled,
  validation runs on submit, errors are linked with `aria-describedby` and the first invalid field
  takes focus. Footer wraps; outer padding 12px below 640px.
- **Empty project.** Project name, one line, three plain suggestion rows, top-aligned.
- **Motion.** Spinner, streaming caret, chevron rotation (150ms) and the jump highlight; under
  `prefers-reduced-motion` they stop / become instant, and jumps scroll instantly. Theme switches suppress
  transitions for one frame.

### Sidebar model (v3)

```text
[⌕]                    [←][→]      header, aligned with the panel top bar (search opens the palette;
                                   back/forward = history.back/forward, disabled via the Navigation API)
⊕ New project
Projects                       +
› Infrastructure: Terraf…      •   unseen activity (accent dot, sr "New activity")
⌄ Orbit mobile                 ◌   running (accent spinner, sr "Working")
    Upgrade us to React N…     ◌   request whose turn is running
    Earlier request…          2h   requests: newest first, 5 shown, "Show all (N)" / "Show fewer"
› Atlas API                   1h   otherwise relative time
…
⚙ Settings          Bridge offline  footer; connection state only when not online
```

- Rows: project 32px (chevron button 24px "Requests in {name}" with `aria-expanded`, then the link), request
  28px with the text inset (30px) on the project name. Selected = `active`: the request in view while the
  orchestrator is open (`aria-current="location"`), otherwise the project row (`aria-current="page"`).
- Requests = user text messages of the orchestrator thread (`getProject` → `listMessages`), loaded when a row
  is expanded, cached per project and refetched only when the project's `updated_at` changes
  (`state/requests.tsx`). The open project is expanded by default.
- Click a request → open the project, scroll its prompt 16px under the top edge, `data-flash` accent ring for
  1.6s (`state/nav.tsx` carries the request across the navigation). The request in view is tracked with an
  IntersectionObserver on a band under the top edge.
- Unseen (`lib/seen.ts`): `localStorage["octo.seen"] = { since, projects: { id: updated_at } }`, guarded.
  A project is unseen when `updated_at` > its stored value (or > `since`, the first-run time). The open project
  is marked seen whenever it changes and never shows the dot. Tracked in the shell so it runs while the drawer
  is closed.
- **Settings dialog** (footer): Theme radio group System / Dark / Light (System = default, follows
  `prefers-color-scheme` live; hidden when the host sets `theme`) and Bridge (URL, state, Retry when offline).

### Command palette (v3)

Ctrl/Cmd+K anywhere (capture phase, so it also works in Monaco) or the sidebar search button. Centred overlay
(`overlay`, radius 10, max 560px): an input (`role="combobox"`, `aria-activedescendant`) over a listbox with
groups **Projects**, **Requests** (open project), **Agents** (open project, `listAgents` on open) and
**Tabs** (every open tab) and **Actions** (Show agents/notes/files, Move tab to the other side, Split right, Close tab, Close other tabs, Make groups equal width — when they apply — then New project, Open settings, Toggle sidebar; shortcuts as `kbd` hints). Substring match ranked by position
and word start, else in-order fuzzy match; 6 rows per group. ↑/↓/PgUp/PgDn move, Enter runs, Esc closes, Tab
stays in the input, focus returns to the opener; hover highlights but never moves the keyboard selection; the
result count is announced (`role="status"`).

### Guards

Leaving a project (sidebar, palette, back/forward, request click) while the editor has unsaved files is held:
the URL is restored, and a dialog asks "Discard unsaved changes?" (Stay / Discard and leave).

### Code pane (Files tab)

Spec: [`2026-11-10-code-pane-design.md`](./2026-11-10-code-pane-design.md). Code: `components/files/`,
`state/code.tsx` (open files, tree cache, save/conflict/live refresh), `lib/files.ts`.

- **Tabs (v4).** The Files tree is a tab; every open file is its own File tab in the dock (no nested editor strip).
  Opening a file from the tree or a link puts it in the side group (widened to ≥45% of the row). Each File tab has a
  32px header (path crumbs; right slot for editor actions), the notice line, then its own Monaco editor.
- **Tree.** One collapsible root per project folder (label, medium weight, `title` = absolute path; roots
  start expanded), directories load on expand. Rows exactly like the agents tree: 28px, 14px indent per level,
  12px chevron, 14px `fg-3` file/folder icon, truncating name with `title` = `folder/path`, selected = `active`.
  Loading / "Couldn't load … Retry" / "Empty folder" rows in 12px `fg-3`. ARIA tree: arrows, ←/→ collapse/expand,
  Home/End, Enter opens or toggles.
- **Closing** a File tab with unsaved edits asks first (one dialog for several files: Cancel / Discard changes).
- **Notices.** One hairline-bounded line under the tab strip: "Changed on disk since you opened it."
  + Reload from disk / Overwrite (409 on save); "Changed on disk." + Reload / "Keep mine" (agent changed a modified
  file); "Couldn't save: …" in `err` + Retry. Too-large / binary / open error: one line in place of the editor.
- **Monaco.** Loaded only via `import()` (`components/files/monaco.ts`), workers bundled with `?worker`,
  no CDN. 13/20 mono from the token stack, no minimap/rulers/sticky scroll/bracket colours, padding top 8.
  Themes `octo-{dark,light}`: background = `panel`; plain text grey; keywords blue, strings sage, numbers sand,
  types teal, italic grey comments — each ≥4.5:1 on the panel and visibly distinct from plain text; line numbers
  ≥4.5:1 (`#808080` / `#737373`). `scrollBeyondLastColumn: 0`, so no horizontal scrollbar unless a line is wider than
  the editor; slim neutral scrollbars (v5: 6px rounded thumb, 8px on hover/drag). `Ctrl/Cmd+S` saves.
- **Links.** read_file / write_file paths in tool details open the file (list_dir reveals the folder) in the
  Files tab / File tab; omitted `folder` = first folder. Host `openFile` wins. No link without folders.
- **Empty.** "No folders attached. Add one in project settings." + Project settings button.

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
window (sidebar tone) ───────────────────────────────────────────────────────────────────────────┐
│ [⌕]          [←][→] ╭ panel ─────────────────────────────────────────╮ 6 ╭ panel ─────────────╮ │
│ ⊕ New project       │ [◧] Project name ······················ [⚙][▣] │   │ Agents Notes Files  │ │
│ Projects          + │ ┌ pinned prompt (when scrolled) ─────────────┐ │   │ ⌄ Orchestrator      │ │
│ ⌄ Project A      ◌  │ └────────────────────────────────────────────┘ │   │   ✓ Role       4s   │ │
│     Request 1    ◌  │   prose… | table | `code`                      │   │   ◌ Role       9s   │ │
│     Request 2   2h  │   ┌ 3 agents ············· Show in panel ┐     │   │                     │ │
│ › Project B      •  │   └ ✓ Role  title ····· haiku-5-5 · 4s ──┘     │   │                     │ │
│ › Project C     1d  │   [ Send follow-up              opus-5-5 (↑) ]  │   │                     │ │
│ ⚙ Settings          ╰───────────────────────────────────────────────╯   ╰─────────────────────╯ │
└──────────────────────────────────────────────────────────────────────────────── 6px margins ──┘
```

≥1100px the pane docks beside the conversation (its tab strip shares the top bar's row) and
opens by default unless closed there before. Below 1100px it overlays the conversation under the
top bar, starts closed, takes focus on open, and closes on Esc or navigation (focus returns to
the toggle). Below 1000px the sidebar is a fixed drawer with a scrim, closed by default; it
closes on navigation and Esc, and opening it closes the pane overlay so the two never stack.

## Components (`packages/ui/src/components`)

| Folder | Components |
| --- | --- |
| `primitives` | Button, IconButton, Dialog and `useModal` (focus trap, Esc, restore focus), Field/Input/Textarea, Menu, Presence (exit animations), Tooltips, Spinner, RunningDot, StatusIcon |
| `shell` | Sidebar (+ConnectionStatus), ProjectItem (+RequestList), Panel, CommandPalette, SettingsDialog, TopBar, OfflineState |
| `chat` | ConversationView, Transcript (+UserPrompt, AssistantTurn, TurnFooter, TurnBanner), Markdown (+CodeBlock copy), ToolGroup, DelegationGroup/DelegationRow, Composer, ObserverBar, AgentHeader/Breadcrumb, StarterPrompts |
| `agents` | AgentsPanel (ARIA tree, 24px chevrons) |
| `notes` | NotesPanel (+NoteItem, NoteEditor) |
| `dock` | Dock (groups), TabStrip (+tab menu), Divider, DragLayer, TabView, `drag.ts`, `tabInfo.ts` |
| `files` | FilesTool (tree tab), FileTab (+Notice), FileTree (ARIA tree), CodeEditor (Monaco wrapper), `buffers.ts` (models per file), `monaco.ts` (lazy chunk: Monaco, workers, themes) |
| `project` | ProjectHeader, ProjectDialog (create + settings + delete), NoProjectsHero |

`app/` holds `OctoApp` (props: `bridge`, `bridgeUrl`, `shell`, `demo?`), `AppShell` (sidebar
inline/drawer) and `ProjectWorkspace` (header row + dock). v4 adds `components/dock/` (Dock, TabStrip, Divider, DragLayer, TabView, drag store) and `state/workspace/` (layout reducers, WorkspaceProvider); `state/pane.tsx` and the side pane are gone.

State: `state/app.tsx` (bridge, health, projects, config, theme preference), `state/nav.tsx` (request jumps,
request in view, leave guard, workspace API for the palette), `state/requests.tsx` (cached request lists, Retry), and `state/project.tsx`
(`useReducer` over agent-client `applyEvent`/`with*`, SSE subscription, refetch on reconnect).
Routing: `lib/route.ts` — `#/p/{projectId}` and `#/p/{projectId}/a/{agentId}`; `useGuardedRoute` can hold a change.

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
- **Theme.** Settings → System (default; follows `prefers-color-scheme` live) / Dark / Light, persisted in
  `localStorage["octo.theme"]` (guarded). Hidden when the embedding host sets the theme.

## States

| State | Treatment |
| --- | --- |
| Bridge checking | Skeleton sidebar rows, "Connecting…" beside Settings |
| Bridge offline | Title, one sentence, `harness serve` command (copy), Retry; "Bridge offline" beside Settings; Settings → Bridge has Retry |
| No projects | "No projects yet", one line, "Create project" |
| New project | Project name, one line, three suggestion rows; composer below |
| Turn running | Send→Stop; spinner + "Working… 12s" under the turn; running rows show a spinner |
| Turn failed / cancelled | One line under the last turn: "Turn failed." in `err`, the error, a next step and Retry (resends the last message) |
| Project failed to load | Message, next step, Retry (reloads the project) |
| Sub-agent failed | Row: second line with the error; transcript header: error + "Ask the orchestrator to retry it." |
| Sub-agent pending | Row from `tool_use.input` with "starting" until `agent.created` arrives |

## Demo mode

`?demo=1` → `createDemoBridge()` (in-memory `Bridge`), six projects: Atlas API (finished; parallel + nested
delegations, tools, notes, table/code answer), Orbit mobile (live scripted turn), Docs site (9 requests, for
"Show all"), two long-named projects whose short turns finish ~3–5s after load (unseen dots), and an empty one. Each folder has a small in-memory file tree (TS, Go, JSON, Markdown, CSS, one binary and
one >2 MiB file; sample content is imported lazily); saves emit `file.changed`, and the live Orbit run's
`write_file` calls change `android/build.gradle` and `metro.config.js` (agent `file.changed`). `?demo=empty` starts with no projects. Sending a message in demo runs a short scripted turn.
