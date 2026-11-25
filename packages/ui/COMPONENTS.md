# `@octo/ui` — components

The component library as it is in `src/components/primitives` and `src/components/shared`, the design tokens of
`src/styles.css`, the anatomy every tool tab follows, the UI decisions that bind how components are used, and how to add a
tool tab or a card. Layers and import rules: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Decisions in full:
[`docs/superpowers/specs/2026-11-10-project-harness-ui.md`](../../docs/superpowers/specs/2026-11-10-project-harness-ui.md).

Built on 2026-11-22 from the source: the list of files, each file's header comment, and an import graph of
`packages/ui/src`, `packages/agent-client/src`, `apps/desktop/src` and `apps/web/src` (a script that resolves every `import`,
`export ... from` and `import()`). "Importers" counts production files that import the file (tests excluded); the folders
named are the ones that import it most. Nothing here was checked in a browser for this page.

Contents: [Rules](#rules-of-use) · [Primitives](#primitives) · [Shared composites](#shared-composites) ·
[Unused and deprecated](#unused-deprecated-and-duplicated) · [Tokens](#design-tokens) · [Tool-tab anatomy](#tool-tab-anatomy) ·
[Decisions 79-100](#ui-decisions-79-to-100) · [Adding a tool tab or a card](#adding-a-tool-tab-or-a-card) ·
[Check scripts](#check-scripts)

## Rules of use

- A feature composes primitives and never styles a native control: the ESLint rule `octo/no-native-controls`
  (`scripts/eslint/no-native-controls.mjs`) warns on a bare `<button>`, `<input>`, `<select>` or `<textarea>` outside
  `components/primitives`.
- `primitives` import only `lib` (and agent-client types). `shared` may also read `state`. A feature imports `primitives`
  and `shared`, never another feature (`octo/layer-imports`, an error).
- Sizes come from one scale (`lib/controls.ts`: `xs` 24, `sm` 28, `md` 32, `lg` 40); a feature passes `size`, never a height.
  Under a coarse pointer or a narrow window the primitives grow a 40px hit area themselves (`touch:` variant, `touch-hit`).
- Tone is the glyph and the text colour; no coloured borders, fills or pulses (decision 81).
- `?demo=1&gallery=1` renders every primitive in every variant (`primitives/Gallery.tsx`, a lazy chunk);
  `scripts/gallery-shots.mjs` screenshots it.

## Primitives

65 files in `src/components/primitives` (5,141 lines; six test files). Grouped as in the library; one row per component.

### Actions

| Component (file) | For | Main props and variants | Not for | Importers (most) |
| --- | --- | --- | --- | --- |
| `Button` (`Button.tsx`) | A labelled action | `variant` primary, secondary, quiet, danger, link (`ghost` = `quiet`); `size` xs-lg; `icon`, `iconEnd`, `pressed`, `loading`, `fullWidth` | icon-only (`IconButton`), a value that opens a list (`Chip`, `Select`), a row (`ListRow`) | 128 (chat 20, settings 19, review 12, shared 12) |
| `IconButton` (`IconButton.tsx`) | An icon-only action; the required `label` is its name and tooltip | `size` xs 24, sm 28 (default), md 32, lg 40; `variant` quiet, primary, round; `shortcut` | a visible label (`Button`), a chip with a value (`Chip`) | 51 (primitives 10, chat 7, browser 5) |
| `IconMenu` (`IconMenu.tsx`) | The "⋯" of a detail or card: an icon button that opens a `Menu` | `label`, items | a trigger with a word (`MenuButton`), a value (`Select`), a context menu (`Menu`) | 11 (memory 3, review 2, sessions 2) |
| `MenuButton` (`MenuButton.tsx`) | A quiet text button with a chevron that opens a menu (decision 33) | 24px, `fg-2` | a value choice (`Select`) | 2 (commands, terminal) |
| `Chip` (`Chip.tsx`) | The composer's control-row chip (model, mode, branch): glyph, label, one chevron | `bare` drops the label | a plain action (`Button`) | 5 (chat 3) |
| `Segmented` (`Segmented.tsx`) | Two to five exclusive choices on a track (decision 33) | 24px segments in a 28px track, text only | a menu of options (`Select`), an on/off (`Switch`) | 12 (review 3, files 2) |
| `InlineButton` (`InlineButton.tsx`) | A button inside running text (a word that acts) | Enter and Space press it | a toolbar, row or form control | 3 (shared 2) |
| `FileInput` (`FileInput.tsx`) | The platform file dialog, hidden; gives files to `onFiles` | with or without its own `button` | dropping files, a visible file name | 2 (chat, notes) |

### Fields

| Component | For | Main props and variants | Not for | Importers |
| --- | --- | --- | --- | --- |
| `TextField`, `TextArea` (`TextField.tsx`) | A text value; one focus rule (the edge turns `fg`) | `size`; `variant` default, `bare` (the composer and comment boxes) | search (`SearchField`), a choice (`Select`), a label (`Field`) | 25 (settings 6, browser 3, sessions 3) |
| `Field` (`Field.tsx`) | A label, hint and error around a control | `label`, `hint`, `error` | – | 14 (review 4) |
| `FieldRow` (`FieldRow.tsx`) | Several fields on one grid: labels on one line, controls on one line, hints under the row (decision 84a) | `fields` | one field (`Field`) | 4 (settings 2) |
| `Select` (`Select.tsx`) | A value from a short list, opened as a menu; options may have a `group` | `size`, `side` | more than about 12 options or anything searchable (`Picker`), actions (`MenuButton`) | 15 (settings 11) |
| `SearchField` (`SearchField.tsx`) | The one search input: glyph, clear button, a `shortcut` hint while empty; Esc clears first | `variant` bordered, header, bare; `size`; `align="rows"` | a labelled value (`Field` + `TextField`), a combobox (`Picker`) | 15 (settings 4) |
| `Checkbox` (`Checkbox.tsx`) | A choice submitted with a form; the whole line is the target | `label`, `description` | an on/off that applies at once (`Switch`), exclusive choices (`Segmented`) | 12 (review 4) |
| `Switch` (`Switch.tsx`) | On/off that applies at once (decision 59), 40x24 | `label` | a form choice (`Checkbox`), more than two states (`Segmented`) | 10 (settings 8) |

### Lists and pickers

| Component | For | Main props and variants | Not for | Importers |
| --- | --- | --- | --- | --- |
| `ListRow` (`ListRow.tsx`) | A row of any list: nav, files, pull requests, pickers, tool rows, memory, queue | `size` 28 / 32 / 40, two-line, leading and trailing slots, selection, `level`, `tone`, `metaYields` | a table (`DataTable`), a menu item (`Menu`), a tab (`ViewTabs`) | 39 (memory 6, review 4, chat 3) |
| `ListFrame` (in `Card.tsx`) | A divided list of rows in a card | – | loose content (`Card`) | (with `Card`) |
| `ListDetail` (`ListDetail.tsx`) | List on the left, detail on the right; one column under 640px (decision 66) | `list`, `detail`, `listHeader` | a list that opens a dialog, a settings page, a table | 5 (memory 2) |
| `SectionHeader` (`SectionHeader.tsx`) | The one section heading | `level` caption (12px `fg-3`, 28px line) or title (14px semibold); `side` | a page title, a dialog title, a table header | 21 (memory 4, settings 3) |
| `MiddleText` (`MiddleText.tsx`) | A label cut in the middle only when its row is too narrow (CSS, no budget) | the text; full text goes in the control's tooltip | – | 9 (review 3) |
| `Picker` (`Picker.tsx`) | A searchable quick picker anchored to a control (decisions 25, 27): field on top, sections of 28px rows | `side`, `align`, sections | a short list without search (`Select`) | 6 (chat 2, dock 2) |
| `PopupList` (`PopupList.tsx`) | The one list inside every popup (slash, mention, "+", `Picker`, model list) | rows, `POPUP_PANEL` | a context menu of actions (`Menu`) | 4 (chat 2) |
| `Menu` (`Menu.tsx`) | A menu of actions (and the context menu at the pointer) | items with `shortcut`, `detail`, separators | a value (`Select`) | 31 (chat 5, review 3, sessions 3) |
| `ViewTabs` (`ViewTabs.tsx`) | View tabs under a panel header, with a hairline (decision 82) | tabs; a chosen tab can be a menu | filters (`FilterTabs`) | 4 |
| `FilterTabs` (`FilterTabs.tsx`) | Filter chips with dim counts (All / Open / Done) | filters, counts | views (`ViewTabs`) | 5 |
| `InfoList` (`InfoList.tsx`: `InfoSection`, `MoreRow`) | Overview lists of label and value rows (Details, Home cards) | caption, rows | – | 3; `INFO_ROW` used 13 times |
| `ScrollArea` (`ScrollArea.tsx`) | A scrolling box with faded ends and a stable gutter | `gutter` | Monaco, the transcript, a `Picker` list | 13 |

### Messages and loading

| Component | For | Main props and variants | Not for | Importers |
| --- | --- | --- | --- | --- |
| `Notice` (`Notice.tsx`) | What just happened or what is wrong | `tone` info, warn, error, success; line or block | an empty state (`EmptyState`), a toast, a field's error | 53 (settings 14, shared 6) |
| `EmptyState` (`EmptyState.tsx`) | Every empty panel as one block centred at about 42% of the height (decision 64h) | `title`, `tone` plain or err, `actions` | a message in a list (`Notice`) | 14 |
| `Skeleton`, `SkeletonList` (`Skeleton.tsx`), `SkeletonText` | The shape of something loading; static unless `shimmer` (decisions 76, 77) | `shape`, `size`, rows | a spinner on a button (`Button loading`), progress, an empty state | 34, 8 |
| `Spinner` (`Status.tsx`) | The working ring (decision 29: the only spinner shape) | `size` per control size | – | 32 |
| `StatusIcon`, `RunningDot`, `OrchestratorGlyph` (`statusMore.tsx`) | An agent's state as its ring; tier and model labels | – | – | 8 |

### Surfaces and overlays

| Component | For | Main props and variants | Not for | Importers |
| --- | --- | --- | --- | --- |
| `Card` (`Card.tsx`) | A block one tone above its panel, no outline (trial T3) | `surface` raised (default), code (`panel` = deprecated alias of raised); `padding` none, sm 8, md 12, lg 16; `header`, `footer` | a card in a card, a divided list (`ListFrame`), a message (`Notice`) | 11 (home 3) |
| `Panel` + `PanelFilters`, `PanelBody`, `PanelEmpty`, `DetailHeader`, `FormActions` (`Panel.tsx`) | The one frame of every tool tab (decision 95f): [anatomy](#tool-tab-anatomy) | `name`, `title`, `lead`, `actions`, `notice`, `filters`, `views`, `footer`, `column="measure"` | the chat, a code editor, a page, a dialog | 28 (memory 6, review 4, notes 3) |
| `Dialog` (`Dialog.tsx`) | A modal dialog that always fits the window (decision 51); primary action last | `title`, `footer` | a non-modal panel (`Popover`), the phone layout (`Sheet`) | 21 (settings 4, shared 3) |
| `Popover` (`Popover.tsx`) | A small non-modal panel anchored to a control (problems, pending comments) | `side`, `align` | a modal choice (`Dialog`) | 10 (chat 3) |
| `Sheet` (`Sheet.tsx`) | A sheet of the phone layout: from the bottom (85% max) or full screen | `variant` bottom, full | the desktop layout (CSS turns menus and popovers into sheets) | 4 |
| `Tooltips` (`Tooltips.tsx`) | The one tooltip layer for `title`/`data-tooltip` (mounted once by the app) | warm-up timing | a visible hint | 1 (app) |
| `Presence`, `usePresence` (`Presence.tsx`) | Enter and exit animation of an overlay, with the motion tokens | – | tab or panel swaps (instant) | 55 (chat 12, primitives 10, shell 7) |
| `useModal` (`useModal.ts`) | Focus, Esc and Tab cycling of an overlay | – | – | 4 |
| `ResizeHandle` (`ResizeHandle.tsx`) | A vertical separator: drag or ←/→ (±16, Shift ±64), double-click resets | `onDragStart`, value | – | 3 (dock, files, shell) |
| `CommandLine` (`CommandLine.tsx`) | A command in mono with a copy button (decision 53) | `command` | – | 8 (review 3) |
| `KeyHint` (`KeyHint.tsx`; `Kbd`, `Key` aliases) | A keyboard shortcut mark, decorative | key text | an icon button's tooltip (`shortcut`), a menu's shortcut column | 3 |

### Marks

| Component | For | Importers |
| --- | --- | --- |
| `Glyph` (`Glyph.tsx`) | The one icon wrapper: lucide at 16 or 14 with `--icon-stroke` | 76 |
| `GLYPH` (`glyphs.ts`) | One glyph per meaning, shared | 12 |
| `StateGlyph` (`StateGlyph.tsx`) | The one state glyph (decision 29): idle dot, working ring, failed, needs-you | 27 |
| `ProviderMark` (`ProviderMark.tsx`, `providerMarkAssets.ts`) | A vendor's logo as a CSS mask; assets in their own chunk | 9 |
| `Highlight` (`Highlight.tsx`) | The matched part of a name on the `mark` tint | 4 |
| `DayBars` (`DayBars.tsx`) | Bars per day with a readout (Usage) | 1 |
| `Streak` (`Streak.tsx`), `StreakLayer` (`StreakLayer.tsx`), `backdrop.ts` | The start screens' dithered band (decisions 21, 91a) | 1, 5, 2 |
| `fileIcons.ts` | Extension to icon, one neutral tone | 10 |
| `Prose` (`Prose.tsx`: `proseClass`) | The class of a block of rendered Markdown: `reading` or `compact` (decision 93g) | 5 |

Helpers in the folder: `popupNav.ts` (the keyboard contract of every popup list, decision 95), `popupScroll.ts` (when a
scroll closes a popup), `floatRoom.tsx` (room a list leaves for the floating composer), `gallery/` (the gallery's sections).

## Shared composites

27 files in `src/components/shared` (3,597 lines). They may read app state.

| Component | For | Importers |
| --- | --- | --- |
| `Markdown`, `MarkdownImage`, `FileLink`, `Prose` (`shared/Prose.tsx`) | Assistant Markdown with lazy highlighting; remote images as a chip until "Load image"; inline paths that open the file; Markdown at a prose scale | 11, 2, 1, 4 |
| `RequestCard` | The one card for "this needs you" (approval, form, plan, always-allow, a group of approvals; decision 91c) | 4 (v7 3) |
| `SchemaForm`, `useSchemaForm`, `SecretForm` | The one renderer of JSON-schema forms (decision 97); a write-only key field | 1, 2, 2 |
| `ModelPicker`, `ModelPickerPanel`, `modelPickerProps`, `ModelRefusedActions` | The model chip and its lazy list (decisions 27, 53, 56, 58); the way out of a refused switch | 3, 1, 2, 1 |
| `ErrorNotice` | A catalogue error with its hint and action button | 8 (chat 6) |
| `DataTable`, `UsageTable`, `WindowReport` | Tables of answers and tool results (decision 44); usage per model/project; `/context` | 2, 2, 1 |
| `PanelPurpose` | The (i) at the start of a tool tab's bar: the panel's purpose as its tooltip | 11 |
| `ReceiptPopover` | What a `window` request contained | 1 |
| `EditorContextMenu` | The editor's context menu (files, review, changes) | 3 |
| `FolderPicker`, `DeleteProjectDialog`, `MoveToWorktreeDialog` | Folder choice with completion; project deletion; moving a session into a worktree | 2, 3, 5 |
| `providers/ConnectDetail`, `ConnectSteps`, `ProviderRows` | The connect screen and sheet, provider rows | 2, 4, 5 |
| `useRemoteAccess`, `remoteText` | Remote access as the computer sees it; its texts | 2, 3 |

Other composites the task list names live in features or primitives: `Panel`, `PanelFilters` (primitives), `ListRow`,
`SectionHeader`, `EmptyState`, `Picker`, `Menu`, `Dialog`, `Popover`, `Tooltips`, `ResizeHandle`, `MiddleText`, `Chip`,
`StateGlyph`, `FieldRow` (all primitives, above).

## Unused, deprecated and duplicated

From the import graph (no production importer) and the `@deprecated` tags. The table below lists each item.

| Item | State |
| --- | --- |
| `components/chat/StarterPrompts.tsx` (77 lines) | Nothing imports it |
| `components/files/editor/completion/CompletionStatus.tsx` (40 lines) | Nothing imports it |
| `lib/must.ts` | Imported by tests only (a test helper in `lib/`) |
| `components/chat/readyLazy.ts` | A two-line re-export of `lib/readyLazy` left by the bundle work; one importer (`Transcript.tsx`) |
| `Input`, `Textarea` (`Field.tsx`) | Deprecated aliases of `TextField`, `TextArea`; still imported by 7 files |
| `IconButton` exported from `Button.tsx` | Deprecated (old sizes); still imported by 7 files |
| `SkeletonRows`, `INFO_ROW_BUTTON` (`InfoList.tsx`) | Deprecated (use `SkeletonList`, `ListRow`); 2 and 1 uses |
| `Kbd`, `Key` (`KeyHint.tsx`) | Aliases of `KeyHint`; `review/parts.tsx` also exports its own `Key` |
| `Card surface="panel"` | Deprecated alias of `raised` |
| `shell/Panel.tsx` vs `primitives/Panel.tsx` | Two components named `Panel`: the window's card surface and the tool-tab frame; both set `data-panel` |
| `review/parts.tsx` `Notice` vs `primitives/Notice` | Same name, different thing (the review's is an `EmptyState`) |
| `review/useWidth.ts` and `v7/useWidth.ts` | Byte-identical files |
| `primitives/Prose.tsx` and `shared/Prose.tsx` | Layered on purpose (a class name; a component that renders Markdown at that scale) |

Off by default but not dead: the tool tabs behind `DEFAULT_TAB_FLAGS` (`sessions`, `agents`, `notes`, `details`, `usage`,
`memory`; `lib/tabFlags.ts`) and their folders (`components/agents`, `notes`, `details`, `usage`, `memory`, the Sessions tab
in `components/sessions`). `?tabs=all` turns them on; the scripts that check them set it.

## Design tokens

All in `src/styles.css` (2,746 lines). Colours are CSS variables `--octo-*` per theme, exposed to Tailwind as `--color-*`
by `@theme inline`; everything else is in `@theme`.

### Themes

Six palettes on `:root[data-theme]`: the default dark (also when no theme is set), `light`, and four dark ones named after
other tools (`cursor`, `claude`, `codex`, `opencode`). The `dark:` variant means "any theme but light".

### Colour roles

| Token (Tailwind name) | Role | Dark default | Light |
| --- | --- | --- | --- |
| `window` | The window behind the panels | `#0b0b0b` | `#f5f5f5` |
| `panel` | A panel (card on the window) | `#171717` | `#ffffff` |
| `raised` | A box on a panel; the chosen tab | `#232323` | `#f3f3f3` |
| `overlay` | Menus, popovers, dialogs | `#262626` | `#ffffff` |
| `code-bg` | Code blocks | `#1d1d1d` | `#f3f3f3` |
| `hover`, `active` | Hover fill; the selected row or tab (clearly above hover) | white 5%, 12% | black 3.5%, 6.5% |
| `line`, `line-strong`, `panel-edge` | Hairlines; a stronger line; a panel's edge | white 8%, 14%, 5% | black 9%, 14%, 6% |
| `field-edge`, `input-border` | A text field's edge at rest; strong edges (checkbox, composer focus) | white 14%, `#7a7a7a` | black 14%, `#8a8a8a` |
| `seg-track`, `seg-on` | Segmented track and chosen segment | white 6%, 12% | black 5%, white |
| `fg`, `fg-2`, `fg-3` | Text: primary, secondary, dim | `#f0f0f0`, `#c6c6c6`, `#a2a2a2` | `#1a1a1a`, `#424242`, `#5e5e5e` |
| `accent` | Activity: running, unseen | `#5c9dff` | `#0a66e0` |
| `link` | Links | `#6fa8ff` | `#0a5fd1` |
| `ok`, `err`, `warn` | Done, failed, attention (glyph and text only) | `#5fbf7f`, `#f6847e`, `#d8b07a` | `#17703d`, `#b42a23`, `#8a5512` |
| `primary`, `primary-fg` | The one filled button | `#ececec` on `#141414` | `#1a1a1a` on white |
| `focus`, `scrim`, `mark`, `drop`, `drop-edge` | Focus ring; overlay scrim; search-match tint; drop target | | |
| `--octo-ctx-*` | One hue per context part (messages, tool results, summary, notes, tools, system, other; decision 38) | | |

Shadows: `shadow-pop` (overlays), `shadow-panel`, `shadow-float`, `shadow-tab`, `shadow-seg`.

### Spacing

The scale is 2, 4, 6, 8, 12, 16, 20, 24, 32, 40 px (Tailwind steps 0.5 to 10) and nothing else; `scripts/spacing-audit.mjs`
fails on any other value.

| Token | Value | For |
| --- | --- | --- |
| `gutter` | 8 | Window edge to panel, panel to panel |
| `pane` | 8 | Panel edge to its strip, rows and bars |
| `card` | 12 | Card edge to content |
| `dialog` | 20 (16 under 640px) | Dialog edge to content |
| `pad` | 24 (16 under 560px) | Conversation side padding |
| `slot` | 16 | The leading slot of every row |
| `measure`, `answer` | 720px, 60ch | The conversation column; running text of answers |
| `sidebar`, `float`, `details`, `home`, `dialog-wide` | 260, 640, 480, 880, 640 px | Column widths |
| `--octo-prose-gap`, `-heading-top`, `-heading-bottom`, `-item` | 12, 24, 8, 4 | Prose rhythm |

### Control heights

| Token | px | Old aliases (same pixels) | For |
| --- | --- | --- | --- |
| `ctl-xs` | 24 | `h-6`, `h-chip` | Compact toolbar buttons, chips, meta rows |
| `ctl-sm` | 28 | `h-7`, `h-row` | Tabs, tree and menu rows, quiet buttons |
| `ctl-md` | 32 | `h-8`, `h-row-nav` | The default: fields, buttons, nav rows |
| `ctl-lg` | 40 | `h-10`, `h-bar` | Header rows, touch height, one-line composer |
| `strip` | 36 | – | The dock group's tab strip |
| `touch` | 40 | – | Minimum hit area on touch |

New code writes only the `ctl` names, and only inside a primitive (`lib/controls.ts`, a test keeps the numbers equal).

### Radii, type, icons

| Radius | px | For |
| --- | --- | --- |
| `2xs` | 2 | Key hints, composer marks |
| `xs` | 4 | Inline code, focus marks, delegation rows |
| `sm` | 6 | Chips, segments, tiny buttons |
| `md` | 8 | Fields, buttons, selectable rows, cards, code blocks |
| `xl` | 12 | Panels, grouped-list cards, overlays, the composer |
| `full` | pill | Only a `round` variant |

| Type | Size / line | Weight | For |
| --- | --- | --- | --- |
| `xs` | 12 / 16 | | Captions, meta |
| `sm` | 13 / 20 | | Most UI text |
| `base` | 14 / 22 | | Answers, fields |
| `heading` | 14 / 20 | 600 | Dialog and section titles |
| `title` | 16 / 20 | 600 | Page titles, Markdown h1-h2 |
| `display`, `figure` | 20 / 28, 24 / 32 | 600 | Home only |
| `input-touch` | 16 / 20 | | Fields on touch screens (iOS does not zoom) |

Fonts: `Inter Variable` (UI), the system mono stack (code). Icons: lucide with `--icon-stroke: 1.5px` at 12, 14, 16, 20.
The sidebar becomes a drawer below `--breakpoint-drawer` (1000px; `DRAWER_BELOW` in `lib/constants.ts`, a test keeps
them equal).

### Motion

| Token | Duration | For |
| --- | --- | --- |
| `--motion-fast` (`duration-fast`) | 100 ms | Hover fills, reveals, presses, every exit |
| `--motion-base` (`duration-base`) | 150 ms | Overlays, chevrons, switches |
| `--motion-slow` (`duration-slow`) | 220 ms | Drawers, sheets, large surfaces |
| `--ease-out-quint` | `cubic-bezier(0.2, 0, 0, 1)` | Enters |

Only opacity, transforms, colours and shadows move, never a layout property; tab and panel swaps are instant; under
`prefers-reduced-motion` only plain cross-fades remain (overlays) and the working ring stops. `lib/constants.ts` mirrors the durations for the Web Animations API.

## Tool-tab anatomy

Every dock tool tab (Sessions, Memory, Notes, Usage, Agents, Details, Changes, Processes, Review) is a `Panel`
(`primitives/Panel.tsx`, decision 95f). The Files and Browser tabs have their own bars with the same measures.

| Part | Measure | Token or class | Notes |
| --- | --- | --- | --- |
| Bar | 40px, one hairline under it across the full width | `h-ctl-lg`, `--octo-line` | No title (G1, 2026-11-18: the dock tab names the panel); `lead` (the `PanelPurpose` (i), a repository menu) at the left, `actions` at the right, one baseline |
| Insets | Edges 8px, text 16px (row label: 8 + 8) | `px-pane` | Title, filters, section headers and the detail title start at 16: one vertical line through the tab |
| Filter row | At most one, 36px: `FilterTabs` then a `SearchField` | `PanelFilters` | May be a `ListDetail`'s `listHeader` (over the list column only) |
| View tabs | A `ViewTabs` row with its own hairline | decision 82 | Content below draws no top line |
| Rows | 32px, 40 with a second line; 4px from the bar or filter row to the first row | `ListRow` sizes | |
| Content | `ListDetail` or `PanelBody` (one scrolling column) | | `column="measure"` caps header, notice and footer to `PANEL_COLUMN` |
| Empty state | One block centred at about 42% of the height | `PanelEmpty` / `EmptyState` | Never a sentence at the top of an empty page |
| Footer | One dim line | | |

`scripts/spacing-audit.mjs` checks the frame through the `data-panel` markers ("panel-frame");
`scripts/panel-measure.mjs` measures and screenshots every tab.

## UI decisions 79 to 100

One line each; the text in full is in the UI spec (headings "Decision NN").

| # | Rule |
| --- | --- |
| 79 | A pane's width comes from the layout state only, never from what it shows |
| 80 | A folder has no label anywhere |
| 81 | No coloured frames: a card that waits for you has a neutral border; the glyph and the one filled button say so |
| 82 | View tabs (a hairline under the row) and filters never look alike |
| 83 | A tab is as wide as its title |
| 84 | Fields in a row share one baseline (`FieldRow`); local review is a list, not a form |
| 85 | Opening a file changes nothing but the editor's content (one `FileView` per group; the tree is a column) |
| 86 | Tokens per model, per project, in Usage; across projects in Settings; on the turn line |
| 87 | The composer does not glow |
| 88 | `/context` shows the whole window, itemised down to each tool and file |
| 89 | Providers is a list and a detail with equal rows |
| 90 | One component library: extend primitives, do not repeat them |
| 91 | UI review round 1, rules a to k (the backdrop never behind content, one "needs you" card, one activity row, ...) |
| 92 | A keyboard shortcut is never a boxed letter inside a control |
| 93 | Memory is Sessions, Knowledge and Files under one search, read in compact prose |
| 94 | UI review round 2, rules a to g (the tree stays a column, errors in the person's words, ...) |
| 95 | Every popup list takes the keys at once (`popupNav`); one panel frame for every tool tab (95f) |
| 96 | Parallel sessions: the sidebar is a tree of projects and sessions; every main session runs at once |
| 97 | Forms are built from a JSON schema (one renderer, `SchemaForm`) |
| 98 | Compact folders in the file tree (`chain` on `GET /files`) |
| 99 | Changing project never blinks (shown only when it can be painted complete in one frame) |
| 100 | The composer's branch chip is the real branch and picks another; a refused switch offers a worktree (code comments still say "98") |

## Adding a tool tab or a card

**A tool tab**

1. Add the id to `ToolTab` and `TOOLS` in `src/state/workspace/layout.ts`, its label, glyph and purpose to
   `components/dock/tabInfo.ts` and `lib/toolPurpose.ts`.
2. Decide its flag in `DEFAULT_TAB_FLAGS` (`lib/tabFlags.ts`); a flag is UI only and never changes the harness.
3. Build the screen in its own feature folder as a `Panel` with a `name` (for the spacing audit) and a `PanelPurpose` in
   `lead`. Use primitives only.
4. Mount it in `components/dock/TabView.tsx` behind `readyLazy` and register its loader with `registerWarm("tool:<id>", ...)`
   (`warmedTool`), so the chunk is warmed on idle or intent and the first open does not suspend (`lib/readyLazy.ts`,
   `lib/warm.ts`). Never import it statically from the entry.
5. Build and run `node scripts/check-bundle-size.mjs`: the entry (gzip, with its preloads) must stay within `BUDGET_KB`
   (161.00 kB on 2026-11-22). Raising the budget needs a reason in the script's header.
6. Add its demo data to `src/demo/` (and any new `Bridge` method to agent-client first, then `demo/bridge.ts`).
7. Add a tour state to `scripts/ui-tour-states.mjs` (with `tabs=all` if the flag is off), then run `spacing-audit.mjs`
   (must print `total=0`), `panel-measure.mjs`, `frame-colours.mjs`, in dark and light, at 1440, 1100 and 390 wide.

**A card that needs the person** (an approval-like request): use `shared/RequestCard` in the transcript slot the shell fills
(`state/chatSlots`), with a `StateGlyph`, a neutral border (decision 81), one primary `Button`, and keyboard answers listed
in the tooltip, never as boxed letters (decision 92). Check it with `frame-colours.mjs`.

## Check scripts

`packages/ui/scripts/`, run against a dev server (`pnpm --filter @octo/desktop dev`, `?demo=1`) with
`--url http://localhost:1420`; every script takes `--browser chromium|webkit` (`browser.mjs`). None runs in CI.

| Script | Verifies |
| --- | --- |
| `spacing-audit.mjs` | Every spacing, height and radius on the scale; panel frames; must print `total=0` |
| `panel-measure.mjs` | Measures and screenshots every tool tab's frame (decision 95f) |
| `frame-colours.mjs` | No warn, error or accent border, outline or ring (decision 81) |
| `width-stability.mjs` | Pane widths never follow content (decision 79) |
| `file-open-stability.mjs`, `layout-shift.mjs` | Opening a file changes nothing but the editor (decisions 85, 60) |
| `flicker.mjs` | Per-frame stability while typing; no running animation on idle screens (decisions 69, 76) |
| `project-switch.mjs` | Changing project paints the next conversation complete in one frame (decision 99) |
| `scroll-on-send.mjs`, `stick-on-open.mjs`, `scroll-anchor.mjs` | Sending scrolls to the message; a long conversation opens at its end; the text under the eyes never jumps |
| `composer-fit.mjs` | The composer grows a line at a time, then scrolls |
| `picker-keys.mjs`, `dropdown-scroll.mjs` | Every popup list takes the keys at once; scrolling never closes a popup on its own (decision 95) |
| `slash-commands.mjs` | Every slash command, typed, from the menu, by click (4 to 6 minutes) |
| `schema-forms.mjs` | Schema forms: errors, values, collapse, focus (spec 2026-11-15) |
| `editor-context-menu.mjs` | The editor's context menu stays open (WebKit with a macOS user agent) |
| `backdrop-check.mjs` | Nothing with text sits on the start screens' band (decision 91a) |
| `gallery-shots.mjs` | Screenshots of the component gallery in dark and light |
| `ui-tour.mjs`, `ui-tour-states.mjs`, `tour-sheets.py` | Every screen in dark and light at four sizes; contact sheets |

Repository checks that touch the UI: `pnpm lint` (tsc, ESLint with `octo/layer-imports` and `octo/no-native-controls`,
`scripts/check-cycles.mjs`), `pnpm test:scripts` (the ESLint rule's tests), `pnpm --filter @octo/ui test` (node:test beside
the code), `node scripts/check-bundle-size.mjs` after the desktop build (CI).
