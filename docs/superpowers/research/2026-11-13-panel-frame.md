# Panel frame: measurements before and after (decision 95f)

Owner, after looking at the tool tabs by hand: sessions lack space, spacing is unbalanced and different everywhere, Memory
looks one way and Sessions another, Notes is not neat. Measured with `packages/ui/scripts/panel-measure.mjs` on the demo
(`?demo=1`, Atlas API, 1440x900, dark; light gives the same numbers). Pixels, relative to the tab's panel. "Before" finds the
parts of each old screen by role (a heuristic, so a "-" means the screen has no such part, and a few cells such as the Changes
and Files rows are approximate); "after" reads the `Panel` markers. Screenshots and contact sheets are in the executor's
scratchpad, not in the repository.

Columns: header h = height of the first line of the screen; text x = left edge of the first text (title, filter chip, row label);
gap = distance from the chrome above (header, filter row or view tabs) to the first row; dy = distance between the centres of
the title text and the action text.

## Before

| tab | header h | header x | filter h | filter text x | row text x | gap above first row | row h | other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sessions | 40 (button row, 8 above) | 8 (button box) | 28 | 10 | 39 | 0 | 40 | action at the left, no title |
| Memory / Sessions | 44 (search) | 8 | none | - | 16 | 0 | 40 | search + view tabs, no title |
| Memory / Knowledge | 44 | 8 | 28 | 18 | 40 | 32 | 28 / 40 | filter chips at 18, rows at 40 |
| Memory / Files | 44 | 8 | none | - | 40 | 0 | 40 | |
| Notes | 44 (search + two icon buttons) | 8 | none | - | 40 | 0 | 40 | action is a bare icon at the right |
| Usage | 33 (view tabs only) | 8 | 64 (two selects wrap) | 29 | 16 | 40 | 41 | selects at 29, table at 16 |
| Agents | 28 (section caption) | 16 | none | - | 40 | 0 | 32 | centred column, 480 max |
| Details | none (section caption) | - | none | - | 40 | - | 28 | centred column, 480 max |
| Changes | none | 8 | none | - | - | - | 24 | list at 8 |

What the owner sees: the first text of a screen starts at 8, 10, 16, 18, 29 or 40 depending on the tab; chips and rows of one
list do not share an edge (Sessions: chips 10, row text 39); the header is 28, 33, 40 or 44 high or absent; the action is a
button at the left in Sessions, an icon at the right in Notes, a link-like "Add" inside a section in Memory; Agents, Details and
Usage are centred columns while Sessions and Memory fill the pane, so the inset changes with the window.

## After (decision 95f: `primitives/Panel`)

| tab | header h | title text x | action right inset | filter h | filter text x | row text x | gap above first row | row h | dy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sessions | 40 | 16 | 8 | 36 | 16 | 39 | 4 | 40 | 0 |
| Memory / Sessions | 40 | 16 | - | 36 (search) | - | 16 | 4 | 40 | - |
| Memory / Knowledge | 40 | 16 | - | 36 | - | 40 | 32 (after the "Remembered" caption) | 28 caption / 40 | - |
| Memory / Files | 40 | 16 | - | 36 | - | 40 | 4 | 40 | - |
| Notes | 40 | 16 | 8 | 36 (search) | - | 16 | 4 | 40 | 0 |
| Usage | 40 | 16 | - | 36 (selects) | 21 (the select box edge, 8) | - | - | - | - |
| Agents | 40 | 16 | - | none | - | 40 | 32 (after the "Finished" caption) | 32 | - |
| Details | 40 | 16 | - | none | - | 40 | 32 (after the "Project" caption) | 28 | - |
| Changes | 40 | 16 | - | none | - | 20 | 4 (list top inset) | 28 | - |

Equal across every tool tab (the spacing audit's `panel-frame` check): header height 40, header text inset 16, list horizontal
inset 8, list top inset 4. 900x600 gives the same numbers; at 390x700 rows and the filter row grow to the 40px touch size.

## What changed

- `primitives/Panel`: header (title, dim meta, actions at the right), optional filter row (`PanelFilters`), view tabs, body
  (`PanelBody`, one scrolling column, left aligned at every width), one footer line; `DetailHeader` (Back in one column, title,
  meta, actions on one 28px line); `PanelEmpty`.
- `FilterTabs`: chips are 24px high with 8px of side padding, 4px apart, so their text starts on the row edge; `bare` for use in
  `PanelFilters`.
- `ListDetail`: the list's top inset is 4px, the detail brings its Back control inside a `DetailHeader` (the old Back row is not
  drawn then), the default detail padding is the frame's.
- Screens on the frame: Sessions, Memory (Sessions, Knowledge, Files, search results), Notes, Usage, Agents, Details, Changes.
- Not on the frame yet: the Files list and tree column, Review, the side question (owned elsewhere or an input of their own).

## Left uneven, and why

- Memory Knowledge, Agents and Details start with a 28px section caption, so their first row sits 32px under the header or
  filter row, not 4px; the captions are section headers, not rows.
- Details rows are 28px info rows (label / value), not 32px list rows.
- Sessions rows carry a state glyph, so their text starts at 40 while Memory's session rows (no glyph unless working) start at 16;
  the glyph column lines up with the title at 16.
- Verified with Playwright against `?demo=1` only; not verified in the Tauri shell or with the live harness.
