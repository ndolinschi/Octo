# UI review, round 1 — by the orchestrator, from screenshots

**Date:** 2026-11-12 · **Source:** `ui-tour.mjs` screenshots (Chromium, demo data, dark and light, 1440×900) of the
state before batch 2 was merged, plus the batch 1 and batch 2 screenshots. Not seen: WebKit, the owner's real data,
motion. Each finding names the rule it breaks and where it goes. Severity: **A** visible defect a user trips on,
**B** inconsistency that makes the app look unfinished, **C** polish.

## Findings

| # | Sev | Screen | What is wrong | Rule | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | A | Home, connect screen | The backdrop streak runs diagonally **behind** the cards and list rows; text sits on an orange-to-blue band and loses contrast ("Infrastructure…" row, provider rows). | 50, 64, 75 | Decision 91a |
| 2 | A | Connect screen | Four "How to connect" buttons and one "Connect" in rows, plus two more buttons under the list — the pattern removed from Settings → Providers. | 89 | Decision 91b |
| 3 | B | Conversation | A waiting approval and a waiting form are two cards with two different header patterns (glyph + "Project · action" vs bold title + project right-aligned). | 64, 90 | Decision 91c |
| 4 | B | Conversation, live turn | Three different row styles for activity in one turn: "Thinking …" (label + text + chevron), "Read 1 file, called 1 tool" (text + spinner + chevron), "Searching for …" (spinner + text + time). | 55, 90 | Decision 91d |
| 5 | B | Composer | Up to six controls in the control row (+, mode, model, folder, tier, ring, send); the tier chip ("Auto" / "Ceiling") is router policy most people never touch. | 62, 75 | Decision 91e |
| 6 | B | Empty conversation | The three suggestions are plain text lines with no affordance; they read as a paragraph, not as actions. | 52, 90 | Decision 91f |
| 7 | B | Top row | "6 agents" sits next to the "+" of the tab strip and looks like a tab or a dead label. | 67, 75 | Decision 91g |
| 8 | B | Queue above the composer | A blue "2" badge floats on the card's corner with no label; each row repeats "Stop and send". | 75 | Decision 91h |
| 9 | B | Review picker header | Repository menu and folder menu on two ragged lines; the refusal text starts lower-case and stays visible after switching to Local branches. | 82, 84 | Decision 91i |
| 10 | B | Memory → session | Model shown as a raw id (`claude-sonnet-4`); a failed exchange is one bright red sentence. | 46 (one model name), 81 | In batch B2 |
| 11 | B | Usage → By model | Share bars nearly invisible; "no price" unexplained. | 86 | In batch B2 |
| 12 | B | Providers detail | Raw model ids; Billing shown for an agent that is not installed. | 89 | Fixed in batch 1 |
| 13 | C | Conversation | The gap between a reply's meta line (copy · time) and the card that follows is tighter than the gap between two cards. | spacing scale | Decision 91j |
| 14 | C | Status bar | Left items (folder, changed files) and right items (working, budget) use different text colours for the same weight of information; the budget turns orange at 80 % next to a neutral "3 working". | 73 | Keep the colour rule (it is a warning); align the two sides' default colour. Decision 91k |
| 15 | C | Sidebar | "Failed" under two projects is orange text while the same state elsewhere is a glyph; fine as a list, but the orange sub-line plus an orange glyph doubles the signal. | 81 | Sub-line neutral; the glyph carries the tone. Decision 91k |

## Decision 91 — what round 1 changes

a. **The backdrop never sits behind content.** The streak is confined to a band at the top of a screen that has no
   content there (the empty conversation's upper third, Home's heading area); below the band the surface is plain.
   A card or row never overlaps the band; cards are opaque. One placement and one angle on every screen that shows
   it (Home, connect, empty conversation, no projects). Test: no element with text intersects the streak layer's
   visible box (`ui-tour` asserts it per screen).
b. **Connect is the Providers list.** The connect screen shows the same rows and groups as Settings → Providers
   (decision 89, same component): a row selects, the detail pane beside it (below it under the floor) carries the
   steps and the one action. No buttons in rows, no second button row under the list.
c. **One card for "this needs you".** Approval, form, plan, rule panel and failed-turn blocks share one header:
   state glyph · title · (dim) what asks · right-aligned quiet meta (countdown). Body, then one action row: primary
   first, quiet alternatives, destructive last and quiet. Built once (`primitives/Card` + a `RequestCard` in
   `components/v7`).
d. **One activity row.** Every live or finished step of a turn is the same row: state glyph (spinner only while it
   runs) · verb phrase · dim detail · duration right-aligned · chevron only when it expands. Thinking, tool groups,
   searches and sub-agent steps differ in text, not in layout.
e. **The composer row holds at most four controls** before the send button: "+", mode, model, folder. The tier
   policy moves into the model menu (a second line "Routing: Auto ▾", shown only when a router is connected). The
   context ring stays next to send.
f. **Suggestions are rows.** The empty conversation's suggestions are `ListRow`s (hover, focus, arrow keys, Enter
   fills the composer), at most three, under a quiet caption.
g. **Sub-agents in the top row** are one quiet button "N agents" with the working glyph only while one runs, placed
   at the end of the strip before the commands, never between the tabs and "+"; it opens the Sessions list filtered
   to this turn's agents.
h. **The queue** shows its count in its header line ("2 queued"), no floating badge; row actions are icons with
   tooltips ("Send now", "Stop and send", remove); the explanation line appears once, under the header.
