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
   input), **32** (sidebar action rows, delegation rows, dialog inputs), **36** (group tab strip), **40**
   (header rows: chat header, file breadcrumb row, composer one-line; since v6.2 also the two-line project rows of the
   sidebar and Home). Window gutters are one value on all sides
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

### Reference analysis (owner: "analyse the good and the bad, then mix")

Two references: an agent IDE window (A) and a desktop assistant's code view (B).

| Pattern | Verdict | What we do |
| --- | --- | --- |
| A: one tab strip for everything (chat, file, changes) with kind icons, tabs of even width | Good: one mental model | Keep our dock; tabs get a min width 96 / max 200 so short labels do not hug their edges |
| A: breadcrumb row + back/forward, tree as a right column, editor edge to edge | Good: the file is the content, chrome is one row | Decision 4 |
| A: floating composer with status chips over a file | Good: never lose the conversation while reading code | Decision 8 |
| A: "+" menu in the composer: one searchable list (modes, skills, attach, tool servers), match highlighted in the row, hint on the right | Good: one entry point, keyboard first. Bad: modes and skills we do not have; coloured mode icons | Decision 10: our list holds only real things |
| A: "N files changed" card under a turn with per-file rows and Review | Good: the result of a turn is visible. Bad for us today: needs per-turn change records and a diff view | Deferred to v7 with a harness endpoint (per-turn changed files); no fake counts now |
| A: built-in browser, element inspector, ports | Out of scope: not an agent-harness feature | Not built |
| A: seven tabs of equal weight, half of them empty tools | Bad: chrome competes with the conversation | We keep Chat primary; tools open on demand |
| A: low-contrast grey on near-black for secondary text | Bad: fails 4.5:1 | Keep our measured ramp |
| B: sidebar = sessions grouped under their project, "+" per group, quiet state glyphs on the right | Good; we already have the two-level sidebar | Keep; align row anatomy (decision 1) |
| B: user message as a right-aligned bubble with "Show more" clamp | Mixed: the clamp is good, the bubble narrows long prompts | Keep the full-width box; clamp prompts longer than 8 lines with "Show more" |
| B: title with a menu in the header; tool icons on the right | Good | Chat header: project / request, plus a `…` menu (Copy request, Project settings) |
| B: composer hint line ("↵ to send…"), model and mode under the box | Good: teaches without a tooltip | Composer footer: model on the left, "↵ send · ⇧↵ new line" hint in `fg-3` on the right when the box is empty and focused |
| B: tool summary line "Ran 4 commands, read 2 files ›" | Good; we already have it | Keep |

10. **Composer "+" menu** (button at the composer's left, also opened by typing `/` or `@` at the start of a word):
    a searchable popover above the composer (`overlay`, radius 10, rows 28px, max 8 visible, match highlighted,
    ↑/↓/Enter/Esc, type-ahead filters). Groups, only when they have entries: **Files** (search project files —
    same loader as Filter files — Enter inserts `folder/path` as inline code and keeps focus), **Agents** (plugin
    ACP agents that are available: inserts "Use the {label} agent for this." — the orchestrator's `spawn_agent`
    already accepts `agent`), **Comments** ("Review N pending comments" opens the comments popover), **Actions**
    (Project settings, Show agents / notes / files). Nothing that the harness cannot do: no modes, no attach
    upload, no MCP picker.
11. **Long prompts** in the transcript clamp at 8 lines with "Show more" / "Show less" (`aria-expanded`).

Second batch of references (owner: "icons are not pretty; analyse these, do not copy blindly; maybe add a glow"):
an agent app with a customisations page (C) and an assistant's start page with a glow behind the input (D).

| Pattern | Verdict | What we do |
| --- | --- | --- |
| D: soft radial glow behind the centred input on the start page | Good as a single "start here" cue; bad if it leaks into working screens (noise behind text, banding, contrast loss) | Decision 12: glow only on empty states |
| C/D: start page = greeting + centred composer, nothing else | Good: one obvious action | Decision 13 |
| C: thin, consistent line icons; very few of them; plain "+" as the action | Good. Ours mix stroke weights and use busy file glyphs (file-with-badge) and unclear tool glyphs | Decision 14 |
| C: customisations as a two-column list: icon tile, name, one-line description, state/action on the right; Marketplace / Installed | Layout good. Marketplace is a non-goal (plugins are local files by design) | Settings → Plugins rows take that anatomy (tile, name, description, state); no marketplace, no Add |
| C: project selector chip above the composer | Not applicable: one conversation per project, chosen in the sidebar | Not built |
| C: pure-black window with barely lighter panel | Mixed: elegant, but panels lose their edge | Keep our measured window/panel pair |

12. **Glow** (`--octo-glow`): one static radial gradient of `accent` (dark ≤ 14% alpha at the centre, light ≤ 8%,
    fading to 0 by ~480px, no banding: multi-stop easing) behind the centred composer of an empty project and
    behind the no-projects hero. It fades in once (240ms, opacity) and never animates otherwise; it is not used on
    any screen with a transcript, code or lists. Text over it keeps ≥ 4.5:1 (measured against the brightest
    point). This is the one deliberate exception to "colour means state": it marks the place to start.
13. **Empty project**: vertically centred block — project name as title, one muted line, the composer (same
    component, 640px max), starter prompts as quiet rows under it. After the first message the composer is in its
    normal bottom position (no animation between the two layouts; the transcript simply appears).
14. **Icon system**: one `Icon` wrapper — lucide, stroke 1.5, `currentColor`, sizes 16 (rows, buttons, tabs) and 14
    (tree, chips, meta) only; optical centring in a fixed square slot. Review every glyph for meaning and
    family resemblance: tools (Agents, Notes, Files) get plain unambiguous glyphs; file types reduce to: folder /
    folder-open, generic file, code (`<>`-style braces file is fine but one glyph for all code), text/Markdown,
    image, config (one glyph for json/toml/yaml/lock/dotfiles). No two different glyphs for the same meaning, no
    glyph reused for two meanings; send = arrow-up, stop = square.

Third batch of references (more of B: a details side panel, stacked tool panels, an outputs list):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| B: details panel — Environment (machine, folder), Context ("16% used" with a per-category breakdown: label, value, share in aligned columns, tiny colour keys) | Good: answers "where does this run and what is it costing" without leaving the chat. We have no context-window figure, so a percentage would be invented | Decision 15: a Details tab with real data only (folders, models, tokens per agent) |
| B: outputs list — icon, name, muted type on the right, one row height | Good row anatomy; we have no "outputs" record | Same anatomy for Details rows and the "+" menu's file rows; an outputs list waits for v7's per-turn change records |
| B: header tool buttons with a filled "on" state for the open panel | Good; ours match | Keep; make sure the on state is the `active` fill, same as tabs |
| B: panels stacked vertically (terminal over browser) beside the chat, each with its own strip | Mixed: powerful, but three strips of chrome crush the conversation into a sliver (visible in the reference) | Not now: the dock stays one row of groups; "Split down" is a v7 candidate. No terminal (the harness has no PTY endpoint) and no browser |
| B: code spans and fenced code in answers are tinted / highlighted | Good, and requested by the owner | Decision 16 |

15. **Details tab** (`details`, header button "Project details", in the side group at 360px like the other tools):
    sections with 12px `fg-3` captions and 28px rows (icon, label, right-aligned muted value) — **Folders** (label,
    path shortened in the middle, full path in the tooltip; click opens the file view on that root), **Models**
    (orchestrator, fast, balanced, deep — as configured), **Tokens** (total in / out, then one row per agent
    sorted by total: role, a 2px proportional bar in `fg-3`, `in / out` in tabular numerals; the orchestrator
    first; ACP agents marked "approx."), **Plugins in use** (language servers and agents available to this
    project). No percentages of a context window — the harness does not report one.
16. **Code highlighting in the chat**: fenced code blocks in the transcript and in the Markdown preview are
    syntax-highlighted with the editor's own palette (same token colours as the `octo-dark` / `octo-light` Monaco
    themes, so chat and editor agree). Implementation: Monaco's `colorize` when the editor chunk is already
    loaded, otherwise a small lazily loaded tokenizer (no new initial-bundle weight beyond ~3 kB; the block
    renders plain first and upgrades without changing its size). Unknown languages stay plain. Inline code is
    never highlighted.

Fourth batch (E: a messenger-style bot app — "interesting ways to interact with the orchestrator"):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| E: side panel with Activity / Library; Library lists what the bot produced, grouped Today / This week, filter All / Media / Files, "Show more" | Good: the work product is one click away, not buried in the scroll. We can derive it from data we already store (`write_file` / ACP edit tool calls in agent transcripts) | Decision 17: Details tab gets Activity and Files sections |
| E: time separators between bursts ("Today 10:00 AM") | Good: orients in a long-lived project conversation (ours is one conversation per project, so it grows for weeks) | Decision 18 |
| E: entities in prose rendered as inline chips with a glyph (PR, tool, link) | Good: prose stays scannable and actionable | Decision 19: file paths in answers become links with a file glyph |
| E: short progress lines as separate small messages before the real answer | Good idea, already ours in another form (muted tool summary line + "Working…") | Keep ours; no bubbles |
| E: tables as their own rounded card with right-aligned numerals | Good | Markdown tables: numeric columns right-aligned with tabular numerals (detect columns whose cells are all numeric) |
| E: chat bubbles, saturated purple user bubble, mascot avatars, message previews in the sidebar | Bad for us: messenger look fights a work tool; brand colour breaks "colour means state"; avatars are another product's identity | Not taken |
| E: reactions, Share | No backing feature | Not built |

17. **Details tab, continued** — two more sections under Tokens: **Activity** (agents newest first: status glyph,
    role, title, relative time; click opens the Agent tab; 8 rows then "Show all") and **Files** (files written
    by agents in this project, from `write_file` and ACP edit/write tool calls in the stored transcripts: file
    glyph, name, folder path muted, grouped Today / This week / Earlier, newest first, deduplicated by path with a
    "×N" count; click opens the file; 8 rows per group then "Show more"). Loaded lazily when the tab first opens
    (one `listMessages` per agent, at most 4 in flight, cached per agent `finished_at`), refreshed on
    `file.changed` from an agent. Empty: "No files written yet."
18. **Time separators** in the orchestrator transcript: a centred 12px `fg-3` line before a request that starts
    more than 30 minutes after the previous turn ended or on a different day ("Today 10:00", "Yesterday 18:42",
    "Nov 6, 09:15"; locale time format). Not inside a turn, not in sub-agent transcripts.
19. **File links in prose**: inline code in assistant prose that equals a project file path (`folder/path`, or a
    path that is unique under one folder — resolved against the file index used by Filter files, loaded lazily
    and never blocking render) becomes a link (file glyph + the same mono text, `link` colour on hover only) that
    opens the file; `path:12` or `path:12-20` selects those lines. Unresolved code stays plain.

20. **Integrations view** (replaces the Plugins section's plain list; reference E's "connect apps" dialog — taken:
    search on top, kind chips, two-column rows, a "N available" summary; not taken: Connect buttons, a catalogue,
    third-party logos — plugins are local manifests by design). Settings → Integrations: a search field
    ("Search integrations"), 24px filter chips All / Language servers / Agents / Tool servers (with counts,
    `aria-pressed`), a summary on the right ("5 available" + "1 not found" in `fg-3`), then two columns (one below
    560px) of 40px rows: a 28px neutral tile with the kind glyph, name, one muted line (languages for a server,
    command label for an agent, URL for a tool server, plugin name on the right), and the state (ok dot
    "Available" / "Not found on this machine"); manifest errors listed under their plugin in `err`. Footer line:
    how to add one (`plugin.json`, `{data-dir}/plugins/`, `--plugins-dir`). The dialog is 640px wide for this view.
    The palette gets "Open integrations".

Fifth batch (F: a start screen with a dithered light streak behind the composer and overview cards — owner:
"this effect looks cool"):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| F: a diagonal light streak rendered with visible ordered dithering (pixel grain) across the start screen | Good: gives the product a face without an illustration or a logo; the grain hides banding and reads as crafted, not as a stock gradient. Bad if it sits under dense text or runs everywhere | Decision 21: our own streak, start screens only (supersedes the plain radial glow of decision 12) |
| F: overview cards under the composer — activity heat map, usage total with provider split, recent sessions, this month | Good: the empty start screen becomes useful. Each card must be real data | Decision 22: Home with cards computed from what the harness stores |
| F: cards as translucent dark panels over the effect | Good, if text contrast is measured on the brightest spot | Cards use `panel` at 88% with `backdrop-filter: blur(12px)`; fall back to opaque `panel` |
| F: pull-request list, "PRs merged" | No backing data (no git integration) | Not built |
| F: saturated full-spectrum colours (red/orange/blue) | Too loud for a tool whose colour means state; also the other product's signature | Our palette: `accent` blue through indigo with one thin warm edge at low alpha |

21. **Streak** (`components/shell/Streak.tsx`, canvas, lazily loaded, not in the initial bundle): one diagonal band
    of light (about 24° from the top-left to the right edge) built from 3–4 soft lobes in `accent` → indigo with
    a thin warm (`warn`-hued) rim, quantised with a 4×4 Bayer ordered dither at 2 CSS px cells (so the grain is
    visible but fine), over the `panel` colour. Peak alpha: dark ≤ 55% inside the band's core, light ≤ 22%; the
    band never passes behind body text — the title and composer sit on it, cards are their own surfaces. Drawn
    once per size/theme change (ResizeObserver, DPR-aware, ≤ 4 ms at 1440×900); a 20 s ± 12px drift is allowed
    only when `prefers-reduced-motion` is not set and the tab is visible; otherwise static. Fades in 240ms. Used on
    Home, the empty project and the no-projects hero — nowhere else. `aria-hidden`, pointer-events none. Text on
    it keeps ≥ 4.5:1 at the brightest pixel (measured; add a local scrim under the title if needed).
    **21b — streak, second version (owner: "the gradient looks weak, not cool, not like the references").**
    The first version was too timid: one thin blue band at ≤ 55% alpha with a fine 2px grain reads as a faint
    texture, and in light it nearly disappears. What makes the reference work is (1) energy — a hot core and a
    cool halo, so the band has temperature contrast, not one hue; (2) scale — the band is a third of the window
    and crosses the whole surface corner to corner; (3) grain you can see — chunky ordered-dither pixels and a
    sparse noise field over the whole background, not only inside the band; (4) surfaces sit *in* the light —
    cards pick up its colour through translucency. Version two:
    - **Shape:** a diagonal band from the top-left to the bottom-right edge of the panel, core width ≈ 18% of the
      panel's shorter side, halo ≈ 45%; two or three overlapping lobes with slightly different angles so the edge
      is irregular; a second, fainter echo band offset below.
    - **Colour (our own ramp, not the reference's):** core `#ff7a3d` → `#ff3d6e` (amber to hot pink) → mid
      `#7a5cff` (violet) → halo `--octo-accent` blue → `#1b2a5e` falloff; a thin near-white (`#eaf2ff`) highlight
      along the upper edge of the core. Dark: core alpha up to 95%, halo 60%. Light: the same ramp at 55% / 35%
      over the white panel, with the falloff toward `#dfe8ff` instead of navy.
    - **Dither:** 4×4 Bayer at **3 CSS px** cells (4 px at ≥ 1920 wide), quantised to 5 levels per channel so the
      steps are visible; plus a static sparse noise field (≈ 3% of cells lit at 6–10% alpha in the ramp's hues)
      over the whole start-screen background.
    - **Surfaces over it:** cards and the project list use `panel` at 72% (dark) / 80% (light) with
      `backdrop-filter: blur(16px) saturate(1.2)`, a 1px `line-strong` edge and a 1px inner top highlight, so the
      band tints them; opaque fallback when backdrop filters are unsupported or under forced colours. The title
      sits on the band with a soft local scrim only if its contrast would drop below 4.5:1; every text run on a
      translucent surface is measured at the brightest pixel behind it and must stay ≥ 4.5:1 (raise the surface
      opacity locally before dimming the band).
    - **Where:** Home, the empty project (mounted behind the tab strip and chat header so there is no hard cut),
      the no-projects hero. Nowhere with a transcript, code or lists.
    - **Motion:** static by default; the optional drift stays as specified (off under reduced motion).
    - **Performance:** draw at half resolution of the dither grid (one sample per cell), ≤ 4 ms at 1440×900.
    - Verified by side-by-side screenshots against references 18–20 at 1440 and 1920, dark and light.
23. **The UI must read as "a project's orchestrator at work", not as a list of chat sessions** (owner: "the UI
    shows sessions, but our point is that the project orchestrator works"). Today the sidebar nests request
    titles under each project exactly like session lists in chat tools, Home lists "recent requests", and the chat
    header is `project / request` — all of which say "pick a conversation". The product is the opposite: one
    long-lived orchestrator per project that plans, delegates and remembers. Changes:
    - **Sidebar = projects only.** No nested request rows, no chevrons. Each project row is 40px with two lines:
      name, and the orchestrator's state in `fg-3` — "Working · 3 agents" (accent dot/spinner), "Needs you"
      (when a turn failed or, later, an approval is pending), "Idle · 2h" — plus the unseen dot. Requests stay
      reachable where they belong: the turn rail in the conversation and the palette ("Requests").
    - **Chat header = the orchestrator.** `Project name` as the title; under/next to it the orchestrator's live
      line: state, the model, running agents as a compact stack ("Dependency auditor, Test runner +1") that opens
      the Agents tab, total tokens. The request title is not a breadcrumb; the request in view is shown only by the
      rail and the pinned prompt.
    - **Tab label** "Chat" → "Orchestrator".
    - **A live "team" strip** above the composer while a turn runs: one chip per running sub-agent (role,
      activity verb, duration), click opens its tab; collapses to "N agents working" when narrow. It replaces the
      plain "Working… 12s" line as the main sign of life (the line stays for the orchestrator's own thinking).
    - **Home = projects and their orchestrators**, not requests: the list shows each project with its state and
      what the orchestrator is doing or last did (first line of its latest reply, not the user's prompt); the
      "Recent requests" card becomes **"Orchestrators at work"** — running agents across projects (project, role,
      activity, duration), empty state "Nothing is running"; the other cards stay.
    - **Empty project** copy speaks about the orchestrator ("Give {project}'s orchestrator its first task"), and
      shows what it has: folders, models per tier, available agents — as three quiet facts under the composer
      instead of generic starter prompts only.
    - **Words:** never "session", "thread", "chat" or "conversation" in UI copy; "request" for what the user asked,
      "run" for a sub-agent's work, "orchestrator" for the project's agent.
24. **Quiet tool panels** (owner on the Usage panel beside the orchestrator: "the right sidebar looks bad — the
    buttons are too gaudy"). What is wrong: three boxed segmented controls stacked on top of each other
    (Tokens|Cost|Limits, then 7d|30d|90d — whose labels truncate to "3…" and "9…" — then This project|All
    projects), directly under a strip that already carries a tab plus six icon buttons. Fourteen boxed controls
    before the first number. Rules for every tool panel (Usage, Details, Agents, Notes, Files):
    - **No boxed segmented controls inside a tool panel.** Views are **text tabs**: one row of 13px labels, the
      current one in `fg` with a 2px underline in `fg`, the others `fg-3`, 16px apart, 28px row, no fills, no
      borders. Usage: "Tokens  Cost  Limits".
    - **Options are inline menus, not button groups**: range and scope become two quiet text buttons with a 12px
      chevron on the total's row, right-aligned ("30 days ⌄", "This project ⌄"), each opening a menu. Never
      truncate a control's label; if the row is too narrow the scope menu drops to its own line.
    - **The strip carries tabs only.** The six tool buttons leave the group strip (see decision 25: they live in
      the "+" menu and the palette); Project settings moves to the orchestrator header's `…` menu. The window's
      top-right corner is empty.
    - One number is the hero (the total); breakdown rows share one grid (label, bar, value) across By model / By
      agent; section captions 12px `fg-3` with 24px above, 8px below.
    - At most one filled or bordered control visible in a tool panel at rest (the floating composer excluded).
25. **Browser-grade tabs** (owner: "tabs must be like in a browser — draggable and really convenient"). The strip
    behaves like a browser's:
    - **Sizing:** tabs share the strip; each is up to 200px, shrinking evenly to a 96px minimum as more open,
      then to icon-only (40px, tooltip with the name) before the strip scrolls; the active tab never shrinks
      below 96px. The Orchestrator tab is pinned first (cannot be closed or moved out of first place in its group).
    - **"+" at the end of the tabs** (and `Ctrl/Cmd+T`): a menu / quick picker — Agents, Notes, Files, Details,
      Usage, then "Open file…" (the file search) and running or recent agents. This replaces the header's tool
      icon cluster.
    - **Close:** × on hover and on the active tab, middle-click, `Ctrl/Cmd+W`; `Ctrl/Cmd+Shift+T` reopens the last
      closed tab (a per-project stack of 20). After closing, the neighbour to the right becomes active (else left).
    - **Switch:** `Ctrl+Tab` / `Ctrl+Shift+Tab` in most-recently-used order, `Ctrl/Cmd+1…8` by position,
      `Ctrl/Cmd+9` the last; mouse wheel over the strip scrolls it.
    - **Drag to reorder with live displacement:** the dragged tab follows the pointer along the strip (clamped to
      the strip while inside it); neighbours slide out of the way as its centre passes theirs (150ms
      `cubic-bezier(0.2,0,0,1)`, transform only); on drop it settles into its slot (120ms). No insertion bar
      inside a strip.
    - **Drag out:** pulled more than 24px below/above the strip the tab detaches into a floating chip; over
      another group's strip it joins that strip with the same live displacement; over a group body the left /
      right quarter shows the split zone, the middle "move here"; dropped on the window's far right edge it
      creates a new group. Esc cancels and the tab returns to its slot with a 150ms settle.
    - **Keyboard equivalents:** `Ctrl/Cmd+Shift+PageUp/PageDown` move the tab left/right; the existing
      "Move to the other side" and "Split right" stay in the tab menu, which also gains "Close tabs to the right"
      and "Reopen closed tab".
    - **Overflow:** when tabs scroll, a 24px "all tabs" button at the strip's right opens a searchable list.
    - **Feel:** no layout jump on open/close (neighbours animate their width 120ms; instant under reduced
      motion); the strip never shifts the panel below it; hit areas ≥ 28px tall; touch drag after a 250ms hold.
    - Pure logic (sizing, MRU order, closed-tab stack, displacement slots) lives in `state/workspace/*.ts` with
      unit tests; pointer handling in one module (`dock/drag.ts`).
Sixth batch of references (G: a multi-agent workspace app — its "what's new" dialog, phone inbox, site hero,
model picker and desktop sidebar; owner: "do not copy — study and adapt"):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| G phone inbox: four status tiles — Activity, Needs you, In progress, Ready for review — above everything | Good: the first question on opening the app is "what needs me?", and it is answered in one glance. Fits us better than it fits a thread list, because our unit is a project's orchestrator | Decision 26: a triage row on Home |
| G: a daily recap written as a sentence with inline entities ("You sent 39 prompts across 7 chats. Most of it went into …, with … carrying 99% of the tokens. Your agents ran for 5h 47m") | Good: numbers become a story; cheaper to read than four cards. Bad if any figure is invented | Decision 26: recap sentence built only from stored data, each figure linking to its source |
| G: activity grouped Priority / Yesterday / Earlier / Done | Good: order by what matters, then by time | Home's project list is grouped Needs you / Working / Recent / Idle instead of flat |
| G model picker: provider tabs with a favourites star, search, rows with ⌘1 / ⌘2 and a star, an effort slider with labelled stops, an "Auto-compact" row | Good: one compact popover answers "which model, how hard, how long can it run". Bad for us: provider-first tabs (our user thinks in tiers and agents, not vendors) | Decision 27: our picker — tiers, models, subscription agents; search; favourites; effort; compaction |
| G: two-tone headlines — a muted lead-in, then the statement in full white ("Introducing Remote Connections. Control … from another.") | Good: hierarchy inside one sentence without a second font size | Decision 28: start-screen and dialog titles use it |
| G "what's new" dialog: generative character/dither art as a header band, eyebrow, headline, one paragraph, two buttons | Good anatomy for announcements and first-run steps; the art is the same idea as our streak | Dialog header band = a cropped streak preset (decision 28); no changelog feature yet |
| G desktop sidebar: an icon rail (home, inbox, tasks, pull requests, scheduled, apps) beside the list | Useful once there are several top-level areas; today we have two (Home, Projects) | Not now. Revisit when Bots and scheduled tasks land (then: Home, Projects, Bots, Scheduled, Usage) |
| G: thread rows with a meta line of glyph + project + branch + PR number | We have the two-line project row; branch/PR need git integration | Keep ours; add branch when git lands |
| G: translucent window showing the wallpaper | Platform effect (window vibrancy), only meaningful in the Tauri shell | Later, with the Tauri shell work; never in the browser host |
| G: remote control of one computer from another, phone apps | Large: needs authenticated remote access to `harness serve` | Out of scope now; noted as a future spec |
| G site hero: a painting behind the headline | Marketing, not the app | Not taken |

26. **Home triage and recap** (replaces the centred title-only top of Home):
    - **Triage row** under the title: four 64px tiles in one row (two rows of two under 640px) — **Needs you**
      (failed turns and, from v7, pending approvals; `warn` glyph, count), **Working** (orchestrators with a
      running turn; spinner glyph), **Ready to review** (turns finished since you last looked — the unseen set;
      from v7 with changed-file counts), **Idle** — each a button that filters the project list below
      (`aria-pressed`, one active at a time, click again to clear). Counts in tabular numerals; a zero tile is
      `fg-3`, never hidden (stable layout).
    - **Project list grouped by state** in that order, with 12px captions; within a group, most recent first.
    - **Recap**: one paragraph in 14/22 `fg-2` with figures in `fg`: "Today you sent **12 requests** across
      **3 projects**. Most went into **Atlas API**; **Sonnet** carried **84%** of the tokens. Agents ran for
      **5h 47m**." Built from `getUsage` (day, model, project groups) and agent start/finish times; clauses with
      no data are omitted (no zeros, no placeholders); project and model names are links (project → its
      orchestrator, model → Usage filtered); "Full recap" opens Usage. Period: today, falling back to "This week"
      when today is empty. Pure sentence builder in `lib/recap.ts` with tests (singular/plural, omitted clauses).
    - The cards stay below (Orchestrators at work, Tokens, Activity, This month); "This month" may fold into the
      recap's "Full recap" if the page no longer fits 1440×900.
27. **Model picker** (replaces the plain model menu in the composer and the orchestrator header): a 320px popover —
    search field on top ("Search models and agents"); sections **Tiers** (Balanced, Fast, Deep with the model each
    maps to), **Models** (every model the harness lists), **Agents** (subscription / ACP agents that are
    logged in; logged-out ones shown disabled with their hint); each row: name, muted detail (provider or
    "subscription"), `Ctrl/Cmd+1…9` hint for the first nine visible rows, a star toggle; a **Favourites** section
    appears first once anything is starred (stored per user in the preference registry). Below a hairline:
    **Effort** — a five-stop slider (Low, Medium, High, Extra high, Max) with the current stop named above it,
    shown only for models that support it; **Routing** — Auto / Ceiling / Fixed (the project's routing policy,
    when the router is detected) and **Compaction** — Auto / Off as two quiet rows with a value and a chevron.
    Keyboard: type to filter, ↑/↓, Enter selects, ←/→ on the slider, Esc closes and returns focus. Needs the
    harness to accept an effort setting per project/turn (small; added to the harness backlog) — until then the
    Effort block is not rendered.
28. **Two-tone titles and dialog header band.** Start-screen titles and announcement / first-run dialog titles are
    one sentence in two tones: the lead-in in `fg-3`, the statement in `fg`, same size and weight
    ("Design system tokens. Give its orchestrator a first task." / "No projects yet. Create one to put an
    orchestrator to work."). Announcement and first-run dialogs get a 160px header band drawn with a streak
    preset (`dialog`), an 11px tracked eyebrow in `accent`, the two-tone title, one paragraph, and at most two
    buttons (one primary). Used for: first run (attach a folder), "router detected", "an agent needs login".
Seventh reference (H: an agent app with tabs in the title bar, a "swarms" sidebar and a start screen over a
monochrome dithered illustration):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| H: tabs run across the title bar, Home pinned first, "+" at the end; every tab carries a small **live state glyph** (dotted ring animating while working, amber when waiting, green when done) | Good: you see which agents are alive without opening them; the glyph, not a coloured dot, carries the state. Confirms decision 25 | Decision 29: one state-glyph family, used on tabs, sidebar rows, lists and chips |
| H: the composer is two layers — the input card, and a footer bar fused under it with the run's context (repository, branch, sandbox level, where it runs) | Good: what the agent may touch and where it runs is stated at the moment you send, not in a settings page | Decision 30: composer context bar |
| H: the start backdrop is a single-hue dithered picture, very low contrast | Good as a calm alternative; the owner prefers the bold streak | Decision 31: the streak keeps Vivid as the default and gains Mono and Off in Settings |
| J (owner, 2026-11-11: a coding-agent desktop app): the right panel is **stacked plain sections** — Environment, Context (one thin multi-colour bar, "20% used", a legend of rows with a number and a share), Outputs (files the run produced), Changes (+/− and one action), Background tasks — with captions, key–value rows and almost no buttons | Good: this is the quiet panel the owner asked for; information first, one action per section at most | Decision 38: Details becomes stacked sections in this anatomy, with a Context meter |
| J: Background tasks pane — "Running 1" / "Finished 37" groups; a row = name, duration at the right, a stop square only while running; a task folds its children ("27 tasks, 1 failed", the failure in red) | Good: the whole team at a glance, grouped by what needs attention; nesting without a tree widget | Decision 39: the Agents tab takes this shape |
| J: a diff review pane — changed files listed at the right with +/− counts, commits below, a scope chip ("Pushed commits only"), each file a foldable block that hides unmodified lines | Good; it is the v7 Changes view | Folded into the v7 spec (file list + per-file blocks + scope: this turn / this request / all) |
| J: **Side chat** — a second, disposable conversation about the session that "sees the full context and adds nothing to the session" | Good for an orchestrator: asking "what is it doing and why" must not derail or lengthen the working thread | Decision 40: Side question |
| J: activity folded to one quiet line with a small animated glyph, the duration and a chevron ("Reading decision 29… 11s ›"); system notes the same ("Hook re-prompted ›") | Good; confirms decision 24 | Decision 24 keeps the one-line form; duration is always shown |
| J: composer hint "↵ to send, ⌘↵ to queue for later"; attachments as thumbnails above the text; model · effort · mode and a small context ring in the footer | Good; the hint teaches the queue without a button | v7 queue uses this hint; the context ring joins decision 30's bar |
| J: sidebar rows carry a right-aligned state glyph with a count (PRs, checks) | Good in small doses | Project rows may show one right-aligned count ("2" agents working, "1" needs you) next to the state ring; nothing else |
| K (owner: a bot list — a coloured blob avatar with two eyes, the bot's name, its latest line) | Good: a standing agent needs a face you recognise at a glance; the earlier verdict "no mascots" is revised — the cartoon style is not ours, the recognisable shape is | Decision 41: generated bot avatars |
| H: "Swarms" (named standing groups of agents) and "Automations" as sidebar sections | Same idea as our bots and standing tasks | Already in the bots design; sidebar sections arrive with it |
| H: thread list under the swarms with state glyph + age | Session list — the thing decision 23 removed | Not taken |
| H: account switcher in the sidebar foot | No accounts in a local tool | Not taken |

29. **State glyphs.** One glyph family (12px; 14px in 36/40px rows) encodes state by **line style** and motion
    first, colour second (so it survives colour blindness and forced colours). Reference I (owner, 2026-11-11: a
    step list where the running step is a ring with a turning arc and waiting steps are dashed rings — "projects
    could look like this: working or not"). All states are rings of one diameter and 1.5px stroke, so a column of
    them reads as one family: **working** — a faint full ring (`fg-3` at 40%) with a bright 90° arc turning (1 s,
    linear; static arc under reduced motion), `fg`; **queued / not started** — a **dashed** ring (6 dashes),
    `fg-3`; **needs you** — a solid ring with a centre dot, `warn`, the dot pulsing slowly (2 s; static under
    reduced motion); **done, unseen** — a solid ring with a filled disc, `accent`; **done, seen / idle** — a solid
    thin ring, `fg-3`; **failed** — a solid ring with a short diagonal bar, `err`. The same family marks the steps
    of the orchestrator's plan when it lists one (running step = turning arc, later steps = dashed), so a project
    row, a team chip and a plan step speak one language. Drawn as one SVG component (
    `primitives/StateGlyph.tsx`, pure geometry in
    `lib/stateGlyph.ts`, tested), never an icon-font spinner. Used everywhere a state appears: sidebar project
    rows, **tab labels** (Orchestrator and Agent tabs replace their kind icon with the state glyph while not idle),
    the team strip, Home rows and tiles, delegation rows, the palette. The watched live turn keeps its existing
    "Working… 12s" line; no other spinner shape exists in the product.
30. **Composer context bar.** The composer becomes two fused layers (one outline, radius 12, hairline between):
    the input row on top, and under it a 28px bar that states the run's context as quiet buttons with a 14px
    glyph — **folders** (the project's folders; opens project settings), **model** (the picker of decision 27),
    **access** (Ask first / Accept edits / Allow all, from v7; "Ask first" because "Ask" is the composer mode, one name per thing), **routing** (Auto / Ceiling / Fixed
    when the router is detected) — left to right, and on the right the hint line ("↵ send") or, while a turn
    runs, the queue count (v7). The loose line of text under the composer goes away. Under 420px the bar keeps
    model and access and folds the rest into a `…` menu. The floating composer has the same two layers.
31. **Streak appearance.** Settings → Appearance: **Start-screen backdrop** — Vivid (default, decision 21b), Mono
    (the same band in one hue: `accent` at 35% peak, same grain; reads as texture), Off. Stored in the preference
    registry; `prefers-reduced-transparency` and forced colours force Off.
32. **Streak, third pass** (v6.2 review: "flat saturated slab with a staircase edge, no hot core"; owner: "weak,
    not like the references"). The band is rebuilt from three layers drawn in one pass: a **hot core** — a line
    2–4 device cells wide at near-white (`#fff4e0`, 95% dark / 70% light) running the band's axis; a **glow** that
    falls off from the core with a long exponential tail (orange → magenta → violet → blue along the distance, not
    along the length); and **grain everywhere** — ordered dither at 2px cells on windows ≤ 1600px wide and 3px
    above, cell size taken from the *window* width, with blue-noise jitter so no staircase is visible on the edge.
    No scrim blob behind the Home title (the title sits where the band is dark; if contrast < 4.5 the band is
    shifted, never patched). Home cards get a 72% surface with backdrop blur 12px so the band reads through.
    Draw budget: ≤ 4 ms median at 1440 and ≤ 8 ms at 1920 — drawn once to an offscreen canvas and redrawn only on
    resize/theme change (no per-frame work when static).
33. **Quiet right panel** (owner: "too garish"; review: 8 buttons before content). One rule: a panel shows **at
    most one segmented control**, 24px high, text-only, the selected segment marked by `hover` fill — never a
    filled accent. Usage: tabs Tokens / Cost / Limits stay as the one segmented control; range becomes a single
    quiet menu button ("30 days ▾") and scope ("This project / All projects") moves into the same menu. The header
    icon strip shows one selected state at a time (the open tool); the comment "+" and the composer send button are
    `fg` on `hover` fill when idle and solid only when there is something to send. Segments never truncate: a
    control that does not fit folds into a menu.
34. **The team is always visible** (review: "idle project is a chat with a follow-up box"). The orchestrator
    header carries a **team line** in every state: idle — "Orchestrator · last ran 3 agents · 1h ago" with the
    last run's agents as quiet chips; working — live chips with state glyphs (decision 29); empty — the roles the
    orchestrator can call on. A chip opens the agent in a **split to the right**, never over the orchestrator.
    The composer placeholder speaks to the orchestrator ("Ask the orchestrator…", after a turn: "Next request…").
    The request rail shows from the first request. The sidebar "Working" dot pulses (reduced motion: static ring).
35. **Focus never falls to the page.** After closing a tab, a tool tab or a split, focus moves to the tab that
    becomes active; "Show project details", "Split right" and opening a project from Home focus the new surface's
    first focusable element (or its container with `tabindex="-1"`). An acceptance check walks the five paths
    found by the review and asserts `document.activeElement !== document.body`.
36. **Review clean-up.** Contrast ≥ 4.5 for the Home list's second line, the Limits stale block and the
    Integrations chip count; 390px: the empty project's Models fact wraps by word, rail markers and tab close
    targets are ≥ 24×24 hit areas; scroll memory attaches when the scroller appears (a project that started
    empty); Limits polling and the clock stop while the tab is hidden; the spacing audit gains the states `home`,
    `empty-project`, `usage`, `details-tab`, `integrations` and a `--help`.
37. **Router in the UI** (integration I1). Orchestrator header: when the project has a budget, "$spent / $budget"
    next to the model (amber from 80%, red at 100% with "Project budget reached"); Project dialog → Models gains
    **Budget** (USD, optional) and **Routing** (Auto — the router may go lower or higher · Ceiling — never above
    the chosen tier · Fixed), shown only when `config.router` is true; Usage → Tokens/Cost rows are the *served*
    models; a quiet "History compacted" separator in the transcript where a compaction was applied (needs a
    harness event — add `agent.compacted`).
38. **Details as stacked sections** (reference J). The Details tab is a single scroll of sections, each a 12px
    caption in `fg-3` and plain rows (28px, label left, value right in tabular mono), separated by 20px — no
    cards, no segmented controls, at most one quiet text action at a section's right edge. Order: **Project**
    (folders, branch when known), **Context** — "N% used" + "used / window", one 3px bar split by colour into
    the parts of the orchestrator's context (messages, tool results, notes, system) with a legend of rows (swatch,
    name, tokens, share; rows under 0.5% fold into "Other"), **Team** (models per tier, routing policy, budget
    when set), **Outputs** (files written this request, newest first, 5 + "Show more"; a click opens the file),
    **Changes** (+added −removed, "Review" — v7), **Plugins in use**, **Activity**. Usage keeps its own tab but
    follows the same anatomy (decision 33). Needs `GET /v1/projects/{pid}/context` from the harness (token counts
    per part; estimates are marked).
39. **Agents tab as Running / Finished** (reference J). Two groups with counts; a row is 32px: state ring
    (decision 29), name, the current activity line in `fg-3` (one line), duration at the right (tabular), and a
    stop square only while running. An agent with children shows a fold line under it — "5 agents, 1 failed" (the
    failure count in `err`) — that expands to the children at one indent step; depth beyond 2 flattens with a
    "↳ parent" prefix. Finished rows are quiet (`fg-2`), failed ones keep the failed ring. A click opens the
    agent in a split (decision 34). The tree widget with chevrons on every row is retired.
40. **Side question** (reference J). A disposable conversation about the project that does not enter the
    orchestrator's history: opened from the header strip or `Ctrl+;` as a right pane titled "Side question" with
    one line of explanation ("Ask about this project without interrupting the orchestrator. Nothing here is added
    to its conversation.") and a single-line input. Harness: `POST /v1/projects/{pid}/side` — one model call with
    the orchestrator's current (compacted) history as context, read-only tools only, the fast tier by default,
    stored in a separate `side_messages` table, usage recorded with role `side`. Works while a turn is running.
    Cleared when the pane is closed unless pinned.
41. **Bot avatars** (reference K; revises the bots draft's "neutral glyph"). Each bot gets a generated avatar: one
    of 8 soft closed shapes (blob, star-blob, rounded square, cloud, …) in one of 8 mid-saturation hues, both
    picked from the bot's id (stable), with two small "eye" dots — drawn as SVG from `lib/botAvatar.ts` (pure,
    tested), 28px in rows and 20px in chips. Colour here is identity, not state — the one stated exception to
    "colour means state"; the bot's *state* is still the ring (decision 29) at the avatar's lower-right corner.
    Bot rows are 40px: avatar, name, the bot's latest line in `fg-3` (one line, ellipsis). Sub-agents keep rings
    only — avatars are for standing identities.
42. **Quality bar for every pass** (owner, 2026-11-11: "more premium, more adaptive, more responsive … good on
    every front, tidy"). A pass is not done until each new or changed screen meets all of: (a) works at 390, 768,
    1100, 1440 and 1920 px with no horizontal scroll, no clipped or truncated control label, and touch targets
    ≥ 40px below 768; (b) every action answers within 100 ms (pressed state, optimistic update or a skeleton —
    never a frozen control), every list has loading, empty and error states with a way forward; (c) all of it is
    reachable by keyboard with a visible focus ring and focus returned after overlays close; (d) dark and light
    are both checked by screenshot; (e) the spacing audit is 0 and the console is clean. The reviewer checks these
    five explicitly and reports per screen.
43. **Forms in the conversation — values that never reach the model** (owner's example: key-entry forms in the
    bot reference). When an agent needs something from the user that is structured or secret, it does not ask in
    prose: it calls a harness tool `request_input` with a schema (`fields: { id, label, kind: "secret" | "text" |
    "select" | "confirm" | "path", options?, required?, help? }[]`, `title`, `reason`), and the UI renders a form
    card in the conversation at that point. Submitting posts to the harness (`POST /v1/projects/{pid}/inputs/{id}`).
    **Secret fields are stored by the harness** (project secret store, file mode 0600, never in SQLite transcripts,
    never in events, never logged) and the model receives only `{ id: "provided" }` plus the name under which a
    tool may use it (`secret:<name>`, resolved by the harness when it builds a child process environment or a
    request header — the allow-list in `internal/childenv` gains per-project secrets). Non-secret values are
    returned to the agent as the tool result. The card shows: title, the agent's one-line reason, fields with
    labels above, a masked input with reveal for secrets, "Submit" (primary) and "Skip"; after submit it collapses
    to one line ("API key provided · Change"). While the form is open the project state is "Needs you"
    (decision 29's dashed ring). A secret typed into the ordinary composer is not intercepted — the composer shows
    a quiet hint when the text looks like a key ("Looks like a secret. Use a form so it is not sent to the model")
    with an action that moves it into a form. Settings → Secrets lists names, never values, with Replace and
    Delete. Built with v7 approvals (same card frame, same "Needs you" plumbing).
44. **Tables and structured results** (owner's example: tables shown in the bot reference). Markdown tables in
    assistant text render as real tables: hairline rows, header in `fg-2` medium, numeric columns right-aligned
    with tabular figures (detected per column), 32px rows, the first column sticky when the table scrolls
    sideways inside its own container (the page never scrolls sideways), a "Copy" menu (Markdown / CSV) on hover
    or focus, and above 12 rows a "Show all N rows" fold. Tool results that are tabular (CSV, JSON arrays of flat
    objects, ≤ 200 rows shown) use the same component inside the tool panel. Below 600px a table with more than
    three columns keeps the sideways scroll rather than stacking. Key–value results (≤ 8 pairs) render as a
    two-column definition list, not a table.
45. **"The model is working" — aurora** (owner: "the gradient effect is nice; maybe a polar-light glow while the
    model generates, as in Gemini; think what other effects fit"). One visual language for *work in progress*,
    built from the streak's palette, used in exactly three places and nowhere else:
    (a) **composer edge** — while the orchestrator of the open project works, the composer's 1px border becomes a
    slowly rotating conic gradient (streak colours, one turn per 6 s) with a soft outer glow (a blurred copy,
    opacity 0.35 dark / 0.22 light, 12px spread) that breathes ±15% over 3 s; on finish it settles in 400 ms to
    the plain border; on failure it drains to `danger` once and stops;
    (b) **streaming text** — the last line being written has a 24px fade-in mask at its end; "Worked for…" while
    running uses a text shimmer (one pass per 1.8 s) instead of a spinner;
    (c) **sidebar ring** of a working project — the existing ring gains the same gradient stroke, no glow.
    Rules: the blurred layer is painted once and only its `opacity`/`transform` animate; the angle is a registered
    `@property`; no `filter` animation, no layout properties; everything pauses when the window is hidden or the
    element is off-screen; with `prefers-reduced-motion: reduce` there is no rotation or breathing — a static
    gradient border and a steady text colour; Settings → Appearance has "Motion: full / reduced / off"
    (default: follow the system). Budget: the effect may not cost a frame — a 5 s trace while streaming stays at
    60 fps on the demo at 1440 and at 390, and idle CPU with no agent working is unchanged. Never animated: the
    whole window edge, backgrounds behind text, anything during typing.
46. **Other effects (small, each with a job).** Send: the message rises from the composer into the conversation
    (160 ms, the composer does not jump). Tool row done: the row's glyph draws a check in 200 ms once. Sub-agent
    spawned: its row in the team strip grows from the delegating row. Diff applied / reverted: changed lines
    flash their add/remove tone for 600 ms and fade. Approval needed: the card's border pulses twice, then rests
    (never loops). Copy: the glyph swaps to a check for 1.2 s. Tab drag: the tab lifts (shadow, 1.02 scale) and
    neighbours slide. All ≤ 240 ms unless stated, one easing (`cubic-bezier(.2,.8,.2,1)`), all removed under
    reduced motion except colour changes.
47. **Borrowed behaviours** (from the reference study `../research/2026-11-11-editor-ui-references.md`; adapted,
    not copied): header actions that do not fit collapse into a "⋯" menu instead of truncating text (fixes the cut
    "Worked al…"); a shortcut sheet on `Ctrl/Cmd+/`; an OS notification when a project finishes or needs the user
    while the window is unfocused (off by default until asked once); in the changes view, a line comment
    (hover → "+") that is sent to the orchestrator with the next request; plan/approval cards can be commented
    before they are approved; inline completion follows `2026-11-11-inline-completion-design.md` with a
    status-line item and accept-word / accept-line keys.
48. **Model names are one thing everywhere.** A model is shown by its display label (catalogue label, else the id
    with the vendor prefix dropped and middle-truncated) in the header, the composer, Usage and the team strip; the
    header shows the *served* model and, when it differs from the chosen one, "chosen → served" in the tooltip —
    never one name in the header and another in the composer without explanation.
49. **Choosing a folder is a picker, never a typed path** (owner, testing: "what is this folder selection — set
    folder URL — a weird solution"; reference shown: a composer chip that opens a searchable list). Everywhere a
    folder is chosen (new project, add folder, the composer's folder chip):
    a popover (320px, anchored to the chip or field; a sheet below 600px) with a search field focused on open,
    then **Recent** (folders of existing projects and the last 8 chosen, newest first; name in `fg`, parent path
    in `fg-3`, middle-truncated; a branch glyph and branch name when it is a git repository), then **Browse…**
    which opens the operating system's folder dialog in the desktop app. Typing filters Recent and, once the text
    looks like a path (`/`, `~`, a drive letter), lists matching directories live from the harness so a path can
    be completed with arrows and `Tab` — this is also the whole picker in a browser, where there is no system
    dialog. `Enter` chooses, `Esc` closes, the current folder has a check mark. A folder that does not exist or
    cannot be read is said inline, before the project is created. The raw text field is gone.
    Host contract: the shell passes `pickFolder?: () => Promise<string | null>` (Tauri dialog) — `packages/ui`
    still imports no Tauri API. Harness: `GET /v1/fs/dirs?path=<prefix>` → up to 50 child directories
    (name, path, `git: {branch} | null`), loopback only, hidden directories only when the prefix names one.
50. **A backdrop never moves.** The streak and every other decorative layer are fixed to their panel: they do not
    scroll with content, do not shift on overscroll or trackpad rubber-banding, cannot be dragged or selected,
    and do not re-layout when a scrollbar appears. Start screens that fit do not scroll at all
    (`overscroll-behavior: none`; no stray overflow). A test asserts `scrollHeight === clientHeight` for Home, the
    empty project and the no-projects screen at 390, 768, 1440 and 1920.
51. **Every dialog fits the window it is in** (owner's macOS screenshot: "New project" taller than a small window,
    its bottom edge and a field cut off, content sliding under the title). Rules for all dialogs, sheets, popovers
    and menus: the surface is never taller than the window minus 24px (never wider than it minus 24px); the title
    row and the action row stay put and only the body scrolls, with a hairline under the title and above the
    actions while there is more to scroll; nothing is ever clipped by the window edge. Below 560px of window
    height or 600px of width a dialog becomes a full-window sheet (title and actions pinned, safe 16px gutters);
    two-column field grids become one column below 520px of dialog width; popovers flip and shrink to stay
    inside, with their own scroll. The quality bar of decision 42 gains **short windows**: every pass is checked
    at 1440×900, 1100×700, 800×600, 640×480 and 390×700, and the screenshot script opens every dialog (New
    project with "Models and delegation" expanded, Settings, the pickers) at each. The desktop window has a
    minimum size of 640×480.
52. **The empty conversation shows nothing the composer already says** (owner: "this info looks useless for
    chat" — the Folders / Models / Agents summary card). The card is removed. An empty project is: the streak,
    one line ("What should we work on in <project>?"), the composer centred at reading width, and under it the
    same chips as everywhere (folder, model or agent, tier) — each chip *is* the setting and opens its picker.
    Nothing else: no list of tiers, no list of available agents, no explanatory paragraph. Up to three starter
    prompts may appear below the composer only when they are specific to this project (from its folder: "Explain
    the structure of <repo>", "Review my uncommitted changes", "What changed since <last tag>?"); they fill the
    composer, they do not send. General rule this follows from: a screen does not repeat configuration as prose —
    configuration lives in controls, and details live in Settings.
53. **Connect first, choose second** (owner, live: "it asks me to select models for the orchestrator but does not
    require connecting a provider — weird; I need to connect at least one provider and then be able to select").
    A *provider* is anything that can run a model: an API key (Anthropic-compatible), the Octo router, or an agent
    CLI on this machine (Claude Code, Copilot, Grok, …). Rules:
    (a) **Nothing can be selected that cannot run.** Every model picker lists only models of connected providers
    and agents that are ready, grouped by provider. Providers that are not connected appear below as one row each
    ("Anthropic API — Connect", "GitHub Copilot — not logged in · how", "Grok — not installed · how") which opens
    the connect sheet; their models are not listed.
    (b) **No provider → no project form.** With nothing connected, Home, "New project" and the first run show the
    connect screen instead: the agents found on this machine with their state and the exact command, and "Use an
    API key" (the key goes to the harness through the form, never through a model). One connected provider is
    enough; the screen says which one will be used.
    (c) **Defaults follow what is connected.** A new project's orchestrator and tiers are filled from the connected
    providers (one agent connected → it is the orchestrator and every tier); tier fields stay folded under
    "Models and delegation" and are never required reading.
    (d) **A provider that stops working is said where it is used:** the chip turns to a warning with "Reconnect",
    and a failed turn's message has a **Connect a provider** button instead of naming an environment variable.
    (e) The harness refuses to create or patch a project whose models cannot run (`422 model_unavailable` with the
    provider and reason), so no client can reach the state in the owner's screenshot.
    Also fixed with this: a failed turn shows **Failed** in the header and the sidebar (not "Needs you · Worked
    alone"); Retry never duplicates the user's message in the transcript; "Retrying…" always resolves to an
    answer or the error within the request timeout.
54. **The title bar is the header** (owner: "this info can be in the very header of the app, next to the traffic
    lights; a lot of unused space there"). The window uses an overlay title bar: one 40px row holds, left to
    right, the window controls' inset (macOS traffic lights; 78px), the sidebar toggle and back/forward, then the
    open project's name and state, and on the right the model chip, budget, the side-question and "⋯" actions.
    The separate conversation header row and the standalone "Octo" title strip are removed, giving the
    conversation ~70px more height. Empty areas of the row drag the window; double-click zooms; controls in it
    are not drag regions. On Windows and Linux the native controls sit at the right and the row's actions shift
    left of them; in a browser the row is the same without the inset. Tabs stay directly under it. Host contract:
    the shell passes `chrome: { overlay: boolean; insetStart: number; insetEnd: number }`; `packages/ui` imports no
    Tauri API and marks drag areas with a data attribute the shell maps.
    **Sidebar closed** (owner's screenshot: "the closed view looks very bad; the button should be in the header
    next to the traffic lights"): the sidebar toggle lives in the title bar immediately after the window
    controls' inset, in the same place whether the sidebar is open or closed; closing the sidebar leaves no
    strip, no second bar and no orphan button — the content panel takes the full window under the title bar, and
    the panel's top-left corner is where the sidebar's was. Back/forward follow the toggle. The streak then runs
    edge to edge under the title bar with no dark band above it.
55. **An agent at work is never just a spinner** (owner, live with Claude Code over ACP: "Working… 23s" and
    nothing else — "we need to stream messages, not only loading; this is not responsive"). The harness already
    forwards an ACP agent's text chunks; what it drops today is everything the agent does *before* it writes:
    thinking, plan updates and its own tool calls as they start. From now on, for ACP agents and the built-in loop
    alike, the conversation shows, live and in order:
    (a) **the activity line** — "Working… 23s" becomes what is happening now: "Thinking…", "Reading
    src/server/routes.ts", "Running `pnpm test`", "Searching for "budget"", "Waiting for your approval", updated
    on every tool start; the timer stays; shimmer per decision 45;
    (b) **tool rows as they start**, not when they finish (pending → running → done/failed), folded into "Ran 3
    commands, read 5 files" when the turn ends, as today;
    (c) **thinking** as a dim, collapsed-by-default "Thinking" row whose first line streams; expanding shows the
    stream; it is never stored in memory or search and is dropped from the transcript after the turn unless the
    user pinned it open;
    (d) **the plan**, when the agent publishes one, as a compact checklist above the answer that ticks off;
    (e) **text** token by token with at most 50 ms of batching; the first visible sign of life (any of a–e) must
    appear within 1 s of the agent's first event, and if nothing at all arrives for 10 s the activity line says
    "Still working — no output from <agent> yet" rather than staying mute.
    Harness: new events `agent.activity` (kind, label, tool id), `message.thinking_delta`, `agent.plan`; tool rows
    are published at `tool_call` (pending) and updated at `tool_call_update`; secret scrubbing may hold back at
    most the length of the longest stored secret, never a whole message.
56. **A control points where it opens.** A chip or select at the bottom of the window opens upward, so its glyph
    is an up-down chevron pair (`chevrons-up-down`), not a down arrow; a menu that opens downward keeps the down
    chevron. The popover is attached to its chip (4px gap, aligned to the chip's start edge) so it reads as the
    chip's menu; the "scroll to latest" button hides while any popover of the composer is open. Model picker rows
    follow decision 53 (only what can run) and show one name per row — the raw model id moves to the tooltip.
57. **The request rail** (the ticks beside the conversation; owner: "too big spacing, should be vertically
    centred not at the top, and appear only after five points"). The rail appears only when the conversation has
    **five or more** user requests; below that there is nothing to navigate. It is centred vertically in the
    conversation's viewport (not pinned to the top), ticks are 6px apart (was ~24px), 8px wide and 1px thick in
    `fg-4`, the current one 12px wide in `fg`; with more ticks than fit in 60% of the viewport height the rail
    scrolls itself to keep the current tick centred. Hover or focus on the rail shows the request's first line
    beside the tick; click or `Alt+↑/↓` jumps. It never takes layout width from the conversation.
58. **An agent's model can be chosen** (owner, live: "I can use subscriptions but I can't set models there").
    In every model picker an agent row with more than one model has a trailing "›": `→` or click opens its models
    (the agent's default first, marked "default"; then the models from its manifest and those the agent advertised
    in its last session), `←` goes back; choosing stores `acp:<agent>/<model>`. The chip then reads
    "Claude Code · Opus". An agent with one or no known model has no "›". Search matches "copilot gpt" across
    both levels. Harness: `/v1/providers` lists per agent `models` (manifest ∪ advertised, cached per agent with
    the time seen) and `default_model`; a model the agent no longer advertises is flagged, not silently dropped.
    **Revised after the owner's run of 2026-11-12** ("I still cannot choose models for Claude Code, Codex, Grok,
    GitHub Copilot" — the picker showed each agent as a group with one row and no second level, because the
    manifest lists no models and nothing had been advertised yet). A model can **always** be chosen for an agent:
    (1) every ready agent row opens a second level, even with no known model: "Default (the agent decides)", the
    known models, and **"Other model…"** — a field where a model name is typed and remembered for that agent;
    (2) the harness finds an agent's models without waiting for a user request: when an agent becomes ready (and
    on "Refresh models" in the picker) it starts the agent, opens a throw-away session in an empty temporary
    directory, reads the models it advertises and closes it — no prompt is sent, nothing is billed; a manifest may
    instead name a `modelsCommand` (for a CLI that prints its models, such as `grok models`) with a pattern;
    (3) the built-in manifest carries the model **aliases the vendor documents** for its CLI (Claude Code:
    `opus`, `sonnet`, `haiku`) — aliases, not dated ids, so they do not go stale; nothing is invented for a CLI
    whose names we cannot source;
    (4) the picker is a flat list: one row per agent (no group heading that repeats the row), the chosen one
    checked, its model shown dim on the right; agents that are not ready are below a "Not connected" divider and
    open the connect sheet instead of being selectable.
59. **Settings is a page, not a dialog** (owner: "the settings page looks very bad and should be Cursor-like";
    reference: a full-window settings view). Route `#/settings/<section>`; the sidebar is replaced by the
    settings navigation ("← Back", a search field that filters rows across all sections, then sections with a
    16px glyph each); content is one centred column, max 780px. Anatomy: section title (20px medium), then groups —
    a 12px `fg-3` group label above a card (panel surface, radius 10, hairline dividers between rows); each **row**
    is title (14px) + one-line description (13px `fg-3`) on the left and exactly one control on the right
    (switch, select, button, number field); rows are 56–64px; long explanations go behind a "?"; destructive
    actions sit alone at the bottom of their section. Sections: **General** (startup, notifications, sound),
    **Appearance** (theme, backdrop, motion, density), **Providers** (decision 53: each provider as a row with
    its state and Connect / Reconnect / Remove; API keys folded under "API keys"), **Models** (which models
    appear in pickers — a searchable list with switches; default orchestrator and tiers; the completion model),
    **Agents** (subscription agents: state, install and login text, default model, test button), **Editor**
    (inline completion on/off, per-language list, language servers), **Usage and budget**, **Memory** (context
    mode, digest on/off), **Privacy and data** (data directory, trace switch, "Copy diagnostic report"),
    **About**. Every change applies at once and says "Saved" inline; a change that needs a restart says so in
    the row with a "Restart now" button. Below 760px the navigation becomes a top select and rows stack their
    control under the text.
60. **Opening something never makes the window jump** (owner: "when opening a file the window is jumping").
    Opening a file, a tab, a side panel or a group may change only the area it opens into. Rules: the first
    split uses the remembered ratio (default: conversation 420px, the rest to the editor) and both sides reach
    their final size in one frame or one 160 ms transition — never an intermediate size; the conversation's
    text does not re-wrap more than once; the file tree column has its width reserved before its content loads;
    the editor shows a skeleton of the right size until Monaco is ready (no 0-height flash, no scroll jump); the
    scroll position of the conversation is anchored to the message at the top of the viewport across the resize.
    A test opens a file from a full-width conversation and asserts at most one layout shift of the conversation
    column and none of the sidebar.
61. **A narrow conversation is a compact conversation** (owner: "we need a mobile-like chat, because on small it
    looks bad"). The conversation column adapts to **its own width** (container queries), not the window's:
    below 480px — 12px gutters, the request rail and timestamps' separators hidden, user requests as
    right-aligned bubbles (max 86%, radius 14), answers full width with no card, inline code allowed to break
    anywhere, code blocks and tables scrolling sideways inside themselves, lists with 16px indent, the header
    reduced to name + state + "⋯", the copy/time row shown on hover or tap only; below 360px the composer's chips
    collapse to icons. Nothing is ever clipped or forced to one word per line; a path or identifier breaks with
    a soft hyphenless wrap. Checked at column widths 320, 380, 480 and 720.
62. **The composer is the most finished thing on the screen** (owner: "the prompt input looks very undone").
    One container (radius 14, panel-raised surface, 1px hairline that brightens on focus; aurora per decision 45
    while working). Inside, top to bottom: **attachments** (files, images, line comments as removable pills —
    "1 comment" is a pill here, its popover lists and removes them); the **text area** (15px, 1 to 10 lines
    auto-growing, then scrolls; placeholder "Ask anything, @ to mention a file" — never "(optional)"); the
    **control row**: left — "+" (attach, mention, slash commands), the agent/model chip, the folder chip, the
    tier chip; right — the context meter (a 16px ring, numbers on hover), and one 28px round button that is Send
    (disabled and dim when empty), Stop while working, and Queue (clock glyph) when a turn is running and text is
    present. Chips are borderless ghost buttons with a glyph and label, 28px high, 4px apart, and truncate their
    label from the middle; when the row is too narrow chips drop their labels in this order: tier, folder, model.
    Keys: `Enter` sends, `Shift+Enter` new line, `↑` in an empty field recalls the last request, `Esc` stops,
    `Ctrl/Cmd+Enter` queues, `@` and `/` open their lists above the composer. Files can be dropped or pasted
    onto it. Its height changes never move the conversation's last line (the scroller compensates).
63. **A tab is named after what is in it, not after its role** (owner: "this should be the name of the project,
    the sub-session — not Orchestrator"). The conversation tab's title is the project's name; a sub-agent's tab is
    its task title (the delegation's `title`, else the first words of its task); a file tab is the file name; the
    word "Orchestrator" appears nowhere as a title. The glyph carries the kind (conversation, sub-agent, file) and
    the state (working ring, needs-you, failed). With decision 54 the project name is in the title bar, so the
    separate "PCMS · Working" line under the tabs goes away: state lives on the tab glyph and in the title bar.
    Tool rows never show an empty input (`{}`) or an "Input" label with nothing to say: a row with no arguments
    shows only its name and result.
    **Revised 2026-11-18 (owner decisions F2 and F4, "Owner decisions — shell polish follow-ups" at the end):** the
    conversation tab is its topic while the tabs belong to one project; a sub-agent's tab is the agent's label, the task
    stays in its header.
64. **Calm, evenly distributed screens** (owner: "the UI must not be gaudy and cluttered; it must be neatly
    distributed between the elements"). Rules every surface is checked against:
    (a) **One job per row, few things per row.** A bar or header shows at most: one title, one state, and three
    controls; everything else goes into "⋯" or a second level. The title bar: project name + state on the left,
    at most three sub-agent chips (then "N agents"), and on the right the model chip and "⋯" — tokens, budget,
    side question and help live in the "⋯" menu or the context ring, not as separate items.
    (b) **One primary action per surface** (filled button); the rest are quiet. Never two filled buttons side by
    side; destructive actions are never the filled one.
    (c) **Whitespace groups, borders do not.** Related things sit 4–8px apart, groups 16–24px apart, sections
    32px; a border or a card is used only when a group must be picked out from its surroundings — no card inside
    a card, no hairline next to a border, no divider between items that spacing already separates.
    (d) **Shared edges.** Everything in a column starts on the same left edge and ends on the same right edge
    (the conversation text, tool rows, cards, the composer); icons sit on one optical line; numbers align right.
    A screen has at most three vertical alignment lines.
    (e) **Colour is information.** Neutral text and surfaces everywhere; the accent only for the one primary
    action and for focus; warn/danger only for a real warning or failure; the streak colours only in the backdrop
    and the working aurora. No coloured chips, badges or icons for decoration. At most two text weights and three
    text sizes on a screen.
    (f) **Show less, reveal on demand.** Secondary facts (ids, paths, timings, counts, token numbers) appear on
    hover, focus or expansion, not permanently; a list row has one line of primary text and at most one dim
    secondary fragment; captions and helper sentences are one line or removed.
    (g) **Even density.** No screen has a crowded corner and an empty half: content is centred in a readable
    column, long toolbars are split into "primary / more", and empty space is distributed (equal gutters), not
    left over.
    (h) **An empty panel is composed, not top-aligned** (owner, on the Side question tab: "this text should be in
    the middle; at the top it looks detached"). Every empty state — side question, Memory, Changes, Review list,
    Agents, Usage with no data, an empty conversation — is one block centred horizontally in the panel and placed
    at the optical middle (its centre at about 42% of the free height): a short title, one line of explanation,
    then the starting actions or suggestions directly under it, all on one left edge or all centred, never a
    sentence at the top with a button floating at its right. When the panel has an input at the bottom, the
    block sits in the space above it; once there is content the block is gone and content starts at the top.
    The spacing audit gains checks for (a) item count per bar, (b) more than one filled button in a surface, and
    (c) nested bordered containers; a pass is not accepted while they report anything.
65. **The context indicator is a button that explains itself** (owner: "the context button is not clickable and
    not informative, unlike in Claude Code"). The bare token count ("61k") is replaced by a small ring showing how
    full the context window is, with the percentage beside it once it passes 50% (warn colour from 80%). Click,
    `Enter` or `Ctrl/Cmd+Shift+U` opens a popover:
    - a headline "41% of 200k used · 118k free", and when it applies "history was compacted 2 turns ago";
    - one stacked bar and a list by category, largest first, each with tokens and share: instructions and
      briefing, tool definitions, project instruction files, memory (index, tasks, facts), conversation, tool
      results, the current request; plus "Free" and, when the model reserves it, "Reserved for the answer";
    - what drives cost: cached vs. uncached input of the last request;
    - actions: **Compact now**, **Open context details** (the Memory tab's Context view for the latest turn), and
      for an agent that manages its own context a plain line saying so with what it reports (used / window size)
      instead of an invented breakdown.
    Numbers are estimates and are labelled "≈" unless the provider reported them. Harness:
    `GET /v1/projects/{id}/context` → `{window, used, free, reserved?, compacted_at?, source: "harness" | "agent",
    categories: [{id, label, tokens}], last_request: {input, cached, output}}`, computed from the same assembly
    that builds the next request (so it matches what will be sent), refreshed after every turn and on
    `context.updated`.
66. **Memory is one tidy view, not tabs over tabs** (owner: "Memory does not look neat at all" — two rows of
    tabs, a narrow list with cut titles, a detail pane that is empty except for a sentence in its corner, the
    same request listed twice). Layout:
    - **One header row:** a segmented control Tasks · Files · Context on the left; on the right a search field
      (search is not a tab: typing filters the current list and, on Enter, shows results from all kinds) and one
      quiet filter menu ("Open ▾": Open / Done / Dropped / All, with counts inside the menu). No second tab row.
    - **List** (fixed 340px; full width below 720px of panel width): rows of two lines — the title (the task's
      own title, never the raw request cut mid-word; up to two lines) and one dim line "open · 14h ago · 3 facts";
      a state glyph on the left, nothing on the right. Identical consecutive requests collapse into one row
      with "×2".
    - **Detail** (readable column, max 720px, 24px padding): the first item is selected on open, so the pane is
      never an empty sentence in a corner; sections in a fixed order with the same heading style and 24px between
      them (Goal, Asked, Decisions, Facts, Outcome, Files); empty sections are omitted, not shown as headings with
      nothing under them; a task with nothing but its request shows the request and one line "Nothing was
      recorded for this request yet".
    - **No items at all:** the shared empty state (decision 64h) with one sentence on what will appear here.
    - Below 720px of panel width the list and the detail are two steps with a back arrow, not two cramped columns.
    The same list + detail frame (header row, 340px list, readable detail, first item selected) is used by Changes
    and Review, so the three read as one family.
67. **The frame: tabs live in the top row, content is only content** (owner, 2026-11-12, with screenshots of
    OpenCode's desktop app as a reference to analyse and adapt, not copy: "main tabs on top, sub-tabs here, a
    sidebar there, and it is not distributed … it would be interesting to move the tabs into the header, outside
    the content, so that content answers only for content … top right it is unclear why there is a model choice
    when the prompt input has one … useful things can live at the top: the project's name, hooks to run, e.g.
    starting the project"). Supersedes the title-bar contents of decisions 54 and 64(a):
    - **One top row (40px) across the window, made of each group's header.** Panels reach the top of the window;
      a group's first row *is* its tab strip and sits at title-bar height. The left-most group's row starts with
      the window-controls inset, the sidebar toggle and back/forward. With one group the row reads: controls ·
      tabs · project actions. Empty areas of every row drag the window.
    - **The conversation tab is the project's breadcrumb:** "Project / what this conversation is about" (the
      latest task title, dim), with the state glyph; its "⋯" holds project actions (settings, export, rewind…).
      **Revised 2026-11-18 (owner decision F2, "Owner decisions — shell polish follow-ups" at the end):** while every tab
      belongs to one project the conversation tab is its topic alone; the "Project /" prefix shows only with tabs of two or
      more projects. The tooltip keeps the whole name.
    - **Right end of the top row: project actions, not model choice.** The model chip is removed from the top
      row — the composer is the one place to choose a model. In its place: at most two pinned **project
      commands** (decision 68) and the "+" that opens a tab. Sub-agent chips stay next to the breadcrumb.
    - **Three levels, three looks — never two rows that both look like tabs.** Level 1: tabs, only in the top
      row. Level 2: a view's own switcher is a segmented control inside a 44px content header that ends in a
      hairline. Level 3: a list column is separated from its detail by a full-height hairline. A view with no
      switcher has no content header at all.
    - **Width floors.** The conversation column is never narrower than 420px: a divider drag stops there, and
      when the window cannot give every group its floor the right-most group becomes a tab in the remaining
      group instead of squeezing the conversation. Lists 280px, editors 360px.
68. **Project commands in the top row.** A project has named commands (for example "Dev server", "Tests",
    "Build"): a name, a shell command, a working folder. Up to two are pinned as quiet buttons in the top row; the
    rest are in a "Run ▾" menu; suggestions come from the project's `package.json` scripts, `Makefile` targets
    and `justfile` (shown as suggestions, never run unasked). Running one opens a "Run: <name>" tab with live
    output, Stop and Re-run; a running command shows a small spinner on its button; exit status is shown, and
    "Send output to the conversation" attaches the tail as context. Commands are started by the user, never by an
    agent, and run with the same environment rules as the shell tool. Harness: project field `commands`,
    `POST /v1/projects/{id}/commands/{name}/run` → run id, output over the event stream, `POST …/runs/{rid}/stop`.
69. **Nothing flickers, nothing jerks** (owner: "the UI flickers very often — I do something and it flickers;
    it jerks in an ugly way when I write a long prompt"). Rules, each with a test that fails when it is broken:
    - **Typing never touches the conversation.** A keystroke re-renders the composer only (0 renders of the
      transcript, measured); when the composer grows, the conversation's bottom inset changes in the same frame
      and the last line stays exactly where it was (0px movement while pinned to the bottom, 0px of the reading
      position otherwise); growth is not animated; the composer stops growing at 10 lines and scrolls inside.
    - **No remounts on interaction.** Clicking a row, tab, chip or button never unmounts and remounts a panel
      (stable keys; a test counts mounts across the standard click path = 0 beyond the opened surface).
    - **No fallback flashes.** A lazy view keeps the previous content until it is ready (transition), or shows a
      skeleton of the final size; chunks for the next likely views are fetched when idle and on hover/focus of
      their trigger. A spinner replacing content for less than 300 ms is a defect.
    - **Popovers and dialogs are positioned before their first paint** (never drawn at 0,0 or at a wrong size
      for a frame); they fade in opacity only, 120 ms.
    - **No layout shift from late content** (scrollbars reserved with `scrollbar-gutter: stable`, images and
      skeletons sized, fonts with matching fallbacks).
    - A frame-by-frame script (record 2 s around each action of the standard path; compare frames outside the
      acted-on surface) runs in Chromium here and is written so the owner can run it against the app's WebKit
      window (`pnpm ui:flicker --url …`).
70. **The composer highlights what it understands.** `@file` mentions, `/commands`, `#task` references and inline
    `` `code` `` are tinted in the text as they are typed (mention: accent-tinted pill-less text with the file
    glyph on hover; command: weight 500; unknown `@`/`/` stay plain), without changing metrics — the highlight is a
    layer under the text, so the caret, selection, IME and undo are the browser's own. Pasted long text over 2 000
    characters becomes an attachment pill ("Pasted text, 3.2k chars") that can be expanded back.
71. **A folder has no label field.** Choosing a folder is enough: its label is the folder's own name (made unique
    with the parent's name when two folders share one); it can be renamed later in project settings, never asked
    for up front. "New project" shows chosen folders as removable chips with one "Add folder" that opens the
    picker with **Browse…** first; the project's name defaults to the first folder's name.
72. **A provider has a face, a preferred model and roles** (owner: "icons are missing, for example on providers
    … I must be able to choose a preferred model — I pick Claude Code in the list and on the right there should
    be either how the roles are distributed or which model is preferred … Grok I cannot choose although it is
    connected"). 
    - **Icons.** Every provider row, chip and settings row starts with a 16px mark. Marks are our own neutral
      glyphs (a distinct simple shape plus the provider's initial, one colour, drawn in the app's icon style) —
      not the vendors' logos, which are their trademarks; a manifest may point to an icon file the user supplies.
      Models inherit their provider's mark.
    - **The picker has two panes** (≥ 560px; below that the second pane is the second level): left — providers
      (mark, name, the model that will be used, dim); right — for the highlighted provider:
      **Preferred model** (the model used when this provider is chosen and nothing more specific applies: the
      agent's own default, its known models, "Other model…"), and **Roles** — Fast, Balanced, Deep, each a small
      select over the same models ("Fast → Haiku, Balanced → Sonnet, Deep → Opus"), prefilled from the manifest's
      hints and editable; "Refresh models"; a one-line explanation: "The router decides how hard a task is; roles
      say which of this provider's models does it." Choosing the provider (Enter / click) uses the preferred
      model; choosing a model row uses that model for this project only.
    - **Where it applies.** Preferences are per provider and global (Settings → Providers shows the same pane);
      a project can override. When a project's orchestrator or tiers point at an agent, a delegation decided as
      fast / balanced / deep runs on that agent with the role's model.
    - **Connected means selectable.** A provider whose login cannot be probed is "ready (login not checked)" and
      can be chosen; only "not installed" and a probe that positively says "not logged in" make it unavailable.
      A probe that fails to run or prints something unexpected counts as not checked, and the reason is in
      diagnostics.
    Harness: `GET /v1/providers` adds `preferred_model`, `roles: {fast, balanced, deep}`, `login: "ok" |
    "not_logged_in" | "unchecked"`; `PUT /v1/providers/{id}/prefs {preferred_model?, roles?}`; tier resolution
    for `acp:<agent>` uses the role's model.
73. **A status bar that earns its place** (owner: "as with the header we can make a footer with useful
    information; today the footer hangs there with nothing useful in it"). One 24px row at the bottom of the
    window, at most five quiet items, each a button: left — the open project's **branch** and number of changed
    files (opens Changes), **running commands** (opens their tab); right — **agents working** across projects
    (opens the list), **spend today / budget** (opens Usage), **connection** (harness and router state; only
    shown when not fine, with what to do). Background work (indexing, refreshing models) appears as one dim text
    while it runs and disappears after. No clock, no version, no decoration. Hidden in full-screen reading of a
    single tab below 600px height.
74. **Settings have two scopes: this machine's defaults, and this project** (owner: "per project there can be
    separate settings, e.g. models … the default model should not be a setting of the whole environment; we can
    put a default on the environment"). The Settings page has a scope switch at the top: **Defaults** |
    **<Project>** (when a project is open; also reachable from the project's "⋯"). Everything that can differ
    between projects lives in the project scope and starts as "Default: <value>" with one click to override and
    one to reset: models and roles, access mode, memory and context mode, inline completion, budget, network,
    project commands, folders and instructions. Machine-only: providers and keys, appearance, notifications,
    privacy and data, about. A row never appears in both scopes with different meanings.
75. **Every element helps do or decide something — otherwise it is removed** (owner, on Home's "This week you
    sent 4 requests … Full recap": "this element does not help me at all"). Home loses the recap sentence, the
    streak-style statistics and any card that only reports; it keeps what needs the user (failed, waiting,
    finished-unread), recent projects, and starting something new. Numbers live in Usage. The same test is
    applied to every screen in each pass, and what fails it is deleted, not restyled.
76. **Motion only while something is in progress** (owner: "this Working spinner always turns — why spend the
    computer's CPU on that animation"). Counters, tiles, tabs and list rows use static glyphs; exactly the item
    that is working right now animates, and stops the moment it finishes; a category that merely *can* be
    working never animates. All animation pauses when the window is hidden, unfocused for more than 30 s, or the
    element is off-screen. A test loads each screen with nothing running and asserts
    `document.getAnimations().length === 0` and no `requestAnimationFrame` loop; with one agent working, only
    that agent's indicators animate.
77. **Loading is shown as shape, quickly** (owner: "it loads for a long time; we must have skeletons or
    something like that"). Any view that can take longer than 150 ms shows a skeleton of its final layout within
    100 ms; lists show the last known content at once and refresh in place (a quiet "updated just now" on
    change); nothing blocks on a network or CLI call that can be cached — the harness caches the pull-request
    list per folder for 60 s and returns the cached list with `stale: true` while refreshing. **Review picker:**
    one centred column (max 720px): the search field doubles as "paste a URL or type a number"; pull requests
    that ask for the user first; "Compare branches…" is one row that opens an inline form with Base and Head on
    one aligned line (labels above both); checks state as a small neutral glyph with a word on hover, not a red
    cross on its own.
78. **Review is a first-class workspace** (owner, after reviewing a real pull request on a GitHub Enterprise
    host: "at the code-review stage these limits matter too — convenient buttons, nothing gaudy … I must be able
    to put the review on the whole screen, as with the code … it is very important that I see the comments … I
    must see all open pull requests of this project, not only mine, review them easily, check one out, run
    things — some configurations must exist"). Adds to the review design
    ([`2026-11-11-pr-review-design.md`](./2026-11-11-pr-review-design.md)):
    - **All open pull requests of the repository**, newest activity first, with one quiet filter (All · Needs my
      review · Mine · Drafts) and the search field; paged, cached (decision 77). Each row: title, number, author,
      size, age, checks glyph, "N comments", and "reviewed by you" / "new commits since your review".
    - **Whole-screen mode for any tab.** `Ctrl/Cmd+Shift+Enter` or a double-click on a tab maximises it: sidebar
      and other groups step aside, the top row stays; the same key or `Esc` (when nothing else is open) restores.
      Review and files open maximised when the window is narrower than 1100px.
    - **Existing comments are in the diff.** Review threads from the code host appear inline at their lines
      (author, time, body rendered as Markdown and marked as external text, replies folded after two, resolved
      threads collapsed to one line), outdated threads in a list; general conversation and reviews in the
      Details panel; a reply is a pending comment like any other; a count per file in the file list.
    - **Calm header** (decision 64): one title row — back, title, and the single primary "Submit review" with the
      pending count inside it; one meta line — number, author, branches, checks; everything else under
      "Details". The diff toolbar keeps "Viewed" and "⋯" (whitespace, wrap, expand all, file comment, open file).
    - **The diff never opens scrolled sideways** (the owner's screenshot shows lines cut on the left): it opens at
      column 0; long lines wrap by default in review; split view only when each side gets ≥ 480px, else unified.
    - **Check out and run.** "Open in workspace" points the file tree, editor, search and language server at the
      review's worktree (a banner says which pull request is open; one click returns to the project's folder);
      "Check out in my folder" switches the project's own working copy to the pull request's branch after
      showing what is uncommitted there; **project commands** (decision 68) can be run in the review's worktree
      from the review header ("Run ▾": install, tests…), with output in a tab and the result shown as a row in
      the review's Details.
    - **Review configuration, per project** (decision 74's project scope): commands to offer on a pull request,
      paths to fold as mechanical, whether split or unified is preferred, whether the AI pass runs on open and at
      which depth.
22. **Home** (`#/`, sidebar row "Home" above Search's neighbours; shown when no project is open; the app opens
    the last project as before): the streak, a title ("What should we work on?"), a project picker row
    (recent projects as 32px rows: name, last request, relative time; Enter opens) with "New project", then a
    card grid (2 columns ≥ 900px, 1 below; radius 10; 16px padding; caption row with a 14px glyph):
    **Activity** — heat map of the last 26 weeks, one cell per day (10px cells, 2px gaps, 5 tones from `hover` to
    `accent`), count = agents started that day across projects; caption "N agent runs · M requests"; cells have
    `title` with date and count; **Tokens** — total (compact, e.g. "92.8M tokens"), split by model family
    as a muted line, 30 days; **Recent requests** — last 5 across projects (title, project, relative time; click
    jumps to it), "N more" opens the palette on Requests; **This month** — requests, agent runs, files written,
    each with the change against the previous month in `ok`/`err`. Data: `listProjects` + `listAgents` (and the
    request cache) per project, at most 4 in flight, cached in memory for the session and refreshed when a
    project's `updated_at` changes; each card shows a skeleton until its data is in and a quiet "No activity
    yet" when empty. No limits/reset dates until the harness reports them (see the usage research).

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
8. The "+" menu opens by button, `/` and `@`; a file pick inserts its path; with `?plugins=none` there is no
   Agents group; a 20-line prompt is clamped and expands.
9. Gates: agent-client tests, UI lint/type-check, desktop build; no console errors; initial bundle growth recorded.

### As built (v6)

**Semantic spacing tokens** (`packages/ui/src/styles.css`, every value on the 2 4 6 8 12 16 20 24 32 40 scale):
`gutter` 8 (window edge → panel, panel → panel, sidebar → panel; also the dock divider) · `pane` 8 (panel edge →
strip, rows, bars) · `card` 12 · `dialog` 20 · `pad` 24 (16 under a 560px conversation) · prose: blocks 12,
headings 24 / 8, list items 4. Row heights by role: `chip` 24 · `row` 28 · `row-nav` 32 · `strip` 36 · `bar` 40.
Widths: `measure` 720 (conversation, Markdown preview), `float` 640 (floating composer, empty-project block).
Radii: `2xs` 2 kbd · `xs` 4 inline code, delegation rows · `sm` 6 every selectable row and control · `md` 8 cards,
inputs, code · `lg` 10 overlays that hold rows at a 4px inset (menus, popovers, palette, dialogs, "+" menu) ·
`xl` 12 panels, composer.

**Row anatomy.**

| Row | Anatomy (left → right) |
| --- | --- |
| Tab (28, 96–200 wide) | 8 · 16 icon slot · 8 · label · 8 · … · 16 trailing slot (close / unsaved / working; reserved on every tab, empty on an idle Chat) · 8 |
| Sidebar nav / project (32) | 8 · 16 slot · 8 · label · … · meta · 8 (project: 4 · 24 chevron · 4 · label) |
| Request (28) | 8 · 24 lead spacer · label · 8 · meta · 8 (text on the project name's 32px line, balanced padding) |
| Tree row — files and agents (28) | 4 · indent spacer 16/level · 24 chevron box · 4 · 16 icon slot · 8 · label · … · 4 (roots included) |
| Menu / palette / "+" menu option (28 / 32 / 28) | 8 · (16 icon · 8) · label · … · hint or kbd · 8, inside a 4px list inset, radius 6 |
| Delegation row (32) | card 4 inset · 0-width edge track + 8 gap · 16 glyph slot · 8 · role · 8 · title · 8 · meta (error line under the row, outside it) |
| Breadcrumb row (40) | 8 · back 28 · 4 · forward 28 · 8 · crumbs · … · status · Preview\|Source (24) · `…` 28 · tree toggle 28 · 8 |
| Composer (40 one-line) | 6 · "+" 28 · 8 · text (14/24, 2px block padding) · 8 · [model, floating only] · send 28 · 6; edge = 1px outline (takes no room) |

**Decided differently from the contract, and why.**

- Conversation edges: the rows outside the scroll area (header, pinned prompt, rail layer, composer, jump room)
  reserve the scroll area's gutters the same way it does (`overflow: hidden` + `scrollbar-gutter: stable
  both-edges`), so every padding is the literal 24 instead of `24 + half the scrollbar` (was 34px, off-scale).
- Jump to latest: instead of an overlay fade, scrolling up adds a 40px room under the transcript (the scroll
  position is kept, nothing moves) that holds the button; the last 12px of text fade above it. The button can
  never sit on text, which an overlay could not guarantee.
- Tree indentation, the request-row lead and the Markdown preview's floating-composer room are spacer widths /
  heights, not padding: they are structure, and padding-based indents produced off-scale values (48, 64…).
- Composer hint: "↵ send", "⇧↵ new line", "/ insert" laid out with 12px gaps, not joined with "·" (craft rule);
  shown while the box is empty and focused. The Chat composer's model sits in the footer (contract B); the floating
  composer has no footer, so its model sits inside the box before send.
- Floating composer hosts: file views (File tabs and the Files tab) and the Agents / Notes tools; an Agent tab
  keeps its read-only bar instead (two bottom bars would stack).
- Narrow file views (< 560px): the tree floats over the editor, starts closed there and closes on a pick; the
  shared column preference is not touched. The column is capped at 40% of the view (min 200) so code keeps room.
  The language-server label collapses to a state dot (name in the tooltip) under 640px. At a 1100px window the
  side group is ~370px, so there the tree is always the overlay (the empty Files view opens with it shown).
- Floating composer room: Monaco's bottom padding is the composer block's height + 16, and because Monaco's own
  reveal (arrows, Ctrl/Cmd+End, typing) ignores that padding, a caret moved under the composer is scrolled back
  above it (measured: last line bottom = composer top on a 56-line file).
- Read-only bar: one 40px line at every width (note truncates with a tooltip); under 360px the link shows only
  its arrow (accessible name unchanged).
- Files button: opens the tree of a visible file view and focuses its filter; otherwise opens the Files tab (now
  half the row, like a file, since it is a file view).
- Status glyphs: failed is `CircleX` (the error glyph) — `X` means close/clear only. Stop is a filled `Square` at 14.
- Glow: `color-mix` multi-stop falloff (6 stops, closest-side ellipse 960×560) rather than a single 2-stop gradient.

**Glow contrast** (WCAG 2, `accent` composited on `panel` at the centre — the brightest point): dark `#212a37`:
fg 12.70 · fg-2 8.47 · fg-3 5.67; light `#ebf3fd`: fg 15.56 · fg-2 8.98 · fg-3 5.80. Measured peak pixel in the screenshots (DPR 2): dark `#1f2836` → fg 13.02 · fg-2 8.69;
light `#ecf3fd` → fg 15.59 · fg-2 9.00. No other surface token changed
in v6 (the v4 table below still holds); `--octo-glow` is the only new colour token.

**Icons** (decision 14): one wrapper `primitives/Glyph.tsx` (lucide, absolute 1.5px stroke, 16 or 14 only); meanings
used in several places live in `primitives/glyphs.ts` (Chat `MessagesSquare`, Agent `Bot`, Agents `Network`, Notes
`NotebookText`, Files `Folder`); file types reduce to `File`, `FileCode`, `FileBraces` (all config incl. JSON),
`FileText`, `FileImage` (`files/fileIcons.ts`). New project uses the same `Plus` as every add action; the sidebar
toggle is `PanelLeft` in both states.

**Bundle** (`pnpm --filter @octo/desktop build`, initial `index-*.js` gzip): 191.21 kB before → 201.22 kB after
(+10.01 kB: file view, tree column, filter/index loader, Markdown preview wiring, floating composer, "+" menu, turn
rail wiring, glyph set). Monaco chunk unchanged (336.7 kB gzip, lazy).

**Spacing audit** (`packages/ui/scripts/spacing-audit.mjs`, all states, 1440/1100/960/390): 866 violations before
the pass (orchestrator's run on the partial build), 263 midway, **0 after** (allow-list empty).

### As built (v6.1)

Decisions 15–22, the fix list F1–F8 and the v6 review (`docs/superpowers/research/2026-11-10-ui-review-v6.md`).
Scripted checks: `scratchpad/v61/accept61.cjs` (102 checks) next to the v6 script (40); unit tests for the new pure
modules run with `pnpm --filter @octo/ui test` (node:test via tsx).

**Fixes.**

- **F1 comment "+"**: the editor now has a glyph-margin lane (20px, left of the line numbers) and the "+" is centred
  in it. Measured on column-1, tab-indented (Go) and space-indented (TS) lines: "+" right edge 874px, line numbers
  start 875px, first glyph ≥ 924px — it can never touch code or numbers. Cost: the gutter is 20px wider.
- **F2 last line**: "at the end" is now strict (≤ 2px, was < 80px), so stopping a few lines short always shows Jump
  to latest; a reflow (tab moved, group resized) never releases a following reader — only scrolling up does; a
  conversation kept alive in a background tab returns to the end when shown (root cause of the clipped footer:
  the turn finished while the tab was hidden). Jump's smooth glide ignores its own scroll events.
- **F3 ACP tools**: `kind` + `{ title, raw_input, locations }` render as the title — first word in the verb style,
  the rest as prose (mono for paths, commands and `execute`); the detail shows `raw_input` and the locations as links
  (absolute paths mapped to the deepest project folder, `:line` kept). Summary lines name ACP kinds ("edited 1
  file"). Demo: Infrastructure → "External agent" (`acp:claude-code`) reads, searches, edits and runs a command.
- **F4 / R12 pin**: 8px solid panel, then a 32px ease-in fade (stops 97/86/60/26/0%), so content reappears from ~0%
  and no row is cut. Measured: the 8px band is the panel colour exactly (Δ0), the next 6px differ by ≤ 7/255.
- **F5 floating composer over tools**: kept over Agents / Notes / Details (it is the way to talk while reading
  them); each list ends with a `FloatRoom` spacer = composer height + 16 (the editor's rule), so the last row
  scrolls above it (measured on Details).
- **F6** overlay tree: Esc (filter empty or toggle focused) and a pointer down outside close it; focus returns to the
  toggle. **F7** tool panels share the pane inset: content starts 8px under the strip (Agents, Notes, Details).
- **F8** Monaco hover / suggest / peek render in a layer on `<body>` (`overflowWidgetsDomNode`, z 45 — above panels
  and the tree, below dialogs): measured on line 3 next to the tree, all four corners of the hover are on top.

**Review fixes.** R1 the "+" menu's search takes focus once the panel exists (button route works from the keyboard).
R2 controls with their own shadow compose the ring (`.octo-ring-float/-pop/-panel`). R3 focus never drops to
`<body>`: Show files focuses the filter also when it mounts the view (one-shot request); a tree pick focuses the
editor / preview when the row went away; chips and the Agents root focus the composer; a new project's composer
takes focus. R4 the rail compresses its pitch 8 → 3px to fit the visible height, then scrolls with the request in
view; ticks `line-strong`, 12px from the text; the card is clamped inside the rail's box. R5 the pinned prompt is
always one `button` (the swap lost `clamped`). R7 icons, below. R9 more than three directories collapse into one
"…" crumb (menu of the hidden folders); the file name is shortened once in the middle; tab labels shorten at 22.
P2 done: reserved hint slot in the "+" menu; no double space after a pick; Enter during a running turn says "The
orchestrator is still working…" (no queue is faked); tooltips also on keyboard focus and never re-armed by a press;
hover/selected 0.05/0.12 (dark), 0.04/0.09 (light); preview h1/h2/h3 20/16/14; the breadcrumb hairline is an inset
shadow (40px content box, no half pixels); clear-filter hit area 24; chips are not a live region (one sr-only status
for state changes); Ctrl/Cmd+L focuses the visible composer from anywhere (Monaco keeps Tab); long rail jumps are
instant beyond two screens; the bottom pin survives a group resize (F2); the chat header drops the project crumb
under 420px; status words capitalised; the composer's folder label carries the folder glyph; the empty project's
title no longer repeats the name and starter rows lost their three unrelated icons (full prompt as tooltip and
description). P2 skipped: #19 tree resizer (re-tested: stored width is already clamped to the real max), #27 close
button under the strip fade at 390.

**15 / 17 Details** (`components/details/`, lazy chunk 3.0 kB): Folders (opens the tree on that root), Models,
Tokens (total, then the orchestrator and one row per role with ×N — eight "Code explorer" rows became one — 2px bar,
`in / out`, ACP rows "approx."), Plugins in use (available language servers and ACP agents), Activity (8, then Show
all) and Files written (from `write_file` and successful ACP `edit` calls; Today / This week / Earlier; ×N; 8 per
group then Show more). Transcripts load through `ActivityStore` (4 in flight, cached per agent `finished_at`, a
running agent re-read on `file.changed` from an agent). Skeletons hold their room from the start (no jump). Rows
fade at the fold. No context-window share: the optional `context_used` / `context_size` are not shown (no decision
covers them yet).

**16 Code highlighting**: one compact rule tokenizer (`lib/highlight.ts`, lazy chunk 2.7 kB gzip) for ts/js, go,
json, bash, python, rust, css, yaml, toml, sql, html and line-based diff; token classes take the editor's palette,
now in one module (`lib/codePalette.ts`) that the Monaco themes import too. Deviation: Monaco's `colorize` is not
used even when the editor is loaded — two tokenizers would colour the same block differently depending on load order;
one tokenizer gives one result. Colours only (comments are not italic in prose), so blocks keep their size: measured
exactly lines × 20px plain and highlighted. Plain text uses the editor's text colour from the start.

**18 Time separators**: 12px `fg-3`, centred, before the first request and any request > 30 min after the previous
turn ended or on another day; inside the turn's section (the rail and jumps land on it). Locale time ("Today 4:11
PM", "Yesterday 18:42", "6 Nov, 09:15").

**19 File links**: inline code in assistant prose (orchestrator and agent transcripts) that resolves to a loaded file
(`folder/path`, or a path unique under one folder; `:12` / `:12-20`) becomes a button holding the same chip with the
file glyph; `link` colour on hover/focus only. The first path-like code asks for the Filter-files index; nothing
blocks render. Opening selects the lines.

**Tables**: numeric columns (every body cell a number, incl. "—") right-aligned with tabular numerals (rehype pass).

**20 Integrations** (Settings → General | Integrations; 640px for this view; lazy chunk 2.6 kB): search, kind chips
with counts (`aria-pressed`), "N available / N not found", two columns of 40px rows (one under 560px): 28px tile —
`Server` (language server), `Bot` (agent), `Plug` (tool server) — name, one muted line (languages / `acp:id` / "Tool
server"), plugin on the right; state "Available" / "Not found" (full text in the tooltip and for screen readers) or
"Configured" for tool servers (no availability check exists). Rows stay grouped per plugin so a manifest error sits
full width right under its plugin's rows. Palette: "Open integrations".

**21 Streak** (`primitives/Streak.tsx` + `lib/streak.ts`, lazy chunk 1.9 kB): four lobes along a 24° band, accent →
indigo (`--octo-streak-indigo`, the one new colour token) with a warm rim, 6 alpha levels, 4×4 Bayer, 2 CSS px
cells drawn at cell resolution and scaled `pixelated`; peak alpha clamped (dark 0.55, light 0.22, measured).
Drift 20s ±12px as a CSS transform (not under reduced motion, paused while hidden). Deviation: a draw takes 6.9–7.6ms
at 1440×900 in Chromium (4.8–6ms in Node for the same cells), not ≤ 4ms; it runs once per size/theme change, so no
frame budget is affected. Text sits on a feathered panel scrim (`.octo-streak-scrim`: 84% panel, 24px blur) — the
first radial version left starter rows at 3.06:1 over the warm rim. Measured worst text at the brightest pixel behind
it (text hidden, DPR 1): Home dark 6.51 (list row, fg-3), light 6.27; Home title 11.13 / 14.90; empty project dark
5.81 (starter, fg-3) / light 5.97, at 390px 6.86 / 6.19; no-projects hero 9.05 / 9.39. Glow (decision 12) removed.

**22 Home** (`#/`, sidebar row "Home"; the app still opens the last active project when there is no route; lazy chunk
4.9 kB): streak, title (new `text-display` 20/28 token, Home and nowhere else), recent projects (32px rows: name,
last request, time; ↑/↓; New project), cards (2 columns from a 900px container): Activity — 26 × 7 cells that fill
the card's width (cells ~14px; decision said 10px), five tones `hover` → `accent`, titled, caption "N agent runs"
"M requests"; Tokens — `getUsage({ group: "model" })` total, families as rows with bars (< 1% folded into Other), a
30-day bar row from `getUsage({ group: "day" })` (falls back to agent totals if the endpoint is missing); Recent
requests — 5, "N more" expands to 15 (deviation: the palette lists requests of the open project only); This month —
requests, agent runs, files written with ±change in `ok`/`err` and this-vs-last bars. Cards in a row share their
height; the block is centred vertically. Demo: Payments and Infrastructure carry 26 weeks of seeded history; demo
`getUsage` now computes buckets from the demo agents (the stub returned nothing).

**Icons (R7)**: file types are badge-free — `CodeXml`, `Braces`, `AlignLeft`, `Image`, `File`; folder rows carry
only their chevron (a file's glyph sits where a folder's label starts). Tools: Agents `ListTree`, Notes `Notebook`,
Details `ChartNoAxesColumn`; settings is one gear (app and project); Home `House`. Sheet:
`scratchpad/v61/shots/icons-{dark,light}.png`.

**Bundle** (initial `index-*.js` gzip): 201.22 → 202.88 kB (+1.66; Home, Details and Integrations are lazy, as are
the streak and the highlighter). Monaco chunk 336.46 kB.

**Spacing**: `spacing-audit.mjs` total 0 on every listed state. New surfaces measured with the same rules
(`scratchpad/v61/myaudit61.cjs`): Home (1440/1100/390), Details and Integrations (1440/1100) — 0 off-scale
paddings/margins/gaps (the sr-only helper's −1px and `ml-auto` excluded), 0 rows outside the set, icon → label 8 in
Details, card insets equal on both sides (17 = 16 + border). States to add to the audit script: `home` (1440, 1100,
390), `details-tab` (1440, 1100, with a floating composer), `integrations` (1440, 390), `empty-project` (1440, 390),
`no-projects` (1440), `acp-agent-tab` (1440).

### As built (v6.2)

Decisions 21b and 23, the Usage tab (usage design, Phase A UI) and the v6.1 review
(`docs/superpowers/research/2026-11-10-ui-review-v6.1.md`). Scripted checks: `scratchpad/v62/accept62.cjs` (new, 70
checks — 72/76 pass, the 4 failures are the draw-time target below) next to the adapted `accept61.cjs` (102/102) and
`accept.cjs` (v6, renamed `accept40.cjs`, 40/40); new pure modules have `*.test.ts` beside them (`pnpm --filter
@octo/ui test`: 242 tests).

**A — the orchestrator at work (decision 23).**

- Sidebar = projects only: 40px two-line rows (name 13/20, state 12/16 `fg-3`), one 16px state slot on the left —
  working = accent dot, needs you = `CircleAlert` in `warn`, unseen activity = filled accent dot (replaces the idle
  ring; sr text "New activity"), idle / new = a quiet ring. State words (no "·" joiners, craft rule): "Working, 3 agents",
  "Working", "Needs you", "Idle, 2h ago", "No requests yet" (`lib/orchestrator.ts`, tested). Data: the open project's live agents
  (`ProjectProvider` publishes them into `ActivityStore`; their root's status alone decides, so the row turns Idle
  with the turn, not with the next project poll), else `listAgents` cached per `updated_at`, else the summary's
  `status` (`state/orchestrators.ts`). "Needs you" = the orchestrator agent's status `failed` after a turn (what the
  harness writes); approvals will join it when the harness has them. Removed: the nested request lists, their expand
  state, chevrons, retry path and `ProjectItem`'s request code; `RequestStore` now serves the palette and Home only.
- Header = the orchestrator: project name (500), the live state, the running agents as one stack (dots + "Dependency
  auditor, Test runner +1"; under 640px of conversation the dots and "+N", so the name never truncates first) that
  opens Agents, the orchestrator's model (hidden under 560px), tokens, and a `…` menu "Orchestrator actions" (Show
  agents, Show usage, Project settings). No request breadcrumb; "Copy request" left with it.
- Tab label "Orchestrator", glyph `Workflow` (was the chat bubble).
- Team strip above the composer while sub-agents run: 24px chips (role, activity, duration) sized to content up to
  320px; when they do not all fit on one line (measured, `ResizeObserver`), one "N agents working" chip (opens Agents) —
  never wraps. The transcript's "Working…" line stays for the orchestrator's own thinking.
- Home: projects and their orchestrators — 5 rows (40px: state slot, name + state word, second line = what the
  orchestrator is doing or the first PROSE line of its latest reply — headings, tables, code, rules and quotes skipped,
  nothing when there is none; `latestReply`, tested), "+ New project" and "N more projects" (opens the palette).
  Cards in a two-column masonry: Orchestrators at work + This month | Tokens + Activity (top-aligned, no stretch, no
  hole); the block is anchored at the top (no jump). At 1440×900 the whole Home fits without scrolling (measured
  scrollHeight = clientHeight with 7 demo projects).
- Empty project: "Give {project}'s orchestrator its first task", one line, the composer, then on a translucent card the
  three facts — Folders; Models as aligned pairs (tier muted, model: "Orchestrator Sonnet 5.5  Fast Haiku 5.5 …", no "·");
  Agents ("Sub-agents, plus Claude Code, …") — and the starter prompts. The demo's default tiers follow the harness
  (`config.DefaultModels`: the orchestrator plans on Sonnet); Atlas, Orbit, Payments and Infrastructure are set to Opus
  on purpose (their history and usage were made on it). Title,
  line and facts load as a lazy chunk; the composer is ONE element across the loading → empty → transcript layouts
  (the conversation renders one tree whose middle slot switches), which fixes the focus race after creating a project
  (R3 now passes).
- Wording: no "session", "thread", "chat" or "conversation" in UI copy, ARIA labels, titles or demo prompts (checked by
  scanning the DOM on Home, empty project, Usage and the palette; demo prose about web-auth sessions reworded; file
  names such as `session.ts` are content). Rail: "Requests to the orchestrator".

**B — streak, second version (21b).** `lib/streak.ts` (tested) + `primitives/Streak.tsx` (lazy, 2.4 kB gzip): one
band per start screen, its geometry a named preset in `lib/streakPresets.ts` (kept apart from the renderer so the main
bundle can name one): `STREAK_HOME` (the diagonal through (0.5, 0.34), echo 0.46 below), `STREAK_EMPTY` (from the top-left
corner across the upper third to the right edge — anchor (0.5, 0.14), rise 0.3 — so the core passes ABOVE the title /
composer / facts, which sit in the halo and the falloff; echo 0.66 below the block), `STREAK_HERO` (the diagonal through
the middle); core ≈ 18% / halo ≈ 45% of the shorter side; three core lobes at
−2°, 0°, +2.6° with along-band waviness; halo wider above the core than below; echo band 0.46 × short below at 0.24;
near-white highlight on the core's upper edge; colour by energy along our ramp (`#1b2a5e` / `#dfe8ff` falloff → accent
→ `#7a5cff` → `#ff3d6e` → `#ff7a3d`, warmer on the lower edge). Alpha: dark core 95% / halo 60%, light 55% / 35%
(measured peaks 0.95 / 0.55). The strength is quantised to 5 levels with a 4×4 Bayer dither at 3 CSS px cells (4 from
1920) — deviation: one step for all three channels (per-channel quantisation split the hue into rainbow fringes); colour
stays continuous. Static sparse noise ≈ 3% of cells at 6–10% over the whole start screen. One sample per cell (a
half-resolution sample showed 2 × 2 blocks — the "large blocky pixels" — and was dropped). Empty project: the streak is
mounted on the dock group behind the tab strip and the header (`primitives/backdrop.ts`), with a 112px eased panel wash
under them (no edge) so their text stays legible; the header is transparent there. Surfaces: `.octo-card` = panel at
78% dark (decision said 72%: measured fg-3 at 4.47:1 over the core, raised locally per the rule) / 80% light, blur 16 +
saturate 1.2, 1px `line-strong` edge, inner top highlight; opaque under forced colours / without backdrop-filter.
Titles on the band keep a soft local scrim.

Contrast, worst text run at the brightest (dark) / darkest (light) pixel behind it, text hidden, DPR 1
(`scratchpad/v62/contrast62.cjs`, every text run grouped by its surface): Home dark 5.02 (project list / Tokens caption,
1440 and 1920), light 4.94 (`ok` green "+109" on white, 1920) / 5.04 (1440); Home title 6.9 dark / 12.1 light; empty
project dark 6.21 (header line), facts card 7.02, starters 6.96, title 11.06, tab 9.54; light 5.73 / 6.48 / 6.43 / 13.97;
no-projects hero dark 7.51, light 8.36.

Draw time — NOT met: decision 21b asks ≤ 4 ms per draw at 1440×900. The pixel work (`data-render-ms`, without reading
the theme's colours and the canvas upload) measures a median of 5.1–5.3 ms at 1440×900 and 8–11 ms at 1920×1080 in this
sandbox's headless Chromium (warm, 7 redraws), 2.7–4.5 ms in Node for the same cells; the first (cold) draw is ~25–35 ms.
Done: lookup tables cached per theme, one pass with the band's row extent only, the noise field as a fill + 3% scattered
writes, no clamping or allocation in the loop. Not done: sampling at half resolution (it halves the time but showed
2 × 2 blocks). A draw happens once per size / theme change, never per frame.

**C — Usage tab.** Tool tab `usage` ("Usage", `Gauge`), header button, palette "Show usage", Home Tokens → "Usage ›"
(opens the most recent project's Usage over All projects: a one-shot `nav.requestTool` taken by the workspace on
mount). Side group like Details; content column ≤ 480px. Controls: one full-width `Segmented` Tokens | Cost | Limits (28px,
radio group, ←/→), then one quiet row of two 24px controls with the same radius — range 7d / 30d / 90d (as wide as its
segments) and scope This project | All projects (the rest; stacked under 320px of panel, checked at the 280px minimum
group); remembered per tab (`USAGE_VIEW` slot).
- Tokens: total, then In / Out / Cache read / Cache write (two columns under 320px); `DayBars` (one bar per UTC day,
  integer widths and heights, 3px minimum bar, a 1px `line-strong` baseline, first / last date ticks; hover or ←/→ on the
  focused chart = a slider over the days, readout line under it) — shown only with ≥ 2 days of data, otherwise one
  sentence ("All of it on Nov 11; the daily chart appears once a second day has usage"); scale linear, square root above
  max/median 8, log above 100 (deviation: sqrt alone still flattened the demo's month, where one day holds most tokens);
  By model; By agent role (this project) or By project (all).
- Cost: compact USD total, "estimated" when any part comes from the price table, per model with "est." / "no price"
  (never $0), and the `prices.toml` line whenever something is unpriced.
- Limits: provider sections, one block per model + kind (label, remaining / limit, 4px bar — `err` under 10% —, "resets
  in 42s" live and stopping at 0, "observed 2m ago"), stale after 10 minutes (60% opacity + "stale"); re-read every 15s;
  empty state. "Plan limits for external agents": the available ACP agents and the sentence that their CLI shows plan
  limits — no numbers.
- Context: Agent tab meta "context 1.8k / 200k" and, in Details' token rows, a context line with an accent bar, only
  when `context_used` and `context_size` are reported.
- Home Tokens: `getUsage` 30 days (model + day); the same chart, hidden under 2 days with data.
- Demo bridge (`demo/usage.ts`, lazy): usage spread over each agent's replies (one row per response like the harness),
  cache read/write for API models, prices for Opus/Sonnet (estimated), none for Haiku ("no price"), the ACP agent's
  reported cost; limits for Opus (requests, input, output — output under 10%), Sonnet tokens, Haiku requests stale
  (observed 14 min ago); the ACP agent reports context occupancy.

**D — review fixes.**
P1: breadcrumbs collapse by measured fit (`lib/crumbs.ts`, tested: everything → `folder › … › parent › file` → `… ›
parent › file` → `… › file`, the "…" a menu that includes the folder; the file name shortened once, only if it alone does
not fit; each crumb's tooltip names its own path); the status slot is `shrink-0` and the crumbs take the rest (no
overlap, measured). Tree: one glyph column — a folder's chevron or a file's type glyph — so each level has one label
edge (folder glyphs stay out: decided once). Details ≤ 480px. Narrow groups: under 420px with two or more tabs (or no
room for one) the header tools fold into "Project tools" `…`. Home cards top-aligned, no jump. Tokens chart (Part C).
P2: focus never on `<body>` after a tree pick opening a second file tab, a Details file row, Remove comment (→ editor),
a tab drop (→ the moved tab; root cause: file tab ids hold a NUL that `CSS.escape` mangles, so `[data-tab-id=…]`
selectors never matched file tabs — `tabButton()` matches by value; `focusSoon(onlyIfLost)` now also waits while focus is
on an element that is about to be hidden). "+" pick via the button: one space. Front matter → a quiet key/value block
(`lib/frontMatter.ts`). Palette: groups ordered by their best match kind (`rankGroups` in `lib/match.ts`) — "integr" →
"Open integrations" first. "1 manifest problem". Esc in a non-empty Integrations search clears it first
(`data-esc-clears`). `?demo=many` heat map counts requests too; integer heat cells. Home/End in Home and Details lists.
Tooltips on truncated rows (sidebar, Home, tree labels). After sending, the rail follows the newest request whose prompt
is fully visible. Start-screen titles 20/28 on all three. Details rows on one 16px slot edge. "Plugins in use" = servers
for languages present in the project's files (from the Filter-files index) + available ACP agents. ACP tool-detail
diffs highlighted (`looksLikeDiff` → the chat's tokenizer). Filter pick: one selected row; the filter text is shared by
the project's file views (kept when the Files tab turns into the file). Comment "+" names "lines 12–20". A group's
active tab survives a reload. 390px: the selected tab and its close button stay 24px clear of the strip fade.
Narrow file group next to the orchestrator: the tree column floats (closed) when it would leave the editor under 480px.

**Structure.** New: `lib/{orchestrator,usage,usageView,crumbs,frontMatter,languages}.ts`, `state/orchestrators.ts`,
`state/workspace/ids.ts` (moved from `dock/`), `components/usage/`, `home/HomeCards.tsx`, `chat/{TeamStrip,EmptyProject}`,
`primitives/{DayBars,Segmented,backdrop}`. Lazy: Home, Usage, Details, Integrations, the empty-project block, the command
palette (warmed 1.5s after start), demo usage, the streak, the highlighter.

**Bundle** (initial JS, gzip, `node scripts/check-bundle-size.mjs`): 211.22 kB, budget 211.80 kB (not raised; the
budget was set at 208.8 + 3). Before the lazy splits this pass measured 215.71 kB; made lazy to stay inside: the command
palette (2.66 kB chunk, warmed after 1.5s), the empty-project block (1.45 kB), demo usage (1.24 kB), and the usage
helpers the main bundle does not need (`lib/usageView.ts` holds the small part). Lazy chunks: Home 5.35, Usage 4.11,
Details 3.66, Streak 2.78 kB.

**Spacing.** `scripts/spacing-audit.mjs --url …:1434`: total 0, skipped 0 (no state became unreachable; the script
reads project names from the sidebar links' `title`, which stays the project name). New surfaces measured with the same
rules (`scratchpad/v62/myaudit62.cjs`, 1440 / 1100 / 390): Home, empty project, orchestrator + team strip, sidebar,
Usage (Tokens, Cost, Limits) and Details — 0 off-scale paddings / margins / gaps (sr-only −1px and `mx-auto` centring
excluded), 0 rows outside the set, team chips 24, Home card insets equal on both sides.

**Acceptance checks changed** (coverage kept): see the list in the v6.2 report; every `Chat` tab selector → `Orchestrator`;
"Requests in this conversation" → "Requests to the orchestrator"; D21 2px / 55% → D21b 3px, peak 85–95% dark / 50–55%
light; D22 four cards → Orchestrators at work, This month, Tokens, Activity; "5 recent requests" → 5 project rows;
"cards share their height" → columns start on one line; "heat map fills the width ±1px" → integer cells, < 1px per
column left over; "a recent request opens its project" → a project row opens its orchestrator; header tool clicks go
through the folded "Project tools" menu when a group folds; palette typing waits for the lazy palette.


### As built (v6.3 part 1, 2026-11-11)

Decisions 33, 29, 25, 34, 35, 32, 36. Verified by the orchestrator: lint (0 errors, 80 warnings), format, no
cycles, 262 UI + 8 desktop tests, build, bundle 196.66 kB (budget raised to 196.8: dialogs moved to lazy chunks,
tabs / rings / team line added), four screenshots viewed. By the executor only: its acceptance script (103 of 104),
the spacing audit at 0, contrast ≥ 4.5:1. **Not verified:** touch drag, screen reader, forced colours, Tauri shell,
a live backend.

- **33**: `Segmented` is 24px text-only; Usage has one segmented control; range and scope are one `MenuButton`;
  the send and Stop buttons are quiet until there is text.
- **29**: one ring glyph everywhere (`lib/stateGlyph.ts`, `primitives/StateGlyph.tsx`); idle ring 1px; a project
  with no requests shows the dashed ring; CSS-only motion, none under reduced motion.
- **25**: pointer-event tab drag with sliding neighbours, detach, split zones, Esc; 200 → 96 → 40px icon-only
  sizing; middle-click, reopen (stack of 20), MRU Ctrl+Tab, Ctrl+1…9; Orchestrator pinned first. **Not built:**
  the "+" picker and the all-tabs list (with decision 24, part 2).
- **34**: team line in the orchestrator header (live chips / "Last ran N agents" / what it can call on); an agent
  always opens in a split beside the orchestrator.
- **35**: the five focus paths of the review pass.
- **32**: streak rewritten (thin near-white core, exponential glow, dithered grain, specks); drawn once, redrawn
  only after resize or theme change. **Deviations:** cards are 85% opaque, not 72% (muted text measured 3.4:1 over
  the core); the ≤ 4 ms draw target at 1440 is met only on a quiet machine (median 2.7–3.7 ms quiet, 4.9 ms loaded).
- **36**: contrast, 24×24 targets, scroll memory (also fixed: moving a conversation tab lost the scroll position),
  Limits polling stops while hidden.
- Seen in the screenshots, for part 2: the right group shows icon-only tabs next to the tool icons (two rows of
  the same glyphs — decision 24 removes this); while working, the team appears both in the header and above the
  composer; the header still shows the requested model, not `served_model`; "orchestrator" capitalisation.
- Debt: `WorkspaceProvider.tsx` 543 lines, `lib/streak.ts` 354 (Q5).


### As built (decisions 51, 54, 60: title bar, folder row, window jump; shell pass 2)

- **51:** the folder row of the project dialog is a grid (`minmax(0,1fr) · minmax(0,8rem) · auto`), the label field's placeholder
  is "Label (optional)". The spacing audit has a `dialog-bounds` rule (nothing in a `[data-dialog-body]` passes its padding box;
  a negative-margin ghost button may bleed its hover surface) and a `new-project-dialog` state at 1440×900, 1100×800, 800×600,
  640×480 and 390×700; `--selftest` injects a 2000px child and the rule reports it.
- **54:** `components/shell/TitleBar.tsx` is the 40px row (window inset from `chrome.insetStart`/`insetEnd`, sidebar toggle,
  back/forward, then two slots); `TitleBarProject.tsx`, rendered inside the project's providers, portals the name and state
  into the start slot and the model chip, budget, tokens, side question and "⋯" into the end slot (`state/titleBar.ts`). The
  sidebar has no header row, the tab strip and the empty panels have no toggle, the drawer starts under the row. Drag areas carry
  `data-drag-region`; `OctoApp` takes `chrome?: WindowChrome` (default: no overlay, no insets). Desktop: `windowChrome.ts`
  (`chromeFor`, `isDragTarget`, tested), `useWindowChrome.ts` (drag, double-click zoom, no inset in full screen; Tauri API loaded
  only for the macOS app), `tauri.macos.conf.json` (`titleBarStyle: "Overlay"`, `hiddenTitle`, `trafficLightPosition`), three
  window permissions in `capabilities/default.json`. The row is `bg-window` above the panel (top gutter 0; the audit's gutter rule
  measures from the row). The team line (decision 34) no longer shows. Interim: `[data-chat-header] { display: none }` in
  `styles.css` hides the old header until chat stops rendering it. **Not verified:** macOS (traffic-light inset, dragging, zoom,
  full screen), WebKit, the Rust side (not compiled here; no Rust source changed).
- **60:** the first split opens with the conversation at its remembered width (`octo.chatSplit`, default 420px, written when the
  divider between the conversation and its only neighbour is dragged) in one commit; the file view's `Suspense` fallback is
  `FileViewSkeleton` (bar, editor lines, tree column at the stored width); the editor shows `EditorSkeleton` until Monaco's editor
  exists. `lib/scrollAnchor.ts` keeps the reading position across the resize; chat has to call it (see the hand-over).
  `scripts/layout-shift.mjs` samples the conversation column and the sidebar after every rendered frame: at 1440×900 with
  `--anchor`: one column shift, none in the sidebar, anchor moved 0px (without the hook Chromium's own anchoring leaves 22px;
  WebKit has none). Not run below 1000px.

### As built (decisions 53, 58, 59 — settings page, providers, connect screen; 2026-11-11)

- **Settings page** (`components/settings/`, lazy chunk): `#/settings/<section>` (`lib/route.ts`: `parseSettingsHash`,
  `settingsHref`, `useSettingsSection`); navigation in the sidebar's place (Back, search across an index of rows,
  sections with glyphs), 780px column (`--spacing-settings`), group cards, rows 56px+ with one control; below 760px
  (`--breakpoint-settings`) a section select on top and stacked controls. Esc goes back. `SettingsDialog` is gone; its
  theme, backdrop, bridge state and Integrations (now Editor → Plugins) are kept. Harness settings (`getSettings` /
  `putSettings`) show "Saved", errors and "Saved. Applies after a restart" with "Restart now" when the host passes
  `HostCapabilities.restart` (desktop: the sidecar restart).
- **Sections as built**: General (startup: last project / Home; harness connection), Appearance (theme, backdrop,
  reduce motion → `data-motion`), Providers (rows with state and Connect / Reconnect / Details / Remove; API keys and
  router folded), Models (default orchestrator and tiers limited to what can run; "Models in pickers" switches,
  `PREFS.hiddenModels`), Agents (state, install / login text and commands with copy, models, Check again), Editor
  (inline completion per project; plugins), Usage and budget (plan limits; budget per project), Memory (context mode
  per project), Privacy and data (Copy diagnostic report, wire trace switch, data folder, child env list), About.
  **Simplified / not built:** notifications, sound and density (no feature behind them), the digest switch, an agent's
  default-model setting, the completion *model* (only Off / tier), per-language completion.
- **Providers** (`lib/providers/`): `useProviders(bridge)` (one cache per bridge; `GET /v1/providers` through the
  optional `listProviders`, else derived from config + plugins + settings — unknown reads as connected),
  `useModelPicker` / `pickerView` / `pickerKey` (the headless model picker of decisions 53 a and 58: only what runs,
  grouped by provider, agents with "›" and a second level, not-ready providers one connect row each, search across both
  levels), `chipLabel`, `canRun`, `commandsIn` (commands in a hint). The picker component is the composer's.
- **Connect** (`components/providers/`): `ConnectSheet` (agent steps with copy buttons and Check again; write-only
  key form — the value lives only in the DOM input and is cleared after `putSettings`; router switch and upstream key)
  and `ConnectScreen`, shown by `AppShell` instead of Home / the project form while nothing is connected.
- Demo: `demo/providers.ts` (Claude Code ready, Copilot not logged in, Grok not installed, API and router not
  connected; `?providers=none` for the connect screen; settings and diagnostics in memory).
- Verified with Playwright against `?demo=1` (screenshots of every section at 1440×900 dark, General / Providers /
  Models at 390×700 and light, Providers at 1100×700, 800×600, 640×480, the sheets and the connect screen; console
  clean, no horizontal scroll). Not verified against a live harness's `/v1/providers` (not built when this was).

### As built — usability pass (2026-11-12)

Defect list with severities: the executor's `defects.md` (scratchpad); summary of what changed:

- **Sub-agents in the title bar** (decision 34 returns): `shell/TitleBarTeam` — chips for the running agents, the latest team when idle,
  click opens the agent's tab, folds into one "N agents" chip (opens Agents) when the chips do not fit (measured). The unused
  `chat/TeamLine` is gone.
- **One model control**: `shared/ModelPicker` (chip on `primitives/Chip`, the former `ComposerChip`) is used by the composer, the title
  bar and the project dialog; its list (`ModelPickerPanel`) renders `lib/providers` (`useModelPicker`, `pickerView`, `pickerKey`):
  only ready providers' models, grouped; a not-connected provider is one row that opens its connect sheet (`ShellContext.openConnect`);
  an agent's models under "›"; a `stale` model is dim with "not offered in the last session"; the project form keeps "Use <id>". Both
  chips show the chosen model's label (decision 48's served model is in the tooltip); a setting that `canRun` rejects turns the chip
  warn (53 d). Removed: `chat/ModelPicker`, `chat/modelPicker*`, `lib/modelPicker` (tiers/favourites rows of decision 27; tiers stay
  in project settings, routing stays on the composer's chip). The picker's chunk graph keeps `deriveProviders` lazy (`lib/providers/derive`),
  and the chip imports `providers.ts` / `useProviders.ts` directly, not the index: initial JS stays 152.89 kB gzip.
- **Settings**: the title bar's sidebar toggle is hidden there. **Changes** opens at the file width (`openTool` treats it like Files).
- **Following new cards**: `useStickToBottom` re-observes after a remount, follows `initialStick` until the reader has moved, and does
  not read a clamp from shorter content as scrolling up. Reproduced with the approvals chunk delayed 3.5 s (before: not at the end).
- **Wording**: "orchestrator" is no longer shown as a name (`agentDisplayName`: project name for approval and form labels, transcript
  speaker; "Conversation", "Agents at work", "Project actions", prose rephrased). **Markdown chunk** warmed in an idle callback.
  Connect screen/sheet no longer repeat the state as the reason (`extraReason`). Home keeps an intentional scroll below ~1200px of
  content (backdrop outside the scroller; end of scroll checked at 390 and 768).
- **Verified**: Chromium via Playwright against `?demo=1` (flows listed in `defects.md`), console clean, no horizontal scroll at
  1100/830/640/390/320; unit tests (383 UI, new: `agentDisplayName`, `extraReason`). **Not verified**: WebKit (the owner's webview),
  a live harness, light theme screenshots for the new controls, the flows listed as not walked in `defects.md`.

### As built — usability pass 2 (2026-11-12)

Cut short by the owner's new frame (decisions 67-71); what is built, what is not. Defect list: the executor's `ux2/defects.md`.

- **Models (58, revised)**: `lib/providers/modelList` — top level is the API/router groups, then one flat "Agents" group (a row per ready
  agent, its chosen model dim on the right, chevron); every ready agent opens a second level even with no known model: "Default (the
  agent decides)", known models (stale dim, typed names removable), "Other model…" (an inline field, Enter chooses
  `acp:<agent>/<name>`); "Refresh models" in the header (spinner, `models_error`). Providers not ready sit under "Not connected" and
  open the connect sheet. Typed names are kept per agent in `PREFS.customModels` and sent through `setProviderCustomModels` when the
  bridge has it. agent-client (all optional/additive): `refreshProviderModels`, `setProviderCustomModels`, `Provider.models_error |
  models_refreshed_at | accepts_custom_model`, model sources `custom | command`. `modelLabel` makes an id-only label readable.
  **Not built**: decision 72 b-d (two-pane at 560 px, roles, `setProviderPrefs`, `login: unchecked`, the Settings pane); the 16 px
  `ProviderMark` exists and is used in the picker only.
- **Folders (49, 71)**: "Browse…" first row (host `pickFolder`, else `Bridge.pickFolder` when `BridgeConfig.pick_folder`), busy/cancel/
  error states (`browseOutcome`, `browseRow`), Ctrl/Cmd+O; rows show the name first, the branch, and the path relative to home on a
  second line (hidden when identical for all rows). New project: chips + "Add folder", no label field, label = folder name (`folderLabels`),
  name follows the first folder. Editing a project keeps the label inputs.
- **Empty states (64 h)**: `primitives/EmptyState` (42:58 spacers, one centred axis) used by the side question, Review, Memory, Changes,
  Agents, Usage and Notes. Not yet: Home with no projects, the empty conversation, palette search.
- **Context (65)**: `chat/ContextRing` is a button with the popover; view model `lib/contextView` (categories largest first, shares sum to
  100, "≈" unless the agent or provider reported, agent variant, "from the last turn" fallback); agent-client `getContextOverview?`,
  `compactNow?`, `ContextOverview` (same URL as `getContext`; the view reads either shape). "Open context details" opens Memory on Context
  once (`MEMORY_START`; a Memory tab that is already mounted does not switch). **Not built**: the `context.updated` event.
- **Title bar**: the model chip, token count and side-question icon are gone (side question and tokens are in "⋯"; the budget shows only
  from 80%); sub-agent chips fold above three.
- **Review**: header is a title row (one primary action), a quiet meta line and "Details"; "New commits: update" only when the list reports
  `new_commits`; `BridgeError.command` (additive) feeds the submit sheet. Demo: Orbit, Atlas, Payments, Infra run on Claude Code (ready
  chips), the API-model projects warn; Codex is ready with no models; `?pick=cancel|fail`, `?refresh=fail`.
- Removed: `PREFS.favouriteModels`, the picker's digit and star code. Placeholders in `Input`/`Textarea` are italic and lighter with "e.g.".
- **Verified**: Chromium via Playwright against `?demo=1` at 1440×900 (and 390×700, 560/830 for the picker, context and side question): model
  picker three levels and typing, folder Browse (ok, cancel, fail), context popover (agent and harness), side-question empty state, console
  clean. Unit tests: modelList, contextView, folderPick, models, client `command`. **Not verified**: WebKit, a live harness, light theme,
  the flows listed as not walked, contrast numbers, `?demo` variants other than the default.
- **Open (handed on)**: decision 72 b-d, 64 b-g beyond the above, quick open (B9), Review wide width and remembered conversation column,
  spacing-audit bar/filled-button/nested-border checks, decisions 66-70.

### As built — usability pass 3 (2026-11-12)

Three complaints from the owner's live run: no model choice, the folder label, the jerking window.

- **Models (58, 72 b-d)**: opening an agent's second level asks the harness once per agent per app session when the list is empty
  or `models_refreshed_at` is absent (`useModelPicker`, `firstAsk`; the "Refresh models" spinner shows; never repeated). While the
  list is empty a dim line under the header says why (`emptyListNote`: `models_error`, else "<Agent> has not reported its models
  yet", then `models_note`). "Other model…" is a labelled row (shown only when `accepts_custom_model !== false`); Enter or a click turns it into
  a field with the placeholder "e.g. opus" (the agent's first model name when it has one). `login: "unchecked"` needs no code: the harness
  reports such an agent `ready`, so it is selectable (unit test); only `not_logged_in` / `not_installed` go under "Not connected". The
  agent row shows the chosen model, else the preferred one (harness, else this browser), else the default, dim. Settings → Providers:
  the first ready agent is selected (its name is the button); on the right `AgentPrefsPane` shows Preferred model and Fast / Balanced /
  Deep, each a select over the agent's models plus "Default" and "Other…", saved through `setProviderPrefs`; a bridge without it keeps
  them in `PREFS.agentPrefs` (`useAgentPrefs`). Stacks below 760 px. Demo: `setProviderPrefs`, `login`, `preferred_model`, `roles`,
  `models_note`; knobs `?claude=empty` (Claude Code starts with no models), `?refresh=fail|none` (the refresh fails / finds nothing);
  Codex starts empty with login unchecked and finds two models on the automatic refresh.
- **Folder label (80)**: no label input in New project or project settings; `labelsForFolders` keeps the label a folder already has and
  names a new one after itself (`folderLabels`); unit test.
- **Width (79)**: not reproduced in Chromium: before the change every pane (both groups, the editor area, the conversation column)
  was identical to the pixel across the three files, the diff and the wide blocks. The structural defects found, all fixed: panels
  and the window root used `overflow: hidden`, which is still a scroll container (a programmatic scroll or a focused input at the end
  of a long line can move the pane sideways: the likely WebKit "jerk"); the editor host had no `min-width: 0` or clip; no pane was
  immune to content-derived min-content width. Now `panelClass` is `overflow-clip contain-inline-size`, the window root and the
  editor area are `overflow-clip` (the area also `contain-inline-size`), and the editor wrapper has `min-w-0 overflow-clip`. The cause
  in WebKit is therefore a hypothesis. `packages/ui/scripts/width-stability.mjs` is the guard: conversation top, wide table, wide code
  block (one group), then a 20-column file, a 400-column file (caret at the end), a one-line bundle, and the Changes diff with a wide
  line (split); asserts equal group and editor-area widths, no sideways scroll on any scroller and `scrollWidth === clientWidth`.
  Demo fixtures: `atlas-api/width/{narrow.txt,wide.txt,minified.js}`, a wide table row and log line in the Atlas answer, a wide change
  in Changes.
- **Verified**: Chromium via Playwright against `?demo=1`: width-stability ok at 1440x900 and 900x600; picker with models, auto
  refresh, empty with error, empty with note, "Other model…" row and field, at 1440 and 390; Settings → Providers with the roles pane;
  New project and project settings without label; unit tests (modelList, folderPick); `pnpm lint`, `format:check`, cycles, tests, build,
  bundle budget (154.28 of 155.90 kB gzip). `spacing-audit`: total 0, 5 states skipped (its model-picker and project-settings-models steps
  look for labels that decision 67 renamed; not fixed here).
- **Not verified**: WebKit (the width fix is untested where the jerk was seen), a live harness (`setProviderPrefs`, refresh against the real
  Claude Code), light theme, saving roles with a real `harness serve`.

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

Tokens (styles.css, mirrored in `lib/constants` for the Web Animations API): `--motion-fast` 100ms (hover, reveal, press, every
exit), `--motion-base` 150ms (overlays, tooltips, chevrons, switches), `--motion-slow` 220ms (drawers, sheets, large surfaces),
`--ease-out-quint` = `cubic-bezier(0.2,0,0,1)` for enters, ease-out for exits; utilities `duration-fast|base|slow`. No other
duration is written by hand, and nothing animates a layout property (a test in `lib/constants.test.ts` checks styles.css).

| What | Enter | Exit | Reduced motion |
| --- | --- | --- | --- |
| Dialog, palette, popover, menu, context menu (opened by pointer) | base, opacity + scale 0.98→1 + 4px rise, ease-out-quint; a menu grows from the point it opened at | fast, opacity + scale 0.98, ease-out | opacity only (fast / fast) |
| Tooltip | after 600ms, fast fade; a neighbour while warm shows at once (no fade, no delay) | fast fade | fade |
| Anything opened from the keyboard (Ctrl/Cmd+K, Shift+F10…) | instant (`html[data-input="keyboard"]`) | instant | — |
| Drawer (sidebar), phone sheet | slow, translateX(−12px)→0 + opacity; scrim base | fast ease-out | opacity only |
| Press (buttons, icon buttons, send) | `:active` scale 0.97, fast ease-out | — | none |
| Press (rows, tabs) | `:active` hover tint over the current fill, fast | — | same (tone) |
| Drop indicator, drag chip | fast fade; zone glides by translate (fast, ease-out-quint), its size snaps | removed | fade only |
| Hover fills, reveals | fast background-color / opacity | — | instant |
| Activity steps (expand) | rows open at once, fade in (base) | instant | instant |
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
- **Wire format and escaping** (code-quality pass Q3): an entry is a header line `{folder}/{path}:{start}[-{end}]`,
  the quoted lines (`> ` prefix, ≤ 6, then `> …`), then the comment text up to the next header. A header is a line of
  that shape that starts the block or follows a blank line, so text containing such a line would split. To keep parsing
  unambiguous for any text, `formatComments` puts U+200B (zero-width space) in front of a text line that is shaped like a
  header, of a first text line that starts with `>` (it would read as a quote), and of a line that already starts with
  U+200B; `splitComments` strips one leading U+200B from each text line. Text without such lines is written exactly as
  before, and blocks written before the escape existed contain no escaped lines, so they parse unchanged. The model sees
  a zero-width space in front of the rare escaped line; it carries no meaning.
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
mono `ui-monospace, "SF Mono", Menlo, Consolas, monospace`. No bundled fonts (superseded by the owner's audit, 2026-11-14: Inter is bundled; see "As built — the owner's UI audit").

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

## As built — Home clean-up (decisions 75, 76)

Home keeps the heading, the four state tiles (each filters the list), the project list and "Agents at work" (shown
only while an agent runs). Removed: the recap sentence, the activity heat map, the tokens card, `lib/recap`. The
needs-you dot no longer pulses anywhere (the `octo-ring-pulse` animation is deleted); state tiles are static; only a
working project's or agent's ring turns. Checked in Chromium on demo data: with no working project Home has no running
animation (the one finished `octo-fade-in` of the backdrop streak remains — a test should count running animations).
Not verified: WebKit, CPU use on the owner's machine.

## Decision 79 — a pane's width never depends on what it shows

Owner: "opening files with different line widths jerks the window". Rule: the width of every pane (sidebar,
conversation, editor, dock) comes from the layout state only — the divider position and the width floors of decision
67 — never from content. Acceptance:
a. Opening, switching and closing files of any line length changes no pane's width by a single pixel (Playwright:
   open a 20-column file, then a 400-column file, then a one-line minified file; `getBoundingClientRect().width` of
   the conversation and the editor pane is identical across all three, and the window has no horizontal scroll).
b. Long lines scroll inside the editor; the editor container has `min-width: 0` and `overflow: hidden` at every flex
   and grid level up to the pane.
c. The same test covers the Changes diff, the Review diff and a wide table or code block in the conversation.

## Decision 80 — a folder has no label anywhere

Owner: "remove the label from the project's folder choice altogether". Extends decision 71 to editing a project and
to every other place: no label input exists. The label sent to the harness is the folder's name (the parent is added
only to tell two equal names apart). Acceptance: no "Label" field in New project or in project settings; existing
projects keep working; unit test on the label derivation.

## Decision 81 — no coloured frames

Owner: "the yellow frames are not good". Supersedes the border part of decision 46. A card that waits for the person
(approval, form, plan, failed turn, queue) has the same neutral border and surface as any other card. What says "this
needs you" is, in this order: its position (directly above the composer), the small state glyph in the warning colour
next to the title, and the one filled primary button. Rules:
a. No border, outline or ring in a warning, danger or accent colour anywhere, except the keyboard focus ring and a
   field with a validation error.
b. No pulsing border (decision 76 already forbids idle motion).
c. Destructive and deny actions are quiet buttons with coloured text, not coloured outlines.
d. Acceptance: a script check that no element in the demo states of the spacing audit has a computed border colour
   from the warn/danger/accent tokens unless it is focused or `aria-invalid`; screenshots of an approval, a form, a
   plan and a failed turn.

## As built — frame (decisions 67, 73, 69, 76)

- **Frame (67).** The tab strips are the window's top row. `app/AppShell` has no title-bar row any more: `shell/TitleBar` is the window
  controls (inset, sidebar toggle, back, forward) floating over the top-left corner, a drag strip behind everything for the screens
  with no strip (Home, Settings; Settings names itself after the controls), and nothing else. With a project open, the main column
  starts at y = 0 and every dock group is `strip (40px, window background, data-drag-region) + card (panelClass)`; the first group's
  strip starts after `controlsWidth(chrome.insetStart)` while the sidebar is closed (`state/chrome.ts`, tested), the last group's strip
  ends with `shell/ProjectBar.ProjectActions` ("⋯": agents, details, usage, side question, tokens, editor, project settings) and
  keeps `chrome.insetEnd` free for Windows/Linux controls. The strip with the conversation shows `ProjectTeamLine` (decision 34's
  chips) after the "+". The conversation tab reads "Project / the orchestrator's title" (dim; `tabInfo.detail`) with its state glyph.
  The model chip, the state words and the budget are gone from the top row (the budget moved to the status bar). Three levels, one
  separator: sidebar and strip share the window background, the card's edge separates them from content; a content header ends in
  a hairline (unchanged). The tab wrapper is `data-no-drag`, so dragging a tab never drags the window. Removed: `TitleBarProject`'s
  portal, `TitleBarTeam` (now `ProjectTeam`), `state/titleBar`.
- **Width floors (67).** `lib/constants` `CHAT_MIN_WIDTH 420`, `MIN_GROUP 280` (lists), `EDITOR_MIN_GROUP 360`; `state/workspace/floors`
  (tested) takes a group's floor from its tabs (conversation 420, file or Files 360, else 280; the largest wins). A group's CSS
  `min-width` is its floor, a divider drag stops at both neighbours' floors (`layout.resize` gained `minRight`), a new file group
  leaves the conversation its remembered width. The conversation's default width beside a side group is 520 (was 420; owner:
  "chat too narrow"). When the groups' floors plus gaps do not fit, the dock shows one strip (`narrow`) — all groups merge into the
  first, not only the right-most one as the decision words it (not changed: with two groups it is the same thing).
- **Status bar (73).** `components/status/`: one 24px row (`[data-status-bar]`) under the window; left (the open project, portalled
  from `ProjectStatus` through `state/statusSlots`): its first folder "+N" (opens Files), "N changed files" from `listChanges`,
  reloaded on `change.recorded` (opens Changes, only when N > 0); right: "N working" projects (opens Home; not shown on Home, which
  lists them; the one glyph that turns), the project's "$spent / $budget" (opens Usage; amber from 80%, red at 100%), and the
  connection, only when not online ("Bridge offline" retries). The sidebar's own connection text moved here. Hidden below 600px
  window height. Pure parts in `lib/statusBar` (tested). **Not built:** the branch (the project data has no branch; only the
  folder picker reads `.git/HEAD`), running commands (decision 68 is another pass), context use and spend *today* (no project-level
  figure for either; the composer's ring and Usage have them).
- **Flicker (69, 76).** `packages/ui/scripts/flicker.mjs`: types 2 000 characters over 20 lines into the composer of Atlas API
  while a recorder samples every painted frame (rAF, then a message task after paint) and asserts: every strip and the tab list
  move 0 px; the conversation scroller's top/left/width and the column's left/width move 0 px; the scroller gives exactly the
  height the composer takes and a column pinned to the end moves by that same amount; the composer's bottom edge is fixed and its
  height never shrinks. Idle: Home with no project at work, an idle project and Settings (`?demo=one`) have no running entry in
  `document.getAnimations()`. Found and fixed: with a wrapping prompt the composer reached 10 lines, the scrollbar that then
  appeared changed the text width, the height oscillated and React stopped with "Maximum update depth exceeded" (typing stopped
  mid-prompt) — `scrollbar-gutter: stable` on `.octo-composer-input`. Not met: decision 69's literal "the last line stays exactly where
  it was": the composer is a sibling under the scroller (not an overlay with a bottom inset), so a pinned last line moves up with
  the composer's growth (lock-step, no lag in a painted frame). Changing that is the composer pass's business (`components/chat`).
  Transcript re-renders per keystroke were not counted (the text lives in `Composer`, `Transcript` is `memo`).
- **Spacing audit.** The `model-picker` step now looks for the dialog "Choose …" and `project-settings-models` for "Project actions";
  the gutter rule measures the card, not the section: top and bottom are 0 by design (strip above, status bar below), right and
  gaps are one gutter; one allow-list entry (the first strip's computed inset). The two skips: see the hand-back.
- **Verified:** Chromium via Playwright against `?demo=1`, dark, screenshots at 1440×900, 1100×700, 830×560, 390×700 (project with a
  file open, Home, Review, Settings). **Not verified:** WebKit (the owner's webview), the macOS overlay title bar and traffic-light
  inset with the new strip (only `controlsWidth` is unit-tested), Windows/Linux `insetEnd`, light theme, drag regions in the shell
  (`isDragTarget` logic unchanged, `[data-strip]` and `[data-title-bar]` carry the attribute).

## Decision 82 — two rows of tabs never look alike, and a line separates them

Owner (Memory tab screenshot): "I still don't see a line between the tabs Tasks / Files and the row below, All / Open /
Done". Applies decision 67's levels inside a tab's content. Rules:
a. **View switcher** (Tasks · Files · Search · Context; Sessions when M4 lands): one row at the top of the content,
   full width, with a hairline under the whole row (the same separator as between frame levels). Built once as
   `primitives/ViewTabs`; the active item is marked by text weight and an underline that sits on the hairline, not by
   a filled pill.
b. **Filters** (All · Open · Done · Dropped) belong to the list, not to the page: they sit inside the list column,
   under the hairline, with the list's own inset, and look different from view tabs — small quiet segmented text
   with counts dim; built once as `primitives/FilterTabs`.
c. Never two pill rows stacked; never a filter row spanning the detail pane.
d. The list column and the detail pane are separated by one vertical hairline that starts at the view-switcher's
   hairline (no gap, no double line).
e. Every screen with both levels uses the two primitives: Memory, Review (picker filters), Changes, Usage, Settings
   sub-sections where they exist.
Acceptance: screenshots of each at 1440×900 and 390×700; the spacing audit checks that a `ViewTabs` row has a bottom
border and that no `FilterTabs` is a direct sibling above another tab row.

## Decision 83 — a tab is as wide as its title

Owner (macOS screenshot): "tabs should be at most the width of their content; the project tab is too big, with empty
space". Rules: a tab's width is its icon + title + close button + the standard inset — no fixed or minimum width
beyond what keeps the close button reachable; a maximum (the existing tab max token) with the title middle- or
end-truncated and the full title in the tooltip; when the strip overflows, tabs shrink evenly down to the icon +
close button before the strip scrolls; a tab's width does not change on hover or when its state glyph changes (the
close button's place is always reserved). Acceptance: unit test for the width model if any logic exists; screenshots
of one short tab, several tabs, and an overflowing strip; `width-stability.mjs` covers hover and state change of a tab.

## Decision 84 — fields in a row share one baseline; local review is a list, not a form

Owner (screenshot of "Review a local branch"): "not aligned at all, and as a separate element it is not pretty".
a. **Rows of fields.** Built once as `primitives/FieldRow`: labels on one line, controls on one line (same height,
   tops aligned), hints on a third line under the whole row — a hint under one field never pushes that field or its
   neighbours; a button in the row is aligned to the controls, not to the labels. No field row is laid out by hand.
   The spacing audit checks that the controls of a `FieldRow` have equal `top`.
b. **Local branches are a view of the picker**, not a block under it: the review picker's view tabs (decision 82)
   are "Pull requests · Local branches". The Local branches view lists the folder's branches, the current one first:
   name, ahead/behind the base, last commit time and subject, "current" mark; a row opens the review of that branch
   against the base. The base is one quiet menu in the list header ("against main ▾", default: the repository's
   default branch); no free-text inputs. A branch with nothing ahead is dim and says "no changes".
c. Needs from the harness: `GET …/review/branches?folder=&base=` → `{base, default_base, branches:[{name,current,
   ahead,behind,commit:{sha,subject,date}}]}` read with git only (no network). If it is absent the view shows the
   current branch only.

## Decision 86 — who spent what: tokens per model, per project

Owner: "we need to see which model consumed how much per project — tokens, I mean". The harness already answers
`GET /v1/usage?group=model&project=<id>`; the UI did not show it plainly. Rules:
a. The project's Usage tab opens on **By model** (view tabs of decision 82: By model · By agent · By day · Limits):
   one table, one row per model or agent-model (`Claude Code · opus`, `claude-sonnet-…`), columns Input · Cached ·
   Output · Total tokens · Requests · Cost (a flat-rate agent shows "≈ $X on your subscription", decision on usage
   contract) · share bar; sorted by total, a totals row, numbers tabular and right-aligned, full values in the
   tooltip, compact (12.4k / 3.1M) in the cell. Role rows (completion, summary, classifier) are listed under the
   model that ran them when "Show roles" is on.
b. Period control: This session · Today · 7 days · 30 days · All (default: All for the project).
c. The same table for **all projects** in Settings → Usage and budget, with a first column Project (group
   `project`, expandable to its models).
d. In the conversation, a finished turn's meta line gains "model · in / out tokens" (quiet, decision 75: one line,
   no new card), and the status bar's budget item tooltip lists the top three models of the project.
e. Export: "Copy as CSV" of the visible table.
Acceptance: view-model tests (sorting, totals equal the sum, flat-rate cost text, compact formatting incl. Russian
locale off — English only), screenshots at 1440×900 and 390×700 (below the list floor the table becomes rows with
the three token numbers under the model name), the spacing audit state.

## Decision 87 — the composer does not glow

Owner: "remove the glow around the prompt input, it does not look good now". Revises decision 45 (a): while the
orchestrator works the composer keeps its normal hairline — no blurred halo, no coloured or animated edge, also not
for a failed turn (decision 81). A running turn is shown by the Stop button, the live activity line and the tab's
state glyph. Decision 45 (b) (the thin streaming line in the transcript) is unchanged. As built: the three CSS rules
that revealed the aurora frame are removed; the now-unused frame elements and `useAuroraState` are to be deleted
with the next change to `Composer.tsx`.

## Decision 88 — `/context`: the whole context window, itemised

Owner (screenshot of a coding agent's context report: a bar, categories with tokens and percent, expandable groups
that list every tool and every memory file): "it would be good to see this information too". Extends decision 65.
a. **Where.** `/context` (B11) and "Open context details" in the context popover show the same report: as a card in
   the conversation for the command (not sent to the model, not stored as a message; dismissible), and as the
   Context view of the Memory tab.
b. **Header.** "Context window  347.9k / 1M (35%)" with the stacked bar; "≈" before estimated numbers; the model or
   agent the numbers are for.
c. **Categories**, one row each with colour key, tokens and percent of the window, in a fixed order: Messages ·
   Tool results · Tool definitions · MCP tools · Skills · System prompt (briefing) · Instruction files · Notes index
   and pinned notes · Memory (facts, tasks, carried summary) · Sub-agent definitions · Reserved for the answer ·
   Compaction buffer · Free space. A category with nothing is not shown. Rows that are not in the window but
   could be (deferred tools, notes bodies, memory files not loaded) are listed below a hairline as "Not loaded" with
   "—" for percent.
d. **Groups open** to their items, largest first, each with tokens: every tool by server (`server · tool`), every
   instruction file by path, every pinned note and the index, every memory file, each skill, each sub-agent
   definition; messages open to "user requests / assistant text / thinking" totals and the five largest messages
   with "Open". Long groups show ten and "Show all N".
e. **Actions** in the report, each next to what it affects: Compact now (Messages), "Turn off" for an MCP server or
   a skill where the project can do that (link to the setting otherwise), Unpin (notes), Open (files).
f. **For an ACP orchestrator** the agent owns its window: the report shows what the agent reports (used / window)
   and, itemised, only what the harness itself sends it (recap, instruction pointers, MCP tools the harness
   exposes, notes index); the rest is one row "Inside the agent — not itemised by <Agent>".
g. Harness: `GET …/context` gains `items` on each category (`[{id,label,tokens,group?,path?,server?,loaded:boolean,
   actions?:[…]}]`), `not_loaded:[…]`, `buffer_tokens`; token estimates use the existing estimator and are marked
   `estimated`. Sums: items of a category add up to the category; categories add up to `used_tokens`.
Acceptance: harness tests for the sums and for each item kind (tools incl. MCP by server, instruction files, notes,
memory, skills when present), the ACP variant; UI view-model tests (order, percent rounding to one decimal that
sums to 100 with Free space, "Show all"), screenshots dark and light at 1440×900 and 390×700.

## Decision 89 — Providers is a list and a detail, not a column of cards

Owner (live screenshot of Settings → Providers): "everything on this page is crooked". What is wrong: rows of
different heights because reasons wrap inside them; three different buttons at three different x positions
(Connect / Details / How to connect); a narrow centred list with a small card floating beside it; six agents that are
not installed taking most of the page; environment-variable text in a row. Rules:
a. **List–detail (decision 66), full settings width.** Left: the list, fixed column. Right: the detail pane fills
   the rest, top-aligned with the list, same hairline frame — never a floating card.
b. **Rows are one height.** Provider mark, name, and one status on a second dim line: "Ready · 16 models" /
   "Not logged in" / "Not installed" / "Not connected" / "Experimental" (dim word after the name when the launch
   command is unverified). Nothing else in a row: no reason text, no button. The whole row selects; the selected row
   uses the standard list selection. A small state dot at a fixed x.
c. **Groups.** "Connected" (ready), "Needs attention" (not logged in, error), "Not set up" (not installed, not
   connected) — the last group is collapsed to one row "6 more agents can be added" when something is connected.
d. **Detail pane**, in this order: title row (mark, name, state, one primary action for the state: Connect /
   How to connect / Check again; "Use anyway" quiet next to it when offered); the reason in plain words with the
   command to run in a copy line (never "set ANTHROPIC_API_KEY" as prose — an API key is a field in this pane);
   "Models" — count, last refreshed, Refresh, the list folded after six; "Preferred model"; "Roles" as one
   `FieldRow` grid (Fast · Balanced · Deep in one row at wide, stacked at narrow) with the explanation under the
   whole row; "Billing" (subscription or per token) one line.
e. Below the list–detail floor the page is the list alone and a row opens the detail with a back control.
f. Same structure for Settings → Agents if it lists the same things; one of the two pages must go if they overlap
   (report which fields each has).
Acceptance: view-model tests (grouping, the collapsed row, primary action per state); screenshots dark and light at
1440×900, 1100×700, 390×700 with the owner's set (Claude Code 16 models, Copilot 7, Grok 4, Codex ready without
models, OpenCode 12, Antigravity experimental, five not installed, API not connected); spacing audit state: all rows
equal height, no button inside a row, detail's top equals the list's top.

## As built — whole-screen review and project commands in the top row (decisions 78, 68, 83, 84)

- **Maximise (78).** `state/workspace/maximise.ts` (tested) keeps the maximised group as a plain group id next to the layout; the
  layout (sizes, tabs, active tabs) is never touched, so the other groups are only `hidden` (not unmounted: scroll, drafts and widths
  come back as they were). `maximisedGroup` says when it still means something: the group exists, holds the focus, the dock is not
  narrow. `Ctrl/Cmd+Shift+Enter` (`useTabKeys`), a double-click on a tab, "Maximise" in the tab menu and the palette's "Maximise tab"
  toggle it; focus leaving the group (a tool opened elsewhere) ends it in `commit`. While it is on, `dock/MaximiseEffects` (lazy)
  closes the sidebar (and gives it back when it ends, only if it was open) and handles Esc in the bubble phase: only when nothing
  consumed the key, no menu or dialog is open and the caret is not in a text field. The strip of the maximised group offers a quiet
  "Restore the layout" button (it lives in the lazy `commands/ProjectCommands` chunk: the initial bundle has no room for it). Opening a
  pull request from the picker maximises the Review tab, "back to the list" restores (`ReviewTab`). Narrow mode: maximise is a no-op
  (one strip already). Width floors are untouched (the maximised group's `minWidth` is 0 only while it is alone).
- **Project commands in the top row (68).** Pinned commands (at most two, hidden below 1024px) and a "Run" menu (all commands, then
  "Edit commands in Settings") sit before the project actions of the last strip (`commands/ProjectCommands`, mounted lazily by
  `dock/TabStrip`; the spinner has its own fixed place so a run starting never moves the strip). A run opens a "Run: name" tab (tab
  kind `run:<name>`, `layout.runTab`; pruned when the command is removed or renamed) that is the review's `RunPanel` filling a tab
  (`RunPanel tab=name`, `commands/RunTab`, lazy). The tab shows the state glyph only while running ("working") or after a failure.
  Shared state: `lib/projectRunsStore` (one external store per project, the commands feature's `RunsState`), fed by the lazy
  `commands/ProjectRunsFeed` (list once, then `command.*` events); the initial bundle only learns `runStatuses` (via
  `WorkspaceValue.setRunStatuses`). The status bar shows "N running" (running project runs, opens the newest run tab). Runs of a
  review are not counted. Start errors open a small dialog with the sentence and a next step.
- **Review leftovers.** The review header renders run/check-out once (a row of its own below `sm`, by order and basis). Renaming a
  command in settings renames it in the review's offered list (`renameOffered`, tested; `settings/CommandsSection`). `spacing-audit`:
  scenes `review-open`, `review-branches`, `command-dialog`, and a new rule `field-row`; `width-stability` also checks tab hover and a
  run tab changing state.
- **Tabs (83).** A tab is as wide as its icon, title and (reserved) close place need, up to `TAB_MAX` 200 with the title truncated by
  CSS and the full title in the tooltip; the strip shrinks tabs evenly (flex) down to `TAB_MIN` 56, and only then scrolls
  (`tabsOverflow`, tested). `tabSizing` and the icon-only mode are gone. Applies to every strip.
- **Field rows and local branches (84).** `primitives/FieldRow` (labels, controls, hints on three grid lines; `data-field-row`,
  `data-field-control`); used by the command form (Name, Folder). The picker has two views, "Pull requests" and "Local branches"
  (tab row built in `PullList.tsx` because `ViewTabs` does not exist in this base; the coordinator unifies). `review/BranchList`
  lists the folder's branches (current first, one 40px line each: name, "current", ahead/behind, subject, time; dim "no changes"),
  one base menu "against main"; a row opens `source: local, base, head`. `LocalBranch.tsx` (the form) is gone. Without
  `listReviewBranches` only the current branch shows. `agent-client` declares `ReviewBranch`, `ReviewBranches` and the optional
  `Bridge.listReviewBranches?(projectId, {folder, base})`; the HTTP implementation is the harness executor's (not here); the demo
  bridge implements it with five branches.
- **Bundle.** Initial JS 155.63 kB gzip (budget 155.90, not raised): the tab menu, the project actions menu, the resize divider, the
  maximise effects, the commands and the run tab are lazy chunks.
- **Verified:** Chromium via Playwright against `?demo=1`, dark: maximise at 1440x900 and 1100x700 (the other group `hidden`, the
  sidebar closed, Esc / the shortcut / the restore button put everything back, no console error), the top row, the Run menu, a run
  tab running and failed, "1 running" in the status bar, tabs (one, several, 900px), the branches view at 1440x900 and 390x700;
  `width-stability` ok at 1440x900 and 900x600 (including tab hover and a command running then ending); `spacing-audit` scenes
  `review-open`, `review-branches`, `command-dialog` at total=0. **Not verified:** WebKit, light theme, a real harness (the HTTP
  bridge's `listReviewBranches` does not exist yet), the full `spacing-audit` of every scene on this tree if the gates note says so,
  Esc inside Monaco (it keeps its own Esc), sidebar behaviour on a window narrower than the drawer breakpoint.

### As built — decision 89 (Providers is a list and a detail; 2026-11-12)

- **Layout (a, e).** `settings/ProvidersSection` is a list column (`ProviderList`, 288px) and `ProviderDetail` filling the rest
  at the full width of the settings page (`isWideSection("providers")` drops the 780px column), top-aligned, same hairline
  frame. The floor is a container query (`@3xl`, 768px of the section, not the window): below it the page is the list alone, a
  row opens the detail, "← Providers" goes back.
- **Rows (b).** One height (40px, `data-row`): state dot at a fixed x, 16px mark, name (+ dim "Experimental"), one dim status line
  ("Ready · 16 models", "Not logged in", "Not installed", "Not connected"). No reason text, no button; the whole row selects.
- **Groups (c).** Connected · Needs attention · Not set up (`lib/providers/view.ts`, `providerGroups`). With something connected
  "Not set up" is one row "6 more providers can be added" ("agents" when all are agents); opened by the row, or when it holds the
  selection; "Show fewer" folds it again.
- **Detail (d).** Title row (mark, name, state, "Experimental", the state's one action), then in order: reason in plain words with
  the install / login commands in copy lines (a hint with no command shows as prose), the API key field (API only), Models (count,
  "updated 2h ago", Refresh, folded after six with "Show all N", `models_error` / `models_note`), Preferred model, Roles as one
  `FieldRow` (three in a row at wide, stacked at narrow, explanation and "Saved" under the whole row), Billing (one line).
  Actions: not-connected API / router: "Connect" (focuses the key field); agent not installed / not logged in / error:
  "Check again" (the steps are in the pane, so "How to connect" became the pane itself). "Check again" calls
  `bridge.recheckProvider?.(id)` when the bridge has it, then re-reads the providers.
- **API key.** A write-only field in the API provider's detail (`ProviderKey`, `SecretForm` moved to `components/shared`), through
  the existing settings API; "Remove key" with a confirm. The router's switch, URL and upstream key stay folded below the page
  (`RouterSettings`).
- **`FieldRow`** (`primitives/FieldRow.tsx`, decision 84 a): a grid of two-row subgrid cells (labels on one line, controls on one
  line with equal tops, hint and status on a third line under the whole row); the stacking is a container query.
- **agent-client.** `Provider.experimental?` and `Bridge.recheckProvider?(id)` declared additively (the harness work adds the
  implementation). "Use anyway" is not built: its call (`force_unverified`) is not in this base.
- **89 f — do Providers and Agents overlap? Yes, completely.** Agents showed, per agent: state, the reason, install and login
  commands, the model list with the default, "Check again". Providers showed state, a button, and the preferred model and roles.
  The new detail has every one of those fields, so **Settings → Agents is removed** (nav entry, section, search rows); `#/settings/agents`
  opens Providers; its search keywords moved to the Providers row.
- **Demo.** `?providers=owner` is the owner's live set (twelve providers); the default demo set is unchanged.
- **Not running (2026-11-18).** A status must be true: Ollama read "Ready · 4 models" with nothing on `:11434` (its list is a
  catalogue). The harness now probes Ollama, and the API on a local base URL (providers.md, "Reachability"); a server that
  does not answer is state `not_running`: row "Not running" in the warn tone under **Needs attention**, the detail's reason
  "Ollama is not running. Start it, then check again." with a **Start** step (`ollama serve` as a `CommandLine`) and the one
  filled "Check again" (`POST /recheck` probes now), the same row, title and step primitives as an agent that is not
  installed or not logged in. The Editor's inline-completion row says "Cannot run: Ollama is not running…" with "Check
  again", and `canRun` keeps refusing `small` / `ollama:<tag>` (the main model picker never lists Ollama). Demo:
  `?ollama=down` (with `?recheck=ok`, "Check again" starts it).
- **Verified.** View-model tests (`lib/providers/view.test.ts`: grouping, the folded row, primary action per state, row status,
  model folding); `settingsIndex` tests; tsc for ui and agent-client; eslint on the touched files (no new warnings); prettier;
  spacing audit states `providers` (1440, 1100, 390) and `providers-open` and `settings-page`: total=0, including the three
  checks of the acceptance (rows equal height, no button in a row, detail top equals list top, FieldRow control tops equal);
  `width-stability.mjs` ok; screenshots dark and light at 1440×900, 1100×700, 390×700; console clean.
- **Not verified / not run.** Production build, bundle check and whole-repo test runs (the coordinator runs them at merge; one
  timing test in `streak.test.ts` fails under load, unrelated). "Check again" and "Refresh" against a real harness; the
  `recheckProvider` path (the demo bridge has no such method, so the demo re-reads the list). Keyboard roving in the list uses
  the shared `useRowKeys`; not exercised beyond that.
### As built — decision 88 (harness)

Harness and agent-client side of (g), with what (a)-(f) need from the data. Exact JSON: `apps/harness/docs/parity.md`, "Itemised report".
- `GET …/context` gains `items` on every category, `not_loaded`, `buffer_tokens` and `largest_messages`; old fields are unchanged. Two categories are new
  (`mcp_tools`, `agents`); `system` no longer counts the delegation note. Code: `internal/orchestrator/context_items.go`; the route serialises the report.
  `tools.Def` gained `Server` (set by `tools/remote`) to name tool servers. agent-client types: `ContextItem`, `ContextLargeMessage`, `items?`/`actions?` on `ContextCategory`.
- Sums are tested (`context_items_test.go`, bridge test): items add up to their category, categories to `used_tokens`, in full and window mode, for a sub-agent
  with tool-server tools, and for an ACP orchestrator (reported and unreported).
- Not built: skills (the harness has none), a per-tool "Turn off" (no setting exists, so no action is offered), notes index/pinned notes (extension point
  `notesItems()`), a compaction buffer (always 0), thinking tokens (always 0). Not verified: any real model or agent (mock model and scripted ACP agent only); the UI.
## As built — decision 86

Built in `packages/ui` only (no harness change). Usage tab, Settings and the pure helper are done. **Wired in batch 3 (2026-11-12):**
the newest finished orchestrator turn's footer ends with `turnLine` ("model · 12k in / 3.1k out"; `chat/useTurnLine.ts` reads
`last_request` of the context report once when a turn ends and once on mount, because the harness keeps usage per request, not per
turn: older turns say nothing, and a harness without the report leaves the line out); the status bar's budget tooltip adds the top
three models by tokens (`topModelLines`, now in `lib/usage/modelLines.ts` so the entry bundle does not import `lib/usage.ts`), read on
the first hover or focus. Not verified with a live harness.

- **View model** `lib/usage/model.ts` (tests beside it): `usageRows` (sorted by total, ties by label; `key-desc` for days; each
  row's share of the table), `usageTotals` (the sum of the rows shown, so it always equals them), `rowCost` / `costCellText`
  (spend, "≈ $X on your subscription", "$X + ≈ $Y subscription", "no price"; an older harness that put a subscription's
  equivalent into `cost_usd` is read as no spend), `placeRoles`, `periodRange`, `chartDays`, `usageCsv`. **Cached = cache read +
  cache write**, so Input + Cached + Output = Total. `lib/usage/turnLine.ts`: `turnLine({model, inputTokens, outputTokens})`
  → "opus · 12k in / 3.1k out" (a figure not reported is left out, never 0) and `topModelLines(buckets, name, 3)` for the status bar.
- **Usage tab** (`components/usage/`): view tabs By model · By agent (By project for all projects) · By day · Limits on one full-width row
  with a hairline under it (a pseudo-element, so the active underline sits on it); a local `ViewTabs` (`items`, `value`,
  `onChange`, plus `label` and an `aside` for the period menu) stands in for decision 82's primitive. The period and scope menu is
  This session · Today · 7 days · 30 days · All (default All) / This project · All projects, and "Show roles" (By model, one
  project). The tab's remembered view is `{segment, period, scope, roles}`; an older stored shape fails validation and falls back
  to the default. The old Tokens and Cost segments are gone: cost is a column.
- **Table** `components/shared/UsageTable.tsx` (shared by the tab and Settings): Input · Cached · Output · Total · Requests · Cost ·
  share bar, totals row, tabular right-aligned numbers, full values in `title`, "Copy as CSV". Below 36rem of its own container only
  Total stays a column and the three token numbers and the cost go under the name. A `~` before Total marks estimated token counts.
- **Roles**: the harness has no model × role report, so with "Show roles" the agent report is joined to the model report through the
  project's agent records (`served_model ?? model`); roles of the same name under one model merge; agents that no longer exist are
  named in a line under the table ("Roles without a known model").
- **Settings → Usage and budget** (`settings/UsageByProject.tsx`): "Usage by project" table (`group=project`) with a period menu; a row
  opens to its models (`group=model&project=`, read when opened).
- **"This session"** is usage since the window opened (`SESSION_STARTED_AT`); the harness has no per-session report.

Verified: `lib/usage/*.test.ts`, `usageView.test.ts`, `pnpm --filter @octo/ui test` (429 pass; one run failed once under load and passed
on the rerun); `tsc --noEmit`; eslint and prettier on the touched files; the spacing audit (total=0 after moving the tab underline off a
negative margin); `width-stability.mjs` (1440×900 ok); Playwright screenshots (dark and light, 1440×900 and 390×700) of By model with a
flat-rate agent row and an API row, roles shown, By agent, By day and the Settings table expanded, console clean. Not verified: a live
harness (demo data only); the production build, the bundle check and whole-repo gates (left to the merge); the chat turn line and the
status bar tooltip against a live harness (wired in batch 3, demo only); decision 82's primitive (the local `ViewTabs` is a stand-in).
## Decision 85 — opening a file changes nothing but the editor's content

Owner (macOS, WebKit, third report): "opening files jerks the sidebar with files and the window itself". Causes found in
the code, not in a browser quirk: every File tab was its own `FileView` (own tree column, own overlay state, own Monaco),
so a file opened from the tree mounted a second tree (scroll back at the top, the narrow-view tree closed itself on a
pick: "the tree hiding after a file opens"), a second Monaco, and the skeleton drew a tree column the real view then
moved to an overlay after a `ResizeObserver` tick (a second layout step).
Rule: clicking a file changes exactly two things, the editor area's content and the selected row.
a. **One file view per group.** All of a group's file tabs (the Files tab and every File tab) render through one mounted
   `FileView` (`dock/Dock.tsx`, `useFileShellTab`); only its `tab`/`fileKey` props change. Tree column, overlay state, tree
   scroll and the Monaco instance survive every open. Monaco swaps models (layout effect, so the old text is never painted
   for the new file); the empty view, the loading skeleton, a message and the Markdown preview are covers over the same box.
b. **The tree never hides because a file opened.** The overlay tree (narrow views) is closed only by the user (toggle, Esc, a
   click outside). The tree list scrolls to the selected row only when that row is outside the viewport (`block: "nearest"`).
c. **The shape comes from the layout state before paint.** `lib/treeLayout.ts` decides column vs overlay from the view's
   width; the view and `FileViewSkeleton` both measure in a layout effect (no unmeasured first frame) and call it, and the
   skeleton carries `data-file-bar` / `data-editor-area`, so the first file of a project (the group is created) is ONE layout
   change, and the real view replaces the skeleton without any.
d. No layout transition runs on a pane because a file opened; the breadcrumb row is `h-bar` always.
Acceptance: `packages/ui/scripts/file-open-stability.mjs` samples every frame from before the click until 600 ms after, for
opens from the tree (narrow, 400-column, one-line, source, too-large file; tree scrolled), a chat link, the palette and the
Changes tab, at 1440×900, 1100×700 and 900×600: every pane box and the tree's scrollTop equal the pre-click frame (the first
open and the Changes tab's re-show: one step), no running geometry animation on a pane, no horizontal scroll.

### As built — decision 85 (2026-11-12)

Built as described. Before the fix the script failed in Chromium at 1440×900: the tree column (`1151,81,280,794`) vanished
from the frame +1096 ms after the first click and its scrollTop (373) was lost, and the first file link took three layout
steps. After: `file-open-stability: ok` at 1440×900, 1100×700 and 900×600 (Chromium). Per-frame JSON of both runs is kept by
the executor, not committed. Not verified: macOS WebKit (the owner's live run); Playwright's WebKit is not installed here.
A tab-strip width transition of the dock's tab (`Tab.tsx`, decision 83) still runs when a new file tab appears; it is the strip's
own, not a pane's, and the script reports it as a note. Monaco's own horizontal scroll is Monaco's.
## Decision 90 — one component library

Owner: "check that all components are unique, extended rather than repeated, not duplicates of each other; if the UI's
consistency is at the level of a UI component library the whole UI will be tidier" and, after reading the ten worst groups
of `docs/superpowers/research/2026-11-12-ui-component-audit.md`: "fix this". Problem: 130 native controls outside
`primitives`, 27 feature-local components with a primitive's job, 132 repeated class runs, 62 hand-written touch sizes, and
one pixel size spelled two ways.

a. **The rule.** A feature composes primitives; it never styles a native control. `<button>`, `<input>`, `<select>`,
   `<textarea>`, `<dialog>` appear only inside `components/primitives` (lint `octo/no-native-controls`). A feature file holds
   layout classes (flex, grid, gap, its own container's padding, width) and no control look: no colour, border, radius,
   hover, focus, height or text size of a control. Where a look is missing the primitive gets a variant; the feature never
   copies. `className` on a primitive is for layout (margin, width, flex, position), not for colour, height or radius.
b. **Adding a variant.** Look for the nearest primitive; add the variant or size next to the others (a `Record<Variant, string>`
   entry with the decision number); add the case to the gallery (`primitives/Gallery`, `?demo=1&gallery=1`) in the same
   commit; migrate the callers you know. A superseded export stays as an alias marked `@deprecated` until the sweep.
c. **One size scale.** Controls are xs 24, sm 28, md 32, lg 40 (`lib/controls.ts`; tokens `--spacing-ctl-*`). `h-6`/`h-chip`,
   `h-7`/`h-row`, `h-8`/`h-row-nav`, `h-10`/`h-bar` are the same pixels (the older names are aliases of the new tokens);
   new code writes `ctl` names only, inside a primitive. Radius: 6px for xs-md controls and rows, 8px at lg, 8px fields and
   cards, 10px overlays and grouped frames, `full` only for switch, round buttons, bars and dots. Fields share one focus
   treatment (the border turns `fg`, no ring) and one look (`FIELD`); rows use `focus-inset`; the rest use the global ring.
   Borders are neutral (`line`, `line-strong`, `input-border`, `panel-edge`); never `warn`/`err`/`accent` except
   `aria-invalid` and the focus ring (decision 81). Icons: `Glyph` 14 or 16; label gap 6px in buttons, 8px in rows.
d. **Touch.** Under a coarse pointer or a window below 768px (`touch:` variant) every control has a 40px target, written once
   inside the primitive: buttons, icon buttons, chips, checkboxes and switches keep their look and gain an invisible 40px hit
   area (`touch-hit`); fields, selects, search fields and list rows really become 40px tall (their text is 16px there). A
   feature never writes `max-md:h-10`.
e. **The set** (each documented in its header comment: purpose, props, variants, sizes, when not to use it): `Button`,
   `IconButton`, `Chip`, `TextField`, `TextArea`, `Select`, `SearchField`, `Checkbox`, `Switch`, `Field`, `ListRow`,
   `ListFrame`, `SectionHeader`, `ScrollArea`, `Notice`, `Card`, `Skeleton`, `KeyHint`, `Spinner`, `EmptyState`. Reserved for
   other batches: `ViewTabs`, `FilterTabs`, `FieldRow`. Not yet built: `RadioGroup`, `SelectButton`, `Badge`, `Loading`,
   `Toolbar`, `ListDetail`, `Meter`, `Dialog variant="palette"`.
f. **Acceptance.** (1) The `octo/no-native-controls` count goes from 130 to 0 across migration batches B1-B9 and the rule
   becomes an `error` in B10. (2) An audit script counts, outside `primitives`, and prints zero for: raw `h-6|h-7|h-8` on a
   `button|input|select`, `max-(md|sm):h-10`, `text-[Npx]`, `border-(warn|err|accent)` outside `aria-invalid`, runs of five
   or more utilities repeated in two files, `<kbd`, `role="alert"` elements not rendered by `Notice`. (3) The gallery shows every
   primitive in every variant; screenshots dark and light. (4) No behaviour change: the spacing audit prints `total=0`,
   `width-stability.mjs` passes, and each batch's before/after screenshots match except for the stated differences (touch
   heights, focus treatment, unified radius, quiet `danger` buttons).

As built (B0, primitives only): the primitives in (e) exist with header comments and the gallery; `lib/controls.ts`,
`lib/listRow.ts` and `lib/truncate.ts` carry the pure logic with tests; `Input`, `Textarea`, `ghost`, the old `IconButton`
(sizes sm 24 / md 28), `INFO_ROW*`/`SkeletonRows`, and `Kbd`/`Key` (in `primitives/KeyHint`) are aliases or deprecated. Verified: type check, eslint and
prettier on the touched files, unit tests, the gallery script in dark and light (control heights equal their size, no console
errors), two spacing-audit scenes. Not verified: touch behaviour on a real device (only the CSS rule), keyboard use of `Select` and
`ListRow` in a real screen reader, any feature migration (none done).

### As built — library migration B1 (Settings; 2026-11-12)

Every Settings section and the Connect sheet and screen (`components/settings`, `components/providers`) now compose the library:
no native `<button>/<input>/<select>/<textarea>` is left (`octo/no-native-controls` in those folders: 15 before, 0 after; eslint 0 errors).
`parts.tsx` keeps only `SettingsGroup` (`SectionHeader` + `ListFrame`), `SettingsRow`, `LoadErrorRow` (the one "Couldn't load X" row),
`SaveStatus` (on `Notice`), `CONTROL_W` (layout widths) and `StateDot` (the provider dot, which has no primitive); its local `Switch`,
`Select` and `SkeletonRow` are gone, as are the hand-written touch and size classes. Selects are the menu `Select` (providers' Preferred
model and roles, the models and tiers with provider groups, completion, context, diff layout, the period, the section picker below 760px);
the nav, the search results, the provider list and the plugin rows are `ListRow`; searches are `SearchField`; the plugin kinds are
`FilterTabs`; `AgentPrefs` and the command form use `FieldRow`; the provider detail is a `ListFrame` like its list.
Decision 74: only **models** exist at both levels today (the harness's `HARNESS_MODEL_*` defaults and each project's `models`), so only Models
has the scope row: `ViewTabs` "Defaults | <project name>", shown while a project exists, with a project picker when there are several. In the
project tab each of the four models says "Inherited from defaults" while it equals the default (the harness copies defaults at project creation,
so inherited means equal now) and shows "Reset to default" once it differs. Completion, context mode, budget, commands and review exist only per
project (no default level in the API) and stay per-project rows; providers, appearance, privacy and about are machine-only. Access mode, network and
the side-question model are not in Settings today. The project tab starts on the project that is open in the app (batch-4 merge: `AppShell` passes it to `SettingsPage`), else on
the most recently updated project.
Primitive fixes found by driving the gallery: the `touch` variant (comma list in one line) never matched narrow windows, so rows and fields
stayed 28-32px at 390px (styles.css); `Select` lost focus after choosing, ignored Tab, had no type-ahead, did not scroll the active row into view and
had no group headings (added `group`); disabled `TextField`/`TextArea` looked enabled; `SearchField`'s clear button dropped focus; two-line `ListRow`
was 44px and its button 36px (now 40, whole row); `ListRow` gained `expanded`; `ViewTabs` tabs were 31px (row now `box-content`).
Verified: type check, eslint, prettier, tests next to the changed logic, spacing audit (`settings-page`, `providers`, `providers-open`, `integrations`,
`command-dialog`, `usage`: total 0), `width-stability.mjs` at 1440x900, Playwright flows on the gallery and the Models scopes (project tab, long select
list, type-ahead, reset, search, narrow section select), screenshots dark and light at 1440x900 and 390x700 (no console errors). Not verified: touch
on a real device, a screen reader, the project tab on a harness (demo bridge only), the audit on the Models project tab, jumping from a search result
into a per-project row while its data still loads (focus stays on the page).

### As built — library migration B2 (Memory, Notes, Usage, Agents, Details, side question; 2026-11-12)

Decision 90's second batch, in `components/{memory,notes,usage,agents,details,side}` and `components/shared/UsageTable.tsx`.

- **`ListDetail` (decision 66), `primitives/ListDetail.tsx`.** One layout for "list left, detail right". Props: `label`, `listLabel` (also the Back control's text),
  `selected` + `onSelect(id | null)` (the owner's remembered choice), `list(select)` (render rows; `select(id)` from a row's `onClick`), `listHeader`, `detail`
  (`null` = nothing to show), `placeholder`/`empty` (the empty-detail slot, an `EmptyState`), `loading` with `listSkeleton`/`detailSkeleton`, `detailClassName`.
  A container query on the component itself (floor 640px, `LIST_DETAIL_FLOOR`): wide = a 280px list column (`w-70`), one vertical hairline that starts at the
  view-tabs hairline, each side its own `ScrollArea`; narrow = one column with a Back control, the selection remembered (the row stays marked and takes
  focus on Back; choosing it again reopens the detail), the list kept mounted so its scroll survives. Keys: ↑/↓/Home/End between `[data-row]` rows, Esc in the
  detail goes back (one column) or to the chosen row (two). Pure state in `lib/listDetail.ts` (`paneReducer`, `escapeTarget`, `isNarrow`) with `listDetail.test.ts`.
  Used by Memory (Sessions, Tasks, Files, Context) and Notes. New small primitives: `IconMenu` (an `IconButton` that opens a `Menu`: the "⋯"), `FileInputButton`
  (a hidden file input behind an `IconButton`).
- **Migration.** No native `<button>/<input>/<select>/<textarea>` is left in these folders (`octo/no-native-controls`: 29 before, 0 after). Rows are `ListRow`
  (sessions, tasks, facts, files, notes, agents, folders, outputs, activity, search hits, plan-limit agents), errors and info lines are `Notice` (the failed
  exchange is a `Notice` with a glyph, not a red sentence), loading is `Skeleton*` (`ListDetail loading` in Memory), search is `SearchField`, section titles
  `SectionHeader`, scrollers `ScrollArea`, the Usage period and scope are `Select`s above the table. `memory/parts` lost `ListDetail`, `ListRow`, `RowList`,
  `Loading`, `ErrorState` and `Empty`.
- **Polish.** Model names in meta lines use `useModelNames().name` (the exchange line reads "Sonnet 4", never `claude-sonnet-4`). Usage share bars are 4px
  (track `active`, fill `fg-2`, at least 2px wide) and "no price" is dotted-underlined with a tooltip that says why and what to do (also in the narrow detail
  line). Memory → Tasks: the `tsk_…` id moved to the "⋯" menu as "Copy id" and the "First words of the request" caption is gone (decision 75).
- **Side question (decision 64h, B13).** Question, answer and input share the conversation's column (`max-w-measure`, `--pad` 24, 16 below 560px); the input
  is the composer's frame (`octo-composer`) with a send button and a small model control (`ModelPicker`) that writes `models.side` (shown as the fast tier until
  chosen); Stop calls `stopSide` while an answer runs; `side.activity` and `side.thinking` show while it streams; `no_provider` (the typed 409 or a
  `side.error`) is one `Notice` with a "Connect a provider" button to Settings → Providers. Demo knobs: `?side=none` (409 `no_provider`) and `?side=hold`
  (an answer that stays in flight with activity and thinking until Stop).
- **Verified:** type check; eslint on the folders (0 errors; the remaining warnings are older: `autoFocus` in the note forms, `Date.now` in `NotesPanel`);
  prettier; `listDetail.test.ts`; Playwright screenshots of every screen in dark and light at 1440x900 and 390x700 against `?demo=1`.
  **Not verified:** the harness (the side question needs a real ACP agent or key), touch behaviour on a device, a screen reader on `ListDetail`'s Back/Esc
  focus moves, "Send to the orchestrator" (B13 rule 4: the composer exposes no public entry for it).
- **Gaps left for others.** `ListRow` has no `aria-expanded` (the Agents fold is a `Button`); the chat `Composer` needs a minimal-props variant to be reused by the
  side question; `SelectButton`/`Meter` are still not built (the context and limit bars stay local spans).

## Decision 91 — UI review round 1

The orchestrator's own review of the screenshots (`docs/superpowers/research/2026-11-12-ui-review-round-1.md`, 15
findings). Rules a–k are stated there in full and are part of this spec: (a) the backdrop never sits behind content;
(b) the connect screen is the Providers list; (c) one card for "this needs you"; (d) one activity row; (e) the
composer row holds at most four controls, routing policy moves into the model menu; (f) suggestions are rows;
(g) sub-agents are one quiet button at the end of the strip; (h) the queue has a header count and icon actions;
(i) the review picker header is one line and a refusal is a `Notice` of its view; (j) one vertical rhythm in the
transcript; (k) tone is carried once.

## As built — batch 3 integration (2026-11-12)

- **Scroll on send** (owner: "the chat does not scroll down when a message is sent"). Rule: sending always scrolls to the sent message and
  re-pins to the bottom, even for a reader who had scrolled up. `ConversationView` scrolls to the end when the orchestrator's request count
  grows after the first load (a rewind, which lowers it, and the first load do not count). Checked by `scripts/scroll-on-send.mjs` (fails
  without the fix: 2330 px short of the end).
- **Composer glow removed for good** (decision 87): the aurora frame elements, `useAuroraState`, the `failed` prop and the aurora CSS are
  gone; the shimmer pause rule (`[data-paused]`) stays for the activity line.
- **Bundle**: the entry measures 155.78 kB (budget 156.8). Tool lines and delegation cards are lazy chunks warmed with the Markdown chunk;
  `openLanguageServer` imports its session code on first use. Not every lazy move helps: a lazy `FloatingComposer` made the entry larger
  (extra hoisted shared chunks), so it stays eager. Measure each move.

## Decision 92 — a keyboard shortcut is never a boxed letter inside a control

Owner (review toolbar: "Viewed [v]"): "what is this strange icon". A key hint drawn as a boxed letter inside a button
or a label reads as an icon. Rules: shortcuts are shown in the control's tooltip ("Mark as viewed (v)"), in menu items
(right-aligned, dim), in the command palette and in the keyboard help — never inside a button, checkbox label, chip
or tab. Applies to the review toolbar (done), approval cards ("Allow once [A]", "Deny [D]"), and any other inline
`KeyHint`. The spacing audit fails on a `KeyHint` that is a descendant of a button or label.

## Decision 93 — Memory is redesigned: three views, one search, compact reading

Owner: "the Memory tab is fully badly designed and looks very inaccurate". The orchestrator's review of the current
screens (after M4 and library batch B2) agrees. What is wrong:
1. **Five views that are not one thing.** Sessions, Tasks, Files, Search, Context: Search is an action, not a
   place; Context (one turn's context receipt) is not memory; facts live inside Tasks where nobody looks for them.
2. **Built for a wide page, lives in a narrow pane.** Memory normally sits in a side group about 480 px wide. There
   it is a list, then "← Back", then a wall: whole answers rendered at conversation size with second-level headings
   larger than the pane's own title, so the hierarchy is upside down.
3. **Rows are bare text.** A session row is two lines of text with no state, no current mark, no counts aligned;
   it does not look like the app's other lists.
4. **Meta lines wrap raggedly** ("Today 8:28 AM · Sonnet 4 · 41s · 3 files changed" / "· 2 sub-agents · $0.18"
   starting with a separator), with "Open in conversation" floating at the right edge of a different line.
5. **Unexplained things:** chips "1" and "19" in Context, "no cap", "Content" as a label over content, an edit and a
   delete icon with no words next to a file name.

Rules:
a. **Three views** (`ViewTabs`): **Sessions** (what was asked and answered), **Knowledge** (what the project
   remembers: remembered facts, decisions, constraints, preferences, open questions; and tasks), **Files** (memory
   files). The tab opens on Sessions.
b. **One search field** above the views, always visible (`SearchField`, Ctrl/Cmd+F while the tab has focus). While
   it has text the views are replaced by results grouped by kind (Exchanges · Knowledge · Files · Notes), each hit a
   row with the match highlighted; Esc clears and returns to the view. No Search tab.
c. **Context leaves Memory.** The window report is `/context` and the context ring (decision 88); one turn's receipt
   opens from that turn's "⋯" in the conversation and from an exchange's "⋯" here, as a popover or the same report
   card — not a view.
d. **Sessions.** List rows are `ListRow` two-line: title; second line "Nov 12 · 5 exchanges"; the current session
   carries a quiet "current" mark; working sessions show the working glyph. Opening a session shows **exchanges as
   rows, not as a document**: each exchange is a row with the request on one line (two at most) and, dim under it,
   the first line of the answer and its outcome glyph (done, failed, stopped); time right-aligned. Selecting an
   exchange expands it in place: the full request, then the answer in **compact prose** (rule g), then one meta
   line, then the actions. Only one exchange is expanded at a time; the list keeps its place.
e. **Knowledge.** Sections with counts, folded by default when long: *Remembered* (newest first; each item: text,
   kind chip — decision, constraint, preference, to do — source "remembered by Orchestrator · Nov 12" as a link to
   the turn; a superseded item is folded under its successor, never struck through in the main list), *Tasks*
   (`FilterTabs` Open · Done · Dropped; a task row expands to goal, constraints, acceptance, decisions). "Add" lets
   the person write a fact themselves (`/remember`). Each item has "Forget" in its "⋯".
f. **Files.** Rows: name, one-line description, size and date right-aligned. Detail: the rendered file in compact
   prose with "Edit", "Delete" as labelled quiet buttons in the header (icons with labels, not bare icons).
g. **Compact prose for panes.** A Markdown block rendered inside a pane (Memory, Notes, Review threads, the side
   question) uses one compact scale: body 13 px, headings of every level 13 px semibold with one step of space
   above, tight lists, code 12 px, tables scroll inside; it never exceeds the type size of the pane's own title.
   Built once (`primitives/Prose` with `size="compact" | "reading"`); the conversation keeps `reading`.
h. **One meta line.** Under an expanded exchange: `time · model · duration · N files · cost`, one line, truncated
   from the right with the full text in the tooltip; never wraps; separators never start a line. Actions ("Open in
   conversation", "Context", "Forget") live in the exchange's "⋯" and, for the first one, as a quiet button at the
   end of the meta line when there is room.
i. **Widths.** Below the list–detail floor (the usual side pane) everything is one column and expansion happens in
   place — no "← Back" page for an exchange; a session opens as a page with one back control. At or above the
   floor (maximised, or a wide group) it is list–detail: sessions left, exchanges right.
j. **Nothing unexplained** (decision 75): no bare numbers, no internal ids, no labels that restate the obvious.
Acceptance: view-model tests (search grouping, one-expanded rule, meta line truncation, superseded folding);
screenshots dark and light at pane width 480, at 760 and maximised 1440, each view, search with hits, an expanded
exchange with a long answer and a table, a failed exchange, empty states; spacing audit scenes for each view; the
`width-stability` script covers expanding an exchange (the pane's width and the list's scroll position do not move).

### As built — decision 93 (Memory redesigned; 2026-11-12)

Built in `components/memory/**`, `lib/memory/**`, `components/primitives/Prose.{tsx,css}` and `components/shared/Prose.tsx`, plus the demo data.

- **a. Three views.** `ViewTabs` Sessions · Knowledge · Files (opens on Sessions). Tasks and Context tabs are gone; facts moved out of the task detail
  into Knowledge. `MEMORY_START` still accepts "tasks" (to Knowledge), "files", "sessions", "context" (below).
- **b. One search.** `SearchField` above the views; Ctrl/Cmd+F while the tab has focus focuses it; Esc clears (the primitive) and returns to the
  view. 200 ms after typing stops, from two characters; one request to the harness's memory search plus the project's notes filtered here (the
  harness does not search notes: `MemoryHit` has no `note` kind). Results are grouped Exchanges (exchange and request hits) · Knowledge (tasks,
  facts) · Files · Notes, current before replaced; the row's title is a window of the snippet around the matched word, so a one-line row always shows
  the match. Opening a hit clears the field, switches the view and opens the item (an exchange opens expanded and is scrolled to; a fact opens, with its
  earlier versions when the hit is one; a note opens the Notes tool).
- **c. Context left Memory.** An exchange's "⋯" has "Context": `ReceiptPopover`, anchored under the exchange, one line per block (name, tokens,
  "3 open tasks", "at its limit"), never ids. The window report is `WindowReport` (a sheet). "Open context details" in `chat/ContextPopover` is
  unchanged and still writes `MEMORY_START = "context"` and opens the Memory tool; `MemoryTab` reads the slot on mount and every 250 ms while mounted
  (the slot has no events) and opens `WindowReport` over Sessions. Integrator: move `ReceiptPopover` and `WindowReport` to `components/shared`, call them from
  `ContextPopover` and the turn's "⋯" directly, then delete the slot value and the 250 ms read in `MemoryTab`.
- **d. Sessions.** Rows are `ListRow` two-line: title; "Nov 12 · 5 exchanges" with a quiet "current" at the right; the working glyph on the current session
  while the orchestrator works. A session opens as a page with one back control (narrow) or beside the list (from 640 px). Exchanges are rows: outcome
  glyph (answered, failed in `err`, stopped), the request on one line, the first line of prose of the answer dim under it, the time at the right; the
  open row shows the full request only when the row cut it, the answer in compact prose, a failure's next step, and one meta line. One open at a time,
  Esc closes it and returns focus to the row, 100 ms height-only motion (`octo-mem-expand`, off under reduced motion).
- **e. Knowledge.** Remembered (newest first; folded after eight with "Show N more"; kind shown in the dim line as Decision / Preference / To do, plain
  facts carry none; the open row shows the source "Remembered by Orchestrator · Nov 12" as a link to the request, and a replaced item folded under its
  successor with "Show N earlier versions"; "Forget" in the row's "⋯", confirmed; "Add" opens a one-line form with a kind, `rememberFact`) and Tasks
  (`FilterTabs` Open · Done · Dropped with counts; a task row opens to goal, constraints, done when, decisions, outcome, what was asked, files).
- **f. Files.** Rows: path (end kept), one-line summary, "2.4 kB · Nov 8"; the detail has "Edit" and "Delete" as labelled quiet buttons and the file in compact prose.
- **g. Prose.** `primitives/Prose.tsx` exports `proseClass("compact" | "reading")` and `ProseFallback`, with `Prose.css` (13/20 body, every heading 13 semibold,
  12 px code, 28 px table rows that scroll inside their frame, all on the spacing scale). The renderer is `shared/Prose.tsx` wrapping the lazy `Markdown`:
  the layer rule forbids a primitive from importing `shared`, so the wrapper cannot live in `primitives`. The conversation keeps `octo-prose` (= `reading`).
  Not yet used by Notes, review threads or the side question (not in this batch's area).
- **h. One meta line.** `metaParts` builds time · model (readable name) · duration · N files · cost, in that order, empties dropped; CSS ellipsis cuts it
  from the right (the cost goes first), the full text is the tooltip; "Open in conversation" ends the line and hides below 380 px of pane (it is also in the "⋯").
- **i. Widths.** Verified at a 480 px pane, 760, maximised 1440 and 390 px wide. Rows put their time or size in the dim second line (`RowLine`), because
  `ListRow`'s own `meta` slot shrinks with the title and clipped a time to "9:26…"; rows without a "⋯" reserve its width (`ROW_TAIL`) so the right edge is shared.
  Details stop at 48 rem.
- **j. Nothing unexplained.** No ids anywhere (the receipt shows counts in words), no "no cap", no "Content" label, labelled Edit/Delete.

Primitive gaps worked around, to fix at their source: (1) `ListDetail` puts its root in a row with a container query on itself (`@container/ld` +
`@min-[640px]/ld:flex-row` on one element), which never matches, so the detail sat under the list at every width; Memory marks a wrapper
`@container/memory` and passes `SPLIT` as `className`. (2) `ListRow` has no `expanded` prop, so the open exchange, fact and task carry `aria-current`
instead of `aria-expanded`. (3) `ListRow`'s `meta` clips (above). (4) `Button variant="link" tone="quiet"` loses to `text-link` (specificity tie), so the quiet
links carry `text-fg-2!`. (5) `ViewTabs` here is 31 px (border inside 32); Memory passes `box-content` (the 32 px fix is on another branch; drop it after the merge).
(6) `useRowKeys` binds at mount, so a list that mounts after a load (the exchanges) uses `onKeyDown={moveInList}` instead. (7) `env.d.ts` gained `declare module "*.css"`.

Verified: ui `tsc --noEmit`, eslint (0 errors, 0 warnings) and prettier on the touched files, `lib/memory` tests (view-model: search grouping and hit targets, one-open rule,
meta line and its order, superseded folding, session row model), `spacing-audit.mjs` on five new scenes (`memory-sessions`, `memory-exchange`, `memory-knowledge`,
`memory-files`, `memory-search`; 1440, 1100 and 390 wide: total=0), `width-stability.mjs` at 1440x900 with the new memory check (pane width, sideways overflow, row position,
one open at a time, Esc), keyboard (arrows, Enter/Space, Esc, Ctrl+F), add and forget of an item, the receipt popover and the window report, in a browser against `?demo=1`, dark and light.
Not verified: a screen reader; a real harness (the demo supplies `kind`, `remembered_by`, summaries and receipts); touch on a device; Notes and review adopting `Prose`.

#### Decision 93, round 2 (coordinator review; 2026-11-12)

- **Search hits.** Line 1 is the item's own name (exchange: its request's first line; fact: its text; task: its title; file: its path; note: its title),
  the match marked when it is in the name. Line 2 is the matching passage of one field (the sentence around the first match, never across a field
  boundary: a line break in a snippet is one), or, when the match was in the name, the usual second line (a fact's task, a task's first goal sentence, a
  note's description); with nothing to say the row is one line and its date ends line 1. One hit per item (`dedupeHits`). The harness decides what a
  snippet holds; where it runs fields together without a line break the passage can still span them (the demo keeps line breaks). Tests: hit anatomy per
  kind, field boundary, dedupe, list markers.
- **Remembered by subject.** Grouped by the fact's `about` ("General" without one; a fact the harness learnt itself has none, so most real items will be
  General until the harness fills `about`); a collapsible quiet header with the count, the group touched most recently first; five items per group before
  "Show N more". Line 2 carries only the kind and "N earlier versions"; with neither the row is one line (32 px). The open row names its task ("In task ...").
- **One surface.** An open exchange, remembered item or task has the selected fill (`bg-active`, standard radius, 4 px below) behind the row and its whole
  expansion; the meta line and "Open in conversation" sit at the bottom edge inside it; collapsed rows stay flat.
- `RowLine` gained `fill` (a row's title box is content-sized, so a tail inside it only reached the right edge with `w-[100rem] max-w-full`).

### As built — batch-4 merge (library B1 + B2, Memory redesign, project sessions, M6; 2026-11-12)

The four branches were merged by the integrator and reconciled; what changed beyond the branches:

- **Primitives.** One `ViewTabs` (32 px through `box-content` inside the primitive; the callers' own `box-content` is gone). `ListRow` `expanded` is used
  by the open exchange, remembered item and task rows of Memory, the Remembered group headers and the Agents fold row (a `ListRow`, no longer a quiet
  `Button`); `selected` stays for real selections. `ListRow`'s `meta` no longer shrinks (`shrink-0`, at most 40% of the row), so a short time never clips
  to "9:26…"; one-line Memory rows (a fact without a second line, a search hit with none, a group's count) put their right-hand text in `meta` (dim,
  small, as in two-line rows); two-line rows keep `RowLine` on line 2. `Button variant="link" tone="quiet"` gets its colour from the tone, so it wins
  without `!`. `useRowKeys` rebinds when its container appears (checked on every render), and the Memory exchanges list uses it again.
- **`ListDetail`.** The container query is on an outer element and the row layout on an inner one, so the list and the detail sit side by side from 640 px
  of the component's width; Memory's `@container/memory` wrapper and `SPLIT` are gone.
- **Sessions in Memory.** The Sessions view lists main sessions (the harness lists only those) and marks `current` from the session entity
  (`state.sessions.currentId`, loaded by the project provider through `listSessions` and kept by `session.*` events); `open` of the memory session is the
  fallback while the entity is not loaded. The working glyph follows the entity's `state`. Test: `lib/memory/sessions.test.ts`.
- **Remembered subjects.** The harness gives a fact it learnt `about` = the digest's `about` or, without one, its task's title (not for the `Remembered`
  record), so the Knowledge view groups by the work instead of "General" (harness test in `internal/memory`).
- **Context.** `ReceiptPopover` and `WindowReport` are in `components/shared`. `WindowReport` is the itemised decision-88 report: per category the
  rows inside (five, "Show all N"), the compaction buffer, "Not loaded" (what loading would add, with "Open" for memory files), "Largest messages" with
  "Open"; view-model and tests in `lib/windowReport.ts`. **Follow-up for the chat executor (the file was not mine to edit):** in
  `components/chat/ContextPopover.tsx` replace `requestMemoryView(ws.memory, "context")` ("Open context details", ~line 150) by a state flag that mounts
  `<WindowReport onClose onOpenMessage={(id) => nav.requestTurn({ projectId, messageId: id })} onOpenFile={...} onOpenMemoryFile={() => ws.openTool("memory")} />`
  from `../shared/WindowReport`; then `requestMemoryView`, `onMemoryViewRequest` and the `"context"` branch of `MemoryTab`'s `startOf` can be deleted.
  Until then `MemoryTab` keeps the compatibility entry point: the `MEMORY_START` slot read on mount and, while mounted, through `onMemoryViewRequest`.
- **Settings → Models** opens its project tab on the open project (`AppShell` keeps the project while the Settings route has none).
- **Demo.** Both demo bridges implement the session methods (`listSessions`, `getSession`, `createSession`, `resumeSession`, `patchSession`): the base demo has
  one current main session and an agent session per sub-agent; the desktop demo's main sessions are its memory sessions (same ids), the open one current.
  The window report in the demo has items, not-loaded rows, largest messages and a buffer.
- The workarounds listed under decision 93's "Primitive gaps" (1) to (6) are fixed at their source by this merge.

## Decision 94 — UI review round 2

Twelve more findings (16–27) and rules a–g, in full in
`docs/superpowers/research/2026-11-12-ui-review-round-1.md` ("Round 2") and part of this spec: (a) the file tree is
a column on the left and stays — never an overlay over code; (b) errors speak the person's language, protocol
vocabulary goes to Details; (c) a pinned command carries a play glyph and looks like a button; (d) one Requests
group in the palette; (e) an agent's label, never its id; (f) narrow chat: the jump button never overlaps a card,
queued rows keep their text; (g) a shared problem is said once above the rows, one `SegmentedControl`.

### As built — decision 94b (harness), 2026-11-12

Rule b on the harness side: every error and notice a person reads has `message` (one plain sentence), `hint`, `command`, `action` (`recheck_provider`, `connect_provider`, `retry`, `open_settings`, `update_agent`; absent = none) and `details` (technical text). One catalogue, `apps/harness/internal/usererr`; the fields, the surfaces and the cases are in `apps/harness/docs/errors.md`.

- Built: the catalogue; turn errors (`turn.finished`, `project.attention`, agent rows), a notice of a completed turn (`turn.finished.notice`, the `warning:` marker stays on `error`), `side.error`, provider `reason`/`problem` and `models_error`/`models_problem`, every HTTP error body (`writeError` makes technical text `details` and sends `usererr.Generic` wording; catalogue cases go through `writeProblem`), review and code-host errors, manifest `auth.command` (`login_command`). `@octo/agent-client`: `BridgeError.hint/action/details/data`, `ErrorFields`, `ErrorInfo`, the reducer keeps the fields.
- Tests: `TestCatalogueWording`, `TestEveryConstructorIsListed`, `TestNoAdHocStrings` (allow-list `testdata/adhoc_strings.txt`), the orchestrator, bridge, providers tests updated to the plain wording, `packages/agent-client/src/errors.test.ts`.
- Run: gofmt, go vet ./..., `go test -race` for usererr, providers, plugins, project, review, codehost, bridge, orchestrator (one flaky `TestContextEndpoint` under load, green alone), cmd/harness, diag, settings, commands, mcp; `e2e-acp-orchestrator.sh`; agent-client tsc and tests.
- Not verified: `packages/ui` tsc (no node_modules in the worktree; the type changes are additive, `TurnOutcome` is a superset); no real agent CLI; agent rows do not persist `command`, `action`, `details` (no schema change), so after a restart a failed row has message and hint only; the UI does not render any of this yet.

### As built — decision 94a (2026-11-12)

The file tree is a column at the left edge of the file group and stays; nothing overlays the code (the right-hand overlay of decision 85's first cut is gone, with `FILE_VIEW_OVERLAY_BELOW` and `EDITOR_MIN_WIDTH`).

- **Column.** `TreeColumn` is a real flex column before the editor: width from layout state (default 220, 200–480), a hairline on its right edge, its own divider (pointer, ←/→ by 16, Shift 64, Home/End, double-click resets). The editor takes the rest. Width and shown/hidden are per group (`state/fileView`: `column(groupId)`); group ids are new on every load, so they live for the session and each change is also written as the project's stored default (`octo.fileTree.{projectId}`, validated codec) that groups nobody touched start from. `FileViewProvider` moved above `WorkspaceProvider` so the dock can read the columns.
- **Floors.** `groupFloor(tabs, treeColumn)` = tree width + `EDITOR_MIN_GROUP` (360) for a file group that shows its column; `groupFloors(groups, width, columnOf)` applies those while all floors fit in the dock, otherwise the plain floors (and the file views then use the page). `WorkspaceProvider` exposes `floorOf(groupId)`; the divider drag (`resize`) and `Dock.tsx` (only the group's `minWidth`: `ws.floorOf(group.id)` instead of `groupFloor(group.tabs)`) use it. `dockFits`/narrow mode still use the plain floors: a group too narrow for the column degrades to the page, it does not push the dock into one strip.
- **Page.** `lib/treeLayout.ts` decides: page when the dock is narrow (one strip) or `width - column < 360`, else column (unmeasured = column; the skeleton calls the same function). In page mode the group shows the tree or the editor (``useTreeShell``): both stay mounted and laid out in the same box, the other is `visibility: hidden` + `inert`, so Monaco, the tree's scroll and selection survive. Picking a file (or any file arriving in the view) turns to the editor; the editor bar shows a "Files" button to go back; "Show files" / "Reveal in tree" turn to the tree; in the tree page of a view with a file an "Editor" button returns.
- **Toggle.** The editor-bar toggle shows/hides the column (icon `PanelLeftClose` when shown, `PanelLeftOpen` when hidden); hidden = the editor has the whole group. One layout change in one frame.
- **Decision 85 holds:** one `FileView` per group, one Monaco; opening a file changes the editor's content and the selected row only.
- **Verified** (Chromium, demo, dev server): `file-open-stability.mjs` ok at 1440x900 and 1920x1080 (column: strict opens, column hide/show one change each, keyboard resize leaves groups/bar/strips/status untouched), 1100x700, 900x600, 390x700 (page: pick = one change, "Files" = one change, tree scrollTop restored); `width-stability.mjs` ok at 1440x900 and 900x600; `flicker.mjs` ok; `spacing-audit.mjs --only file-view` and `--only markdown-file` total=0. Unit tests: `treeLayout.test.ts`, `floors.test.ts`. **Not verified:** WebKit; pointer drag of the divider (keyboard only in the script); a project reloaded with a persisted layout where a file group starts under its floor (the floor is a CSS minWidth, so it is widened by the flex row, not tested live).

## As built — shell review fixes (91, 94)

Built in `components/{shell,home,status,project,shared,providers}`, `dock/{Tab,TabStrip}`, `commands/ProjectCommands` and the streak module.

- **91a, the backdrop never sits behind content.** `StreakLayer` is a band at the top of its positioned parent, `--octo-band-h` tall
  (`clamp(72px, 14svh, 140px)`, `styles.css`), its lower edge masked out. One preset, `STREAK_BAND` (`lib/streakPresets.ts`); the three
  earlier names are deprecated aliases of it, so Home, connect, no-projects and the empty conversation (via `dock/Dock.tsx`) share one
  placement and one angle. Home, connect and no-projects are a flex column: a spacer of the band's height, then the scroller, so a row can
  not slide under the band. The scrim rule is gone and `.octo-streak-topfade` is `display: none` (its one user, `dock/Dock.tsx`, still renders
  the element). Cards on Home are `Card` (opaque). `scripts/backdrop-check.mjs` asserts, per screen, theme and size, one band and no text-bearing
  box intersecting it.
- **91b, connect is the Providers list.** `shared/providers/ProviderRows.tsx` (the list, on `ListRow`), `ConnectDetail.tsx` (title, one sentence,
  steps, the one action: "Check again" or the key form's save) and `ConnectSteps.tsx` (lifted from `ConnectSheet`, which imports it). `ConnectScreen`
  takes no props (`AppShell` renders `<ConnectScreen />`). List and detail sit side by side in one frame from 880px of content (`--spacing-connect` is 928px); below that the list is a page and a row opens the detail as another page with a back control.
- **91g, 94c, 94d, 91k.** "N agents" is one quiet `Button` (`shell/ProjectTeam.tsx`) at the end of the strip before the commands, the working ring in a
  fixed 16px slot; it calls `useOpenSessions()` (`shell/openSessions.ts`), which opens the Agents tool today and is the one place to switch to
  Sessions. Pinned commands are quiet buttons with a play glyph (the spinner while running), after a divider. The palette has one "Requests" group
  (this project's first, then other projects' hits with the project dim on the right). Sidebar sub-lines are neutral; the status bar items are
  `StatusButton`s with one default colour, `warning` colours only the budget.
- **Run tab.** `commands/RunPanel` in a "Run: name" tab has one status line: name, state glyph, the command in dim mono, duration, Stop or Re-run; no chip and no second row.
- **94e.** No string in these folders prints an agent id.
- **Home and first run (64/75).** Home's groups, the project rows and "Agents at work" are `ListRow`s, the state tiles are one-row `Card`s (a 40px `ListRow`: glyph, label, count),
  skeletons are `SkeletonList`. The New project dialog uses `TextField`/`TextArea`, `FieldRow` for budget and delegation depth.
- **Library migration.** `octo/no-native-controls` in these folders (counting `commands/RunPanel`, not mine): 37 before, 5 after.

Verified: `tsc --noEmit`, prettier and eslint on the touched files, `backdrop-check.mjs` (dark, three sizes), the stability scripts listed in the hand-back.
Not verified: WebKit, a real harness, the Sessions list (not built), touch behaviour on a device.
Left: the folder-select button of the project dialog, `ModelPicker`'s field button, `FileLink` and the tab's own `role="tab"` button need `SelectButton`/inline-link/tab
primitives; `FolderPicker` rows follow when `Picker` moves to `ListRow` (B10).

## As built — conversation review fixes (91, 94) and B11/B12 UI

Scope: `components/chat`, `components/v7`, the new `components/shared/RequestCard.tsx` and
`components/primitives/FileInput.tsx`, `lib/errors`, `lib/slash.ts`, `lib/images.ts`, `demo/slash.ts`.

- **91c.** `components/shared/RequestCard` (in `shared`, not `v7`, because `chat/PlanCard` uses it and features may not
  import each other) is `primitives/Card` with a focusable, labelled wrapper: header glyph · title · dim "what asks" ·
  quiet meta, body, one action row (primary, quiet alternatives, destructive last). Approval, form, pending plan and the
  always-allow panel (inside the approval) use it. Two or more pending approvals in a row are one `ApprovalGroup` ("3 requests
  from Docs site", one "Allow all for this turn"); its rows are compact (title, command on one mono line, quiet buttons,
  Details fold). Failed-turn blocks are `ErrorNotice` (a `Notice` block) per 94b, not a RequestCard.
  (2026-11-18) The labels say exactly what is allowed: a card's "Allow <scope> for this request" names the one kind the
  harness remembers (`lib/v7/approval.ts` `turnScopeLabel`: "edits", "echo commands", "fetches from <host>", ACP tool
  kind; none for a memory prompt), and the group's "Allow all for this request" sends `allow_all_for_turn`, which the
  harness applies to every further request of that turn (v7 spec, As built).
- **91d.** `chat/ActivityRow` (on `ListRow`) is the one step row: glyph (spinner only while running) · verb · dim detail ·
  duration · chevron only when it opens. Used by `ToolGroup`/`ToolRow`, `ThinkingRow` and the live `ActivityLine`. Sub-agent
  rows (`DelegationGroup`) and plan steps (`PlanList`) keep their own layouts: not done.
- **91e/91f/91h/91j.** The composer row is "+", mode, model, folder; the router's tier policy is a "Routing" `Segmented` line
  under the model list (`ModelPicker footer`, only with a router). Suggestions are `ListRow`s under a "Suggestions" caption, at
  most three. The queue has a "N queued" header, the explanation once, rows with icon buttons (Send now, Stop and send,
  Remove) and a "⋯" menu below 480 px (container query); no badge on the send button (the `QueueBadge` export stays for the
  app's slot). Transcript rhythm: reply blocks 16 apart, consecutive step rows 8, the meta line tight to its reply, the
  approvals slot 16 above and between cards.
- **94b/94e/94f.** `lib/errors/plain.ts` maps codes and texts to a sentence plus a next step (check, retry, a command), and
  falls back to the first sentence with protocol words removed; `plain.test.ts` checks every string it can produce against
  `JARGON`. `shared/ErrorNotice` lays out the sentence, "Check again"/Retry/copy line and a Details fold; used by the failed
  turn, the start failure, the harness-tools warning, the send error and slash errors. The agent's label, never its id,
  comes from `agentLabelOf`/`useAgentName`; `modelName` falls back to it and the turn meta line uses the ACP labels.
  Jump-to-latest is an `IconButton round` in its own room under the transcript.
- **B11.** `/` at the start opens `SlashMenu` (portal above the box; Octo group, then the agent's under its label; fuzzy
  filter; ↑↓ Enter Tab Esc; unavailable rows dim with the reason). Octo commands run through `useSlashRunner`: compact, clear
  (`conversation.cleared` draws "New session started"), mode, model (opens the picker with the query), rewind (the last
  request's dialog), export, review, context (inline card from `getContextOverview`; no shared `WindowReport` exists),
  memory, settings, remember (`fact.remembered` draws "Remembered: …" with Undo via `forgetFact`), help. A full command
  typed with arguments runs on Enter; an agent's command is inserted as `/<name> ` and sent as typed. Notes are not stored;
  they live in the conversation's `InlineNotesProvider`. Demo: `demo/slash.ts`.
- **B12.** Paste, drop on the composer or the conversation, "+ → Image…" (`HostCapabilities.pickImages`, else `FileInput`).
  `lib/images.ts` decides (long side 2 048 px, ≤ 5 MB, ≤ 8, redraw for other types); `useImages` scales on a canvas, shows a
  chip (thumbnail, size, remove) and uploads. `accepts_images === false` is said under the chips at once; a 422
  `images_unsupported` keeps the draft and shows the Notice. User messages render `image` blocks as thumbnails that open a
  `Dialog` preview. Demo: `?images=no` for the unsupported case.
- **Migration.** `octo/no-native-controls` in chat + v7: 36 before, 12 after (kept: the composer textarea, the sticky
  prompt toggle, the rail dots, the comments popover rows, the patch toggle in `ApprovalExtras`, `TurnFiles` rows, the
  gallery demo link, the composer menu search input). Hand-written touch overrides in these folders are gone.

Verified: ui `tsc`, eslint (0 errors), `prettier`, ui tests, `flicker`, `scroll-on-send`, `frame-colours` (its approval
scene now opens the group's Details), `width-stability` at 1440×900, screenshots dark and light. Not verified: a real ACP
agent's slash commands and a real image round trip (demo bridge only); `ui-tour-states` approval steps assume single cards
and were not updated.

### As built — batch 5 integration (decisions 94a-g with the four branches merged), 2026-11-12

- **Errors end to end.** `shared/ErrorNotice` reads the harness's `message`, `hint`, `command`, `action`, `details` first (`lib/errors/plain.ts`: `plainStructured`, `isStructured`, `readable`); only a bare text with protocol words (an older harness) goes through the mapping. Buttons by `action`: `recheck_provider` → "Check again" (re-reads the login, then sends the failed request again when it was a failed turn), `connect_provider` → the connect sheet, `retry` → Retry, `open_settings` → the section of the error code, `update_agent` → command and hint only. Home rows, the sidebar tooltip, the Agents list, provider reasons (`problem.message`) show the plain sentence, never `details`. Demo data carries structured errors; `demo/userFacing.test.ts` and `lib/errors/*.test.ts` check no ACP, MCP, exit status, stderr or JSON-RPC reaches a person.
- **Window report.** The context ring's "Open context details" and `/context` mount `shared/WindowReport` (lazy, through `chat/ContextReport`); Memory has no context branch, `requestMemoryView` is gone. The report has the stacked bar and colour keys (`lib/contextView.contextKey`, free space last and dim).
- **Providers.** Settings → Providers renders `shared/providers/ProviderRows`; `settings/ProviderList.tsx` and `StateDot` are gone (`ToneDot`).
- **Activity rows** in `DelegationGroup` and `PlanList`; `ListRow expanded` replaces the sr-only text.
- **Export** goes through `bridge.exportConversation` (Authorization header, Blob URL); `exportConversationUrl` stays for the demo.
- **Primitives.** `Card`, `Checkbox`, `Select` forward refs (Card: aria/data/handlers too, `RequestCard` no longer wraps it); `FileInput` has an optional `button` and replaces `FileInputButton`.
- **Not verified / not done:** `SelectButton`, Settings → Models single Notice and project-scope menu, native controls to the target (49 warnings remain), the entry bundle is over its budget (see the hand-back numbers).

### As built — final integration pass (batch 5 + the Sessions tab), 2026-11-12

- **Sessions merged.** `ProjectItem` is a `ListRow` with the sessions chevron (`SidebarSessions`, lazy) mounted under it; `DelegationGroup` rows
  are `ActivityRow`s whose `trailing` action is "Open session"; the "N agents" button (`shell/openSessions.ts`) and every other way into the tab
  go through `requestSession`. A refusal in the Sessions tab shows the harness's `message` (and `hint`); the fixed texts by code are only the
  fallback for an older harness (`failureText`, tested). The palette has "Show sessions".
- **List semantics.** `ListDetail` names its rows container `role="list"` (the owner's `ListRow`s carry `role="listitem"`); a list the owner
  builds itself (`SessionRows`: `ul`/`li`) passes `listSemantics="own"`. The list column is no longer a landmark.
- **Settings → Models.** One `ModelsProblem` notice above a group whose models cannot run; rows show only the value. The project scope is
  chosen once: when there are several projects the project tab's label is a menu (`ViewTabs` option `menu`); the "Settings for" row is gone.
  (Settings → Commands keeps its project row.)
- **Export errors** from the project "⋯" menu show as the standard `ErrorNotice` under the top row with the harness's `message`, until dismissed.
- **Entry bundle.** The sessions model (`lib/sessions/current` stays), the error mapping (`lib/errors/words` stays; `TurnBanner` is a chunk, the
  sidebar tooltip maps through `useReadable`), provider reasons, tool vocabulary, the image canvas work, the routing line, the pills band,
  the folder menu and the "unsaved edits" dialogs are lazy and warmed after first paint: 172.99 → 163.59 kB; the 158 target is not reached
  (see `scripts/check-bundle-size.mjs`). `ErrorNotice` moved to `components/shared` so the shell may use it.
- **Browser scripts.** `width-stability.mjs` at 900×600 clicks exchanges with the DOM's `click()` (Playwright's `click()` scrolled an off-screen row
  into view and that scroll was the driver's); the tour has a `sessions` group, a palette helper that finds the search field by name, and
  selectors for the "Requests" group, the outdated-threads strip, the reply box and "Show roles".
- **Not verified:** a screen reader on the new list roles; the Models project-tab menu with a real harness; WebKit.

## Decision 95 — owner's hand test of 2026-11-13: menus, sessions, panels

a. **One popup list.** The composer's slash menu and file mention menu, the model/provider picker, the folder menu and
   every other anchored list are one component (`primitives/PopupList` or the existing `Menu`, whichever is chosen —
   one, not two): same row height, paddings, group captions, empty line, and the same keyboard contract. The active
   row is always scrolled into view (`scrollIntoView({block: "nearest"})`) when it changes by keyboard, wraps at both
   ends, and never moves by itself on hover-less mouse rest.
b. **A list that opens takes the keys at once.** Opening a picker (by click or shortcut) puts focus where arrow keys
   work without a second click; Left/Right switch its sections (providers) when it has sections; Escape returns focus
   to the opener. Test: open, press ArrowDown, the second row is active — for every picker, in a browser script.
c. **Sessions can be deleted.** A session that is not current and has nothing running has "Delete" (confirm once,
   says what goes: its transcript and its agents' sessions; memory entries made from it stay and say "session
   deleted"). The current session cannot be deleted; it can be cleared or replaced by a new one.
d. **A cleared or new session with no request is not "working".** State comes from a running turn only; an empty
   session shows "No requests yet".
e. **"New session" says what it keeps.** The action's popover states in plain words what carries over (a summary
   of the session being left, the open tasks, the project's notes and instructions) and what does not (the
   conversation itself; earlier sessions and remembered facts stay stored and searchable but are not put into the
   context by default), with a link "What it remembers" opening Memory. "New session" and `/clear` are one
   operation. The wording follows what the harness does (`apps/harness/docs/sessions.md`, "What carries over").
f. **One panel frame.** Sessions, Memory, Notes, Usage, Files list and every other tool tab share one frame
   (`primitives/Panel`): header line (title · primary action right), one filter row (`FilterTabs`, then search), list
   with one horizontal inset, one row rhythm, one empty state. Insets and gaps come from the frame, not from each
   screen; a screen may not set its own outer padding. Test: the spacing audit gains a "panel-frame" check — header
   height, horizontal inset and the gap between filter row and list are equal across all tool tabs.

## As built — review and files on the component library (B3, B5; 91i)

- `components/review` and `components/files` report 0 of `octo/no-native-controls` (19 and 14 before). File rows, folded groups, the
  "outdated threads" strip, a resolved thread, the typed-address row and "Reviews in progress" are `ListRow`; "viewed" and "suggest a change"
  are `Checkbox`; the narrow file picker is `Select`; the tree filter is `SearchField`; the comment box is `TextArea variant="bare"`; crumbs,
  the Markdown Preview/Source toggle, Retry and the problems button are `Button`; the problem rows are `ListRow`. No primitive was changed.
- Kept native, with an `eslint-disable-next-line` and its reason: `PullRow` (wrapping badge line), `BranchRow` (container-query layout),
  the comment "+" over Monaco (18px, measured position).
- 91i: the picker header is one wrapping flex line, title, repository menu, folder menu, then freshness and refresh; it holds one line from
  the container's `md` width and wraps below it. A refusal is a `Notice form="block"` tied to the view it came from (`Refusal.view`);
  changing the view clears it and the open error; the sentence starts with a capital.
- Verified (Chromium, demo, dev server): `tsc`, eslint (0 errors), prettier, `check-cycles`, `@octo/ui` tests (602), `spacing-audit` total=0,
  `width-stability`, `file-open-stability`, `frame-colours`, `ui-tour` groups review, review-b3, files at 1440x900 dark and light (0 missing).
  Not verified: 1100 and 390 widths of these groups, WebKit, touch.

## Decision 95f — one panel frame for every tool tab

Owner (tool tabs by hand): Sessions lack space, spacing differs from tab to tab, Memory and Sessions look unlike, Notes is untidy.
Rule: Sessions, Memory, Notes, Usage, Agents, Details and Changes share `primitives/Panel`; a screen supplies content and sets
no outer padding and no header of its own. Header 40 (title, dim meta, actions at the right: the single main action a
secondary `Button` sm, others quiet), at most one filter row of 36 (`FilterTabs` first, then a search), view tabs with the
frame's only hairline, list area with one inset (edges 8, text 16, top 4), rows 32 or 40, one detail header (`DetailHeader`:
Back in one column, title, meta, actions on one 28px line). Single-column bodies are left aligned at every width (no centred
columns). Measurements and screenshots: `docs/superpowers/research/2026-11-13-panel-frame.md`.

### As built — decision 95f

- `Panel`, `PanelFilters`, `PanelBody`, `PanelEmpty`, `DetailHeader` in `primitives/Panel.tsx` (gallery section, unit test with
  `react-dom/server`); `FilterTabs` chips are 24px / 8px padding and take `bare`; `ListDetail` hides its Back row when the
  detail has a `DetailHeader` (CSS `:has`, no effect) and gives the list a 4px top inset.
- On the frame: Sessions, Memory (three views and search results), Notes, Usage, Agents, Details, Changes. Not on it: the Files
  list, Review, the side question.
- `spacing-audit.mjs` state `panel-frame` opens each tab and compares header height, header text inset, list inset and list top
  gap; it names the deviating tab and reports a tab without `[data-panel]` as "not in a Panel". `panel-measure.mjs` prints the
  table and screenshots.
- Verified: type check, eslint (0 errors), prettier, cycles, ui tests, spacing audit, width stability, frame colours on the
  dev server with `?demo=1`, dark and light at 1440x900, 900x600 and 390x700. Not verified: WebKit (`:has` is supported there
  but untested), the live harness.

## As built — fixes after the UI verification of 2026-11-13

Findings and ids: `docs/superpowers/research/2026-11-13-ui-verification.md`. Each batch was checked by its executor and
again by the orchestrator with Playwright against `?demo=1` (Chromium); not verified: WebKit, a live harness, touch.

- **Batch 1a.** A14: Settings → Providers under the list–detail floor opens the detail (`@max-3xl:hidden`; `max-@3xl:` was
  not a class). A3: `Segmented` gives the first option `tabIndex 0` when no option is chosen, so a required choice can be
  reached and made with the keyboard (checked: the Deploy settings form sent with keys only). B47: `Segmented` segments and
  `FilterTabs` chips carry `touch-hit`. B64: `FilterTabs` counts are plain `fg-3`. B45: `ToneDot` is `inline-block` (8×8;
  checked in Settings → Providers, not on the connect screen). A4, B17: `lib/errors/plain.ts` maps a text to "The provider
  did not accept the key" only when it speaks of an API key; a bare 401 falls to the first plain sentence (Billing webhooks:
  "Staging rejected the webhook signing secret (401)." with Retry); key refusals carry `action: "open_settings"`. A6: only a
  `ContextRing` that is laid out answers Ctrl+Shift+U.
- **Batch 1b.** A13: the note editor and the memory file editor compare every field with what they opened with; when dirty,
  Esc or Cancel swaps the action row for "Discard changes? · Keep editing · Discard" (an `alertdialog` row, written inline in
  both editors, no shared primitive); "Keep editing" returns focus to the field that had it; clean forms close as before.
  B36: an empty Summary shows "A file needs a one-line summary" at the field. B35 (order only): the memory file editor's
  actions are at the right, Cancel then Save. A12: the Add row in Knowledge wraps, so "Remember" stays inside the panel at 347
  and 374 px. B31: a group's items are indented to the header's text line. A8: in the diff header the name takes the free
  space and truncates; below the container's `md` the counts, the folder and Revert's label are hidden (Revert is icon-only
  with a title). A7 (Changes half): the Changes list and the diff end with `FloatRoom`, so the last diff lines scroll clear of
  the floating composer. Not done: the composer over Notes, Memory and other tool tabs in one-strip mode (the rest of A7, B2).
- **Batch 1c (focus).** A1: opening the Files tool asks the tree for focus (`WorkspaceProvider.openTool` calls
  `fv.focusTree()`), and the palette runs the chosen command after it has closed and handed focus back, so a command that
  moves focus keeps it; Esc or a click outside only restores focus. Checked: after Ctrl+K "Show files" typing lands in the
  filter and the waiting approval is untouched (1440×900, 390×700). **Not changed, owner's decision:** an approval card
  still takes focus by itself and answers the single keys A / D. A2: an empty Files view that becomes visible opens its
  group's tree column (`files/useTreeShell.ts`); the editor-bar toggle still hides it. A11: `primitives/Menu` does not return
  focus to its trigger when the item's action already moved it; the rename field hands focus to "⋯" on Enter and Esc. A9:
  Esc or Cancel in the review's comment box returns focus to the review, the reply box to its Reply button; a second Esc
  still restores a maximised group (decision 78). A10: the review header's command block wraps inside a narrow group.
  Not done: B27 (play glyph in the review header). Gates after batches 1a–1c: `tsc`, 615 unit tests, eslint (0 errors),
  prettier, `file-open-stability` and `picker-keys` at 1440×900.
- **Batch 2.** A5: the end of the tab strip folds to keep the tabs `TAB_MIN` each (`state/workspace/tabStrip.ts`: `endPlan`,
  tested): first "N agents" becomes its glyph and the count (`ProjectTeam compact`; name and tooltip unchanged), then "Run"
  becomes an icon-only menu button (`ProjectCommands compactRun`). At 390×700 the tab list is 98 px (was 25). B53, partly:
  with three tool tabs in a side group "Run" folds first; the active tab still shows two characters ("Me…") — four need a
  larger `TAB_MIN` or a wider minimum for the active tab, left to the owner. B2: the chips over the floating composer are
  the new opaque `Button` variant `float` (in the gallery). A7, the rest: a tool tab that shows an editing form (note editor,
  memory file editor, Knowledge "Add") calls `useBlockFloating()` and the floating composer is not shown while the form is
  mounted. Still as before: over a tool tab without a form the composer covers the lower part of the panel at rest in
  one-strip mode (the content scrolls clear through `FloatRoom`).

## As built — polish trial, step 1: foundation (2026-11-13; one commit, revertable on its own)

Owner: "it looks unfinished, not levelled; not premium like Cursor or the Claude Code desktop app; adapt, do not copy."
The orchestrator's reading of 2× screenshots: outlines inside outlines, chrome as loud as content, a muddy light theme,
widths not set by meaning. Five rules were tried on six screens in both themes; before/after pairs were read by the
executor and by the orchestrator. **A trial: the owner has not approved the direction yet.**

- **T1, type.** Measured first: chrome was already 13px and meta 12px, so little changed. The composer's text is 14px
  (was 15), so its placeholder matches the reply; the field placeholder is plain `fg-3` (was `fg-3/60` italic, 3.3:1 —
  finding B61). Not done: fields and field labels stay 13px.
- **T2, sidebar rows.** An idle project is one 32px line: a 6px quiet dot, the name, the relative time right-aligned
  ("1h"); rows that say something (Failed, Working, No requests yet) keep two lines at 40px (`lib/orchestrator.ts`
  `projectRowLines`, tested). The time hides while the sessions chevron shows. **Departs from decision 29** (idle is a thin
  ring): only the sidebar draws the dot; Sessions and Home still show rings.
- **T3, one outline per level.** `primitives/Card` has no border: a card is one tone above its panel (`panel` is now an
  alias of `raised`); inside a card code blocks and fields take the panel's tone (`.octo-in-card`). The request bubble has
  no outline. The queue is a band inside the composer's one outline. Fields use a new `--octo-field-edge` (14 % of the
  foreground) at rest; focus still turns the border `fg`. **Departs from decision 90c** (fields named `input-border`) and is
  under 3:1 against the surface (WCAG 1.4.11): the field is told by edge plus recessed tone. Not done: `DelegationGroup`,
  the live plan box and `SentComments` still draw their own frames.
- **T4, surfaces.** Dark: window `#0b0b0b`, panel `#171717`, raised `#232323`. Light: window `#f5f5f5` (was `#ececec`),
  raised and code `#f3f3f3`, hover 3.5 %, active 6.5 %. **Differs from the visual spec's colour table** (window `#f2f2f2`,
  active 7 %), which the old values did not match either. Contrast of `fg`, `fg-2`, `fg-3` on every surface is at or above
  4.5:1 except `fg-3` on raised+active in dark (4.23:1; no screen puts a selected row on a raised card).
- **T5, widths.** Settings controls are capped at 16rem (`CONTROL_CAP`); in a provider's model list "default" is a quiet
  badge after the name.
- Gates: `tsc`, 617 unit tests, eslint 0 errors, prettier, `spacing-audit` total=0, `width-stability` ok, `frame-colours`
  ok; 390×700 looked at for the conversation and the drawer. Not verified: WebKit, touch, a screen reader on the new row.

### As built — fixes after the UI verification, batch 3 (conversation)

- B15: `ActivityLine` is not drawn when the last step row already is the current step; `ThinkingRow` shows the done tick
  ("Thought") once a tool call or text follows it. B16: step rows in a live turn are 8 apart (28 high, 36 pitch). B17,
  second half: "Check again" is `loading` (keeps focus) while it runs and then says "Checked just now — still not logged
  in" in a status line. B18: a failed sub-agent's row and the Agents row show the plain sentence of `plainError` dim (the raw
  text in the tooltip); the row's tone is the glyph's. Not covered: the agent transcript's own text. B19: while an
  always-allow panel is open "Allow all for this turn" (and "Allow once" on a single card) is secondary, and the toggle
  keeps its label with `aria-expanded`, so the row does not move. B3, in part: `lib/models.ts` `readableModelId` gives an id
  without a provider entry a readable name ("DeepSeek v4.1 Flash"); checked in the turn meta line and Usage. Not done:
  Settings → Editor still prints `claude-haiku-5-5`. Also: Esc in "Add note" closes it and returns focus; the pending plan's
  body lines up with its header. Checked at 1440×900, mostly dark; not at 390×700.

## As built — polish step 2: the frame (2026-11-13; one commit)

Owner, after step 1: "yes, continue part by part, start with the frame". Rules F1–F7 of the orchestrator's brief; pairs
of 2× screenshots (dark and light, 1440×900; 900×600 and 390×700 for the narrow states) read by the executor and by the
orchestrator. All x values are CSS px at 1440×900.

- **F1, sidebar rhythm.** Every project row is one 32px line (40 under touch): glyph at x 24, name at x 48, a right-aligned
  meta of one thing — idle and failed: the relative time; working: "N agents" or nothing; never started: "new"
  (`lib/orchestrator.ts` `projectRowLines` returns `{ meta, full }`, test rewritten on purpose). The sentence ("Failed ·
  GitHub Copilot is not logged in") is in the accessible name only: the tooltip still shows the name, because
  `spacing-audit.mjs` finds rows by the link's `title`. Nav rows, the "Projects" caption and project rows share the height
  and both edges; session sub-rows are 32; the sessions chevron sits over the meta column and no longer covers a name.
  **Replaces** the two-line rows of decision 23 and of step 1's T2.
- **F2, one idle glyph.** `lib/stateGlyph` draws idle as a quiet dot (radius 3, opacity 0.7), no ring, everywhere the glyph
  family is used (sidebar, Home, Sessions, palette, tabs). **Revises decision 29** (idle was a thin ring). The dot's
  contrast as a non-text mark: 4.27 dark / 3.13 light on the window.
- **F3, top row.** The active tab's title is medium weight (an invisible medium copy keeps every tab's width, so the width
  model of decision 83 is untouched). The end cluster is one group in the last strip: "N agents", pinned commands, Run,
  "⋯", 28px tall, gaps 4, labels on the tabs' line. "N agents" moved from the conversation's strip to the last strip
  (**departs from 91g**) and the divider before pinned commands is gone (**departs from 94c**; the play glyph stays). The
  window controls sit on the sidebar's glyph column. Known cost: in a side group with many tool tabs the tabs get about
  50px less room.
- **F4, status bar.** Left glyph on the sidebar's glyph column, last text on the panel's right edge; empty slots take no gap.
- **F5, Home.** The heading and the tiles share the cards' left edge; a tile with 0 is quiet, glyph included; "New project"
  and "N more projects" are a quiet action line under the card; "N more projects" expands the whole list on Home (with
  "Show fewer"), and Needs you / Working are never cut (B55); a project never started says "No requests yet" once (B54).
- **F6, palette.** Project rows take their glyph and meta from the live state (a failed project shows as failed); captions
  sit on the rows' text edge; an unselected `role="option"` row hovers at half strength (`primitives/ListRow`), so the
  keyboard selection is the stronger one (B58).
- **F7, narrow.** The drawer is `shell/SidebarDrawer` (a modal dialog): Tab stays inside it, Esc closes and returns focus
  (B59). "Can't reach the harness bridge" fits a 390 window (B56).
- Gates: `tsc`, 619 unit tests, eslint 0 errors, prettier, `spacing-audit` total=0 (2 skips, both the stale `tool-tables`
  step), `width-stability` at 1440×900 and 900×600, `frame-colours`, `backdrop-check`, `flicker` ok; keyboard of tabs,
  palette, sidebar and drawer checked by script. Not verified: WebKit, the macOS title bar inset, touch, a screen reader.

### As built — fixes after the UI verification, batch 4 (Settings, connecting a provider)

- B5: the connect steps render backtick spans as inline code (`ConnectSteps` `Rich`); a step with copy lines shows the lines
  and a "Details" fold with the full sentence, so commands are not repeated and an environment variable is not surface prose
  (decision 89d). Left: `KeySteps` still has an error branch "Set <ENV> in the harness's environment". B46: `Notice` (line
  form) keeps its glyph beside the first line; text and action wrap in one column. B48: `writePref` returns whether it wrote;
  On startup shows "Could not save. The browser's storage is full or blocked." instead of "Saved" (test). B49: the window
  arrows are "Previous page" / "Next page"; the Settings page's "Back" has the tooltip "Back to the app". B50: after a key is
  saved there is one message ("Saved. Applies after a restart — quit and reopen the app.") and the title says "Restart
  needed". B51: the Defaults selects in Models are 256 wide with one left edge (1440, 1100, 900). B52, in part: the project
  dialog says once above the model group which models cannot run; the values keep the warning tone (it comes from
  `shared/ModelPicker`). B3, Settings part: Settings → Editor shows "Haiku 5.5". Also: no doubled dot in the refresh failure,
  "Experimental" once, Esc disarms "Confirm remove key" before it leaves Settings, Add command opens on its first field.
  Not done: the "Choose" dialog's first focus (needs `Checkbox` to take `data-autofocus`). Not seen in the UI: the Copilot
  connect dialog from the model chip, `?refresh=fail`, Antigravity.

## As built — polish step 3: the conversation and the composer (2026-11-13; one commit)

Rules C1–C8 of the orchestrator's brief; 72 before/after pairs (dark and light; 1440×900, 900×600, 390×700) read by the
executor, a sample by the orchestrator.

- **C1, three voices.** Request and reply are content (14px, `fg`). What the agent did is one activity style (13px, `fg-2`,
  one glyph column): "Worked for Ns" is now an `ActivityRow` that heads the turn's tool rows and opens them in place.
  **A finished turn's tool rows are folded under that head by default** (open when a step failed) — a behaviour change that
  **departs from 91d / 91j**; live turns are unchanged. Time stamps, the turn's meta line and counts are meta (12px, `fg-3`).
  Not folded: delegation rounds (they link to agent sessions).
- **C2, step rows.** The chevron sits right after the row's text; the duration stays right-aligned; every activity glyph is
  14px; what a row opens is indented to its text line.
- **C3, no frames inside frames.** `DelegationGroup` and the live plan are a meta caption over activity rows, no box;
  `SentComments` and the always-allow panel are recessed tones; a block `Notice` has a tone and no outline (every block
  notice in the app; that one-line change landed in commit `b6ac876`).
- **C4, `Segmented` reads as a control.** The group has a recessed track (`--octo-seg-track`), the chosen segment a raised
  chip (`--octo-seg-on`, `--octo-shadow-seg`); keys, roving tabindex and touch target unchanged; a gallery block was added.
  **Departs from decision 33** (no track). Looked at in Settings → Appearance, the note editor, the form and the gallery;
  not looked at in Review, Memory's Add row, the project dialog, Routing. Quiet buttons inside a card hover one step stronger.
- **C5, form card.** One left edge for labels, fields, the Region track and the lock note; label → field 6, field → next
  label 16; field text 14 in a conversation form.
- **C6, composer.** Text 14; the control row's items 28 tall on one centre line with gaps of 4; the context ring is a pie
  gauge (rim + filled wedge, amber from 80 %), no longer an arc that reads as the spinner; the top padding of a long prompt
  stays while the text scrolls. Not done: one icon size in the row (chips 14, icon buttons 16 — fixed inside primitives).
- **C7, markers.** Time separators use the compacted / rewound style: meta text centred on a hairline, 32 above, 16 below.
- **C8, light.** The same states were read in light; no light-only token moved apart from the segmented and hover tokens.
- Gates: `tsc`, 619 unit tests, eslint 0 errors, prettier, `spacing-audit` total=0 (2 skips, the stale `tool-tables` step),
  `width-stability` (1440×900, 900×600), `frame-colours`, `flicker`, `scroll-on-send`, `picker-keys` ok; approvals, the
  form (Region by Tab and arrows), always-allow, the head's Enter, Check again and the queue driven by script. Not verified:
  plan approve and rewind by script, WebKit, touch, a screen reader.

### As built — fixes after the UI verification, batch 5 (popup lists; decision 95a/b)

- B6: one Home/End rule in `primitives/popupNav.ts` (`popupListKey`, `popupMove`, tested; the contract is in its header): in a
  list fed by a text field (slash, mention, "+", pickers, the palette) Home/End move the caret and Ctrl/Cmd+Home/End jump to
  the first/last row; in a list with no field (`Menu`) plain Home/End jump. B7: an open `Popover` keeps Tab and Shift+Tab
  inside it and closes when focus leaves it (every popover: model picker, context, problems, pending comments, `Select`);
  `Menu` moves between items on Tab; Tab accepts the active row only in the slash and mention menus. B8: `Menu` rows have the
  16px leading slot (text at x 32) and are 40 under touch like `PopupList`, whose max height is computed from the row token
  (9 whole rows at 390 instead of 6.3). B9: the slash and "+" menus close on window resize, as `Menu` and `Popover` do.
  B12: the composer highlights only a command at the start of the text, from the list `slashRun` runs
  (`OCTO_COMMAND_NAMES`); agent commands are not highlighted yet. B13: in the model picker an unverified row keeps
  "Check again" only and shows the full name ("Use anyway" is in the connect sheet the row opens); the state text is what
  truncates now ("Not logge…"). B10: `/remember` shows "Remembered: … Undo" from `rememberFact`'s answer (the desktop demo's
  `withDemoMemory` never emitted `fact.remembered`); a harness that also sends the event still gives one line.
  Checked: `picker-keys` ok, part 3's key script at 1440×900 dark and 390×700 light. Not verified: popovers other than the
  model picker, the folder picker and the context popover; touch (a resize from an on-screen keyboard would close the menus).

## As built — polish step 4: files and the editor (2026-11-13; one commit)

Rules E1–E7 of the orchestrator's brief; before/after pairs in dark and light at 1440×900, 900×600 and 390×700 read by
the executor, a sample by the orchestrator.

- **E1, editor bar.** Navigation · crumbs · status words · the language server · one right-hand group of 28×28 controls
  (16px glyphs, gap 4). Crumbs: folders `fg-3`, the file name `fg` medium; `lib/crumbs.ts` `crumbFloor` (tested) keeps
  "… › file" readable, so the status folds before the name is cut (B21). The language server is a glyph of the app's state
  family with its name in the tooltip (and beside it when there is room), and in words when it is not ready ("Starting…",
  "Failed" + Retry). "Unsaved", "Saving…" and the server's failure share one slot. Preview | Source is the app's
  `Segmented`. Not done: "Changed on disk" stays a notice line under the bar (two actions do not fit a narrow bar).
- **E2, tree.** Indent 12 per level (was 16); root folders are 12px caption heads; names one weight, icons `fg-3`; the
  selected row is the sidebar's selection tint; the filter sits in `PanelFilters` on the rows' edges; rows 28, 40 under
  touch (B22).
- **E3, E4, the surface.** The editor's background is the panel tone in dark (`#171717`, was `#141414`), so tree and editor
  are one surface split by a hairline; the divider draws 2px on hover and drag. Line numbers `#888888` / `#707070` (one step
  under meta, about 5:1), the active one `fg`; comments are `fg-3`; selection, find matches and the current line come from
  tokens, no boxes; scrollbar track 8, thumb 4 (6 on hover). The syntax palette lives in `lib/codePalette.ts` (also read by
  the conversation's code blocks: their comment colour moved too); every token is at or above 5.8:1 in both themes.
  **Departs from** the Code pane section's listed colours, 14px tree indent and 6/8 scrollbars.
- **E5, covers.** No file, too large, binary, an open error and "no folders" are centred `EmptyState`s with actions (Copy
  path, Reveal in tree, Retry, Project settings) — no longer one line in a corner. Monaco's scrollbar cannot show through a
  cover or the tree page (B20).
- **E6, comments.** The comment card is a tone without an outline; the Pending comments popover opens on its first comment
  and "Remove all" is the last stop, in a footer (B23; no Undo).
- **E7, page mode.** Files / Editor are one control in one place; focus goes to the selected row (else the filter) on the
  tree page and into the editor on the editor page.
- The Changes and Review diffs share the theme: only the dark background, the comment and line-number greys and the
  scrollbars moved.
- Gates: `tsc`, 619 unit tests (+ crumbs), eslint 0 errors, prettier, `file-open-stability` at 1440×900, 900×600 and
  390×700, `width-stability` (two sizes), `layout-shift`, `spacing-audit` total=0, `frame-colours`, `flicker` ok; tree keys,
  divider, save, conflict, comments, Preview/Source, ghost text, LSP retry and page mode re-run by script. Not verified:
  WebKit, touch, a screen reader.

### As built — fixes after the UI verification, batch 6 (Review)

- B24: the pull-request list's filters are `FilterTabs` with counts (decisions 82b, 82e). B25: thread text is the compact
  prose scale (13/20). B26: the picker's skeleton reserves the repository-menu line and the chips reserve their count width;
  header 56, tabs y 137 and filters y 230 are the same before and after load (side group, 1440×900). B27: "Tests" /
  "Typecheck" in the review header carry the play glyph (the spinner in the same slot while running). B28: a file row's
  marks moved into its title and the counts alone are the meta, so "+8 −2" is whole (`ListRow` caps `meta` at 40 % of the
  row — anything else with many marks in `meta` can clip the same way). Focus: Esc in the Pending panel returns to its
  button; "All pull requests" returns to the review's row in the list. B60, Review part: "atlas-labs/atlas-api #476" instead
  of the raw source id; a failed list load is an `ErrorNotice` ("Could not reach the code host." + hint, Retry, Details).
  Also: the base menu ticks the current base and does not offer the current branch; "(s)"; the outdated sentence is whole;
  "Post 1 comment and 1 reply"; no "Enter" inside the open-by-number row; a shorter search placeholder.
  Not done: the 24 pull rows are still 24 Tab stops (`ListRow` has no roving tabindex). Looked at only: `Segmented` with its
  new track in Overview, Pending and the submit sheet (fine; the Pending track is faint in light). Not verified: 390×700, a
  single-repository project's skeleton.

## As built — polish step 5: tool panels (2026-11-13; one commit)

Rules P1–P9 of the orchestrator's brief for Sessions, Memory, Notes, Usage, Agents, Details, Changes and the side question;
228 before/after pairs (dark and light; side group and maximised at 1440×900, 900×600, 390×700) compared by the executor, a
sample by the orchestrator.

- **P1, one empty state.** `PanelEmpty` with a title is one centred block that fills the body; Agents, Notes, Usage,
  Changes, Memory, Sessions and the side question use it (title at 37–42 % of the body's height; before 1–7 % for Notes,
  Usage, Changes). Notes shows no footer with no notes. Limits' "no rate limits" is a section with the inline empty line.
- **P2, one detail header and action row.** `FormActions` (in `primitives/Panel`): buttons at the right, Cancel then the
  primary; as a confirmation the question sits at the left (`alertdialog`). The note editor, the memory file editor and the
  note-delete confirmation use it; the note editor opens under a `DetailHeader`. A note's actions are labelled: "Edit",
  "Pin" / "Pinned", "⋯".
- **P3, lists as one family.** Memory → Sessions rows carry a state glyph (text at 40); Notes rows: the pin in the glyph
  column, the description (heading marks removed) then tags on the second line, the date right-aligned (`lib/notes.ts`
  `noteLine`, tested); Knowledge group heads 32; "Forgotten exchange" has a glyph slot; the "2 agents" fold and Details'
  list rows are 32 (Details' label/value rows stay 28 — **revises** 95f's "As built"); a session's second line is
  "3 exchanges · Sonnet 4" with the date at the right. Not done: Memory search hits have no glyph column; Changes rows.
- **P4, filters.** `FilterTabs` shrinks to its column and scrolls inside it with a faded edge, the chosen chip kept in view;
  in Sessions' split view the row no longer crosses the divider (B30).
- **P5, side question on the frame**: `Panel` with the title, Keep / Clear at the right, left aligned at every width; the
  caption moved to the empty state (round 2 #26, B41); Clear returns focus to the input.
- **P6, words and numbers.** Limits say "3,998 of 4,000 left" in compact numbers and the bar shows what is spent, red only
  under 10 % left (B43; **revises** decision 86's bar); a role's share bar is its share of the table (B44); the agent
  transcript's crumbs are "Conversation / Security reviewer" (B42); the New session popover lists earlier sessions and
  remembered facts under what is not carried into the context (B37, 95e). Not done: Changes headings "Turn N".
- **P7, search.** A hit's snippet keeps the match in view; the highlight is a new `--octo-mark` token (a warm tint; text on
  it 8.2:1 dark, 13.8:1 light; the mark against its row 1.9:1 dark, 1.3:1 light — it reads by hue; **revises** 93b's hover
  tint) (B33). A one-column list marks no row while nothing is chosen.
- **P8, tooltips.** Line breaks are kept; a tooltip on focus shows only after a navigation key, so opening a tool from the
  palette shows none; an open tooltip follows its title's changes (B40, B57).
- **P9, narrow.** Over a tool tab the floating composer rests as one 40px line and opens on a press, Tab or typing;
  `FloatRoom` follows (56 at rest, was about 250–290). The conversation tab and the file view are unchanged. **Revises**
  batch 2's "covers the lower part at rest".
- In passing: Esc in a one-column detail returns to the list (`ListDetail` decides one column by the container's width,
  B29); a new session with no request shows "No requests yet", not the previous conversation (B38, fixed in
  `useSessionConversation`; the desktop demo's data still has no session ids).
- Gates: `tsc`, unit tests, eslint 0 errors, prettier, `spacing-audit` total=0 (2 skips, the stale `tool-tables` step),
  `panel-measure` (header 40, inset 16 on every tab), `width-stability` (two sizes), `frame-colours`, `flicker`,
  `scroll-on-send` ok. Not verified: an empty Sessions list and the budget tooltip (the demo has neither), keyboard reach
  of the queue inside the collapsed composer, WebKit, touch, a screen reader.

## As built — polish step 6a: Settings (2026-11-13; one commit)

Rules S1–S7 of the orchestrator's brief; 118 before/after pairs (dark and light; 1440×900, 900×600, 390×700).

- **S1, one page structure.** Every section, Providers included, is one centred 880px column (`--spacing-settings-page`):
  the page title, group captions (meta) and row labels on one left edge (x 450 at 1440; before 488 for row sections and 288
  for Providers), each group one surface. Providers is one group — caption "N providers connected", one surface split by a
  hairline into the list (288) and the detail, equal heights; Router is a group with a Show / Hide row.
  **Departs from decision 59** (780px column) and from 89's "full width of the settings page".
- **S2, one row anatomy.** Label (14/20), explanation (12/16, `fg-3`), the control on the label's line ending on the row's
  right edge (x 1249 in every section); rows 60. `SaveStatus` sits beside the control and no longer changes the row's
  height (60 → 60; was 66 → 86 → 66); Appearance confirms its changes. Every select is 256 wide (`SELECT_W`).
- **S3, type roles.** The provider detail's Models / Preferred model / Roles / Billing are meta captions, not bold body
  text (**departs from 89d's** titles).
- **S4, nav.** ↑ / ↓ / Home / End move between sections, Enter opens; in the settings search ArrowDown goes to the results
  and Enter opens the first. Under the floor Back and the section menu share one 40px line.
- **S5, provider detail.** Title: mark, name, state once ("· Experimental" in the same run); the name no longer truncates
  in a narrow pane (the action wraps under it). Models' count and age are in its caption with Refresh at the right; a stale
  model's note follows its name. One "API key" label. "Check again" keeps focus while it runs (it is not `disabled`).
- **S6, words.** `document.title` is "Settings · Octo"; "Record what agents send and receive" (the protocol's name in the
  explanation); About says what the app is connected to; "Default model" in the project dialog too; Plan limits in compact
  numbers. Not done: project names in Usage by project still truncate (the shared table).
- **S7, narrow.** `ViewTabs` are 40 under touch; Providers in list-only mode marks no row as chosen.
- Gates: `tsc`, eslint 0 errors, prettier, unit tests, `spacing-audit` total=0 (settings and providers scenes 0),
  `width-stability`, `frame-colours`, `flicker`, `backdrop-check` ok; theme, On startup, provider pages, Check again, the
  key form, Router, Back/Forward and Esc driven by script. Not driven: Refresh, the project scope menu, Commands edit /
  choose, CSV and diagnostics copy. Open: on a 1440 window the 880 column puts a row's control far from its label.

## As built — polish step 6b: Review (2026-11-13; one commit)

Rules R1–R7 of the orchestrator's brief; 164 before/after pairs (dark and light; side group and maximised at 1440×900,
900×600, page mode at 390×700).

- **R1, the picker is a `Panel`** (decision 95f listed Review as not on the frame): header 40 with the title at 16 and
  the repository menu in a new `lead` slot of `Panel` (shrinks first; nothing else in `Panel` changed), view tabs with the
  frame's hairline, a 36 filter row (chips, then search; below 560 the search takes its own line), rows inset 8; "not
  logged in" and empty are `PanelEmpty`. The folder menu sits at the right end of the view-tab row (**departs from 91i's**
  one header line); below 600 "Updated …" is the refresh button's tooltip. A maximised list is capped at 880 and left
  aligned.
- **R2, pull rows** are `ListRow`s of two lines, 40 high (were about 72 in a side group): CI glyph · title · time at the
  right; meta "Review requested · #482 · mira · 14 files · 8 comments" with "+1317 −986" at the right. The state word shows
  only for New since your review, Review requested and Draft (`lib/review/pullList.ts` `pullRowLine`, tested).
- **R3, the open review's header**: the title line (Back, title, one group of 28px actions, "Submit review" last) and one
  meta line cut from the right. It folds by its own width, in a declared order: below 1024 pinned commands go into "Run";
  below 720 Check out, Pending and Details go into "⋯"; below 480 Run is its glyph and Submit says "Submit · N". Height: 61
  maximised (was about 77), 41 in a side group (was about 210, three wrapped rows). **Replaces batch 1c's wrapping (A10);
  departs from 64/78** (Pending and Details moved from the meta line to the actions).
- **R4, file list, diff bar, threads.** The diff bar is one 40px line on step 4's sizes ("More" became "⋯"); group heads
  are captions; thread cards are tones on the code's left edge, capped at 720; the reply box ends with the shared action
  row. **A bug found and fixed:** Monaco's code layer took every click on a thread in the diff, so Reply, "N more replies"
  and Collapse could not be used with a mouse; the thread zone now sits above it and keeps focus without scrolling.
- **R5.** The submit sheet's drafts and the Pending panel's items are rows with hairlines; the segmented track inside
  Review is 8 % in light.
- **R6, page mode (390×700).** The header is the title line; the file picker, Viewed, previous / next change and "⋯" share
  one line. Code starts at y 171 (was 355); 505px of code are visible, 326 with a comment box open (were about 320 and 141).
- **R7.** The pull list and the branch list are one Tab stop with arrow keys: `useRowKeys(ref, { roving: true })` in
  `lib/hooks.ts`, opt-in; other callers unchanged.
- Gates: `tsc`, unit tests, eslint 0 errors, prettier, `spacing-audit` total=0 (review scenes 0; Review is not in the
  audit's panel-frame tab list), `width-stability` (two sizes), `frame-colours`, `flicker` ok; batch 1c's Esc and resize
  scripts still hold; picker, branches, Pending, Details, suggest, three verdicts, check out and Run driven by script.
  **Known and not fixed:** threads inside the diff are in Monaco's `aria-hidden` zone layer, so a screen reader cannot
  reach them (it was so before). Not verified: WebKit, touch, a screen reader, a live `gh`.

## As built — after the polish: entry bundle and cross-part leftovers (2026-11-13)

- **Entry bundle.** After the fixes and six polish steps the entry measured 160.34 kB gzip (budget 158.90). It is
  **158.07 kB** again; the budget was not raised. What had entered: the drawer and its modal hook, the composer's one-line
  form, the roving-row hook, the top row's fold logic and smaller growth across the frame and the transcript. Now lazy and
  warmed after first paint: `SidebarDrawer`, the agent tab's observer bar (a 40px placeholder holds its row), the start
  failure, attachment rules and image adding (first drop, paste or picture), `ContextRing` (mounted once the context size
  is known), `recheck`; Review's roving focus is `lib/rovingRows.ts` (`useRovingRows`; the `roving` option of `useRowKeys`
  is gone). Tried and dropped: a lazy `FloatingComposer` (+2.4 kB through hoisted chunks), a lazy drag layer.
- **Settings.** Row sections are 660px wide (`--spacing-settings-rows`) inside the shared 880 column, left aligned;
  Providers keeps 880. One left edge in all ten sections (title x 450 at 1440); label to control 798 → 626.
- **Sidebar.** An empty meta takes no column, so a long name uses the free width; the column returns while the sessions
  chevron shows.
- **Focus when a tool tab opens** (`lib/focus.ts` `focusSurfaceSoon`): `[data-autofocus]`, else the search field, else the
  chosen row, else the first row, else the panel itself. Notes and Review open in their search field (were a header icon
  and a view tab), Sessions and Changes on the first row.
- `Checkbox` passes `data-*` through (the Choose commands dialog opens on its first box); `ModelPicker problemShown`
  draws a value in the normal tone when the caller explains the problem (project dialog); an unverified row of the model
  picker shows its state on a second line (40px), nothing truncates at 310; Memory search hits have a glyph column;
  Changes headings read "Earlier request · Today 8:11 PM" instead of "Turn 60" and file rows are 32 (40 under touch);
  `KeySteps`' refusal says the sentence plainly with the variable under Details (not seen in the browser: no demo knob);
  the desktop demo emits `fact.remembered` and its base session's messages carry a session id.
- The status bar's "filled box" in several screenshots was a hover state under a parked mouse pointer, not a resting
  background: no change.
- Not done: one glyph size in the composer's control row (needs a primitive variant).
- Gates on the final tree: `pnpm lint` (cycles included), `pnpm format:check`, 636 UI and 42 desktop tests, the
  production build and bundle check, `spacing-audit` total=0, `width-stability` (two sizes), `frame-colours`, `flicker`,
  `file-open-stability` at 1440×900, 900×600 and 390×700, `picker-keys`, `scroll-on-send`, `backdrop-check`,
  `panel-measure`, `layout-shift`. Not verified anywhere in this work: WebKit and macOS, a live harness, real agents and
  `gh`, touch on a device, a screen reader.

## As built — the owner's UI audit (2026-11-14)

The owner tested `9c167c9` live (vite dev, not Tauri; 108 screenshots) and listed 20 items. What changed, by item:

- **1 (P0). A `spawn_agent` refused before its agent existed span forever.** `lib/transcript.ts` `spawnStatus`: with no
  agent the call's result decides (error → failed, or stopped when a stop wrote it; no result → pending only while the
  turn runs). The row reads "not started" with the plain error under it; the caption counts it ("1 agent · 1 failed").
  Demo: send "refused spawn please".
- **2 (P0). A stopped turn read "✓ Worked for 8s … 1 failed".** `turnHead` gives "Stopped after 8s" / "Failed after 8s" /
  "Worked for 8s" from the turn's ending; `stepState` / `isInterruption` mark a call as stopped when it has no result
  and the agent is not running, when its error is one of the harness's interruption texts (`interruptedResult`,
  `finishLocked`), or, in a cancelled turn, when an ACP agent answered `rejected` / `cancelled` / `interrupted`. Any
  other error stays failed and is counted. The stopped glyph is the family's quiet dot (decision 29 has no square).
  Demo: "slow command please", then Stop. The ACP wording is taken from the owner's report, not seen live.
- **3.** `lib/truncate.ts`: a space at the middle cut moves to the tail as a no-break space ("Claude Code · Sonnet").
- **4.** Model picker: list up to `min(480px, 100vh − 160px)`; providers that are not set up fold into one row
  ("N more providers can be added"); "experimental" is a tag that never shrinks; a scrolled edge fades.
- **5.** `Segmented`: segments 24 in a 28 track with 2px padding, track radius 8 over segment radius 6. A form row that
  holds one is 54px (was 50).
- **6.** Turn rail: a mark's target is 24px wide (was clipped to 12; the pointer hit nothing beside the mark) and its own
  6px cell high, the end marks 14; the card on hover and focus adds the request's time. **Not the asked 24×16:**
  decision 57's 6px pitch leaves no room without overlap; a larger pitch when the rail has room is the owner's call.
- **7.** A project row goes placeholder → final glyph and never through another state (`state/orchestrators.ts`
  `PendingState`, `isPending`). **Not done:** a skeleton in the main area on first paint (the entry bundle has 0.06 kB
  of room).
- **8.** `GET …/plans/latest` answers 200 `{"plan": null}` (done earlier, `internal/bridge/plans.go`).
- **9.** `ListRow`: a selected row's meta is `text-fg-2` (palette shortcut 4.06 → 6.07 in dark; sidebar 5.75 → 8.60).
- **10.** `ObserverBar` under 560px reads "Read-only"; the sentence is the tooltip; one line, 40px, at every width.
- **11.** Typeface: Inter 4.1 variable, self-hosted in `packages/ui/src/assets/fonts/` (OFL, `LICENSE.txt`; `subset.sh`
  rebuilds the eight subsets: latin, latin-ext, cyrillic, cyrillic-ext, upright and italic; optical size pinned to
  text, `cv11` and `ss01` kept — the `@fontsource` subsets strip them). Only `inter-latin.woff2` (47.7 kB) loads at
  start, preloaded by the desktop host (`main.tsx`); the others by `unicode-range` when such text appears. Mono and
  Monaco unchanged. Row heights unchanged (line boxes are tokens).
- **12.** Inline code is 0.93em (13px in 14px prose), padding `2px 4px` (the audit's 1px is off the spacing scale).
- **13, 14.** No change: 12/20 is the code block's line only; 10px is `--radius-lg`. The composer's and the prompt
  bubble's 14px radius became `--radius-xl` (12).
- **15.** The streak band is drawn at device resolution, smooth, with no dither cells, fading at both ends; muted in
  light (`lib/streak.ts`). Appearance → Backdrop Off still removes it. The owner chooses between this, none, or none
  in light only.
- **16.** The palette highlights substring matches (not scattered fuzzy letters); a cut row has the full text as tooltip.
- **17–20.** The disabled Review item is focusable and says why; `TextField` has a `leading` slot (the budget's "$");
  a login failure of an agent CLI shows the steps and the command to copy (`lib/errors/login.ts`); a host that manages
  the harness (`managesHarness`) shows a restart screen instead of the developer's instructions when offline.
- File-link chips stay 23px: they are inline in running text (the target-size rule's inline exception), and 24 would
  change the paragraph's line height.

Gates on the final tree: `pnpm lint` (cycles), `pnpm format:check`, 648 UI tests, agent-client and desktop tests, the
production build, bundle 158.84 kB of 158.90, and the browser scripts (`spacing-audit` total=0, `width-stability`,
`flicker`, `file-open-stability`, `scroll-on-send`, `layout-shift`, `picker-keys`, `frame-colours`, `backdrop-check`).
Not verified: WebKit and macOS, the Tauri window (including whether the first frame is already Inter), fractional
pixel ratios, a live harness and real ACP agents, a screen reader.

## As built — round 3: a first-time user's walk, vendor marks, the owner's re-test (2026-11-14)

Two reviewers walked the app as a person who has never seen it (first run, new project, conversation; Settings, files,
panels, palette); the owner re-tested `75fe457` live and asked for the providers' real marks. What changed:

- **Decision 72a is overridden by the owner: provider marks are the vendors' real marks.** `ProviderMark` draws a
  `currentColor` box masked by an SVG file from `assets/providers/` (22 marks; sources, versions and licences in
  `SOURCES.txt`: `@lobehub/icons-static-svg@1.102.0`, MIT, and `simple-icons@16.37.0`, CC0; the marks are their owners'
  trademarks, used to identify the provider). Monochrome in the text colour. Provider rows show the provider's mark; a
  model chip shows the agent's mark when the model runs through an agent, else the model vendor's. `router`,
  `factory-droid` and `oh-my-pi` keep the neutral shape with an initial (no real mark found). The table and the URLs
  are a lazy chunk. Not confirmed: that the `pi` mark is the pi coding agent's.
- **Needs you.** A project whose turn waits on an approval or a form is "Needs you" in the sidebar, on Home and in
  the tile, with "Waiting for your approval" / "Waiting for your answer"; waiting wins over working
  (`lib/orchestrator.ts`); `project.attention` refreshes the summary at once. The harness sends `needs_you`,
  `pending_approvals`, `pending_inputs` while the turn runs (checked against `harness serve` with the mock model).
- **A stopped turn.** Its ending and duration come from the session's stored exchange after a reload
  (`lib/storedEndings.ts`, current session only), the duration is measured to the turn's end, and the turn says
  "stopped" once (head; rows read "stopped").
- **One time for a project** in the sidebar and on Home (`projectWhen`); the context ring and its popover read one
  number; a passing run says "Passed".
- **Narrow windows (390).** The composer's row sheds labels by container query (mode < 460, model < 380, folder < 320);
  "+", the ring and Send/Stop never shrink. The tab strip folds its end cluster from its real shortfall
  (`stripShortfall`; an earlier `scrollWidth` version looped and blanked the app — caught by the second reviewer before
  any commit). The strip keeps its inset under the drawer. The queue card is a header and one row per message. Over a
  file tab the floating composer rests as one line.
- **Decision 57 revised: the turn rail's pitch** is `clamp(floor(avail / n), 6, 16)`: targets are 24×16 when there
  is room and fall back to 6px cells on a dense rail. Measured at 10 requests only.
- **New project.** Unrunnable default models switch to the first runnable choice; a notice above the buttons when one
  cannot run; the typed draft survives Esc ("Your earlier draft is back. Clear"); tiers and routing policies are
  explained for every option; one left edge.
- **Menus and actions.** Mode rows carry their explanation (`Menu` items take `sub`; captions are not rows); the "+"
  menu starts with "Attach image…" and "Mention a file"; a duplicate agent command is labelled with its agent; a failed
  helper has an always-visible "Retry" that pre-fills the composer; reply tables fill the column and fade at a
  scrolled edge; a refusal's note is shown without code fences.
- **The editor's context menu is the app's `Menu`** (`shared/EditorContextMenu.tsx`: Add comment, Go to definition and
  Find references when the language server offers them, Cut, Copy, Paste, Copy path); Monaco's own menu and its F1
  palette are off in the file editor and both diff editors. A failed language server reads "TypeScript help failed ·
  Retry".
- **Palette and help.** The palette searches labels and descriptions, has a Settings group (fed by the settings index
  through a dynamic import), drops loose hits when a substring hit exists, starts with "Suggested" actions, puts
  actions above past requests and dedupes those. New: "Change theme", "Change model", "Keyboard shortcuts", "Help".
  `ShortcutsSheet` (lazy) lists the shortcuts that exist; it opens with "?", from the palette and from About.
- **Settings.** One primary action for API-key providers and where to get a key; the unrunnable-defaults warning says
  what is true and offers "Use <agent> instead" with Undo; one name, "tier"; the router described by its benefit; the
  background service is "Octo's local service" in user-facing copy (commands, paths and "Harness version" keep the
  word); a new Integrations section (language servers, agents, tool servers; manifest errors in plain words with the raw
  text under Details); per-project settings use one scope menu ("Settings for") in Models, Commands, Editor, Memory
  and Budget; a budget is stated as a total, "Saved" clears on edit, spend matches the usage table; plan limits read
  "Anthropic API · requests — Resets in 12 min"; Usage by project uses the 880 column.
- **First paint.** `MainSkeleton`: three static lines in the conversation column, fading in after 300 ms, while the
  projects or a project load (owner's audit, item 7).
- **Entry bundle 157.67 kB of 158.90.** `apps/desktop/vite.config.ts` filters already-loaded initial chunks out of the
  preload lists written into JS (about 2.5 kB of `__vite__mapDeps`); an import cycle through `useOrchestratorComposer`
  was broken (`chat/composerDraft.ts`); rarely used helpers moved to lazy modules (`rare.ts`, `hooksMore.ts`,
  `statusMore.tsx`, `modelNames.ts`, `duration.ts`, `contextText.ts`).

Not done: image preview in Files (needs a bridge read that returns bytes); Run folding into "⋯" under ~350px; tool tabs
that shrink to two letters (walk B12); panels' purpose lines (B13); `ProjectWorkspace`'s load error still says "harness
bridge". Not seen on screen by anyone: the project dialog's unrunnable notice and Routing field, the table fade, the
"/review · agent" label (no demo state). Gates on the final tree: `pnpm lint` (cycles), `pnpm format:check`, 666 UI,
141 client and 42 desktop tests, the layer-rule tests, `cargo test -p octo-sidecar`, the build and bundle check,
`spacing-audit`, `flicker`, `width-stability`, `layout-shift`, `scroll-on-send`, `picker-keys`,
`file-open-stability`. Not verified: WebKit and Tauri (including CSS masks for the marks), a live harness for the UI
parts, real agents, touch, a screen reader.

## As built — the owner's stress test (2026-11-14)

The owner ran 61 chaos scenarios and a responsiveness check against a live stack (their snapshot had no round 3). What
changed, with the report's ids. Every fix was reproduced first against a real `harness serve` with the mock model behind
a fault-injecting proxy.

- **A send that never gets an answer (A9).** "Sending…" after 1 s; the fetch is aborted after 15 s; the client then
  reads back the conversation and the queue, and a message that did arrive is shown as sent (the harness has no
  idempotency key); otherwise the text is kept and the notice offers Retry, which looks again before posting.
- **A silent or broken event stream (A16, A11).** The harness's ping is a named `heartbeat` event (a comment never
  reaches the page) and the stream starts with `retry: 1000`. The client reopens a stream that was silent for 35 s or
  was refused (backoff 1–10 s); every reopen re-reads the project; a disagreement between the polled project list and
  the stream about a running turn for 4 s also re-reads. After a re-read, agents that no longer run lose their live
  parts (`settleStreams`), so a cut answer is replaced by the stored one.
- **A first load that fails (A14).** Failures are tracked per agent and for the project; retries with backoff 1–30 s,
  on window focus and on stream reopen; "Couldn't load the conversation · Retry" while it fails.
- **Offline, refused, unreadable (A15, P2-3, P2-4).** A stream error checks health at once (0.4 s, was 12–14 s).
  After the first load the workspace stays under a banner and the composer says why sending is off; the full-screen
  state is only for a first connection. A 401 is "Octo's local service didn't accept this window" (Restart Octo in the
  packaged app; reload and the token hint in dev); a body that is not JSON is "sent an answer that could not be read".
- **Clock skew (P2-12).** Relative times use the offset from the service's `Date` header when it is over 30 s.
- **Interrupted turns (P1-1).** The harness checkpoints streamed text every 500 ms and a heartbeat every 5 s; on start
  it closes turns that were running: kept text, interruption results for open tool calls, an exchange marked
  `interrupted`. The head reads "Interrupted after 15s — Octo's local service restarted" with Retry. When the model or
  the router dies mid-stream the text stays above the failure card ("The connection to the model broke off." / "The
  Octo router stopped answering.").
- **The route decides the project (P1-4).** `resolveProjectRoute`: an id that is not in the list is re-read; a 404
  shows "This project no longer exists" with no composer; the app opens the first project only when it starts with no
  hash. A deleted open project is noticed through its stream (the harness emits no `project.deleted`).
- **Ctrl+K typeahead (P2-7).** Keys typed after Ctrl+K are held until the palette's field has focus (they used to go
  to the composer, and Enter sent them as a prompt); a held Enter runs the first row once the rows for that text exist.
- **The composer on long input (P1-5).** The cost was layout: the tint layer copied the whole text, and Inter's
  kerning on a 50k-character word took ~2 s per layout. The tint layer is skipped above 20k characters or with a
  1000-character word; such text is shaped without kerning (`data-long-word`); the field sizes with
  `field-sizing: content` where supported; the `@`/`/` trigger reads 256 characters before the caret. 100k paste
  5.3 s → 46 ms, a keystroke 7 s → 18–32 ms (dev server). A counter from 75 % of the 1 MB body limit; over it the send
  is refused before any request.
- **Long conversations (P1-6, CLS).** Turns near the viewport are mounted; the rest are empty sections of their
  measured height that keep their text findable (`hidden="until-found"`); jumps mount their target first
  (`turnReveal`). 1000 messages: 106,560 → 4,530 nodes, scroll 18–28 → 52–56 fps, streaming 20 → 50–54 fps. Parts
  that are already loaded render without suspending (`readyLazy`); CLS on open at 390×700 0.72 → 0.026.
- **Smaller.** An empty paused queue shows nothing; a long project name wraps to two lines in the empty state; soft
  line breaks are kept unless a line is 50+ characters and does not end a sentence (`lib/softBreaks.ts`; applies to
  every Markdown render); answers' prose is 60ch wide (~83 characters; the bubble, tables, code and composer keep the
  column) and the column is 820px when the conversation is ≥ 1240px wide; the model picker's list uses the height
  down to 88px of margin; the budget's wording says it is checked between steps.
- **Entry bundle 154.56 kB of 158.90**: the transcript is its own chunk (`transcriptPart`), warmed after first paint.

Not reached or not verified: one long task of 139–183 ms while streaming in two of three runs (target 100 ms); Ctrl+F
over unmounted turns was exercised only by dispatching `beforematch`; in WebKit the scroll correction when turns mount
above the viewport and the composer's height fallback were not run; a turn killed before it wrote anything leaves two
user messages in a row; tool rows of an interrupted turn read "error"; the real router's wording (unit test only);
Tauri's "Restart Octo"; IME input; all numbers are from the dev server. Gates on the final tree: lint with cycles,
format, 693 UI / 157 client / 42 desktop tests, `go test -race ./...`, `cargo test -p octo-sidecar`, the build, and
the browser scripts including `spacing-audit` total=0.

## As built — the owner's third re-test (2026-11-14)

The owner re-tested `6a15218` (round 3, before the stress-test fixes) and listed new findings and a "distance to
premium" table (G1–G15). What changed for it:

- **A tool call reads as an action (G1).** The expanded body depends on the kind (`lib/toolView.ts`,
  `components/chat/tools/`): a command shows its line with copy, the last 8 lines of output ("N earlier lines"
  expands, 1000 at a time), and the end in words ("Exited 0 · 4s", "Failed (exit 1)"); output is never red. A read is
  a `folder/path:lines` link. An edit shows "+N −M", "Open diff", "Go to line N" and a compact inline diff (12 rows,
  "Show all"; a plain line list, no Monaco). Other tools get a one-line summary and key–value input. A call cut short
  reads "Stopped by you at 9:51 AM." / "Declined … It did not run." / "Interrupted …"; the agent's or harness's own
  refusal text is only under "Raw". A refusal's row reads "stopped", not "failed". The group summary is per kind.
- **Changes in the conversation (G2).** Under a finished reply that changed files: "2 files changed +6 −3 · Expand
  all · Review changes" (`chat/TurnChanges.tsx`). "Open diff" and "Review changes" open the Changes tab on that request
  (and file) through `lib/changesFocus`; Changes shows "Showing one request · Show all" and drops the focus when it is
  opened any other way. The Changes diff header has "Go to line N"; a line number on the modified side opens the file
  there. Review's diff header is a separate component and has no "Go to line".
- **Why a turn failed survives a reload (NEW-1).** A failed turn's reason is its stored error, else its own last error
  result (`turnFailureText`), else "This request failed." with Retry; earlier failed turns have Retry. The sentence
  "no reason was reported" is gone. (The harness now stores `error` on a failed exchange; `lib/storedEndings.ts` does
  not read it yet.)
- **Stop gives feedback at once (G5).** `lib/stopping.ts`: the button is disabled with "Stopping…", the live row says
  "Stopping…", and after 5 s the composer says "Still stopping — a running command has to finish". Nothing reads as
  stopped before the harness ends the turn.
- **A helper waiting for the person (NEW-3)** reads "Waiting for your approval" / "…your answer" with the needs-you
  glyph in the conversation and the Agents panel (`lib/agentWaiting.ts`). Not in Home's "Agents at work".
- **No change of a turn after it is shown (NEW-4, G13).** Turns stay invisible until the first stored-endings read
  answers (at most 800 ms); a head that changes later, notices and waiting rows fade in (`.octo-fade`, 120 ms).
  Measured CLS at 1440: the long chat 0.211 → 0.000, Atlas 0.046 → 0.012; at 640–900 it was already 0.002–0.003 here
  (the owner measured 0.16–0.24 on live data: not reproduced).
- **Overlays and the palette (NEW-6, G12).** A hash change closes the palette, the shortcuts sheet and the New project
  dialog. An empty query shows "Suggested" and the three projects last worked in.
- **Turn rail (N7).** The button itself is 24px wide; targets stay 16, then at least 12 high while the height can hold
  them (`railLayout`); 100 requests give 24×7.
- **Vendor marks** in Integrations, Details and the Agents panel (N9).
- **Evenness (G7–G9).** Every lucide icon draws a 1.5px stroke at every size through `--icon-stroke` and a CSS rule
  (36 icons used outside `Glyph` drew 1.17px); inline code is 13px in 14px prose and 12px in 13px prose (no fractional
  sizes); the radius scale is 6 / 8 / 12 and pill, with 2 and 4 for small marks — `--radius-lg` (10) is gone, surfaces
  are 12 and rows inside them 8; Settings rows and provider details use `--spacing-card` (12).

Open: the vendor marks are filled and look heavier than the line icons at 12–14px; 14px has two line heights (22 for
prose, 20 for semibold headings); a previous failed turn's notice stays beside a send error (NEW-5 was not reproduced
without the owner's proxy); the exit code of a built-in `bash` is parsed from its output; G10, G11, G14, G15 and the
@-contexts of G6 are not started. Not verified: anything against a live harness; real ACP diff payloads; Details and
the Agents panel marks in the browser; the line-number click in the Changes diff.

## As built — sessions in the sidebar, the changed-code blocks, the backlog (2026-11-14)

- **Decision 96 (parallel sessions, phase 2)** revises decisions 23, 26 and 63: the sidebar is a tree of projects and
  their sessions, a tab is a session, the composer names the session it sends to. The contract and what was verified
  are in `2026-11-14-parallel-sessions-design.md` ("As built — Phase 2").
- **Tool group and changed code** (the owner: "the block about the changed code does not look good"). One grid for
  every diff row: `[old][new]` number columns sized to the largest number, an 8px gap, the sign in its own 1ch column,
  then the code; a sticky opaque gutter; quiet tints (`color-mix` of ok/err at 8–9 % on the code, 15–18 % on the
  gutter); the code scrolls sideways under the gutter with a 24px edge fade and never wraps. A body sits on the row's
  text edge (`bg-code-bg`, radius 8, inset 12) and ends in one action line ("Show all" left; "Open diff", "Go to line
  N", "Raw" right) — no header band, no separate Raw row. Rows have one grammar (`callRow` in `lib/toolView.ts`): a
  past-tense verb, the object in mono, a quiet qualifier, the state as the glyph and a quiet word; built-in and ACP
  tools read the same. Consecutive edits of one file are one row ("Edited src/http/retry.ts · 2 edits +4 −2"). The
  group's glyph is the worst state only when every call ended that way; problems are a dim suffix. The turn's footer
  names up to three files and uses the same row and body. Command output is `pre-wrap` with a 16px hanging indent; the
  command is repeated in the body only when it is long. Monaco's diff colours (Changes, Review) do not use these
  tints yet.
- **Usage** holds everything under the table until its three requests answer and shows a table-shaped skeleton only
  after the delay: CLS 0.34 / 0.24 / 0.10 → 0 at 640 / 900 / 1440.
- **Files preview images** (png, jpg, gif, webp, svg, ico, avif) from `GET …/files/content?encoding=base64` (the
  optional bridge method `readFileBytes`; the desktop host loads its code with the first image): pixel and file size,
  Fit | 100 %; an SVG is drawn through an `<img>` (a script inside it does not run) with Preview | Source; over 2 MiB
  says "Too large to preview".
- **Review's diff header** has "Go to line N" and "Open file". **Panels** (Agents, Notes, Memory, Usage, Details, Side
  question) carry their purpose on an (i) in the header (`lib/toolPurpose.ts`); Files says it in its empty state;
  Changes does not yet. Notes' footer is a plain sentence with the counts in its tooltip.
- **Settings nav** is grouped under App, Models and agents, Workspace (`settings/navGroups.ts`); "Default
  (recommended)" and "default" read "Default"; a router provider's detail shows its status, models and where its
  settings are (not seen in a browser: no demo router).
- **Vendor marks** are scaled by ink coverage so they sit at the weight of the 1.5px line icons (coverage 0.15–0.52 →
  0.17–0.39).
- Entry bundle 158.59 kB of 158.90.

Not verified: images on a live harness and at 390px; the review workspace open; real ACP titles in tool rows; "+N
more" in the footer; anything in WebKit.

## As built — the phone layout mode and the fourth re-test (2026-11-14)

- **Phone layout mode** (the owner: "the mobile version is too cramped"; it is the main view of the mobile web client).
  One switch: `lib/phone.ts` `PHONE_QUERY = "(max-width: 640px) and (pointer: coarse), (max-width: 479.98px)"`, read
  once in `OctoApp` (a host may force it with `HostCapabilities.layout`), exposed as `usePhone()` and `data-phone` on
  `<html>`; every phone rule hangs off it and nothing changes while it is off (static desktop screens: 0 changed
  pixels). A desktop window under 480px is in phone mode.
  - Header: one 44px line — menu, the session title with the project as meta, a state glyph, "⋯". In a panel or file:
    Back, the name, "⋯". The "⋯" sheet groups: this session's tabs and New session; Run; Panels; Status (changed
    files, running commands, budget, other projects' agents, the remote indicator); Project settings; Settings.
  - Navigation: the sidebar is a full-screen sheet with 44px rows; picking closes it.
  - Composer: one line ("+", the field, the context ring, Send/Stop) growing to `min(120px, 20 %)`; "+" opens a sheet
    (attach, mention, mode, model, folder); the queue is a chip that opens a sheet; no session chip. It follows the
    visual viewport (`app/phone/useVisualViewport`) so it stays above the on-screen keyboard; safe-area insets.
  - No title bar and no status bar. Conversation: prose 16/24, helper rows on two lines, tool bodies at full column
    width, the diff without the old-number column, 44px buttons on cards, no turn rail, reply footers always shown.
  - Panels and files are full-screen with Back; menus, popovers, selects and pickers are bottom sheets (the new `Sheet`
    primitive); the palette is a full-screen search; Settings is a list of sections, then the section. Sheets, panels
    and navigation are history entries (`lib/historyLayer.ts`): Back closes them in order. A long press shows a
    control's description.
  - Open: system Back inside a panel leaves the panel instead of stepping from detail to list; a panel's own title
    repeats the header; the editor opens editable; "Rewind to here" overlaps the prompt bubble's edge.
- **Send is disabled over the 1 MB limit** in every layout (NEW-11).
- **A remote device** (`lib/remoteDevice.ts`, the mobile web host): entry points the harness would refuse are hidden
  or say "Change this on your computer"; a read-only device has no Send.
- **Fourth re-test.** A failed turn's stored `error` is read for every session a transcript shows (action from the
  code through `ACTION_BY_CODE`, to be kept in step with the harness catalogue); the interrupted banner's hint follows
  `kept_text`; calls and helpers of an interrupted turn read "interrupted"; first reads have a 10 s deadline
  (`lib/deadline.ts`) with a new "didn't answer in time" state, retries at 1–30 s, on focus and on stream reopen, and
  the hosts abort a hung GET after 12 s (the owner's "malformed" proxy mode never answered and held all six
  connections); the palette's open/close is a small state machine (`lib/typeahead.ts`) so keys typed during a reopen
  are delivered once; pending approvals and forms load on sync, so a helper reads "Waiting for your approval" after a
  reload and in Home's "Agents at work"; the demo's stored endings carry `error`, `interrupted`, `kept_text`; Monaco's
  diff uses the conversation's tints (lines 9/8 %, words 18/15 %, gutter transparent); Changes has its purpose (i); a
  narrow model chip reads "Opus 5.5" with the agent's mark.
- **Entry bundle 149.98 kB of 158.90**: everything the page loads at start is one chunk (`codeSplitting` group
  `$initial` in `apps/desktop/vite.config.ts`) — the same code as ~40 preloaded chunks compressed worse.

Not verified: a real phone, WebKit, the real on-screen keyboard, a screen reader; NEW-7 before the change (it did not
reproduce here; the cause was read from the code); built-in tool rows of a real interrupted turn.

## As built — neatness, minimalism, balance (2026-11-14)

The owner: "Check neatness and minimalism; everything must be balanced." A measured pass over both layouts; findings
and before/after pairs were kept in the session scratchpad.

- The composer's session chip is the last chip of its control row and takes the row's free room (the composer with two
  queued messages: about 191 → 167px at 1440); under a 480px composer it keeps its own top line (two placements, CSS
  shows one). It cuts the title at its end (`Chip` `cut="end"`); "default" is in its name and tooltip.
- A turn's row with a hover-only action (a helper's "Open session") puts the action where the duration is
  (`data-row-overlay`), so durations in a delegation group end on one edge; always shown on touch.
- A turn head's words are `fg-3`: the head is quieter than the work under it.
- Phone: a panel's own title and a Settings section's page title are for screen readers only (the header names
  them); "Rewind to here" sits under the bubble on touch.
- Home's triage groups are 8px apart; the empty project's heading, note and suggestions share the composer's text
  edge; Details' "All files" sits on the right edge; the palette lists a session that is open as a tab once.
- Measured and left: diff tints are not stronger in light than in dark (ΔE76 light 6.1 / 7.0, dark 8.4 / 7.7).

For the owner to decide: Settings row sections sit left of centre at 1440 (660px rows in the 880 column, by the earlier
S1 decision); Usage and budget has two right edges (880 table, 660 rows); the top bar's right cluster is heavier than
its left; the phone navigation shows row actions on every row (no hover on touch).

Not looked at in this pass: the shortcuts sheet, Review with an open pull request, the offline banner, several panels
in light. Not verified: WebKit, a real phone, a screen reader.

## As built — the premium pass, wave 1: navigation, conversation, panels (2026-11-15)

The owner asked for an even, calm interface on both layouts ("no clutter, clean edges"). Four reviewers first walked the app
(WebKit; the phone and the screens not looked at before; accessibility; every string) and returned measured findings; the
fixes then went to executors on disjoint files. A reference was measured for principles only (one ink at opacity steps,
hierarchy by ink not by weight, one icon size per zone, one border per seam). This wave is the shell, the conversation and
the tool panels; Settings, the primitives, the tokens and the WebKit fixes follow in their own commits.

- **Section titles in the sidebar** (the owner's screenshot: "the sidebar is uneven where it says Projects"). A section
  title starts on the left edge of the rows' icon column (x 48 → 24), 16px above it and 4px under it, a 20px line. The "+"
  beside "Projects" is gone in the tree and Projects views (it was a second way into New project); in the Sessions view it
  stays (New session). A session's highlight starts where every row's does; the step in is inside the row.
- **Phone: Back.** A row that opens a route from a panel no longer loses the navigation (`lib/historyLayer.ts` marks the
  entries the page has seen; a new entry is a navigation, `onClose(navigated)`): Agents → agent → Back → Agents. A file
  goes back to the Files tree. The palette, every `Dialog` and the shortcuts sheet are history layers on the phone. A
  detail inside Sessions, Memory (a session, a file), Review (an open pull request) and Changes (a diff) is a layer:
  Back returns to the list. Not done: Agents' own detail (it opens a tab), a provider's detail (Settings, next commit).
- **Phone: the rest.** A panel's purpose is the first group of the "⋯" sheet and the lone (i) row is gone (44px back in
  Memory, Usage, Details, Changes). Navigation rows carry one "›" with a 44px zone and the project's time; New session is
  in the row's menu and the "⋯" sheet (iOS has no long-press menu). "Rewind to here" opens when the bubble is tapped (a
  request block 126 → 98px; the old always-shown row's hit area covered the whole bubble). One-line step rows are 32px with
  a 44px zone, 12px apart. Diffs in a reply and in Changes wrap (a continuation hangs 2ch past the line's indent); the
  Changes toolbar keeps Back, the name, "⋯" and Revert. The slash menu's descriptions are a second line. A file opens
  read-only with Edit / Done (`domReadOnly`, so WebKit raises no keyboard); crumbs are hidden; an SVG's source wraps.
  Home's tiles are two rows of two. The shortcuts sheet is not offered. Gone and timed-out states keep the header.
- **`/new <text>`** (the owner): starts a new main session and sends the text there as its first request; the current
  session gets nothing and the view stays, with "Started in a new session: … · Open" above the composer. `/new` alone
  opens an empty session. A failed create keeps the text; a failed send opens the new session with the text in its box
  (both unit-tested only: the demo cannot fail). `lib/newSession.ts`, `chat/useNewSession.ts`.
- **Review.** Threads are reachable: a "N threads" control in the file's bar opens a list outside Monaco (one tab stop;
  Enter shows the thread and its Reply there and scrolls the diff), `n` / `p` step through them, and the copies inside
  Monaco's view zones are `inert` while no pointer is over the diff. `j` / `k` keep the focus in the diff. The header is
  Run (pinned commands first), Check out, Details, Submit; "Pending" shows only above zero. A failed list keeps "Reviews
  in progress"; the `gh` install command follows the platform. A wholly added line carries the line tint only. There is
  no Resolve: the bridge has no such method.
- **Keyboard and names.** One tab stop per list (`lib/listStops.ts`, `lib/rovingRows.ts`): Home, the Sessions tab, Agents,
  Memory, Notes, Review's files, the empty composer's suggestions, a reply's file chips; a row's menu on Shift+F10. A
  project row's menu (New session, Show sessions) opens on Shift+F10. The file editor says how to leave it ("Press
  Ctrl+M, then Tab"; Esc with no selection and no widget moves to the file's tab). The composer is a `combobox` for its
  "@" and "/" menus. One polite live region says when a request starts and ends and when an approval or a form arrives
  (never the streamed text). Both sides of a Monaco diff have names. After a route change the focus goes to the page's
  title or back to the control that opened the page; focus set by the app draws no ring until a key is pressed
  (`lib/quietFocus.ts`). `<main>`, a page `h1`, and `document.title` with the project and the session.
- **Words** (one name per thing; the list is in the session's copy report): the orchestrator is "Octo"; "harness" and
  "bridge" are "Octo's local service" ("Offline" in the status bar); a turn is a request or a reply; helpers and
  sub-agents are agents; an exchange is a request; a worktree is "a copy of the code"; the code host is GitHub; "Routing"
  is "Model choice"; "Review changes" is "Open changes"; buttons say "Retry"; sizes are KB / MB. Kept for the owner to
  decide: "Compact", Memory's tab names, "agent" for both a helper and a coding agent.
- **Syntax colours on diff tints** pass 4.5:1 in both themes (`lib/codePalette.ts`; minimum 4.13 → 4.6).

Gates on this commit's index (a clean copy): see the commit message. Browser scripts were run by the executors on their
own screens only; the full set, the spacing audit and both engines run on the pass's last commit. `ui-tour-states.mjs`
and `spacing-audit.mjs` still look for some of the old strings until the scripts' commit. Not verified: a screen reader
(the accessibility tree and axe only), a real phone, Safari and the Tauri window (Playwright's Linux WebKit only, and
only for the phone's Back, the conversation and Monaco), a live harness, 1100 and 1680 for the panels. Known and open:
the demo shows a failed request's text twice; `aria-allowed-role` on the composer's textarea; small touch-zone overlaps
at "Go to line N" and "Raw"; Shift+Tab in the composer still switches the mode (the owner's call).

## As built — the premium pass, wave 2: Settings, primitives, tokens (2026-11-15)

- **Settings navigation** (the owner's screenshot: "the titles have crooked gaps"). Group titles follow the sidebar's rule
  and are no longer headings (`role="group"`, `aria-labelledby`): on the icon column (x 24), a 20px line, 16px over and 4px
  under. Measured against the project sidebar at 1440: rows 16 / 236 / 32, icons at 24, labels at 48, first row at y 48 in
  both. The search field's icon sits on the icon column (`SearchField align="rows"`).
- **Settings pages.** A group's caption is 20px with 4px to its surface and 24px between groups (`SectionHeader
  line="tight"`); a row's text starts on the caption's and the page title's line (`--spacing-settings-row-inset`); controls
  in rows are 28px, the switch 24; quiet buttons end on the controls' right edge. Remote access says its name once and has
  one red action; General's "Sidebar shows" and the Commands footnote are one line; Models has one warning line and no
  "Project" caption over "Settings for"; Integrations' explanation is over its list. Not changed (the owner's call): the
  660px rows at the left of the 880 column, and Usage and budget's two right edges.
- **Phone.** A provider's detail is a history layer; a section's header has "Back to Settings" and the page's own link is
  gone (`settings/sectionBack.ts`); "Keyboard shortcuts" is not offered; segments are 32 in a 36 track.
- **Tokens** (WCAG, computed): key hints 3.13 → 5.95 (light, `fg-3`; the opacity is gone, only the frame is dimmed); light
  `--octo-ok` 4.35 → 5.29 on a selected row; dark `--octo-input-border` 2.89 → 3.43 on a selected row; a menu item's meta
  under the highlight 4.06 → 6.07. `--octo-field-edge` (the hairline, 1.51 / 1.38) is unchanged: the owner's decision.
- **Primitives.** `ListRow` builds its name from the title, the glyph's label, the description and the meta (`treeitem
  "Changelog bot Failed 50m"`), passes `aria-haspopup`, and gives an empty meta no room. `Menu` closes on a scroll only
  when its opener's ancestor really moved (WebKit with a macOS user agent closed the editor's context menu after ~280 ms;
  it now stays). `Segmented` with nothing chosen draws each segment as its own tile. Forced colours: the switch, the
  chosen segment, primary buttons, the selected row and provider marks are visible. A provider mark's letter is a whole
  size (≥ 9) and only from 20px. `-webkit-text-size-adjust: 100%`; `-webkit-backdrop-filter` beside `backdrop-filter`.
- **Words** in Settings, providers, the project dialog, the desktop host and the web client follow wave 1's list ("Language
  help", "Extra tools", "Add a device", "Remove", "Subscription limits", "Model choice", "This window can't …").

Not verified: Safari and iOS; the model picker's menu after the `Menu` change; forced colours in WebKit; the pairing
screen's safe-area padding on a device. Kept: "Full history / Recent window", the names Auto / Ceiling / Fixed.

## As built — the premium pass, wave 3: panel edges, the request bubble, checkpoints (2026-11-15)

- **One left and one right edge in every panel** (the orchestrator's own walk of every tool tab beside the conversation:
  Agents and Details ended at x 1277 where Changes ended at 1415 and header buttons at 1423). One rule, `lib/panelColumn.ts`:
  a list fills its panel; a panel that is one column (Agents, Details, Usage, Side question, Review's list) and a detail
  (a note, a session, a memory file) stop at 720px together with their header. Measured at 1440 in a 636px panel: title
  813, glyphs 813–817, text 837, meta 1415 (1387 where rows have a "⋯" column) in every panel. "New note" and "New session"
  are quiet buttons whose text ends on the rows' edge; Memory's count sits on the dates' edge.
- **The request bubble** (the owner's picture; sketches first, then V1): a person's request is a filled bubble on the
  right, as wide as its text and at most 80 % of the column; one line is a pill (40px, 42 on the phone), more lines have an
  18px radius. `--octo-bubble` is #3a786b in dark and #356e61 in light with white text (5.15 and 5.91:1; the picture's
  #4a9887 gives 3.42). Labels ("Sent while Octo was working") sit over the bubble. Replies stay plain text. The colour is
  two variables; the same shape with a neutral fill is a change of two values. The 18px radius is outside the 6 / 8 / 12
  scale on purpose (a large surface).
- **Checkpoints: "Restore to here"** replaces "Rewind to here" everywhere. It is in a reply's footer on the right, on the
  edge of "Open changes": always shown under a reply that changed files, on hover or focus otherwise, never under the
  last reply; disabled with a reason while Octo works. The dialog ("Restore to this point?", "Restore") is the preview:
  it lists the files that come back and the requests that go; the harness gives paths only, so no content preview is
  promised. The bubble has no action any more (wave 1's tap-to-reveal is removed). `/rewind` keeps its name.
- **The stopped glyph** is a ring with a square (the weight of "failed" and "needs you"); idle stays a dot.
- **The composer in a narrow column** (beside a panel): the session chip is an icon in the control row and the queue is
  one line ("2 queued · Then rename…") that opens: 193 → 111px. A form's segments with nothing chosen say "· choose one"
  in the field's label.
- **Review**: a thread opened in the list leaves one quiet line ("Thread open above") at its place in the diff instead of
  a second copy. **Changes**: a wholly added line carries the line tint only, as in Review.
- Focus set by the app when a panel opens draws no ring in any panel (`lib/quietFocus.ts`, one module).
- **Demo**: a failed request has no reply text (it was shown twice); a turn with five changed files ("+2 more"); the
  review's files exist, so "Go to line" opens them; `?router=on` adds a router provider. A test forbids "harness",
  "bridge", "orchestrator" and "worktree" in the demo's and the error catalogue's readable strings.
- Phone touch zones in a tool body: 23 overlaps → 4 (left: "Copy table" against "Raw", 4px, in `DataTable`).

Not seen on screen: a request with an image, with mentions and a comment card, and the "Sent while…" label in the new
bubble; text selection inside it; forced colours; the router's detail in Settings; a 409 in the new dialog. Open: on the
phone Memory shows two back arrows (header and `ListDetail`); after Back from an agent opened in Agents the address
keeps the agent's route; "Rewound to here" in `lib/compact.ts`.

## As built — the premium pass, wave 4: Settings width, whole tabs, first open, the empty project (2026-11-15)

The designer's sketches (kept in the session's scratchpad) were taken as built here; two of the owner's balance questions
stay open (the top bar's command buttons; the text field's hairline).

- **Settings on a wide window** (the owner's question 4a/4b, decided by the orchestrator on "do it yourself"): the 880
  column stays centred and rows, cards and the usage table fill it, so every section has one left and one right edge
  (at 1680: cards 554–1386, controls end at 1374, text starts at 566; before, rows ended at 1214 and the usage table at
  1381). A row's description is at most 56ch (the longest line 105–110 → 61–75 characters). The phone is unchanged.
- **Tabs are whole** (decisions 25 and 83 revised): a strip shows only tabs whose label fits (a tab's floor is its whole
  label and its close button, 144 for long file names; the middle cut of a long name stays); the active and the pinned
  tab always show; the rest go, least recently used first, into "All tabs" as "+N" right after "+". Widths come from
  measured parts, kept per tab, with no measure-change-measure loop (`state/workspace/tabStrip.ts` `fitStrip`). Arrows,
  Home and End walk hidden tabs too; a drag's index is mapped through the hidden ones. At 1440 with eight tool tabs:
  three whole tabs and "+5" (before: five, the active one cut to "Se…").
- **First open on a wide window**: with no saved layout, a window of 1600px or more and recorded changes, the project
  opens Changes beside the conversation at 432px; an empty project opens alone; closing the panel is remembered with the
  layout. Not on the phone, not with a saved layout. The panel appears after the changes answer, so the divider moves
  once on that first open.
- **The empty project** (decisions 52 and 91f revised): at most three suggestions from what the folder holds — an empty
  folder's own pair; "Run the tests and fix what fails" when the project's commands include tests or lint; "What is this
  project?" when there is a README; "Explain the structure of …"; "What changed recently?" only with a `.git` folder.
  "Review my uncommitted changes" is gone (the harness has no git status and it showed without git). Their room is
  reserved and they fade in (no shift). One line under the heading: "Octo edits {folder} and runs its commands; you can
  undo any change.", hidden while a problem notice shows.
- **Usage table**: the cost cell is "≈ $9.00" with the sentence in its tooltip (Cost 194 → 66px, Project 227 → 363).
- The marker after a restore reads "Restored to here".

Not seen on screen (unit tests only): the suggestions for an empty folder and for a folder with only a README (the demo
gives every project the same commands and hides `.git`); a tab dragged from another group into a strip with hidden tabs.
Not verified: WebKit for this wave; the first-open panel on a phone (it is off outside the docked layout).
`--spacing-settings-rows` is no longer used.

## As built — the premium pass, wave 5: WebKit, and the browser scripts in two engines (2026-11-15)

The interface had never run in WebKit. A reviewer ran both layouts in Playwright's WebKit 26.6 beside Chromium (this is the
Linux build: not Safari on iOS or macOS, and not the Tauri window). Vendor-mark masks, `:has`, `color-mix`, container
queries, the Inter subsets (widths equal to the pixel), the streak canvas, history layers and `visualViewport` without a
keyboard behaved the same. What was broken, and what was done:

- **A long conversation did not open at its end** (WebKit only: 92–132px short at 1440, a screen short on the phone, so
  approval cards were out of sight). The engine itself moves `scrollTop` up when mounted content above the viewport is
  replaced, and `overflow-anchor: none` does not stop it. `lib/stickDecision.ts`: a move up counts as the reader's only
  within a second of their input inside the scroller (wheel, touch, scrolling keys, a press on the scroller or its bar,
  `beforematch`, a selection) or when one event moves most of a screen; otherwise a pinned view returns to the end
  before paint. After: 0px from the end in both engines.
- **Scroll correction without CSS anchoring** jumped 1716px (1440) and 2336px (390) in both engines when anchoring was
  forced off: only the frame of mounting was corrected. `chat/useTurnWindow.ts` now observes every turn section and adds
  the height change of a turn that is wholly above the viewport before paint: 0px over 30 steps, native and manual.
  Whether Safari has native anchoring was not checked.
- **The composer's height fallback on the phone** (no `field-sizing`, Safari before 26) cut lines 7–11 at 120px with no
  scrolling: the limit is now read from the computed `max-height` (`fitHeight`), and the empty field is one 20px line.
- **The editor's context menu** closed after ~280 ms in WebKit with a macOS user agent (wave 2's `Menu` change); a
  script now checks it.
- **Changes' diff** shows a dimmed loading state until Monaco has computed the diff (in WebKit the text stood uncoloured
  for 1–4 s on the dev server and read as "no changes").
- The shortcuts sheet's second column no longer starts 16px low in WebKit; it lists N / P for review threads.
- **Scripts.** Every script in `packages/ui/scripts` takes `--browser chromium|webkit` (`browser.mjs`); four new ones
  (`stick-on-open`, `composer-fit`, `scroll-anchor`, `editor-context-menu`); `flicker` samples with a ResizeObserver
  probe after the page's own observers (the old sampler recorded a frame nobody saw); the tour finds the file tree by
  name again and follows the new wording.

Not verified: Safari and the Tauri window; the on-screen keyboard; dragging the scrollbar (headless cannot grab it);
Safari's own find over folded turns; landscape safe areas on the phone frame; Ctrl+Alt+C (comment) does nothing in this
WebKit build; `apps/web/scripts/phone-flow.sh` was not run (it needs Go 1.26, the environment has 1.24).

## As built — schema forms in the client and the UI; the audit at zero (2026-11-15)

- **Decision 97 (forms from a schema; contract in `2026-11-15-dynamic-forms-mentions-design.md`, phase A2).** One renderer,
  `shared/SchemaForm`, draws a form from a flat JSON schema on the library's primitives; nothing is written per form. The
  pure part is `lib/schemaForm/` (parse, the old five field kinds to a schema, defaults, `visible_when`, checks, the
  summary). `v7/InputFormCard` is built on it; a request without `schema` is converted on the client. Controls: an enum
  of up to four short options is segments, a longer one a Select; `email`, `uri`, `date`, `date-time` and numbers are
  `TextField` with a type; many-of is a list of checkboxes; a boolean is a checkbox; `password` has show / hide. Enter
  submits a single-line form, Ctrl/Cmd+Enter any; a refused submit focuses the first field in error and says how many
  need attention; the service's `error.fields` show under their fields. After an answer the card is one line ("Answered ·
  Email: … · Password: •••"); a password is not left in the DOM, the console or the optimistic state. `pattern` runs on
  the client only when it cannot backtrack badly; otherwise the service decides.
  Demo: `?demo=1&forms=1` (sign in, region, rollout, release checks). `packages/ui/scripts/schema-forms.mjs` passes in
  Chromium and WebKit; axe finds nothing on the card. Differences from the contract: the summary shows values (the
  contract says "answered"); group titles are parsed and not drawn; the path widget is still a text field.
  Not seen on screen: 1100 and the narrow column; "Closed: stopped". The shared fixture
  `packages/agent-client/src/fixtures/forms.json` (50 cases) is checked by the client's tests; the Go side is the
  harness's phase A1.
- **The spacing audit** found 182 off-scale values after waves 1–5 (11px and 7px paddings that made room for a 1px frame
  in Settings; the phone's hanging indent of a wrapped diff line). `ListFrame` and the settings search field now draw
  their frame as an overlay, so paddings are 12 and 8 and no text moved (1112 of 1136 measured edges equal; the others
  are the search input's own box). The hanging indent is one allow-list entry (content geometry, in `ch`). The audit
  reaches the tool tables and the phone's New project dialog again; both were skipped on `main` as well, so the earlier
  "total=0" there was with four states skipped.
- An agent that is installed but too old (Antigravity before 1.5.0) reads "Installed, but too old for Octo. Update it,
  then check again." and its step is "Update".

## As built — a project never waits for a login (2026-11-15)

- **Cause.** `POST /v1/projects` (and PATCH) refused a model whose provider was not ready: `422 model_unavailable` with the agent's own sentence ("Claude Code is not logged in."), or `409 no_provider` with nothing connected (the check dates from 2026-11-12; the "too old" agent joined it on 2026-11-15). The dialog showed the sentence as a red line with no action, and "New project" with nothing connected opened the Connect screen instead of the dialog.
- **Now.** Creating or changing a project never checks readiness (harness `internal/project/service.go`: no `checkModels`, no `no_provider`); the project lists what cannot run in `models_unavailable`. Unknown agents and malformed models stay `400`. `ProjectDialog` shows one calm block above the buttons per provider that cannot run (`ModelNotice`, text from `lib/errors/modelReadiness.ts`): the sentence plus "You can create the project now and log in later, or choose another model.", the login command to copy, "Choose another model" (opens "Models and agents") and "Check again" (`recheckAgent`). "Create project" stays on; red is only a refusal of the create itself. "New project" always opens the dialog.
- **Demo.** `?claude=loggedout`: Claude Code is the default agent and not logged in (providers, plugin list, config); a demo create or patch is never refused and reads back `models_unavailable`.
- **Verified.** Real harness (built-in plugins, a fake `claude` whose probe says logged out, fake ACP agent behind `npx`, no key): create returns 201, the dialog closes and the project opens, a request in it fails with "Claude Code is not logged in." with `claude auth login` and "Check again". Not verified: a real Claude Code, the packaged macOS app. Known and left: the empty project's sentence (`chat/EmptyProject.tsx`) still says "its provider is not connected" for a logged-out agent and has no actions.

## As built — commands, a simpler composer, dropdowns and scrolling (2026-11-15, after the owner's hand test)

The owner, using the app: "the commands hardly work", "`/clear` takes effect late", "the prompt input is too big, too
complicated", "scrolling closes dropdowns".

- **Commands.** Every Octo command was run three ways (menu and Enter, typed in full, with an argument) on the demo and
  against a real `harness serve` with the mock model. What did not behave: Enter on `/new`, `/model` and `/review` in the
  menu only inserted the name (their argument is optional: `argsOptional`, Enter and a click now run them, Tab inserts);
  the palette's "New session" offered the first project of the list, not the open one. `/clear` and `/compact` gave no
  sign of life while the service worked: the service summarises the session before it answers
  (`apps/harness/internal/orchestrator/clear.go`, a model call: 40–55 ms with the mock, seconds with a real model). The
  composer now clears at once and shows "Starting a new session…" / "Compacting the conversation…" until the answer, and
  a second Enter is ignored (`lib/slashPending.ts`); the view follows the answer within 70 ms. The service still answers
  late: making `clear` answer first and summarise after is a harness change, not made. `scripts/slash-commands.mjs`
  checks each command's result on the demo (Chromium, WebKit, the phone).
- **The composer is one box and one row** (decision 91's "four controls" is now three and two): "+", the mode and the
  model on the left; the context ring and Send on the right. The folder chip and the session chip are rows of the "+"
  menu ("Folders: …", "Session: …", the same menus as before) and of the phone's "+" sheet. The model chip shows the short
  name with the agent's mark. A line over the field ("Sends to "…", not the default session") appears only when the tab's
  session is not the default. The queue is one line at every width. Heights at 1440: idle 74 → 68, with two queued
  167 → 101, three lines of text 118 → 112.
- **Dropdowns and scrolling**: see the commit that carries `primitives/popupScroll.ts`.

Not verified: the review keys (j k ] [ n p v c); the palette on the phone; `/export`, `/context`, `/memory`, `/settings`
by result on the live service (clear, compact, new, model, rewind and export were). Open: a project's Run menu does not
offer the commands found in `package.json` (only a review's does); `/review` ignores its argument.

## As built — alignment, single-provider ACP, mentions, streaming & spacing polish (2026-11-16)

- **Cleaner empty/non-default chat framing.** Removed the `"Sends to “<session>”, not the default session"` banner above the
  composer (`chat/useOrchestratorComposer.ts`, `chat/Composer.tsx`), the `"Octo edits <folder> and runs its commands; you can
  undo any change."` footnote (`chat/EmptyProject.tsx`), and `"Suggestions"` starter-prompt cards on empty/new chats (`EmptyProject.tsx`).
- **Unified column alignment.** Matched desktop `<textarea>` and `<ComposerHighlight>` inset (`12px`, `px-3`) with `[data-column]`
  transcript text (`+12px` inner column on desktop via `styles.css`, keeping phone `12px` gutters), `Composer` collapsed floating
  state, and `SidePanel` right-aligned prompt bubbles (`-mx-3` in `side/SidePanel.tsx`). Fixed `ChangesView` column width
  (`w-70` / `280px` matching `ListDetail`), filter header bar (`px-4`), and nav padding (`px-pane pt-1 pb-4`), and aligned
  `SessionComposer` checkbox/outcome footer to `px-3` (`12px`).
- **Open project sessions as tabs immediately.** Added `openSessions.ts` (`openSessionTab`) and wired `ProjectTeam` (tab strip header),
  `ProjectActionsMenu` (`⋯`), and `TabMenu` (`+` Chat) so sessions can be opened as `session:<id>` tabs right after initial
  project setup without waiting for a sub-agent or secondary state.
- **Icon-only `Run` trigger by default.** `ProjectCommands.tsx` now renders the top-bar command trigger as a compact `Play` icon
  button; removed the wide `"Run ⌄"` text label and the `compactRun` tab-strip folding rule (`tabStrip.ts`).
- **Single-provider ACP alignment & tier marks.** Switching `orchestrator` in Session mode (`settings/ModelsSection.tsx`,
  `settings/ProjectModels.tsx`, `lib/models.ts`: `modelsPatchForSessionChoice`) aligns `fast`, `balanced`, `deep` (and clears a
  cross-provider `side` override) to the same `acp:<id>` provider; the Go harness mirrors this in `internal/project/input.go`
  (`alignACPSessionModels`), `service.go`, and `orchestrator/spawn.go` (defaulting an unassigned or cross-provider tier on an
  ACP-orchestrated project to that ACP provider). Fixed tier icon resolution in `lib/providers/markKey.ts` for `acp:<id>/<model>`.
- **Markdown highlighting in composer & smart `@` mentions.** `ComposerHighlight.tsx` tints headings (`#`), bold/italic/strikethrough,
  inline code, `@mentions`, `/commands`, `#tasks`, blockquotes, and lists by colour/tint without changing metrics. `lib/mentions.ts`
  and `ComposerMenu.tsx` emit `@<filename> ` when a filename is unique across project files, `@<f.path> ` when ambiguous in a
  single-folder project, and `@<f.folder>/<f.path> ` when multi-folder.
- **Side question panel (`SidePanel.tsx`).** `useOrchestratorComposer` / `SidePanel` follows `project.models.orchestrator` when
  it is `acp:*` and `models.side` is unset, updated tooltip wording, and centered the exchange, composer, and error columns.
- **Streaming smoothness, clocks & animation cadence.** Extracted `lib/markdownSplit.ts` so `Markdown.tsx` memoizes stable
  completed blocks while `streaming`; isolated live token updates inside `StreamingReply` in `chat/Transcript.tsx` with rAF-aligned
  `useBatched` (`LiveActivity.tsx`) and subtle CSS caret pulse + `octo-msg-in` live turn entrance (`styles.css`); localized 1 s
  `useNow` ticks inside `ActivityRow`/`AgentHeader`/`DelegationRow` while `ConversationView` ticks every minute; replaced animated
  height drawers with GPU-friendly CSS grid `.octo-drawer-rows` and enabled smooth `scrollToBottom(true)` on send.

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors across `agent-client`, `ui`, `desktop`), `pnpm --filter @octo/ui test`
(851/851 including `mentions.test.ts`, `tabStrip.test.ts`, `models.test.ts`, `markKey.test.ts`, `markdownSplit.test.ts`),
`pnpm --filter @octo/agent-client test`, `pnpm test:scripts`, `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs`
(initial JS 156.48 kB gzip vs 158.90 kB budget), and `gofmt -l .` in `apps/harness`.
**Not verified.** Live Playwright `spacing-audit.mjs` (the `playwright` npm package is not installed in the build VM); `go vet` /
`go test` in `apps/harness` (blocked in this VM by `proxy.golang.org` HTTP 403 fetching uncached `modernc.org/sqlite@v1.62.0`);
live streaming/scroll smoothness in WebKit/Tauri or against a real ACP agent CLI.

## As built — session selector, gone-guard & model picker hover stability (2026-11-16)

- **Project session selection & creation across entry points.**
  - Workspace header (`shell/ProjectTeam.tsx`): always renders the quiet Sessions button (`[data-sessions-button]`) opening lazy
    `shell/ProjectSessionPicker.tsx` (switch `Chat` to any live main session, open any session in its own tab via trailing action,
    start `"New session"` / `"New session in new tab"`, or open `"All sessions…"`), while keeping the `"N agents"` control
    when running/team agents exist.
  - Strip `"+"` / `Ctrl/Cmd+T` (`dock/TabPicker.tsx`, `TabStrip.tsx`, `state/workspace/paletteCommands.ts`): added a searchable
    `"Sessions"` section listing project main sessions (`"in Chat"` / `"open"` / `"default"`) plus `"New session"` (`"Open in new tab"`).
  - Project `"⋯"` menu (`shell/ProjectActionsMenu.tsx`, `ProjectBar.tsx`) and pinned `Chat` tab context menu (`dock/TabMenu.tsx`):
    replaced blind tab creation with `shell/sessionSwitcher.ts` (`useSyncProjectSessions`, `useCreateProjectSession`,
    `sessionMenuItems` with `"New session"`, `"New session in new tab"`, up to 5 `"Switch session"` radio items, and `"Show sessions"`
    / `"All sessions (N)…"`).
  - Extracted lazy-only pure helpers in `lib/sessions/picker.ts` (`sessionChoices`, `sessionChoiceMeta`) so the initial entry chunk
    stays within budget (`check-bundle-size.mjs`).
- **Eliminated false "session no longer exists / is gone" races.**
  - `lib/sessions/current.ts` (`sessionTabMode`) + `dock/TabView.tsx` (`SessionTab`) + `sessions/SessionPane.tsx`: wait until initial
    sync completes (`synced > 0`) before falling through to `SessionPane` / `"This session is gone"` when a `session:<id>` tab is
    opened before `state.sessions` receives its entry.
  - `shell/openSessions.ts`, `shell/sessionSwitcher.ts`, and `dock/phone/PhoneMoreSheet.tsx`: upsert the newly created session into
    `state.sessions` (and refresh activity sessions) before navigating or opening its tab.
- **Model picker non-setup agent hover stability (`shared/ModelPickerPanel.tsx`).**
  - Removed the hover-reactive `unverifiedNote` paragraph above `<PopupList>` that dynamically mounted/unmounted whenever the cursor
    moved onto/off an unverified `"Not set up"` agent, eliminating the ~38 px height/position jump (`Popover` `ResizeObserver`) that
    caused the dropdown to flicker while moving the cursor across unverified agents. Kept `USE_ANYWAY_NOTE` in the row's native
    tooltip (`rowTitle`) and in `ConnectSheet` (opened on click/Enter).

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors across `agent-client`, `ui`, `desktop`), `pnpm --filter @octo/agent-client test`,
`pnpm --filter @octo/ui test` (including `lib/sessions/picker.test.ts` and `shell/sessionSwitcher.test.ts`), `pnpm test:scripts`,
`pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs`, `gofmt -l .` in `apps/harness`, and headless Chromium
CDP end-to-end checks on `?demo=1` (header session picker, `+` TabPicker `"Sessions"`, reload with persisted `session:<id>` tab,
project `"⋯"` menu, `Chat` tab context menu, single-session project, and `ModelPickerPanel` 0 px height/position shift when moving the
cursor across `connect:copilot` / `connect:grok` non-setup agents, with zero console/page errors).
**Not verified.** Live `harness serve` with real CLI agents in Tauri/WebKit; `go vet` / `go test` in `apps/harness` (blocked in build VM
by `proxy.golang.org` HTTP 403 for uncached `modernc.org/sqlite@v1.62.0`).

## As built — Browser tab and Design Mode (2026-11-16)

- **Workspace and dock integration.**
  - Added both the singleton `toolTab("browser")` (`browser`, `Alt+8`, palette `"Show browser"`, `PhoneMoreSheet` `"Browser"` row) and
    multi-instance `browserTab(id)` (`browser:<id>`, opened from `+` `TabPicker` `"New browser tab"` or the Browser toolbar `+` button) across
    dock split groups (`state/workspace/{layout.ts,floors.ts,WorkspaceProvider.tsx,paletteCommands.ts}`, `components/dock/{TabView.tsx,TabPicker.tsx,TabStrip.tsx,tabInfo.ts}`).
  - Per-project browser tab state (`state/browserTabs.ts`, persisted under `octo.browserTabs.{projectId}`) tracks URL, page title, navigation
    history, viewport preset (`full` / `tablet` 768 px / `mobile` 390 px), and Design Mode preferences (`batchMode`, active tool).
  - `TabStrip` badges Browser tabs with pending batch pin counts (`useTabPendingNotesCount`).
  - `components/commands/RunPanel.tsx` detects local dev-server URLs (`lib/commands/urls.ts`, ANSI-stripped `localhost` / `127.0.0.1` / `0.0.0.0` / `[::1]`
    rewritten to `http://localhost:<port>...`) in command output and exposes `"Open in Browser"` alongside quick-open suggestions in the Browser empty state.
- **Harness loopback proxy (`apps/harness/internal/browserproxy` + `internal/bridge/browser.go`).**
  - `POST /v1/projects/{id}/browser/proxy` opens or reuses an isolated `http://127.0.0.1:<ephemeral-port>` reverse proxy per `(projectID, tabKey)`
    (capped at 16 active proxies, 30 min idle eviction, graceful shutdown on bridge close; `DELETE .../browser/proxy/{sessionId}` closes explicitly).
  - Strips `X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `Cross-Origin-Opener-Policy`, and `Cross-Origin-Embedder-Policy`;
    rewrites root-relative/origin attributes, `<base href>`, `Location` redirects, and `Set-Cookie` attributes; streams SSE; proxies WebSockets (e.g. Vite HMR);
    and injects `inspector.js` (`/__octo_inspector__/inspector.js` + per-session nonce) before `</body>`.
  - Remote Access (`internal/remoteaccess/rules.go`) rejects `/v1/projects/{id}/browser/...` with `403` (`"Browser proxy is only available on this computer."`)
    because ephemeral `127.0.0.1` ports are unreachable over a phone tunnel.
  - In `?demo=1`, `BrowserTab` renders a rich self-contained interactive preview (`lib/browser/demoPage.ts`) via `<iframe srcDoc>` running the exact same
    `INSPECTOR_JS` (`lib/browser/inspectorSource.ts`), verified byte-identical to `apps/harness/internal/browserproxy/inspector.js` in unit tests.
- **Cursor-style Design Mode (`components/browser/*`).**
  - `BrowserToolbar.tsx` + `DesignHintBar.tsx` (`Mod+Shift+D` toggle): element picker (`Click`, `Shift+Click` multi-select, `ArrowUp` / `ArrowDown`
    parent/child DOM walk, `Alt+Click` straight to Chat composer, React `_debugOwner` / `_debugSource`, Vue `__vueParentComponent`, Svelte `__svelte_meta`,
    and `data-octo-component` / `data-octo-source` extraction), area drag (`Shift` square lock, `Alt` center-out) + `MarkupCanvas.tsx` (`Draw` freehand,
    `Rectangle`, `Ellipse`, `Arrow`, `Mod+Z` stroke undo), double-click inline `contentEditable` text editing (`Enter` commit, `Mod+L` stage, `Esc` revert),
    live `CssInspector.tsx` (`padding-*`, `margin`, `gap`, `width`, `height`, `color`, `background-color`, `font-size`, `font-weight`, `border-radius` with
    filter and per-property reset), and `Batch edits` switch (`Switch` + numbered corner-anchored pins on page + `PendingNotesPopover.tsx` + `Send (N)`).
  - Element/area captures render an SVG `foreignObject` snapshot inside `inspector.js` and composite `MarkupCanvas` strokes onto a cropped `2×` PNG uploaded
    through `bridge.uploadAttachment`.
- **Chat staging, wire format, and transcript rendering (`lib/browser/designNotes.ts`, `components/chat/*`).**
  - `Add to chat` / `Mod+L` / `Alt+Click` stages notes into `state/designNotes.ts`, surfaced above the composer by lazy `DesignNotesControl.tsx` (`N design notes`
    pill + review popover).
  - Sending formats structured metadata into a fenced `octo-design` JSONL block (`formatDesignNotesBlock`, `formatMessageWithDesignNotes`, integrated into
    `lib/comments.ts` `splitUserMessage`) alongside uploaded cropped PNG attachments.
  - `Transcript.tsx` strips the raw `octo-design` fence from visible prose and renders `SentDesignNotes.tsx` cards (`#pin`, `<Component>` + selector,
    clickable `sourceFile:line` opening the Monaco editor tab, inline text diff, CSS override chips, and note prose). Demo bridge (`demo/generic.ts`,
    `demo/slash.ts`) parses `octo-design` blocks and replies with targeted file/selector guidance.

**Verified.** `gofmt -l`, `go vet ./internal/browserproxy/...`, `go test -race ./internal/browserproxy/...`, `go test -race` on `internal/remoteaccess`
(`rules.go` / `rules_test.go`), `pnpm format:check`, `pnpm lint` (0 errors, 0 cycles), `pnpm --filter @octo/agent-client test`, `pnpm --filter @octo/ui test`
(including `lib/browser/designNotes.test.ts`, `lib/commands/urls.test.ts`, and `state/workspace/layout.test.ts`), `pnpm --filter @octo/desktop test`,
`pnpm test:scripts`, `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`158.75 kB` gzip vs `158.90 kB` budget), and headless Chromium
Playwright end-to-end + in-page `spacing-audit` and `frame-colours` checks across 11 dark, light, desktop (`1440×900`, `1100×800`), and phone (`390×844`) states
with zero console/page errors and zero spacing/frame-colour violations.
**Not verified.** Full `apps/harness` `go build ./...` / `go test ./...` (blocked in the cloud VM by sandbox proxy HTTP 403 for uncached `modernc.org/sqlite@v1.62.0`),
and live `harness serve` proxying real external sites or Vite HMR WebSockets inside native Tauri/WebKit.

## As built — tab design-system alignment, padding balance & whole-frame measure (2026-11-16)

- **Shared primitives (`Panel.tsx`, `ViewTabs.tsx`, `ListDetail.tsx`).**
  - Added `column?: "measure"` to `Panel` so single-column tabs (`Usage`, `Agents`, `Details`, `Review` picker, `Side`) cap
    `[data-panel-header]`, optional `notice`, and `[data-panel-footer]` to `PANEL_COLUMN` (`736px`), keeping header/footer text
    edges flush with the `720px` body measure without full-width edge-to-edge drift on wide panels.
  - Added `contentClassName?: string` to `ViewTabs` so `Usage` and `PullList` cap their `[role="tablist"]` + trailing controls
    to `PANEL_COLUMN` while keeping the outer `h-row-nav border-b border-line` hairline full-bleed.
  - Aligned `ListDetail`'s default `detailClassName` bottom padding to `pb-4` (`16px`), matching non-`ListDetail` panels (`pb-4`),
    and removed duplicate `pb-4` in `NoteDetail.tsx` and `NoteEditor.tsx`.
- **Dock tabs & fallbacks brought onto Decision 95f / spacing-scale rules.**
  - **Chat (`ConversationView.tsx`)**: replaced the raw missing-agent `grid place-items-center` + `<a>` fallback with `<EmptyState>`
    and `<Button>`.
  - **Sessions (`SessionsTab.tsx`, `SessionDetail.tsx`, `SessionPane.tsx`, `SessionComposer.tsx`)**: added `lead={<PanelPurpose tool="sessions" />}`
    to both fallback and live `Panel`s; balanced `SessionDetail` sticky footer (`mt-4 -mb-4 px-2 pt-2 pb-3`), `SessionPane` `pb-4`,
    and matched `SessionComposer`'s `.octo-composer` padding (`pt-3 pb-2`, `px-3`, `px-1.5 pb-2`) with `Composer.tsx`.
  - **Memory (`MemoryView.tsx`, `KnowledgeView.tsx`, `SearchResults.tsx`)**: added `lead={<PanelPurpose tool="memory" />}` to fallback
    `Panel`; removed `border-b border-line pt-2 pb-2` from `PanelFilters` (restoring the `36px` filter row and single hairline);
    used `<PanelEmpty>` in `KnowledgeView`; cleaned `SearchResults` to `pt-1 pb-4` and `gap-3` / `gap-1.5` group spacing.
  - **Usage / Agents / Details (`UsagePanel.tsx`, `AgentsPanel.tsx`, `DetailsPanel.tsx`)**: applied `column="measure"`, `ViewTabs`
    `contentClassName={PANEL_COLUMN}`, and container-scoped wrapping (`@container` + `@max-[480px]:py-1`) on `UsagePanel`'s filters.
  - **Changes & Diff (`ChangesTab.tsx`, `ChangesView.tsx`, `DiffPanel.tsx`)**: added `lead={<PanelPurpose tool="changes" />}` to fallback
    `Panel`; updated `"Showing one request"` focus bar to `pr-pane pl-4`; replaced custom `Centered` wrappers with `<EmptyState>` (`42:58`)
    and updated `Banner` padding (`px-4 py-1.5`).
  - **Review (`ReviewTab.tsx`, `PullList.tsx`, `BranchList.tsx`, `ReviewView.tsx`)**: framed unsupported fallback in `<Panel>` + `<PanelEmpty>`;
    applied `column="measure"` + `contentClassName={PANEL_COLUMN}` on `PullList`, converted unavailable card to `<ViewNotice form="block">`,
    and replaced raw `<h2>` with `<SectionHeader inset>`; removed `py-1` and `font-medium` caption override on `BranchList`; replaced
    off-scale `pl-11` (`44px`) in `ReviewSkeleton` with `pl-10` (`40px`) + `SkeletonList` (`px-pane pt-1`), and used `<EmptyState>` when
    no files changed.
  - **Files (`TreeColumn.tsx`, `FileView.tsx`, `ImagePreview.tsx`)**: removed `pt-1` on `TreeColumn` `<PanelFilters>`; aligned `FileNotice`
    bar (`px-4`) and `ImagePreview` footer (`pr-pane pl-4`).
  - **Run (`RunPanel.tsx`)**: balanced standalone `"Run: name"` tabs with `h-ctl-lg pr-pane pl-4` header, `text-heading` title, `px-4` error/note
    bars, `<EmptyState title="Not run yet" />`, and `px-4 pt-2 pb-4` output body.
  - **Side (`SidePanel.tsx`)**: applied `column="measure"`, left-aligned `PANEL_COLUMN` across empty state, `ScrollArea` (`max-w-measure px-2 pb-4`),
    composer (`PANEL_COLUMN px-pane pb-pane`), and error notice (`px-2`), matched `.octo-composer` padding (`pt-3 pb-2`, `px-3`, `px-1.5 pb-2`),
    and removed negative horizontal bubble bleed (`-mx-3`).

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors across `agent-client`, `ui`, `desktop`), `pnpm --filter @octo/ui test` (all UI unit tests
including `Panel.test.ts`), `pnpm --filter @octo/agent-client test`, `pnpm test:scripts`, `pnpm --filter @octo/desktop build`,
`node scripts/check-bundle-size.mjs` (within budget), and headless `/usr/bin/chromium` CDP audits on `?demo=1` across
`Chat`, `Sessions`, `Memory` (`Sessions`/`Knowledge`/`Files`/search), `Notes`, `Usage`, `Agents`, `Details`, `Changes`, `Files` (tree + image),
`Review` (`Pull requests`/`Local branches`/open PR), `Side` (wide `1247px` panel verifying `736px` `PANEL_COLUMN` cap and aligned `header`/`composer`
edges), and phone viewports (`390x844`): 0 spacing violations across all runs, `headerH=40`, `hInset=16`, `rInset=8`, `dy=0`, and 0 console/page errors.
**Not verified.** `spacing-audit.mjs` CLI directly (the `playwright` npm package is not installed in the build VM); standalone `"Run: name"`
tab runtime layout with live command output; WebKit/Tauri desktop binary.

## As built — Processes tab (2026-11-17)

- **Harness (`apps/harness/`).**
  - Added `PID int` (`json:"pid,omitempty"`) to `projectstore.CommandRun`.
  - Extended `commands.Service` with `StartAdhoc` (ad-hoc command execution inside validated project folders), `StopWith(ctx, projectID, runID, force)` (`SIGTERM` with 5s escalation when `force=false`, immediate `SIGKILL` to `-pid` process group when `force=true`), and `Restart(ctx, projectID, runID)` (stops active run if needed and spawns a fresh PID with the stored command/cwd).
  - Extended `lsp.Manager` (`ListProject`, `Restart`, 16 KiB `stderrTailCap` ring buffer) and `orchestrator.Orchestrator` (`WorkerProcesses`, `StopWorkerProcess`, `acp.Client.Stderr`) to surface active language-server and ACP worker subprocesses.
  - Added bridge endpoints (`POST /v1/projects/{id}/runs`, `POST .../runs/{rid}/stop?force=`, `POST .../runs/{rid}/restart`, `GET /v1/projects/{id}/processes`, `POST .../processes/{procid}/stop`, `POST .../processes/{procid}/restart`) with `ClassDeny` remote-access rules for non-owner devices (`apps/harness/docs/commands.md`).
- **Client & UI (`packages/agent-client/`, `packages/ui/`).**
  - Added `WorkerProcess`, `AdhocCommandInput`, `startCommandRun`, `stopCommandRun` (`{ force?: boolean }`), `restartCommandRun`, `listWorkerProcesses`, `stopWorkerProcess`, and `restartWorkerProcess` behind `rare.ts` lazy forwarders.
  - Added `tool:processes` (`ProcessesTab.tsx`, `ProcessDetail.tsx`, `StartProcessDialog.tsx`, `lib/processes/model.ts`) using `Panel` (`lead={<PanelPurpose tool="processes" />}`), `ListDetail`, `FilterTabs` (`All` / `Running` / `Stopped` / `Failed`), `SearchField`, `DETAIL_COLUMN` (`max-w-measure`), `DetailHeader`, `CommandLine`, detected local URL `Open in Browser` integration, and `Dialog`, plus entry points in `TabPicker`, `CommandPalette`, `PhoneMoreSheet`, `ProjectCommands`, and `ProjectStatus`.

**Verified.** `gofmt`, `go test ./internal/lsp/... ./internal/acp/... ./internal/usererr/...`, GitHub Actions `harness` (`go vet ./...`, `go test -race ./...`, `go build`), `CI`, and `desktop` workflows, `pnpm format:check`, `pnpm lint` (0 errors, 0 cycles), `pnpm --filter @octo/agent-client test` (182 tests), `pnpm --filter @octo/ui test`, `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`160.31 kB` gzip vs `161.00 kB` budget), and headless Chromium Playwright visual + frame/border/idle-animation checks across desktop dark/light (`1440×900`) and phone (`390×844`) viewports.
**Not verified.** Native Tauri/WebKit desktop sidecar runtime with real third-party ACP agent CLIs.

## As built — UX walkthrough polish & browser/processes/dock fixes (2026-11-17)

- **Browser & Design Mode (`BrowserTab.tsx`, `NoteCard.tsx`, `CssInspector.tsx`, `DesignHintBar.tsx`, `tabInfo.ts`).**
  - Split `tabRef` (`<section data-browser-tab>`) from `stageBoxRef` (`<div data-browser-stage>`) in `BrowserTab.tsx` and passed `stageBoxRef` as `NoteCard`'s `containerRef` so `NoteCard` clamps strictly within the active viewport stage (e.g., `Mobile (390px)` / `Tablet (768px)`) instead of being clipped by `overflow-hidden`.
  - Widened `NoteCard` to `w-[min(360px,calc(100%-16px))]` with `max-h-[calc(100%-16px)] overflow-y-auto overscroll-contain` so expanded CSS inspector drawers scroll within the stage bounds; widened `CssInspector` property label column from `w-28` to `w-32` so properties such as `background-color` render unclipped.
  - Replaced `DesignHintBar`'s static `"octo-design-batch-switch"` DOM ID with `useId()`, added `@container/dh` so gesture hints hide cleanly below `520px` instead of truncating to a single-character orphan on phone widths, and pinned the batch switch + `Done` cluster with `ml-auto`.
  - Removed redundant `middleTruncate` calls in `browserTabInfo` (`tabInfo.ts`) so `Tab.tsx` performs a single clean right ellipsis; added regression assertion in `tabInfo.test.ts`.
- **Processes (`ProcessesTab.tsx`).**
  - Consolidated variable 0–2 per-row `Restart`/`Stop`/`Kill` `IconButton`s into a uniform `size-6` trailing `IconMenu` slot (`<span aria-hidden className="size-6 shrink-0" />` when empty) so `PID` and duration metadata align vertically across desktop, narrow, and phone layouts.
  - Added wrapping breathing room (`className="flex-wrap gap-y-2 py-1"`) on `PanelFilters` and `min-w-44 flex-1` with shorter placeholder `"Filter processes…"` so the filter input no longer squeezes beside chips on phone/narrow splits.
- **Dock, Spacing & Demo Test Runtime (`Dock.tsx`, `WorkspaceProvider.tsx`, `styles.css`, `demo/runtime.ts`, `spacing-audit.mjs`).**
  - Rendered merged `<TabStrip>` only on the active narrow group (`showStrip = !narrow || activeNarrowGroup`, `last={narrow || last}`) and updated `openPicker` in `WorkspaceProvider.tsx` to target `L.focusedGroup(current).id` in narrow mode, eliminating duplicate `#dock-*-tab` DOM IDs while preserving the top-right actions and "+" picker anchor.
  - Adjusted `[data-floating-composer][data-collapsed] [data-composer-pad]` vertical padding from `9px` to `8px` in `styles.css` to satisfy the `spacing-audit` `scale` rule (`8px` on the `2..40` scale) at an unchanged `40px` min-height.
  - Added `.unref?.()` to `sleep()` timers in `demo/runtime.ts` so `pnpm --filter @octo/ui test` exits cleanly with code 0 without waiting on demo `orbitLive` intervals; registered `browser` and `processes` in `spacing-audit.mjs` `PHONE_PANELS`.

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors across `agent-client`, `ui`, `desktop`, 0 cycles), `pnpm --filter @octo/ui test` (`872/872` pass, clean exit), `pnpm --filter @octo/agent-client test` (`182/182` pass), `pnpm test:scripts` (`10/10` pass), `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`160.35 kB` gzip vs `161.00 kB` budget), and headless `/usr/bin/chromium` CDP walkthrough on `?demo=1` across 29 desktop (`1440×900`), narrow (`830×560`), and phone (`390×844`) dark/light states (0 spacing violations, 0 DOM/clipping/duplicate-ID/border checks, 0 console/page errors).
**Not verified.** `spacing-audit.mjs` Playwright CLI directly (`playwright` npm package is not installed in the build VM) and native Tauri/WebKit runtime.

## As built — Phase 2 UX audit & mobile decluttering (2026-11-17)

- **Grouped list frame & input spacing (`Card.tsx`, `TextField.tsx`, `controls.ts`, `FileView.tsx`).**
  - Replaced `divide-y divide-line` in `ListFrame` (`Card.tsx`) with an inset bottom hairline shadow (`[&>*:not(:last-child)]:shadow-[inset_0_-1px_0_var(--octo-line)]`) and overlay panel edge so fixed-height `ListRow` buttons (`h-ctl-lg` 44px on phone) never shrink by 1px to 43px (`spacing-audit` `row-height`).
  - Changed leading-adornment left padding in `TextField.tsx` from off-scale `touch:pl-7` (`28px`) to `touch:pl-8` (`32px`, matching the `2..40` scale), extracted `FIELD_BASE` in `controls.ts`, and added `touchSize` (`lg` default) to `TextField.tsx` so compact toolbar inputs can stay proportionate on touch screens.
  - Replaced `<Suspense fallback={null}>` around lazy `MarkdownPreview` in `FileView.tsx` with `<EditorSkeleton />` plus an `sr-only` status message (`"Opening {file.name}…"`) so Markdown previews never show an empty opaque cover while their chunk loads.
- **Mobile decluttering (`BrowserToolbar.tsx`, `UsageTable.tsx`, `MemoryView.tsx`, `PhoneMoreSheet.tsx`).**
  - Added `@container/bt` container queries in `BrowserToolbar.tsx` to hide secondary controls (`Forward`, `New browser tab`, and `Viewport` when `viewport === "full"`) and collapse `Design` to icon-only below `500px` (`@max-[500px]/bt`), giving the URL field usable horizontal width on `390px` phones; set `touchSize="sm"` (`28px`, aligned with flanking buttons) and `touch:text-sm` inside a `touch-hit` `<label>` so the URL field stays compact without touching `h-bar` edges while keeping a 44px touch target.
  - Wrapped `<CostText />` in `whitespace-nowrap` (preventing mid-label `"no price"` wraps) and hid secondary `cached` / `reqs` metadata below `440px` (`@max-[440px]/utable:hidden`) in `UsageTable.tsx` so narrow/phone rows stay compact (`in · out · cost`).
  - Shortened `MemoryView.tsx`'s clipped phone placeholder to `"Search memory…"` (`usePhone()`) and arranged `PhoneMoreSheet.tsx`'s `PANELS` launcher rows in a 2-column grid (`grid grid-cols-2 gap-1`) to reduce mobile scroll depth while preserving 44px touch targets.

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors across `agent-client`, `ui`, `desktop`, `web`, 0 cycles), `pnpm --filter @octo/ui test` (`872/872` pass), `pnpm --filter @octo/agent-client test` (`182/182` pass), `pnpm test:scripts` (`10/10` pass), `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`160.34 kB` gzip vs `161.00 kB` budget), and headless `/usr/bin/chromium` CDP audits on `?demo=1` across 66 screens (29 Phase 1 + 37 Phase 2 covering Home, Command Palette, New Project, Files + MarkdownPreview + Monaco, Review + Local branches + PR diff, Changes diff, all Settings sections across `1440×900` / `830×560` / `390×844`, Shortcuts dialog, Memory, and `PhoneMoreSheet`), each reporting 0 spacing violations, 0 DOM/clipping/border/overflow issues, and 0 console/page errors.
**Not verified.** `spacing-audit.mjs` Playwright CLI directly (`playwright` npm package is not installed in the build VM) and native Tauri/WebKit desktop sidecar runtime.

## As built — Spacing audit discovery, Browser/Processes coverage & activity guide alignment (2026-11-17)

- **Spacing audit (`packages/ui/scripts/spacing-audit.mjs`, `browser.mjs`).**
  - Updated `probe()` in `spacing-audit.mjs` to set `octo.sidebarView = "tree"` in its own probe context so project href discovery (`nav[aria-label="Projects"] a[href^="#/p/"]`) finds demo project links by title even though the default `sidebarView` is `"sessions"` (eliminating 95 skipped states).
  - Added `tool-browser`, `tool-processes`, `phone-browser`, and `phone-processes` states to `spacing-audit.mjs` so automated spacing checks cover the Browser and Processes tabs across desktop and phone viewports.
  - Added optional `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` support in `browser.mjs` (`launchBrowser`) so scripts can use a system Chromium binary when Playwright's bundled browser is not downloaded.
- **Activity row tree guide (`packages/ui/src/components/chat/ActivityRow.tsx`).**
  - Changed `[data-activity-body]`'s left margin from off-scale `ml-[7px]` to tokenized `ml-2` (`8px`), clearing the `scale` violations surfaced in `tool-tables`, `tool-showcase-expanded`, and `turn-changes-expanded` once those states stopped skipping.

**Verified.** `pnpm format:check`, `pnpm lint` (0 errors), `pnpm test:scripts`, `pnpm --filter @octo/agent-client test`, `pnpm --filter @octo/ui test` (`872/872` pass), `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`160.33 kB` gzip vs `161.00 kB` budget), and `spacing-audit.mjs --strict` via Playwright + `/usr/bin/chromium` (`0` skips across all states before the `ml-2` change, and `total=0 skipped=0` across `tool-tables`, `tool-showcase-expanded`, `turn-changes-expanded`, `tool-browser`, `tool-processes`, `phone-browser`, `phone-processes`, and `phone-settings` after the `ml-2` change).
**Not verified.** WebKit engine in `spacing-audit.mjs` and native Tauri/WebKit desktop runtime.

## As built — UI/UX audit & interaction polish (2026-11-17)

- **Popovers, focus & scroll lock (`Popover.tsx`, `hooks.ts`, `stick-on-open.mjs`).**
  - Deferred initial focus in `Popover.tsx` until `open && pos !== null` (guarded by `focusMoved` ref) so `.focus()` is not dropped while the popover renders with `visibility: hidden`.
  - Updated `useStickToBottom` (`lib/hooks.ts`) with `stopGlide()` on `wheel`, `touchstart`, `touchmove`, scroll keys, and scrollbar/autoscroll `pointerdown`, skipped re-issuing smooth glides inside `useLayoutEffect(deps)`, and gated `ResizeObserver` smooth-scroll updates on `Math.abs(el.scrollHeight - lastHeight.current) > 1`; tuned `stick-on-open.mjs`'s stream smooth-scroll settle window to `900ms`/`2100ms`.
- **Sidebar & Navigation (`SessionTree.tsx`, `ProjectWorkspace.tsx`, `backdrop-check.mjs`).**
  - Removed duplicate `, ${s.project_name}` from `SessionTree` `title` `sr-only` text (already exposed via `ListRow` `meta`) and changed `[data-tree-meta]` from `inline-flex` to `flex min-w-0 items-center gap-1 tabular-nums` with `<span className="min-w-0 truncate">` so long sidebar project names truncate with ellipsis instead of clipping mid-character.
  - Gave `{phone && <PhoneHeader />}` its own `<Suspense fallback={null}>` boundary in `ProjectWorkspace.tsx` so phone navigation renders independently of `<ProjectStatus />` and `<ProjectRunsFeed />`, and updated `backdrop-check.mjs` (`menuButton()`) to wait up to 5s for the Menu button to become visible.
- **Browser & Design Mode (`BrowserTab.tsx`, `NoteCard.tsx`, `CssInspector.tsx`, `DesignHintBar.tsx`, `PendingNotesPopover.tsx`).**
  - Replaced missing `bg-surface` and deprecated `rounded-lg border border-line` on `[data-browser-stage]` (`BrowserTab.tsx`) with `bg-window rounded-md shadow-float forced-colors:border forced-colors:border-[CanvasText]`, and removed the doubled `border border-line` on `shadow-pop` `NoteCard.tsx` (preserving forced-colors borders).
  - Kept `<label htmlFor={inputId}>` wiring in `CssInspector.tsx` and widened the property label column (`w-28` -> `w-32`) so `background-color` renders unclipped; raised `DesignHintBar.tsx`'s inline hint reveal threshold from `@[520px]/dh:block` to `@[660px]/dh:block` so split-pane viewports do not clip hint copy mid-word.
  - Eliminated nested clickable + double hover/scale styling in `PendingNotesPopover.tsx` (`li.group/row` + `<button>` row + `<IconButton>`).
- **Composer, Menus, Dialogs & Deprecated Tokens (`AccessChip.tsx`, `CommentsControl.tsx`, `PromptImages.tsx`, `ProjectCommands.tsx`, `PullList.tsx`, `DiffPanel.tsx`, `ProjectActionsMenu.tsx`, `Dialog.tsx`, `MainSkeleton.tsx`, `ImportSessionsDialog.tsx`, `PhoneChrome.tsx`).**
  - Passed `warn={props.value === "full"}` to `AccessChip` (`<Chip>` warn token) so `"Allow all"` is visually distinct without violating `frame-colours`.
  - Removed doubled `border border-line` on `CommentsControl` (`chip`), added `touch-hit`, and replaced raw `<button>` remove/clear actions with `<IconButton size="xs">` and `<Button size="xs" variant="quiet">`; switched `PromptImages` error text inside the teal bubble from `text-fg-3` to `opacity-80`.
  - Anchored hidden pinned commands (`ProjectCommands.tsx`) with `relative` + `top-0 left-0`, shortened `PullList`'s `SearchField` placeholder to `"Search pull requests…"`, switched `DiffPanel` header filenames to `<MiddleText>`, moved `tokens used` and `Budget:` `caption` items in `ProjectActionsMenu` into a separated bottom footer, gave footerless `Dialog` bodies `pb-4`, and replaced remaining `rounded-lg` classes (`MainSkeleton.tsx`, `ImportSessionsDialog.tsx`, `PhoneChrome.tsx`).

**Verified.** `pnpm format:check`, `npx eslint packages/ui/src/components/shell/ProjectActionsMenu.tsx`, `pnpm lint` (`0` errors, `0` cycles), `pnpm test:scripts` (`10/10`), `pnpm --filter @octo/agent-client test` (`182/182`), `pnpm --filter @octo/ui test` (`872/872`), `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs` (`160.40 kB` gzip vs `161.00 kB` budget), Playwright Chromium suite against production `vite preview` (`http://localhost:4173/?demo=1`) covering `picker-keys.mjs`, `stick-on-open.mjs`, `backdrop-check.mjs` (all 24 dark/light desktop/narrow/phone checks), `frame-colours.mjs`, `composer-fit.mjs` (engine + fallback), `schema-forms.mjs` (desktop + phone + axe), `slash-commands.mjs` (desktop + `--phone`), `spacing-audit.mjs --strict` (`126` initial states + `12` remaining phone `--only` states = `138` viewport-state checks, `0` violations, `0` skips), and visual screenshot inspection of dark desktop, Design Mode, Shortcuts, DiffPanel, ProjectActionsMenu, and AccessChip.
**Not verified.** WebKit Playwright engine, native Tauri/WebKit desktop sidecar binary, Go backend tests after the earlier `QA_CHANGES.md` edits, and live `harness serve` with real third-party CLIs.

## As built — Session Details, Browser proxy white screen, TabPicker Recent tabs, Changes/Review borders & chunked Review loading (2026-11-17)

- **Session-scoped Details (`DetailsPanel.tsx`, `TabView.tsx`, `sessionDetails.ts`, `useWrittenFiles.ts`, `contextMeter.ts`, `demo/sessions.ts`).**
  - Attached the Details panel (`Details` tab + `useWrittenFiles`) to the active `sessionId` (`sessionDetails.ts` pure helpers + `contextMeter` handling for `ContextBreakdown | ContextOverview`) instead of showing whole-project state.
- **Browser tab white-screen fix (`internal/browserproxy/{handler,rewrite,manager}.go`, `useBrowserSession.ts`).**
  - Fixed proxy frame loading without third-party cookies (`activated` + 15s `pendingNavs` TTL for cross-site top-level iframe requests while rejecting foreign origins and unsolicited `Sec-Fetch-Site: cross-site`), stripped `Accept-Encoding` on outbound upstream requests so `http.Transport` gunzips HTML/CSS/JS/JSON cleanly, preserved oversized HTML bodies with `io.MultiReader`, rewrote upstream/WebSocket origins across HTML/CSS/JS/JSON, stripped `upgrade-insecure-requests`/`block-all-mixed-content`/`'strict-dynamic'` CSP directives, tried all resolved loopback IPs in `newGuardedTransport`, and kept `loadedFrame` mounted across inspector `ready`/`nav` updates (`internalUrlRef`/`loadedKeyRef` in `useBrowserSession.ts`).
- **Recent tabs in `+` `TabPicker` (`tabStrip.ts`, `WorkspaceProvider.tsx`, `TabPicker.tsx`).**
  - Added `recentTabs()` / `reopenTab(tab)` (`recentPickerTabs` in `tabStrip.ts`) and rendered a searchable `"Recent"` section at the top of `TabPicker` (filtering unavailable `CHAT` / `memoryBlocked` / missing entries) with `"Files"` search results ordered right after `"Open"`.
- **Changes & Review layout polish (`ChangesView.tsx`, `PullList.tsx`, `BranchList.tsx`) and chunked loading (`usePullList.ts`, `lib/review/{branches,pullList}.ts`).**
  - Added `border-t border-line` to `[data-v7-changes]` (`ChangesView.tsx`) and `ViewTabs` (`PullList.tsx`), removed `column="measure"` / `PANEL_COLUMN` wrappers in `PullList.tsx` and `BranchList.tsx` to balance the Review tab width, and switched `PullList` (`CHUNK_SIZE = 30`) and `BranchList` (`BRANCH_CHUNK = 25`) to chunked loading with `"Load more"` pagination.

**Verified.** `gofmt`, `go vet`, `go test -race ./internal/browserproxy/... ./internal/gitx/... ./internal/codehost/...` (including `TestCrossSiteIframeWithoutCookiesGzipCSPAndOriginRewrite`, `TestLocalBranchesChunk`, `TestGHListPRsLimit`), `pnpm format:check`, `pnpm lint`, `pnpm --filter @octo/agent-client test`, `pnpm --filter @octo/ui test`, `pnpm test:scripts`, `pnpm --filter @octo/desktop build`, and `node scripts/check-bundle-size.mjs`.
**Not verified.** `apps/harness/internal/review` and SQLite-dependent Go tests (blocked offline by uncached `modernc.org/sqlite@v1.62.0` returning HTTP 403), Playwright browser/spacing runs and native Tauri/WebKit runtime on these changes.

## As built — UI tab feature flags (2026-11-17)

- **Feature flag definitions and context (`packages/ui/src/lib/tabFlags.ts`, `packages/ui/src/state/tabFlags.tsx`, `OctoApp.tsx`, `index.ts`).**
  - Added `DEFAULT_TAB_FLAGS` disabling six dock tool tabs by default (`sessions`, `agents`, `notes`, `details`, `usage`, `memory` set to `false`) while keeping the remaining tool tabs enabled (`files`, `browser`, `terminal`, `processes`, `changes`, `review`, `side` set to `true`).
  - Added `resolveTabFlags(overrides, search)` and `<TabFlagsProvider>` / `useTabFlags()` supporting host prop overrides (`<OctoApp tabs={...} />`) and URL query overrides (`?tabs=all`, `?tabs=none`, `?tabs=sessions,usage`, `?tabs=all,-notes`), with zero impact on `apps/harness`, `apps/router`, or `@octo/agent-client`.
- **Workspace, dock, menus, status, and slash commands (`WorkspaceProvider.tsx`, `TabView.tsx`, `ProjectTeam.tsx`, `TabPicker.tsx`, `PhoneMoreSheet.tsx`, `paletteCommands.ts`, `ProjectActionsMenu.tsx`, `TabMenu.tsx`, `SessionTree.tsx`, `Composer.tsx`, `ComposerMenu.tsx`, `FolderMenu.tsx`, `SessionMenu.tsx`, `ProjectStatus.tsx`, `slash.ts`, `slashRun.ts`, `InlineNotes.tsx`).**
  - Guarded `openTool`, `openBrowser`, `openTerminal`, `firstLayout`, pending tool requests, `canReopen` / `reopenClosed` / `reopenTab`, `TabView`, and layout hydration/pruning so disabled tool/browser/terminal tabs never mount and stale persisted tabs are pruned automatically while keeping enabled tabs (`Changes`, `session:<id>`, `agent:<id>`) intact.
  - Hid the top-bar `Sessions` icon button and `ProjectSessionPicker` (`[data-sessions-button]`) when `tabFlags.sessions` is `false`, while preserving left-sidebar `SessionTree` sessions, `/new`, and side-by-side `session:<id>` conversation tabs ("another sessions").
  - Filtered disabled tool tabs from `TabPicker`, `PhoneMoreSheet`, `CommandPalette`, `ProjectActionsMenu`, `TabMenu`, `ComposerMenu`, `SessionMenu`, `NewSessionButton`, `DelegationGroup`, `ContextReport`, and slash commands (`/memory` and `/review` gated on their UI flags while keeping `/remember` active); routed `ProjectStatus`'s `Budget` pill to `#/settings/usage` when `usage` tab is disabled; extracted `FolderMenu.tsx` as a lazy chunk alongside `SessionMenu` to stay under the `161.00 kB` initial JS budget.

**Verified.** `pnpm format:check`, `pnpm lint` (`0` errors, `0` cycles), `pnpm test` (`877/877` `@octo/ui`, `182/182` `@octo/agent-client`, `41/41` `@octo/desktop`, `10/10` `test:scripts`), `pnpm --filter @octo/desktop build`, `pnpm --filter @octo/web build`, `node scripts/check-bundle-size.mjs` (`160.96 kB` gzip vs `161.00 kB` budget), and Playwright Chromium against `vite preview` covering `slash-commands.mjs` (`slash-commands: ok`), `spacing-audit.mjs --only home,chat-short,phone-more` on both `?demo=1` and `?demo=1&tabs=all` (`total=0 skipped=0`), and end-to-end persistence pruning + screenshot checks (`default-tab-flags.png`, `override-tabs-all.png`).
**Not verified.** WebKit Playwright engine and native Tauri desktop binary.

## As built — Interactive PTY Terminal tab, reliable project & session deletion, project selector on new session, and single-tab-per-session deduplication (2026-11-17)

- **Interactive PTY Terminal tab (`apps/harness/internal/terminal/`, `apps/harness/internal/bridge/terminal*.go`, `packages/agent-client/src/terminal*.ts`, `packages/ui/src/components/terminal/`, `packages/ui/src/demo/terminal.ts`).**
  - Added harness PTY session manager (`POST /v1/projects/{id}/terminals`, `GET .../events` SSE with `?token=`, `POST .../input`, `POST .../resize`, `DELETE .../terminals/{tid}`) using sanitized child environments (`childenv`), process-group termination, 8-session per-project cap, Remote-access `ClassDeny`, and `Processes` worker visibility (`kind: "terminal"`).
  - Added `Bridge.openTerminal` in `@octo/agent-client` and lazy-loaded `@xterm/xterm` + `@xterm/addon-fit` `TerminalTab` (`86.8 kB` gzip lazy chunk) in `@octo/ui`, supporting singleton `terminal` (`Ctrl+\``) and multi-instance `terminal:<id>` (`Ctrl+Shift+\`` / `+`), working-folder switching, clear/restart, theme sync, and an in-memory demo shell for `?demo=1`.
- **Reliable project and session deletion (`apps/harness/internal/{projectstore,project,bridge}/`, `deleteProject.ts`, `DeleteProjectDialog.tsx`, `deleteSession.ts`, `SessionTree.tsx`, `ProjectWorkspaceStates.tsx`).**
  - Added `projectstore.Store.Has` (checks `registry.sqlite` without opening `project.sqlite`), `makeWritableTree` before `os.RemoveAll` for read-only (`0555`/`0444`) worktree/module-cache trees, `Service.DeleteForce` (`DELETE /v1/projects/{id}?force=1`) stopping active turns/approvals/sessions/side/ACP processes, and `terminals.CloseProject(pid)` on project deletion.
  - Added `deleteProjectCleanly` and `DeleteProjectDialog` wired into `SessionTree` project rows (`⋯` button + context menu), `ProjectList`, `HomeProjects`, `ProjectWorkspace` settings, and `LoadError` (`ProjectWorkspaceStates.tsx`).
  - Added `deleteSessionCleanly` (`deleteSession.ts`), enabling `"Delete…"` on all sessions (including default, running, and a project's sole main session — stopping active work, promoting another main session or creating a fresh empty default session before deletion) across `SessionTree`, `useSessionActions`, `SessionDetail`, `SessionRows`, and `demo/sessions.ts`.
- **Project selector when creating a session (`NewSessionPopover.tsx`, `Sidebar.tsx`, `AppShell.tsx`, `SessionTree.tsx`, `HomeProjects.tsx`, `NewSessionButton.tsx`, `SessionsTab.tsx`, `TabPicker.tsx`, `CommandPalette.tsx`).**
  - Updated `NewSessionPopover` (`components/shared/NewSessionPopover.tsx`) to always display a `Project` `<Select>` pre-populated with the active/default project and navigate to `#/p/<pid>/s/<sid>` when creating a session in another project; wired into the left sidebar (`New session` row below `New project` + section caption `+` in both `tree` and `sessions` modes), `HomeProjects`, `NewSessionButton`, `SessionsTab`, `TabPicker`, and `CommandPalette`.
- **Single-tab-per-session deduplication & closable first conversation tab (`WorkspaceProvider.tsx`, `Tab.tsx`, `TabStrip.tsx`, `TabMenu.tsx`, `paletteCommands.ts`, `nav.tsx`, `floors.ts`).**
  - Fixed initial `#/p/<pid>/s/<sid>` hydration and deduplicated `openSession`, `showSession`, `followSession`, `openIn`, `reopenClosed`, `recentTabs`, and `reopenTab` (plus an auto-dedup effect) so `L.CHAT` and `session:<id>` never show the same session twice.
  - Added `ws.canClose(tab)` making `L.CHAT` closable (`×` button, middle-click, `Ctrl/Cmd+W`, tab menu, palette) whenever at least one other main session tab is open, promoting the surviving session into `L.CHAT` cleanly on close.
  - Lazy-loaded `FloatingComposer`, `ProjectGone`/`LoadError` (`ProjectWorkspaceStates.tsx`), `ProjectTeam`, `DragLayer`, and `Announcer` to keep initial JS under the `161.00 kB` gzip budget (`160.74 kB` gzip).

**Verified.** `gofmt -l .`, `go vet ./...`, `go test -race` across `internal/usererr`, `internal/terminal`, `internal/projectstore`, `internal/project`, and `internal/bridge` (including `TestNoAdHocErrorBodies`, `TestCatalogueEveryCodeHasUserText`, `TestManagerStartWriteResizeAndClose`, `TestTerminalLifecycleAndProcesses`, `TestDeleteProjectForceAndBrokenStore`), `pnpm format:check`, `pnpm lint` (`0` errors across `agent-client`, `ui`, `desktop`, `web`, `0` import cycles), `pnpm test` (`889/889` `@octo/ui` including `deleteSession.test.ts` and `floors.test.ts`, `182/182` `@octo/agent-client`, `41/41` `@octo/desktop`, `10/10` `test:scripts`), `pnpm --filter @octo/desktop build`, `pnpm --filter @octo/web build`, `node scripts/check-bundle-size.mjs` (`160.74 kB` gzip vs `161.00 kB` budget), live Playwright Chromium E2E against `harness serve` + Vite verifying single-tab session load, closable first session tab, cross-project `New session` selector, live PTY `TerminalTab` I/O + multi-instance tabs (`terminal-tab.png`), UI deletion of default & sole sessions, UI deletion of a project with open PTY terminals, and `?demo=1` interactive terminal shell (`0` page errors), plus `slash-commands.mjs` (`slash-commands: ok`) and `spacing-audit.mjs --strict` across `home`, `empty-project`, `tool-browser`, `tool-processes`, `tool-terminal`, `phone-more`, and `phone-terminal` (`total=0 skipped=0`).
**Not verified.** WebKit Playwright engine, Windows PTY implementation (stubbed with explicit unsupported error), and native Tauri desktop binary.

## As built — Direct session creation, inline agy-style composer project selector & empty-project sidebar visibility (2026-11-17)

- **Removed pre-creation modal/popover selector (`createSession.ts`, `AppShell.tsx`, `Sidebar.tsx`, `SessionTree.tsx`, `HomeProjects.tsx`, `NewSessionButton.tsx`, `SessionsTab.tsx`, `state/activity.tsx`).**
  - Deleted `shared/NewSessionPopover.tsx` and `sessions/NewSessionPopover.tsx`; removed the `Project` `<Select>` dropdown from `NewSessionButton.tsx` and `SessionsTab.tsx`.
  - Added `lib/sessions/createSession.ts` (`createAndOpenSession`) wired into `SessionTree` (`+` buttons and project row menu `"New session"`) and `HomeProjects` (`New session`), and removed the redundant top-nav `+ New session` row (`onNewSession`) from `Sidebar` and `AppShell`, creating & opening a session directly in the active or newest project and focusing its `#octo-composer` with zero modal.
  - Bound `ActivityStore.refreshSessions` (`state/activity.tsx`) as an arrow property so destructured / option-passed callbacks (`createAndOpenSession(..., { refreshSessions: activity.refreshSessions })`) keep their `this` context.
- **Inline composer project selector & draft handoff (`ComposerProjectBar.tsx`, `ConversationView.tsx`, `composerDraft.ts`, `composerDraft.test.ts`, `useOrchestratorComposer.ts`, `focus.ts`, `styles.css`).**
  - Wrapped empty orchestrator sessions in `[data-composer-shell]` (`.octo-composer-shell` in `styles.css`) pairing lazy-loaded `ComposerProjectBar` (`<FolderGit2> {project.name} <ChevronDown>` project `Picker`, plus `<GitBranch> Main checkout <ChevronDown>` / worktree label and `MoveToWorktreeDialog` menu) directly above `<Composer>` without remounting `<Composer>` once conversation messages arrive.
  - Added `clearDraft`, `stashCrossProjectDraft`, `takeCrossProjectDraft`, and `applyCrossProjectDraft` in `composerDraft.ts` (covered by `composerDraft.test.ts` and wired in `useOrchestratorComposer.ts`) so switching projects from `ComposerProjectBar` reuses an unused empty main session when available (else creates one), transfers typed draft text across project switches, deletes any previous unused non-default empty idle session (`ws?.dropTab` + `bridge.deleteSession`), and moves focus to the newly visible `#octo-composer`.
  - Updated `visibleComposer()` (`lib/focus.ts`) to scan all matching `#octo-composer` elements via `document.querySelectorAll` so an inactive hidden session tab in `Dock` never shadows a newly opened tab's visible composer.
- **Empty-project & active-session visibility in sidebar (`lib/sessions/flat.ts`, `flat.test.ts`, `state/sessionIndex.ts`, `SessionTree.tsx`).**
  - Added `flatSessions` and `treeSessions` in `lib/sessions/flat.ts` (covered by `flat.test.ts`) so the default `"sessions"` sidebar (`Sessions`) retains the active session even while empty (`exchanges === 0`) and shows one representative session (default else newest) for any project that has no non-empty sessions yet, preventing an empty sidebar while project/terminal tabs are open; shows skeleton loading while `index.loaded` is pending, marks `useSessionIndex`'s `loaded` true after retry failure (`failed > 0`) so projects are not stuck behind skeletons, and falls back to `ProjectRow` for any still-unrepresented project.
  - Updated `treeSessions` and `ProjectRow`'s `active` check in `"tree"` mode (`!shown.some((s) => s.id === currentSession)`) so empty open projects keep their selected highlight and newly created empty sessions appear when a project already has session rows.

**Verified.** `pnpm format:check`, `pnpm lint` (`0` errors across `agent-client`, `ui`, `desktop`, `web`), `pnpm test` (`@octo/ui` `901/901` including `composerDraft.test.ts` and `flat.test.ts`, `@octo/agent-client`, `@octo/desktop`, `test:scripts`), `pnpm --filter @octo/desktop build`, `pnpm --filter @octo/web build`, `node scripts/check-bundle-size.mjs` (`160.89 kB` gzip vs `161.00 kB` budget), `spacing-audit.mjs --only home,empty-project,chat-short --strict` (`total=0`, `skipped=0`), `frame-colours.mjs` (dark & light ok), and Playwright Chromium E2E + screenshot inspection (`1440×900` / `1280×800` dark/light desktop & `390×844` dark/light phone) covering default `Sessions` empty-project + terminal tab visibility, `Tree` empty-project selection, absence of the top-nav `New session` row, Home/`Sessions +`/`ProjectRow +` direct creation with no modal, `ComposerProjectBar` switching, cross-project draft & focus transfer, unused empty session cleanup, and shell hiding after send (`0` errors).
**Not verified.** WebKit Playwright engine, native Tauri desktop binary, and live `harness serve`.

## As built — QA Pass 4 fixes (2026-11-17)

- **Explicit `Processes` row actions (`ProcessesTab.tsx`).**
  - Added visible explicit `Stop` (`Square`) and `Kill` (`OctagonX`) `IconButton`s with `trailingShown={canStop || canKill}` and `size={phone ? "lg" : "xs"}` alongside the `⋯` `IconMenu` in `ProcessRow` (`ProcessesTab.tsx`) so active command runs expose `Stop` (`SIGTERM`) directly on every row on desktop and phone while active LSP/agent workers expose `Kill` (`SIGKILL`) and desktop retains both `Stop` + `Kill` on active commands.
- **Phone layout on touch landscape viewports (`phone.ts`, `phone.test.ts`, `AppShell.tsx`, `shell/Panel.tsx`, `styles.css`).**
  - Updated `PHONE_QUERY` (`packages/ui/src/lib/phone.ts`) to `"(max-width: 640px) and (pointer: coarse), (max-height: 479.98px) and (pointer: coarse), (max-width: 479.98px)"` (tested in `phone.test.ts`), keeping `data-phone` active on landscape touch phones (`844×390`, `740×360`) without switching into a cramped desktop strip.
  - Updated `AppShell.tsx` (`phone:px-0`, `phone:pt-bar`) and `shell/Panel.tsx` (`phone:rounded-none phone:border-0 phone:shadow-none`) to replace viewport-width `max-[479.98px]:*` rules, and hid responsive `[data-key-hint][class~="max-sm:hidden"]` keyboard badges under `[data-phone]` (`styles.css`).
- **`>= 44 px` phone touch targets (`styles.css`, `FilterTabs.tsx`, `Segmented.tsx`, `MenuButton.tsx`, `primitives/Panel.tsx`, `ComposerPills.tsx`, `ComposerProjectBar.tsx`, `PendingNotesPopover.tsx`, `UsageTable.tsx`, `ModelPicker.tsx`).**
  - Enlarged `[data-phone]` `touch-hit` `IconButton`/`Button` (`xs`/`sm`/`md`) and `[data-composer-row] > button` boxes to `44×44` (`--spacing-ctl-lg`) and matched `[data-phone] [data-jump-room]` to `--spacing-ctl-lg` (`44px`) in `styles.css` so the `Jump to latest` button fits inside its room without overlapping compacted-history markers.
  - Updated `FilterTabs` (`phone:h-ctl-lg phone:min-w-ctl-lg` on wrapper and `radio` buttons), `Segmented` (`phone:h-ctl-lg phone:p-0`, `phone:min-w-ctl-lg`), `MenuButton` (`touch-hit phone:h-ctl-lg phone:min-w-ctl-lg`), `DetailHeader` back/actions slots (`phone:h-ctl-lg`, `phone:min-h-ctl-lg`), `ComposerPills` (`phone:min-h-ctl-lg`), `ComposerProjectBar` (`phone:min-h-ctl-lg`), `UsageTable` footer (`phone:min-h-ctl-lg`), `PendingNotesPopover` row (`touch:min-h-ctl-lg`), and `ModelPicker` field trigger (`touch:h-ctl-lg`).
- **Harness `TestAcceptEditsAutoApprovesWritesAndAsksForBash` flake (`v7_approvals_test.go`).**
  - Replaced `waitApprovals(t, pid, 1)` + manual turn polling in [`v7_approvals_test.go`](apps/harness/internal/bridge/v7_approvals_test.go) with `e.turnWithApprovals(t, pid, "Go [bash:echo ok > cmd.txt]", allow)` asserting every seen approval has `Kind == "command"`.

**Verified.** `gofmt -l apps/harness/internal/bridge/v7_approvals_test.go`, `pnpm format:check`, `pnpm lint` (`0` errors, `0` cycles across `849` files), `pnpm test` (`184/184` `@octo/agent-client`, `902/902` `@octo/ui` including `phone.test.ts`, `41/41` `@octo/desktop`, `10/10` `test:scripts`), `pnpm --filter @octo/desktop build`, `pnpm --filter @octo/web build`, `node scripts/check-bundle-size.mjs` (`160.92 kB` gzip vs `161.00 kB` budget), `slash-commands.mjs --phone` (`slash-commands: ok`), Playwright Chromium verification across `1440×900`, `844×390` & `740×360` landscape phones (`data-phone=true`, `overflowX=false`, `mainPaddingLeft=0px`), and `390×844` / `360×740` portrait phones (`0` control target issues across Chat, Processes, Sessions, Terminal, Browser, Side question, Agents, Notes, Usage, Review, and Changes; `DiffPanel` `retry.ts` `0` overlap/overflow) with screenshot inspection, plus `spacing-audit.mjs --query "demo=1&tabs=all" --strict` (`total=0`, `skipped=0` across `chat-idle`, `delegation`, `tool-processes`, `tool-browser`, `tool-terminal`, `v7-gallery`, `phone-home`, `phone-nav`, `phone-plus`, `phone-files`, `phone-changes`, `phone-browser`, `phone-processes`, `phone-terminal`, `phone-settings`, and phone panel runs).
**Not verified.** `go test -race` on `apps/harness/internal/bridge` (`TestAcceptEditsAutoApprovesWritesAndAsksForBash`) could not run in this offline/proxy-blocked VM (`modernc.org/sqlite@v1.62.0` absent from `GOMODCACHE` and `proxy.golang.org` returns HTTP `403`); WebKit Playwright engine and native Tauri desktop binary.

## As built — work-surface polish (2026-11-18)

A reviewed list of small fixes to the editor, Review, terminal, browser, Processes, side question, Settings and Details. No
new dependency, no primitive variant, behaviour unchanged except where stated.

- **Editor.** (1) Ghost text: `editorGhostText.border: #00000000` made Monaco draw a transparent 1px border on each side of every
  ghost token ("." 9.8px against 7.8px of real code); the key is gone and a ghost glyph now advances 7.8px, as code does.
  (2) Ghost text takes the line-number tone (`editorGhostText.foreground` and `.ghost-text` read `--vscode-editorLineNumber-foreground`):
  dark `#888` 5.06:1, light `#707070` 4.95:1 (it was `fg-3`, as loud as a comment). Cursor's palette gives 4.36:1, the same as its
  line numbers. (6) One mono stack: the editor, both diff editors and the terminal read `--font-mono` (`lib/monoFont.ts`, tested);
  xterm cells measure 7.86px against the canvas's 7.83 and the cursor sits in the cell. (7) Diff tints: a changed line is the ok /
  err token at 14 % / 12 % (was 9 % / 8 %; 1.28 / 1.21:1 against the editor in dark, 1.23 / 1.22 in light, was 1.15 / 1.14). A
  changed word stays one more 14 % / 12 % layer on its line (Monaco stacks the two, about 26 % / 23 %): 28 % on top, as asked,
  took comments and keywords down to 3.4:1 on a changed word, so it was not done; code text is at least 7:1 on every tint, syntax
  colours about 4.4:1 on a changed word (as before). The conversation's `.octo-diff` lines match (14 % / 12 %), its opaque gutter
  cell goes 18 % / 15 % → 22 % / 20 % (line numbers `fg-3` stay ≥ 4.6:1). Changes and Review share `diffColors()`. (11) The file
  bar no longer shows a second unsaved mark: under 640px a ready language server shows nothing (its lone dot beside "Unsaved"
  read as one), under 440px "Unsaved" is for screen readers only (the tab's dot says it).
- **Review.** (3) The chip "Review requested" is "To review" (`lib/review/pullList.ts`, tested; the pull-request row still says
  "Review requested" as its state). Under 420px the search is an `IconButton` that opens the field in place of the chips (focus
  moves into it; Esc with no text, or leaving it empty, closes it and focus returns to the button; `closesSearch`, tested). At a
  363px dock the four chips end at 270px in one 40px row (they were partly under the fade). (4) A review diff stays behind its
  spinner until Monaco reports the first computed diff of the new models (`lib/review/diffWait.ts`, tested), with a 6 s fallback:
  in the demo the text appeared after about 3 s already aligned and tinted. (9) The thread header's "Others' text, shown as text"
  is gone (the comments are Markdown; the words added nothing).
- **Rows and dock.** (5) `ListRow`: actions that show on hover or focus take no width; with a fine pointer in a wide window they
  overlay the row's end on the row's own fill (`.octo-row-host` / `.octo-row-actions` in `styles.css`; the list surface is
  `--row-surface`, default panel), and the meta and any `data-row-tail` (the dates of Sessions and Memory rows) give way while they
  show. Touch keeps them in the flow and always visible. The `ROW_TAIL` spacers of Sessions and Memory and the empty slot of Notes
  are gone, so their dates end on the row's edge. Processes keeps Stop and Kill in view (QA pass 4) in a slot as wide as the widest
  set (76px, 84px on a phone; a row with only "⋯" shows it on hover): its PID / duration column ends at one x (1335 on all four
  demo rows, was 538/564/564/590 in the reviewer's dock), with no change on hover. (8) The side question's starters are secondary
  buttons sized to their text. (10) The terminal's PID is in the status dot's tooltip ("Running · PID 51423"). (13) The browser's
  address field lets go of focus once a navigation starts. (14) Memory: not reproduced — the second line under the view tabs is
  the bottom edge of the bordered search field (y105), not a hairline; nothing changed.
- **Settings and Details.** (12) Privacy: the group "Feature flags" is "Memory", its footer "Applies to every project right away."
  (`apps/harness/docs/memory.md` names the new path). (15) A tier model whose provider is not connected says "provider not
  connected" under it, not only amber. (16) Oh My Pi's fallback mark is the hexagon (it hashed to the triangle, as Factory Droid).

**Verified.** Playwright Chromium on `?demo=1&tabs=all` (dark and light, 1440×900 with a 363px dock, maximised review, 900×700 and
390×760 for the touch path), screenshots in the session's `work-after/`; `pnpm format:check`, `pnpm lint` (0 errors, no cycles),
`@octo/ui` tests, `pnpm --filter @octo/desktop build`, `check-bundle-size.mjs` (160.94 kB of 161.00), `spacing-audit.mjs`
(`total=0`). **Not verified.** WebKit, a real touch device, the live harness, a real completion model.

Owner decisions of 2026-11-18 (the four items held back from the polish list):

- **G1 (2026-11-18).** A dock tab's bar repeats no title: `Panel` keeps `title` as the section's accessible name only, and the
  bar is the lead (the (i) purpose button, now `sm` with no negative margin, so its box starts at 8px as the first buttons of
  Files and Browser; the review's repository menu), the meta ("4 running"), then the actions at the right. A bar with only the
  (i) stays, so all tabs share one 40px anatomy. Every `Panel` user is a dock tab (no dialog or page uses it). Tested
  (`Panel.test.ts`); `spacing-audit.mjs` measures the bar's first element instead of the title. Checked all 13 tool tabs in
  dark and light (`?demo=1&tabs=all`, the Atlas project and Design system tokens): no `h2` in any bar, header 40px.
- **G2 (2026-11-18).** File-tree rows are 24px (`h-ctl-xs`; touch keeps `touch:h-ctl-lg`, 40, 44 on a phone; every other list
  stays 28). Indent guides: the indent spacer draws a 1px `line` per 12px level under each ancestor's glyph, only while the
  tree is hovered or holds focus (`.octo-tree-indent`, a background: nothing moves). Checked dark and light: every tree row
  24px, rows 24px apart, the same tops at rest and on hover; ArrowDown moves focus; the filter ("token") leaves 4 rows;
  `file-open-stability.mjs` ok. Not measured: a real phone (the touch height is the unchanged `touch:` rule).
- **G3 (2026-11-18).** Processes says who started each process, after the state: "Running · by you · pnpm dev". Runs and
  terminals are always the person's (no agent can start one, `apps/harness/docs/commands.md`), a run from a review says "by you,
  from a review", a language server "by the editor", an agent worker "by <its session's title>". The harness did not send the
  session an ACP worker serves; it now does (`session_id` on `GET …/processes`, kind `agent`, from the orchestrator's existing
  record; `internal/bridge/processes_test.go`), and the demo's worker carries the default session. `processStarter`
  (`lib/processes/model.ts`) is tested; an unknown or missing session says nothing. A long session title gives way (half the line).
- **G4 (2026-11-18).** The editor's menu starts with "Add to chat": the selected lines (or the caret's line) go into the
  conversation's composer as a file mention with its range, `@src/auth/refresh.ts:9-14` (the `@path` the "+" menu inserts,
  appended to the draft with a space either side), and the caret moves to the composer. A file in the tree has a right-click
  menu (`Menu`, decision 95) with "Add to chat" (the file, no range) and "Copy path". The files feature does not import the
  chat: the conversation's composer registers how to insert (`state/chatInsert.ts`, tested; the last mounted composer wins)
  and the item shows only while one is there; the text goes through the composer's shared draft (`appendToDraft`).
  `lib/chatMention.ts` (tested: lines, a trailing column 1, the composer reading the range as one mention).
  `editor-context-menu.mjs` now also checks both entries (the composer holds `@src/auth/refresh.ts:2 ` and has focus; then
  `@src/auth/tokens.ts `). The Changes and Review diffs offer it too (they share `EditorContextMenu`).

Merged with the tool-tab consistency pass (2026-11-19): Processes follows that pass (E: actions on hover and focus, always on
touch and the phone), and with this pass's `ListRow` overlay the hidden actions take no width, so the PID / duration column
lines up; the fixed 76px slot above is gone, the phone keeps an 84px slot. The review picker keeps that pass's single
`PanelFilters` row (B) and adds the search button below 420px. The side question's starters stay `secondary` (item 8; that
pass made them quiet text-sized buttons, and calls `secondary` the other tabs' empty-state action). `Panel` keeps that pass's
full-width bar hairline (A) around G1's title-less header.



## As built — shell polish pass (2026-11-18)

Small fixes from a review of the shell (sidebar, top bar, status bar, overlays, copy). No redesign; existing tokens and primitives.

- **Sidebar list.** The flat Sessions list sorts by start (newest first, then id), not by activity, so rows no longer swap under
  the pointer every few seconds (`lib/sessions/flat.ts`). It shows its skeleton until the session index has loaded, then the
  whole list at once (was: empty → three sessions and nine project rows → sixteen session rows). On hover the row's meta leaves the
  layout (`display: none`) instead of keeping its width, so the title gains the room (measured 133 → 172 px; was 133 → ~109).
  Rename keeps the row's state glyph and puts the field's text exactly where the title was (x = 48 before and in the field;
  was 48 → 32), selects the whole title and shows its beginning. A session waiting for the person shows its age like a failed
  one (`sessionMeta`). A session row's tooltip names the agent that runs it (`sessionAgentName` in `lib/sessionAgent.ts`: an ACP agent
  by its label, Octo's own loop by its model).
- **Sidebar width.** The sidebar has a resize handle in the 8px gutter to the first panel (`primitives/ResizeHandle`, the
  pointer and keyboard logic the dock's `Divider` now also uses; loaded lazily): drag, ←/→ ±16 (Shift ±64), double-click resets.
  The width is the `sidebarWidth` preference (200–480, default 260, `lib/sidebarWidth.ts`), applied as `--spacing-sidebar` on the
  element; a drag previews it in an animation frame without a React render (measured: the panel beside it mutates at its idle
  rate during a drag) and stores it on release. Settings' column takes the same width. A flat Sessions row caps its project
  name at 33% (ListRow's 40% is for a time or a count). Measured at 1440: 260 → 380 by drag, ← to 364, double-click to 260,
  clamped at 480, kept over a reload; a title in the flat list 123 → 193 px at 380. Not in the drawer or on the phone.
- **Top bar and status.** The agents count is a count, not a command: dim (`fg-3`, `fg` on hover) tabular figures and 12px
  before the command buttons beside it (measured gap 4 → 12). The status bar says "N projects working" ("1 project working").
  The "+" tab menu opens from the "+" (start-aligned: left edge 188 → 480 with the "+" at 480) instead of over the sidebar.
  Terminal tabs that would share a name are numbered in open order (`terminalOrdinals` in `components/terminal/ordinals.ts`, written into the tab state by the terminal's session store): "zsh ·
  orbit-app", "zsh · orbit-app 2", in the tab, its tooltip and the tab picker (the command palette lists no terminal tabs).
- **Overlays.** The command palette lists "New session in …" for the projects the query names (a word of the name starts
  with it), else for two projects (the open one first): "re" gives two such rows, not four. The "Show …" rows' details are
  short sentences (`TOOL_HINT`: "Read a pull request and review it.", was "pick one, read it, comment, submit"), as are
  Help's, Change model's and Open a tab's. (With "re" Settings is still below the fold: the sessions and projects that
  match come first; not changed.) The keyboard-shortcuts sheet's rows are `min-h-row` (28px) and a `reading` dialog body
  has 24px at its end, the fade's height: at 1440×900 the sheet fits whole (no scroll, last row 40px above the body's
  end); at 1100×700 it scrolls and the last row ends 40px clear of the fade. A tooltip the pointer armed hides on
  `pointerleave` of its control and shows only while the control is still `:hover` and connected (`lib/tooltipGate.ts`,
  tested); measured: after leaving a row to the gutter, and after leaving before the delay, no tooltip.
- **Copy and identity.** A session title from a request is cut at the last space at or before 80 characters and ends
  with "…" (`projectstore.SessionTitle`, Go-tested; the demo's `lib/sessions/title.ts` mirrors it); the harness's empty
  title is "New session" (was "Session"), the one name the UI uses. Home's session rows name who runs them: "Atlas API ·
  Claude Code · Waiting for you" (`sessionAgentName`: the session's `model`, an ACP agent by its label, never its id;
  Octo's own loop by its model, "Sonnet 5.5"). The waiting rows there now show their age. With only Ollama ready the
  connect screen's line reads "Ollama is connected. Projects also need a coding agent, an API key or the router."
  (`connectSubtitle`, tested; the screen itself not driven, the demo has no Ollama-only state).
- **Entry budget.** These items first took the initial JS from 160.92 to 161.64 kB gzip (budget 161.00). Code a module that
  loads with the app exports stays in the entry even when only a lazy chunk calls it, so: `sessionAgentName` is its own module;
  the palette's `TOOL_HINT` moved to `state/workspace/paletteCommands.ts`; the terminal ordinals live with the terminal
  (its session store numbers the tabs when one opens or closes); the sidebar's stored width is read and applied by its edge
  (`shell/SidebarEdge`), which rides in the Projects list's chunk that the sidebar asks for at once: a width other than the
  default can show one frame after the first paint. Result: 160.90 kB.

## Owner decisions — shell polish follow-ups (2026-11-18)

The owner approved five changes the polish review had left as their decisions. Each is its own commit; where one
supersedes an earlier decision, that decision carries a dated note pointing here.

- **F1. Sidebar session rows are 28px** (`--spacing-row`, the tree-row height of the row-height table in `styles.css`), not
  32: a session row under a project and a row of the flat Sessions list are `ListRow size="sm"`, the row's "⋯" sits 2px
  from its top, the rename field is 24px in the 28px row (its text still on the title's x, measured 48 → 48), the
  loading skeleton of the flat list has the same height. Project rows and the nav rows above stay 32px; on touch every row
  keeps its 44px (`touch:h-ctl-lg`). Measured: row height 32 → 28 at 1440.
- **F2. The conversation tab drops "Project /"** while every tab of the workspace belongs to one project (`conversationLabel`
  in `dock/tabInfo.ts`, tested): the tab reads "Upgrade us to React Native 0.80…", its tooltip and `name` keep "Orbit mobile
  / …" (the palette's de-duplication reads `name`). With tabs of two or more projects the project is the label and the topic
  dim. A workspace holds one project's tabs today, so the prefix is always dropped; the count is a parameter (`projectsInTabs`)
  for the day it does not. Revises decisions 63 and 67 (dated notes there).
- **F3. The flat Sessions list pins "Needs you"** (`pinNeedsYou` in `lib/sessions/flat.ts`, tested): sessions that wait for
  the person or failed — Home's rule, `sessionTriageOf` — come first under a "Needs you" caption, the rest under "Other
  sessions"; each group keeps the stable order by start (item 1), so a row moves only when its state changes. No captions
  when nothing needs the person. Revises the pinned-group note of the review (it was left to the owner).
- **F4. A sub-agent's tab is the agent's label** ("Dependency auditor": `roleText` of its role, "Agent" without one, never its
  id), not its task; the task stays in the agent's header and in the tab's tooltip ("Dependency auditor: Breaking changes
  0.76 → 0.80"). Tested in `tabInfo.test.ts`. Revises decision 63 (dated note there).
- **F5. Ollama alone still does not leave the connect screen.** The owner allowed it if Ollama's models can run tools. The
  harness has no such signal: its Ollama provider (`internal/providers/providers.go`) is the "dedicated small tier for inline
  editor completions", its catalogue (`ollamaCatalogue`: Qwen 2.5 Coder 1.5B/3B, StarCoder2 3B, CodeLlama 7B) carries no
  capability field, `Connected` does not count it, and the only Ollama route in the orchestrator is inline completion
  (`config.IsOllamaCompletion`). So the gate (decision 53 b, `noProvider` in `app/AppShell.tsx`) is unchanged and the
  connect line of item 10 says what Ollama does not cover. Leaving the screen needs a harness change first: a tool-capable
  flag per Ollama model (for example from Ollama's `/api/show` capabilities) and an orchestrator path that runs on it.

## As built — tool-tab consistency pass (2026-11-18)

Polish, not a redesign: every dock tool tab measured against the Files / Browser bar (40px bar, 8px inset, a `line` hairline
under it, 28px quiet icon buttons 4 apart, a 36px `PanelFilters` row, `EmptyState`), and the smallest change that removes
each deviation.

- **A. Panel hairline (`primitives/Panel.tsx`, `v7/ChangesView.tsx`, `review/PullList.tsx`).** The `Panel` header sits in a
  full-width `[data-panel-bar]` with the Files bar's inset `line` shadow, so every Panel tab (Sessions, Memory, Notes, Usage,
  Agents, Details, Changes, Processes, Review picker, side question) has the same hairline under its bar, also when the header
  is capped to `PANEL_COLUMN`. The two lines that stood in for it are gone (`border-t` on `[data-v7-changes]` and on the
  review picker's `ViewTabs`), so no tab shows a double line.
- **B. Review picker (`review/PullList.tsx`, `review/ReviewTab.tsx`).** The hand-built filter row is a plain `PanelFilters`
  (chips, then the search; in a narrow group the chips scroll under their fade instead of the search taking a second line;
  the placeholder is "Search…", the label still names pull requests, addresses and numbers). The panel title is "Review" (the
  dock tab's name), so "Pull requests" is said once, by the first view tab. Chrome above the first row at 363px: 150 → 114.
- **C. Open review header (`review/ReviewHeader.tsx`, `ReviewView.tsx`, `Overview.tsx`).** One 40px bar at every width (was 61
  maximised): Back, the title, the 28px group, the Files bar's hairline. The mono meta line (number, author, branches, viewed,
  unresolved threads) is the title's tooltip and the first line of Details at every width (it already was in page mode);
  "New commits: update" is a quiet button in the group, and in "⋯" when the group folds below 720. "Submit review" is
  `secondary`: no tool tab has a filled button in its bar. R3's folding order is unchanged (1024 / 720 / 480); at 363 the
  bar holds Back, the title, Run, "⋯" and "Submit". **Departs from R3** in one point: there is no meta line at any width.
- **D. Side question (`side/SidePanel.tsx`).** One column with two edges: boxes (the list's content box, the composer, the
  header's actions) at 8 and 728 when maximised, text (title, answers, the input's text, the model picker) at 16 and 720 (the
  bubble and the send button end on 720). Measured before → after (1422 wide): input text 20 → 16, model picker 14 → 16, send
  right edge 722 → 720; the composer's inner padding departs from the main composer's for this. The empty state is laid over
  the whole body (the composer paints over it), so its title sits at 37 % of the tab (was 32 %), like the other tabs; the
  three starters are text-sized quiet buttons (were full-width). "Keep" and "Clear" both carry an icon (Pin, Eraser).
- **E. Processes (`processes/ProcessesTab.tsx`).** Stop, Kill and "⋯" show on hover and keyboard focus (`ListRow`'s
  focus-within), always on touch (`touch:`) and on the phone layout (`trailingShown={phone}`); **revises QA pass 4**, which
  showed them on every active row. There is no Retry on a process row (a failed run restarts from "⋯"), so nothing stays
  pinned. Row pitch 44 → 46 (`gap-1.5`, as Notes and the pull list); the filter row is a plain `PanelFilters` of 36 (chips,
  then the search at the right, `min-w-28`), no longer wrapping.
- **F. Changes list (`v7/TurnFiles.tsx`).** File rows are `ListRow` md (32, text `fg` at rest instead of `fg-2`, kind letter
  in the leading slot, folder after the name, source and `+a −r` or "reverted" / "not reverted" as the meta); group heads are
  `SectionHeader` captions (12px `fg-3` on 28, at the rows' text edge) with the count, totals and "Revert" as the aside. The
  revert button moved to the 24px `IconButton` (same pixels, no deprecated wrapper). Checked in the demo: revert a request
  (reverted row struck through with "reverted", failed ones "not reverted" in `err`), no console errors.
- **G. Terminal and Browser bars (`terminal/TerminalTab.tsx`, `browser/BrowserToolbar.tsx`, `browser/BrowserTab.tsx`).** The
  terminal bar's inset is 8 (`px-2`, was 12), so its status dot and its last 28px button sit where the Files bar's controls
  do; the browser's Back / Forward / Reload are 4 apart (were 2), as in Files; the browser's empty-state actions are
  `secondary`, like every other tab's (was a filled `primary`). Not changed: the terminal's folder `MenuButton` stays 24 high
  (the primitive's `chip` height everywhere; changing it is a library decision).

## As built — QA rough-edges pass (2026-11-18)

- **Image thumbnails no longer overlap the bubble's text (`chat/PromptImages.tsx`).** `Button size="lg"` fixes the height at `h-ctl-lg` (40 px) and a later `h-auto` does not beat it (`cn` is `clsx`, no merge), so the 96 px thumbnail overflowed upwards over the text. The thumbnail is now a bare `button` sized by its image. Checked at 400, 700, 1000 and 1300 px with 1, 3 and 4 images.
- **Scroll position survives a reload (`lib/scrollSpots.ts`, `chat/useScrollSpot.ts`, `ConversationView.tsx`).** Saved per project and conversation key under `octo.scroll.<project>` (debounced on scroll, flushed on `pagehide`, at most 40 entries); an entry exists only while the reader is off the bottom, so "stick to bottom" is unchanged. The restore waits until the transcript is tall enough to reach the offset (setting it earlier clamps to the end of a short transcript, which read as "at the end" and made the view follow the stream), and gives up after 5 s or on the reader's own input. A loading view with nothing to scroll no longer writes its position to the tab memory (it hid the saved spot).
- **Palette (`lib/sessions/tree.ts` `sessionsBesideTabs`, `state/workspace/paletteCommands.ts`, `state/terminalTabs.ts`).** A session open as a tab was dropped from the Sessions rows even when the tab's label did not carry its title; it is now dropped only when the label does. A terminal tab with no button in the strip (under "All tabs") was listed by its raw id; the workspace now names it as the strip does (`terminalTabName`, shared with `tabInfo`).
- **Ctrl/Cmd+Shift+U (`chat/useContextShortcut.ts`).** Handled only by the ring, which is not mounted before a turn reports usage. The composer answers it then with the `/context` report.
- **Unreachable page in Browser (`apps/harness/internal/browserproxy/handler.go`, `browser/useInspectorBridge.ts`, `useBrowserSession.ts`, `BrowserTab.tsx`).** The proxy's 502 page now also posts `{ channel: "octo-browser", type: "error", nonce, message }`; the tab swaps the frame for `EmptyState` (title, reason, Retry). Retry re-opens the proxy.
- **Offline (`app/AppShell.tsx`, `styles.css`).** The app root carries `data-offline` while `health` is `offline`; the working ring, the activity shimmer and the needs-you pulse are paused and the working ring takes the quiet tone.

**Verified.** Playwright Chromium against `?demo=one` / `?demo=1` / `?demo=many` for each item (screenshots in the session's `fix-rough/` folder); `scrollSpots.test.ts`, `tree.test.ts` (`sessionsBesideTabs`), `terminalTabs.test.ts`; `go test ./internal/browserproxy` (new `TestUnreachableUpstreamPostsAnErrorToTheHost`); `scroll-anchor.mjs` ok.
**Not verified.** The Browser error against a live harness (the message was posted from the demo frame by hand; the Go side is covered by its test); the `data-offline` wiring against a really stopped harness (the CSS was checked by setting the attribute; the attribute comes from `health === "offline"`); Ctrl+Shift+U with zero usage was checked by forcing the ring off (the demo always reports usage); the palette case of a tab whose label differs from the session title is covered by the unit test only; `stick-on-open.mjs` and `scroll-on-send.mjs` fail intermittently on this loaded machine, also on the unchanged tree (`scroll-on-send`: 38 px short before and after).

## As built — "Ask first": one name per thing (2026-11-18)

"Ask" named two things: the composer mode (Agent / Ask / Plan) and the permission level `supervised` in the composer's
Permissions menu and the project dialog. The mode keeps "Ask"; the permission level is now **"Ask first"**, beside its
neighbours "Accept edits" and "Allow all" (the menu's own words: it asks before edits and commands). One place holds the
label (`lib/access.ts` `ACCESS_LABEL`), so the chip, its tooltip ("Permissions: Ask first — Asks before edits and
commands."), the menu and the project dialog all change; no slash command, palette entry or settings row names the level.
Wire values (`supervised`, `accept_edits`, `full`) are unchanged. `lib/access.test.ts` asserts that no permission level
shares a name with a mode (it failed before). Verified: ui tests, lint, the chip and its menu in the browser.

**Verified.** `pnpm lint` (0 errors; no new warnings in the 13 touched files), `pnpm format:check`, `pnpm --filter @octo/ui test`
(902/902 at each commit; one later run failed only `streak.test.ts`'s time budget under a machine load of ~34),
`spacing-audit.mjs` on `?demo=1` and on `?demo=1&tabs=all` (total=0; states that timed out under load were re-run alone with
longer waits, `panel-frame` and `review-open` included: total=0), `frame-colours.mjs` (ok), `panel-measure.mjs --mode after`
(every Panel header 40, title at 16, right inset 8), and Playwright Chromium at 1440×900 in dark and light, populated and
empty: every one of the 13 tool tabs has a 40px bar with one `line` hairline at y 40 and no double line; Review picker chrome
150 → 114 at 363 wide; the open review's header 61 → 40 (also 40 at 363); side question edges as in D; Processes pitch 46 with
actions on hover; reverting a request in Changes. **Not verified.** WebKit, the phone layout by eye (the audit's phone states
pass), a live harness, the Tauri app.

## As built — conversation and composer polish (2026-11-18)

A reviewed list of small fixes; no redesign, existing tokens and primitives, behaviour unchanged.

- **Composer (WP-A).** A model whose provider is not connected leads with a 14px circled "!" in the warn colour — the
  "needs you" `StateGlyph` at 14, the same shape as lucide's `CircleAlert`, which alone put the entry 0.03 kB over budget — and
  its accessible name ends ", provider not connected" (`shared/ModelPicker.tsx`; colour alone said it before). The context gauge is a
  2px arc on r=6.75 over a `line-strong` track ring, not a filled pie (`chat/ContextRing.tsx`; checked at 1%, 50%, 95% in both
  themes). The @ menu is as wide as the composer box, like the / menu (480 → 720px at 1440; `chat/ComposerMenu.tsx`).
- **Approvals (WP-B).** A group is titled "3 approvals" with the distinct agent labels as its dim line (it said "from <project>");
  its rows name their agent at the end (`text-xs text-fg-3`) when more than one agent asks (`v7/ApprovalGroup.tsx`, test
  `ApprovalGroup.test.ts`). A row's caption line (what · subject · +N −M) is its Details disclosure (button, chevron,
  `aria-expanded`, `data-approval-details`); the action row is Allow once · scope · Always · Deny; an edit opens straight onto its
  diff, so it has one disclosure (`PatchView open`). Scripts that clicked "Details" (`frame-colours.mjs`, `ui-tour-states.mjs`)
  click `[data-approval-details]`. Cards in the approvals slot span the column's whole edge (`-mx-3`: frame −12…708, the user
  bubble's and the composer's edge) and the RequestCard glyph gains a 4px margin, so glyph x=0 and title x=24 like the activity
  rows (before: glyph 12, title 32, frame 0…696). Measured at 1440, 1000, 760, 560 and 390 (phone): no horizontal scroll.
- **Code and prose surfaces (WP-C).** One class, `.octo-code-surface` (`styles.css`: 8px radius, `--octo-code-bg`, a
  `line`/70 hairline; the hairline is dropped under an `.octo-in-card` ancestor, one outline per level), replaces the four
  treatments: the Markdown fence, the tool body frame (`chat/tools/parts.tsx`: it had no edge, 1.06:1 against the panel), the
  approval blocks (`ApprovalSubject`, `PatchView`: `rounded-sm` → 8px) and `primitives/CommandLine` (`border-line` → `line`/70).
  A file chip in prose is `primitives/InlineButton` (a `<span role="button" tabIndex=0>`, Enter/Space press it, a held key
  presses once, the global focus ring; test `InlineButton.test.ts`, gallery entry) — a native `<button>` is an atomic inline. Its
  file glyph sits in the code's left padding (`position: absolute`): an inline SVG is a break opportunity too, and it alone kept
  "after 10 s (" at a line's end. Measured on Atlas API at 1440/1300/1200/1100/1000: the orphaned "(" before
  `src/http/client.ts` at all five widths before, none after; Enter on a focused chip opens the file (tab count 1 → 2).
- **Transcript and copy (WP-D).** A failed or stopped turn's banner (`TurnBanner`) and the plan card span the column's whole
  edge too (−12…708; measured: failed banners and the plan card at x −12, w 720); the empty project's start failure keeps its
  place on the composer's edge (`flush`), so `Transcript.tsx` is unchanged. The empty project says one problem once: when the
  start failure ("GitHub Copilot is not logged in") shows, the title's "can't run yet: its provider is not connected" sentence is
  left out (`lib/startFailure.ts`, shared with `StartFailure`; its own module so it stays in the lazy chunks). While streamed text with its caret is on screen
  the live line no longer adds "Writing…" under it (`showsActivityLine`, test in `activity.test.ts`); sampled every 50ms over a
  streamed reply: 36 of 36 caret frames also had the "Writing…" row before, 0 of 34 after. Copy: "History compacted 2 requests
  ago" (was "history was compacted …"), "History compacted by you" (was "· manual"), and a plan whose text opens with its own
  "Plan…" line takes it as the card title instead of repeating "Plan" (`lib/planTitle.ts`, tested).
- **E1 — the request bubble is neutral (owner's decision, 2026-11-18).** The user bubble (and its pinned copy, and the side
  question's) is the raised tone of cards and menus with `fg` text and a 1px `line` hairline, in every theme; the teal fill
  (#3a786b dark / #356e61 light) and the per-theme `--octo-bubble`/`--octo-bubble-fg` tokens are gone, with the fill-specific
  selection, "Show more" and focus-ring overrides. Measured: text 13.79:1 (dark) and 15.68:1 (light), was 5.15 and 5.91; the
  fill against the panel is 1.14:1 (dark) and 1.11:1 (light), under 1.15, hence the hairline; a one-line pill is 40px high (the
  "1px edges" the R2 note counts; it measured 38 without a border). Checked in the Docs site and Atlas API conversations with a
  sent @mention and /command, a queued message and a rewind point, dark and light, 1440 and phone 390. Not checked: a bubble
  with images.
- **E2 — one small chevron on a chip (owner's decision, 2026-11-18).** `primitives/Chip` ends its label with one `ChevronDown`
  at 12px in `fg-3` instead of the 14px up-down pair (mode, permission, model and the folder chip, and the title bar's model chip:
  one primitive). `Glyph` admits 12 for this one use. Measured in the composer at 1440, 900, 700 and 560: chevron 12px, 6px from
  the label on every chip, no control outside the box, no label cut; each chip 2px narrower. `Select`'s upward chevron pair is
  not a chip and is unchanged.

## As built — instant first opens, one-step load, motion tokens (2026-11-18)

Measured on a production build (`vite preview`-equivalent static server), `?demo=1`, 1440x900, Chromium, 5 runs, median, before ->
after, on a shared machine (load average ~30 on 4 cores: absolute numbers are noisy; before and after ran back to back).

**First opens of lazy surfaces.** The cold gap was not the chunk fetch (the palette, Settings and the model list were already warmed
1.5 s after start): a plain `React.lazy` suspends on its first render even when its module is in, and React then holds the revealed
content until 300 ms after the fallback (its fallback throttle). `readyLazy` (moved to `lib/readyLazy`; a failed fetch is now
retried) renders without suspending once its chunk is in, and now carries the palette, the project dialog, Settings, the model
list, the "+" picker and the tool tabs (Files, Terminal, Review, Browser, Processes, Changes; `dock/TabView`'s `warmedTool`).
`lib/warm` is the registry (each surface registers its loader next to its `readyLazy`); `lib/warmSchedule` (its own chunk, loaded
after first paint) warms on idle 1.5 s after the shell mounts, one key per idle slot, most likely first (palette, model list,
Settings, "+" picker, project dialog, tool tabs), none under `navigator.connection.saveData`, and on intent: hover, focus or press of
a control with `data-warm` (sidebar Search/Review/New project/Settings, the model chip, the "+" button) or a picker row whose
`data-picker-row` id is a key (`tool:terminal`); holding Ctrl/Cmd warms the palette. Monaco is warmed on idle once a file view
has been on screen 1 s (`warmMonacoSoon`), and at once when the pointer enters or presses the file view. Entry budget: the new
code is paid for by moving lazy-only exports out of entry modules (`TOOL_HINT` out of `lib/toolPurpose`, now in `state/workspace/paletteCommands`; the tree's
`visibleSessions`/`projectSummary`/`isOpen`/`parseOpen`/`treeKey` -> `lib/sessions/treeRows`): 160.92 -> 160.73 kB. After merging
the tool-tab, QA, approval and composer passes (161.71 kB) more lazy-only code left the entry: `agentActivity`/`teamRoles` ->
`lib/orchestratorMore`, `railLayout` -> `lib/railLayout`, `sessionTitle` -> `lib/sessions/title` (so `lib/sessions/tree` leaves
the entry): 160.93 kB. After the shell-polish merge (161.92 kB on its own; 161.32 merged): the after-first-paint
warm-up moved into its own chunk (`app/warmApp`: the first-paint imports, the intent listeners and the idle queue), and
`THEME_CHOICES` (`lib/themeChoices`), `usePageVisible` (`lib/hooksMore`), the chips' `useChipMenu` (`chat/chipMenu`), `SkeletonText`
(`primitives/SkeletonText`), `RunningDot`/`OrchestratorGlyph` (`primitives/statusMore`) and the demo's `titleFromRequest`
(`lib/sessions/requestTitle`) left entry modules: 160.28 kB (0.72 kB of room). Next candidates, each blocked by a file another
pass owns: `turnHead`/`turnFailureText`/`turnDurationMs`/`compactionSlots`/`turnWarning` (`lib/transcript`, read only by
`chat/Transcript`), `formatSeparator`/`needsSeparator` (`lib/format`, Transcript), `useLoginHint` (`chat/agentName`, Transcript),
`useCopy` (`lib/hooks`, Transcript and Processes), `useRequests` and `projectRowLines` (the palette), `useAllRequests` (needs the
request store's hook exported), the conversation's scroll spots (`chat/useScrollSpot` + `lib/scrollSpots`, ~0.6 kB, loaded with
the conversation but only read after a scroll).

| 1x (4x) | before | after |
| --- | --- | --- |
| Palette, first open (`more`) | 345 | 49 (warm 41) |
| Palette, first open (`interact`) | 227 (540) | 61 (128) |
| Model list, first open | 341 (436) | 33 (138); warm 31 |
| Settings, first open | 360 (423) | 60 (210) |
| First file (Monaco), Files on screen ~1 s | 1077 (1791) | 211 (884); warm 43 |
| Review tab | 360 (523) | 61 (275) |
| Browser tab | 340 (393) | 53 (220) |
| Terminal tab | 402 (570) | 295 (495) |

Not reached: Terminal (the chunk is warm; what remains is the tab's own mount, xterm and the PTY session, not measured further).
`interact.cjs`' `settings:open` (~590 both before and after) is a measuring artefact: its predicate `h1[data-page-title]` is
already true before the click after the session switches, so it reports the time since the previous click; the numbers above use
`[data-settings] h1[data-page-title]`. Not verified: WebKit, the Tauri shell, a real harness.

**Load sequence.** What each late piece waited for: the project list and config were asked for only after `/health` answered
(now in parallel with it, `state/app`); the composer's Mode and Access chips are their own chunks, requested only when the composer
first rendered and then revealed through the 300 ms fallback throttle (now fetched when `Composer`'s module runs and rendered
with `readyLazy`, so they appear in the composer's first frame; the same for the top row's commands cluster, `ProjectCommands`);
the sidebar's session rows waited for the demo's `listAllSessions`, which read every project one after another (~1 s; the
harness answers it in one request: the demo now reads them in parallel). Milestones (ms from navigation, 1x / 4x): session rows
1219 -> 1036 / 3557 -> 3125, composer 1219 -> 1136 / 3557 -> 3562, mode and access chips 1630 -> 1136 / 5203 -> 3562 (same frame
as the composer), first turn 1309 -> 1252 / 4971 -> 3933. Load at 4x: CLS 0.20 -> 0.00 (median of 5; before, every run had one
0.2027 shift), long tasks 16 -> 11, "interactive" 5410 -> 3803 ms. The 0.2027 shift was the transcript's turn window replacing
estimated-height shells with mounted turns while pinned to the bottom (`chat/Transcript`, `useTurnWindow`: off limits for this
pass); it no longer shows in these runs because the chunks the turns wait for are in earlier, but its cause is not fixed there.
The UI scripts that open a project by its sidebar row (`flicker`, `layout-shift`, `width-stability`, `scroll-on-send`,
`file-open-stability`) relied on the project rows showing before the session rows; they now also match a session row carrying the
project's name and take the project's part of its link.

**Motion tokens.** `--motion-fast` 100 / `--motion-base` 150 / `--motion-slow` 220 ms with `--ease-out-quint` (table in "Motion"
above), `duration-fast|base|slow` utilities, mirrored in `lib/constants` (`MOTION_FAST_MS`, `MOTION_BASE_MS`, `EASE_OUT_QUINT`)
for the tab settle (Web Animations) and `Presence`'s exit timer; every hand-written duration in styles.css and the components
outside the excluded files now uses them (the 600 ms change flashes, loops and loading thresholds are not motion and stay). The
context menu (`primitives/Menu`) enters and leaves like the other overlays (`octo-overlay`, growing from the point it opened at;
the menus' `Presence` wrappers lost `exitMs={0}`), instant from the keyboard as before; tooltips fade in and out (fast, opacity),
a neighbour shown while warm appears at once (`data-warm`, no fade on top of the warm-up). Layout properties no longer animate:
the activity steps' `grid-template-rows`, Monaco's scrollbar thumb geometry (it trailed the scroll), the turn rail's mark width
(now `scale`) and the drop zone's left/top (now `translate`; its size snaps). Reduced motion, the keyboard rule and instant tab
swaps are unchanged. A test (`lib/constants.test.ts`) keeps styles.css free of hand-written transition durations and layout
transitions. Checked in Chromium on the dev server (context menu: `octo-overlay-in` 150 ms from its origin, `octo-overlay-out` on
close; tooltip: `octo-fade-in` 100 ms, `octo-fade-out` on leave); not checked in WebKit or on the phone layout.

## As built — long conversations: send lands at the end, background tabs keep their place, cheaper scroll and drag (2026-11-19)

**Send stops short (scroll-on-send.mjs: 38 px, 38–506 px under load).** Root cause in `useStickToBottom` (`lib/hooks.ts`): the
smooth glide to the end was aimed at the height at send time; when the new turn grew the content mid-glide, a scroll event of
the glide usually read the new height first and stored it in `lastHeight`, so the ResizeObserver saw no growth and never
re-aimed. The glide stopped at the old end with `gliding` stuck (no "Jump to latest" either). The glide now keeps its own target
(`glideEnd`); a glide longer than a screen jumps to one screen above the end and glides that. The scroll-position restore
(`scrollSpots`) was not the cause; restore-on-reload still restores a scrolled-up reader to the same turn and offset and opens a
reader at the end at the end (Playwright, 3 rounds, the same result as before the change).

**Background tabs.** A conversation hidden behind another tab of its group (`display: none`) unmounted every turn: its
IntersectionObservers reported each turn "not intersecting" with a zero box, so `useTurnWindow` stored 0 as each height. Showing
the tab remounted ~1200 nodes and moved the reader. Entries seen while the scroller has no size are ignored. Two more hidden-0
reads moved a scrolled-up reader when the tab came back: the composer anchor (`useComposerAnchor`, 98 px: the row's 0 height read
as the composer shrinking) and the prompt bubbles turning into pills while hidden. Now the same text is at the top before and
after (was: 2398 px off). The demo's "+ → Terminal" opens in the side group, so switching to it never hid the conversation (the
earlier "tab switch" numbers measured the wait since the previous click); measured here by dragging Terminal into Chat's group.

**Scroll (Stress, 60 wheel steps up).** Profile (unminified build, CPU sampling and React commit counts): `scrollAnchor`'s
`remember` measured every candidate paragraph on every scroll event (~316 ms of JS); the conversation re-rendered the whole
composer on each turn boundary (65 times); remounted turns re-parsed their Markdown; long tasks were mostly paint and the
compositor commit of mounting turns. Now: the anchor is found once per frame by bisection over a cached candidate list
(`lib/scrollAnchorTrack.ts`, `pickAnchor`, its own chunk; ~45 ms); `useOrchestratorComposer` returns one memoised object and
`Composer` is memoised (0 composer renders while scrolling, also none per project event while streaming unless its inputs change);
settled Markdown keeps its rendered tree (400 entries). `content-visibility: auto` on mounted turns was tried (injected CSS) and
showed no measurable gain, so it is not used.

**Divider drag.** Each pointer move changed the layout and rendered the whole dock (61 workspace renders per drag). The shared
`primitives/ResizeHandle` now coalesces moves (`onDragStart`, `onFrame` once per animation frame, `onDragEnd`); the dock
divider previews the groups' `flex` on their elements and commits the layout once on release, with the same clamping; the
sidebar edge uses `onFrame` instead of its own requestAnimationFrame.

**Measured** (production builds, headless Chromium, 1440×900, interleaved runs of the integration tip before and after the
merge; medians). At 1x on a quiet machine both builds meet every target (scroll 0–1 frames > 50 ms, no long task; drag 0; typing
p95 20–24 ms; tab switch 30–35 ms; stream 0 long tasks), so 4x CPU is what separates them: drag frames > 50 ms 13/31 → 5/3, drag
long tasks 28/41 → 9/5; scroll frames > 50 ms 51/49 → 43/45 (long tasks 12/6 → 13/3); typing p95 44.6/39.4 → 36.3/38.3 ms; tab
switch 196/131 → 149/128 ms. Load at 4x: CLS 0 in all 5 runs before and after; the 0.2027 turn-window shift of the previous
pass did not show, so whether its cause is gone is not verified. Entry bundle 160.24 kB (integration tip 160.28). Not verified:
WebKit, the Tauri shell, a real harness, the phone layout.

## As built — a project of several folders: names that stay apart, the tree column, the new-session edge (2026-11-19)

Owner (macOS, a project "PCMS + PCFS" of two folders whose names share `product-configuration-`): "project and multiple
projects looks not correct and not balanced". Reproduced in `?demo=1` with a demo project of the same shape ("PCMS + PCFS":
`product-configuration-management-system` + `product-configuration-facade-service`; and "PCFS", one of them), Chromium,
1440×900 and 1100×700 dark and light, 390×700 phone. Decisions:

a. **One middle-cut for names, and siblings keep what tells them apart.** `lib/truncate.middleSplit(text, siblings?)` /
   `primitives/MiddleText` are the one helper: a name is cut by CSS only when its box is too narrow, its end stays; with
   `siblings` (the other names shown beside it) the tail is everything after the longest head it shares with one of them, from
   the word break before the difference, and the head gives way first (down to its first letter, `min-w-4`) before the tail is
   cut. Lengths count code points (no split surrogate pairs). Used by the file tree's roots, the status bar's folder, the
   sidebar's project meta, and (already) chips and list rows; ordinary titles and prose keep the CSS end-ellipsis. Full name:
   always in the tooltip. Tests: `lib/truncate.test.ts`, `lib/truncateSiblings.test.ts` (shared-prefix siblings, the owner's
   `…-management-data-subsystem` pair, short names, non-ASCII and emoji).
   A path without spaces (a compact folder chain of decision 98, "com/wsgc/…/configurator") keeps its last folder whole (up to
   24 characters); its tooltip is the chain's full path.
   Measured, Files tree roots at 1440×900: "product-configuration-ma…" twice → "product-co…management-system" /
   "product-configur…facade-service" (tails 123/88 px, whole).
b. **Status bar, one rule.** One folder: its name, middle-cut. Several: "2 folders" (a first name and "+1" read as that folder
   alone; the project's name is the heading, the composer chip and the tab already — one name per thing). The tooltip names
   each folder with its path. Before: "product-configuration-… +1" (192 px); after: "2 folders" (86 px).
c. **Sidebar session meta (the flat Sessions list) is the project's name, and the title wins.** ListRow `metaYields`: the title
   keeps its natural width up to what leaves the meta 64 px (+ the 8 px gap), the meta takes the rest (no 33% cap any more,
   the `li[data-tree-level="1"]` rule in `styles.css` is gone). A name of words ends with "…"; one long identifier keeps both
   ends (`MiddleText`). Left out when every listed session is in one project. `nodeText` reads a `MiddleText`'s words, so the
   row's accessible name keeps the project. Before: "New session · PCMS + …" (meta 61 px); after: "New session · PCMS + PCFS"
   (84 px whole); long titles unchanged (124 px, meta 64 px).
d. **The tree column's default follows the file view.** A column nobody dragged (stored width 0, `state/fileViewPrefs`
   `TREE_DEFAULT`; the old fixed 220 every untouched project stored reads as the default) is 40% of the view, 220–360, never
   leaving the editor less than its 360 (`lib/treeLayout`). It depends on the layout only (decision 79), never on whether a
   file is open (decision 85). Dragging stores a width (200–480, per group, the project's default); double-click on the edge
   goes back to the default. The edge is now the shared `primitives/ResizeHandle` (drag coalesced per frame, ←/→ 16, Shift 64;
   Home/End of the old local handle are gone). Measured at 1440×900 with Files beside the conversation: column 220 → 254 of a
   634 px view; the owner's 760 px view: 304.
e. **Roots read as roots, each on its own.** Kept as the tree's section heads (12 px caption, chevron, 8 px above every root
   but the first, own expand state per root); only the label changed (a). Filter, reveal and the file menu were not changed
   and work per root (checked: filtering shows matches under each root).
f. **New-session heading on the composer's text edge, in every layout.** The title block uses the composer row's edges
   (`EDGES`: the padding and the scrollbar gutter) and the shell's 2 px + the text's 12 px, so the first letter of the heading,
   of a notice and of the prompt's placeholder start on one line. Before: wide 542 vs text 544 (−2), split (Files open) 305 vs
   317 (−12: the composer row's scrollbar gutter, absent from the title's row, in Chromium); after: 544/544 and 317/317; phone
   26 (on the project chip's glyph). Vertical position measured and kept: the block's centre is 8 px above the pane's centre in
   both wide and split (title top 341 in both), the same rule as before; Home is a list page and starts under the band on purpose.
g. **Naming, as found.** The project's name: heading, composer chip, Files bar's root crumb (one folder or several), tab
   tooltip, Home rows, the sidebar's tree. A folder's name: tree roots, the file breadcrumb, mentions, the terminal's folder menu,
   Processes, Changes group heads, the composer's folder menu. Unchanged; only the cutting of both changed.

h. **Review, one anatomy in every state** (owner, screenshot of the same project: "uneven"). Before: the 40 px bar was empty but
   for the refresh button in the error state, and the folder menu sat at the right end of the view-tabs row ("Pull requests |
   Local branches … product-configuration-management-data-subsystem ⌄"); in a one-folder project the bar held the repository.
   Now the bar holds what is reviewed at its 8 px inset (as Files' crumb): the folder menu when the project has several (its
   text cut with the siblings rule of a), then the repository (menu or text); with no repository known (loading, a failure)
   the folder alone (a one-folder project: its name, quiet). Status and refresh stay at the right; the view row holds only the
   views. Measured (`?review=aborted,noopen`, 1440×900 and 1100×700, dock 634 and 365 px): bar text "" → "product-configuration-
   ⋯management-system" (lead 805,47 307×28); view row "Pull requests Local branches product-configuration-managemen…" →
   "Pull requests Local branches".
i. **A list that did not load, with nothing else to show, is the tab's empty state** (`PanelEmpty`, centred, one text edge, as
   "not available" in the same tab and the load failures of the other tool tabs) with Retry and Details, in an `alert`; the
   tinted block from the pane's edge (box 8 px, text 44 px, under tabs whose text is at 16) is gone. With reviews in progress
   below, the structured `ErrorNotice` stays in the list, on the rows' box edge, as the "not available" block there. The
   reason is the catalogue's: `lib/review/pull.listFailure` maps a client cut-off ("Fetch is aborted", "The operation was
   aborted", a timeout) to "GitHub did not answer in time, so the request was cancelled."; the raw text is only under Details.
   The title colour and frame are the shared `Notice`'s (decision 81: no coloured frame; glyph and title carry the tone) and
   unchanged. Demo knobs: `?review=aborted` (the client cuts the list request off) and `noopen` (no review in progress).
j. **Composer chips at this width** (checked, unchanged): under 460 px of composer the mode and permission chips drop their
   labels first and the model chip keeps its own (it is the one that changes most and says most); a bare chip keeps its
   accessible name and tooltip ("Mode: Agent", "Permissions: Ask first"; `primitives/Chip`).

Verified: the gates in the commit of this change (lint, format, unit tests, build and bundle, spacing-audit, width-stability,
layout-shift, file-open-stability, composer-fit). Not verified: macOS WebKit (the owner's machine), a real harness and a real
GitHub failure (the demo's AbortError stands in for it).

## Decision 98 — compact folders in the file tree (2026-11-19)

Owner (a Java project's screenshot, `management-system-application > src > main > java > com > wsgc > … > subsystem > config`,
one row and one indent level per directory): "java subpackages is too long, should be like in IDEA com.package1.package2 if no
child files".
a. **A chain is one row.** Directories that each hold exactly one entry, a directory, form one row with one chevron and one
   indent level; its children are the last directory's. A directory holding a file, two or more entries, or nothing ends the
   chain (it is the last segment). IntelliJ's "compact middle packages", VS Code's "compact folders".
b. **Separator.** Inside a JVM source root (`…/src/<set>/<java|kotlin|scala|groovy>`) the row is a package and reads
   `com.wsgc.ecommerce`; elsewhere it reads `src/main/java`. A source root ends a `/` row, so the screenshot's module reads
   `management-system-application`, `src/main/java`, `com.wsgc.ecommerce.product.configurator.management.data.subsystem`, then
   `config`, `mdm`, `model`. A row with a dot in a name uses `/` (a dot would read as a package separator). Rule:
   `lib/compactFolders.ts` (`compactChain`, `isSourceRoot`), unit-tested.
c. **The row acts on its last directory.** Open/close, the context menu (Add to chat, Copy path), ← (to the first directory's
   parent row), reveal and selection; the row's tooltip is the last directory's full path and its label truncates with an
   ellipsis. Opening or closing a chain opens or closes every directory in it (expanded state stays per real path), so a chain
   that splits keeps its open subtree. Type-ahead matches any segment.
d. **One listing per visible row.** `GET …/files` gives a directory entry an optional `chain` (the names below it while each is
   the only entry, at most 32, never through a symlink, `.git` ignored); the tree takes a directory's own listing when it has one
   and the hint otherwise. A `file.changed` in a directory that is not listed, or that holds (or held) one entry, lists the nearest
   listed ancestor again, so the row splits or re-forms.
e. **Setting.** Settings → Editor → File tree → "Compact folders", on by default, stored in `octo.compactFolders`; off is the tree
   as before (one row per directory).

### As built — decision 98 (2026-11-19)

Built as described. Harness: `files.List` fills `Entry.Chain` (`internal/files`, tests `TestListChain`, `TestListChainCap`;
`internal/bridge` `TestFileListChain`), documented in `apps/harness/docs/architecture.md`; `FileEntry.chain?` in
`@octo/agent-client`. UI: rows come from `components/files/treeRows.ts` (`treeRows`, `typeAhead`; tests beside it); the
preference is `lib/compactFoldersPref.ts`, imported only by the lazy file view and the lazy settings page. The demo has a
"Product configurator" project shaped like the screenshot; its bridge returns `chain` (`demoChain`, tested). The tree had no
type-ahead before; it has one now (700 ms, like `Select`). There is no rename, delete or new file/folder in the tree (nor a harness
route for them), so those were not built; the directory context menu is new (it was files-only).
Run: Go `gofmt -l .` (empty), `go vet ./...`, `go test ./...` in `apps/harness`; `pnpm lint` (0 errors), `pnpm format:check`,
agent-client and UI tests (the UI suite's wall-clock `streak.test.ts` budget case failed once under the machine's parallel load and
passes alone); build: initial JS 160.71 kB gzip (budget 161.00; the preference module and the tree code are in lazy chunks, the
entry gains the `PREFS` key and `state/code`'s refresh rule). Scripts (Chromium, 1440×900): `spacing-audit` total=0,
`file-open-stability` ok, `editor-context-menu` ok, `layout-shift` ok. Playwright on `?demo=1` and against a real `harness serve`
with the screenshot's tree on disk: the three rows, one indent level each, 24px rows, indent guides, ellipsis and full-path
tooltip, ←/→/↓/Home/End, type-ahead on a later segment, filter (rows shown, highlight), reveal of a file opened deep in the chain,
the directory menu (Copy path gives the last directory), the setting off (one row per directory) and on, dark and light; a file
written with `PUT …/files/content` into `ecommerce` split the row in place within 0.4 s (`com.wsgc.ecommerce` and
`product.configurator.management.data.subsystem`, both still open). Not verified: a file created from a terminal — the harness has no
file-system watcher, so no `file.changed` arrives and the tree (any tree, compact or not) shows it only after the folder is listed
again; a chain re-forming after a delete (unit-tested only: no delete route); WebKit, the Tauri shell, the phone layout.

## Decision 98 — the composer's branch chip shows the real branch and picks another (2026-11-19)

Owner (screenshot of the new-session screen, a chip that always read "Main checkout" and offered only "Move to worktree…"):
"I should be able to select branch in input." Aim: Cursor's composer, where the chip is the branch and opens a branch list.
Decided:

a. **The chip is the branch.** Shared workspace: the branch the project's main checkout is on (first git folder's
   repository), with the git-branch glyph; a detached HEAD shows its short commit; no chip when no folder is in git. A
   worktree session shows its worktree's branch (read from disk). Tooltip: "main — main checkout" / "fix-login — worktree".
   Read again on focus, on becoming visible, after any turn of the project ends, and when the picker opens — no polling.
b. **One picker.** The shared `Picker` (search field, keys, as the project chip): per repository its local branches, current
   first and checked, then by last commit; a "Create branch “x” from <current>" row when the query names no branch;
   "Show more (N)" pages with the harness's chunks (30); searching asks the harness (`q`), so thousands are never loaded.
c. **Switching never risks work.** Choosing a branch runs `git switch` in the main checkout only when its tracked files are
   clean and no session of the main checkout is working; otherwise the harness refuses (`uncommitted_changes`,
   `checkout_in_use`, `branch_switch_failed`, action `use_worktree`) and the picker shows the refusal in the error style
   (`shared/ErrorNotice`: message, hint, Details) with the primary button "Start in a worktree from <branch>". Never force,
   stash, discard or commit.
d. **Parallel work is one step.** An "In a new worktree" section lists the same branches (5 until a query narrows it):
   the empty session moves into a new worktree started at that branch (`moveSessionToWorktree {base_ref, carry_changes:
   false}`), else a new session is made in one (`createSession {workspace: {kind: "worktree", base_ref}}`). "Move to
   worktree…" (the dialog with branch name and carry-over) stays in a "Session" section.
e. **Several repositories:** one section per repository titled "name · current branch"; a switch acts on that repository.

### As built — decision 98 (2026-11-19)

- `lib/branches.ts` (tested: label, tooltip, sections, create row, paging merge, branch-name rules); `chat/useBranchHead.ts`
  (the chip's data, a per-project cache so a remount shows the branch at once); `chat/BranchPicker.tsx` (lazy chunk);
  `chat/ComposerProjectBar.tsx` renders the chip as the `Chip` primitive (below 360px it is icon-only like the composer's
  chips). With a harness without the branch route the old "Main checkout" menu remains. Demo (`demo/branches.ts`): Atlas API
  has two repositories, Docs site uncommitted changes (refusal), infra 140 branches (paging), Design system tokens no git.
  Harness and client: `apps/harness/docs/sessions.md` ("Branches of the main checkout"), `@octo/agent-client`
  `listBranches?` / `switchBranch?` (HTTP and message port; the wire error now keeps hint, action and details).
- **Deviations.** The bar is still shown only on the new-session screen (empty session), as before: putting it above every
  conversation's composer changes the chrome of all conversations (and the composer-fit and flicker measurements), which the
  owner did not ask for; in a conversation with messages "Move to worktree…" stays in the "+" menu's Session entry. The
  worktree rows are offered only for the first repository, because a worktree workspace takes one start point for every
  repository and another repository may not have that branch. Untracked files do not block a switch (git keeps them and
  refuses by itself when one would be overwritten: `branch_switch_failed`).
- **Status bar vs. project chip (owner's screenshot).** Not a mismatch: the status bar shows the open project's first
  *folder* name (`ProjectStatus`), the chip the project's *name*. Reproduced with a project "PCFS" whose folder is
  `product-configuration-management`: after choosing PCFS in the composer's project chip from another project, the status
  bar reads "product-configuration-management" (truncated at 192px as in the screenshot). Nothing changed.
- **Verified** against a real `harness serve` (mock model, throwaway repository with main, fix-login, feature/export;
  Chromium): chip "main — main checkout"; switch to fix-login (`git branch --show-current` = fix-login); create and switch
  spike/one; refusal while another session's turn was held by the mock (`checkout_in_use`), branch unchanged; refusal on a
  dirty tree, then "Start in a worktree from main" moved the session to `octo/…` with the main checkout still on spike/one
  and the edit untouched; no chip for a non-git project; status bar after switching projects. Keys: open, ArrowDown on the
  second row, Esc returns focus to the chip. Demo: multi-repository and dirty refusal in dark and light; screenshots dark and
  light at 1440×900 and 390×700. `spacing-audit` total=0, `composer-fit`, `picker-keys`, `dropdown-scroll` ok; entry bundle 160.57 kB (budget 161).
  **Not verified:** WebKit, Tauri, Windows paths, real agents, a repository with thousands of branches (only 140 in the demo
  and the harness test's paging), touch on a device.