i. **Review picker header** is one `FieldRow`-like line: title · repository menu · folder menu · refresh; a refusal
   is a `Notice` that belongs to the view it happened in and clears on view change; sentence case.
j. **Vertical rhythm in the transcript:** the space above a card equals the space between cards; a reply's meta line
   belongs to the reply (tight above, one full step below).
k. **Tone is carried once:** a state shows either a toned glyph or toned text, not both (sidebar sub-lines, status
   bar items).

## Next rounds

Round 2 covers the complete merged tree (`tour2`): review workspace, settings after B1, memory/notes/usage after B2,
files, palette, narrow windows (830×560, 390×700), light theme throughout, and the primitives gallery.

---

# Round 2 — the merged tree (`tour2`, batch 3 in progress)

Seen: chat at 390×700, file view, command palette, long prompt, failed first turn, Home at 390×700, plus the
Settings (B1), Memory (decision 93), side question and Usage (B2) screenshots.

| # | Sev | Screen | What is wrong | Fix |
| --- | --- | --- | --- | --- |
| 16 | A | File view in a side group | The file tree is an overlay on the **right** that covers the code; since decision 85 it no longer closes on a pick, so the opened file stays hidden behind it. | Decision 94a |
| 17 | A | Empty conversation after a failed start | "Failed. ACP agent GitHub Copilot could not start: not logged in (exit status 1). Run `copilot auth login` in a terminal, then reopen this list." — protocol jargon, an exit status, and "reopen this list" refers to nothing on this screen; no action. | Decision 94b |
| 18 | A | Top row, every project | Pinned commands ("Tests", "Typecheck", "Run ▾") are bare words spaced like tabs; nothing says they run something. | Decision 94c |
| 19 | B | Command palette | "Requests" and "Past requests" are two groups with the same items. | Decision 94d |
| 20 | B | Turn meta line | "1h ago · claude-code · Opus 5.5 · 58k in / 2.8k out": the agent's internal id instead of its name. | Decision 94e |
| 21 | B | Conversation notice | "ACP agent Claude Code refused the harness's MCP server (method not supported); this request ran without harness tools (spawn_agent, notes)." — internal vocabulary. | Decision 94b |
| 22 | B | Chat at 390 | The jump-to-latest button sits on top of the form card's title; queue rows lose their text to two icon buttons; boxed key letters still in buttons (decision 92 pending in batch 3). | Decision 94f |
| 23 | B | Settings → Models | The same warning and link repeated in each of four rows. | One `Notice` above the group; rows show only the value. Decision 94g |
| 24 | B | Settings → General | "Last project / Home" is a third kind of segmented control. | `FilterTabs`-style `SegmentedControl` primitive, used everywhere a two- or three-way choice is inline. Decision 94g |
| 25 | B | Memory → search, Remembered, expanded exchange | Glued snippets, repeated subject, no visible end of an expanded block. | Returned to the executor (r2) |
| 26 | C | Side question | Header caption truncated ("Nothing here is added to the proj…"). | Caption moves to the empty state; the header keeps Keep / Clear only |
| 27 | C | Providers detail | Model list as six bare lines with "default" as a dim word. | `ListRow`s with the default marked by a quiet badge; fold after six stays |

## Decision 94 — what round 2 changes

a. **The file tree is a column, on the left, and it stays.** In a file group the tree is a real column at the
   group's left edge (like every editor), never an overlay over code. Its width comes from layout state (default
   220, resizable, remembered); the editor takes the rest. A file group's width floor becomes tree + 360. When the
   group cannot give that (narrow mode, phone) the tree is a separate page of the group: picking a file shows the
   editor with a "Files" back control — one deliberate navigation, no overlay, nothing covered. The tree toggle in
   the editor bar hides or shows the column (remembered per group). Decision 85's guarantees hold: opening a file
   changes only the editor's content.
b. **Errors speak the person's language.** No "ACP", "MCP", "exit status", method names or tool ids in any text the
   person reads; those go to "Details" (a fold) and the diagnostic report. Every failure is a `Notice` with: what
   happened in one sentence ("GitHub Copilot is not logged in."), the next step as a button or a copy line
   ("Check again", `copilot auth login`), and "Details". A rule in the harness's error catalogue test: the
   user-facing `message` of every typed error passes a word list (no ACP/MCP/exit status/stderr/…); the UI test
   does the same for its own strings.
c. **A command looks like something that runs.** Pinned commands are quiet buttons with a play glyph and the name,
   grouped at the end of the top row before "⋯", separated from tabs by the strip's divider; while one runs its
   glyph becomes the spinner and a click opens its run tab. No pinned command without the glyph.
d. **The palette has one "Requests" group**: this project's first when a project is open, then other projects',
   each row showing the project dim on the right; no second group.
e. **One name for an agent everywhere** (extends decision 46): the label from the provider entry ("Claude Code"),
   never the id (`claude-code`), in meta lines, usage, memory, sessions, errors.
f. **Narrow chat.** The jump-to-latest button floats above the composer's top edge with its own clearance and never
   overlaps a card (cards under it scroll with a bottom inset equal to the button's box); a queued row keeps its
   text as the priority and puts its actions in one "⋯" below 480 px.
g. **Settings rows.** A problem shared by several rows is said once, above them. Inline two- or three-way choices
   use one `SegmentedControl` primitive.
