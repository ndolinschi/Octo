# UI component audit — one component library (2026-11-12)

Owner: "check that all components are unique, extended rather than repeated, not duplicates of each other; if the UI's
consistency is at the level of a UI component library the whole UI will be tidier."

Scope: `packages/ui/src` (163 `.tsx` files, `demo/` excluded) at commit `6ba3e27`. Read-only audit: no component was
changed. The only code that lands with this document is the lint rule `octo/no-native-controls` (warn) and its tests.

## 0. Method, and what was not done as asked

- **No Haiku sub-agents.** The brief asked for seven Haiku sub-agents, one per folder slice. This session had no Agent
  tool, so none could be started. The inventory was produced by one TypeScript-compiler-API script instead
  (`scripts` were kept outside the repo): it walks every `.tsx`, records every JSX element with `file:line`, tag, `role`,
  `type` and the `className` string pieces (including the string arguments of `cn(...)` and template literals), and every
  top-level component declaration. Counts below come from that data; the groupings and the judgement are mine.
- **Verification of rows.** Because the rows are machine-made, the check was mechanical plus reading:
  all 2,733 rows were checked to have their tag on the reported line (0 wrong); 40 evenly spaced rows were checked for
  their first class run within 15 lines (39 matched; the one miss, `files/TreeColumn.tsx:136`, is a correct row whose class
  string starts further down, so 0 real errors). I also opened by hand the files of every group named in section 3
  (about 30 files). Total: 2,773 row checks, 0 wrong. This says the script is accurate; it says nothing about a Haiku
  agent, which was not used.
- **Known blind spots of the counts.** (a) About 25 of the 130 native elements take their `className` from a variable or a
  spread (the class column is empty in the row; they are counted as native, not as class groups). (b) Class strings kept in
  constants outside JSX (`INFO_ROW`, `ROW`, `panelClass`, `boxClass`) are visible only where they are used by `cn(...)`
  inside JSX. (c) CSS classes in `styles.css` (`octo-card`, `octo-v7-kbd`, `octo-composer`) are not audited for
  duplication. (d) "Copies" are structural matches by regex; a group count is a good order of magnitude, not an exact census.

## 1. Headline numbers

| What | Count |
| --- | --- |
| `.tsx` files / JSX elements | 163 / 2,733 |
| Top-level component-like declarations (includes about 25 `lazy()` aliases and local re-declarations) | 399 |
| Exported components in `components/primitives` | 31 (Button, IconButton, Chip, CommandLine, DayBars, Dialog, EmptyState, Input, Textarea, Field, Glyph, Highlight, InfoSection, MoreRow, SkeletonRows, Menu, MenuButton, Picker, Popover, Presence, ProviderMark, Segmented, StateGlyph, Spinner, RunningDot, StatusIcon, OrchestratorGlyph, Streak, StreakLayer, Tooltips, FloatRoom) |
| Control-grade primitives (things a person clicks or types in) | 10 (Button, IconButton, Chip, MenuButton, Segmented, Input, Textarea, Menu, Picker, Popover) |
| **Native controls outside `primitives` (hand-rolled)** | **130**: 109 `<button>`, 15 `<input>`, 4 `<select>`, 2 `<textarea>`; 0 `<dialog>` |
| ...in how many folders | 17 of 19 (chat 26, review 15, files 14, settings 14, shared 11, memory 8, v7 7, side 6, details 5, home 5, status 5, shell 4, agents 3, dock 3, project 2, notes 1, providers 1) |
| Share of buttons that use the primitive | 153 primitive call sites (Button 112, IconButton 38, Chip 3) vs 109 native: 58 % |
| "Pseudo-primitives" that live in a feature folder (same job as a primitive, or a primitive that is not shared) | 27: settings/parts (Switch, Select, SettingsGroup, SettingsRow, SkeletonRow, StateDot, SaveStatus), memory/parts (ListDetail, ListRow, RowList, Block, Loading, ErrorState, Empty, DetailTitle), review/parts (Notice, Key), v7/parts (Kbd, ErrorLine, CardFrame, LineCounts), v7/DiffPanel Banner, v7/ChangesView Empty, chat/Composer Notice, files/FileView Notice, review/ReviewView Banners, shared (DataTable, TableFrame) |
| Repeated class runs (5 or more utilities, in 2 or more files) | 132 distinct runs (rule 7 of the TypeScript rules) |
| Touch-size overrides written by hand (`max-md:h-10`, `max-sm:h-10`, `max-md:h-bar`, `max-md:size-10`) | 62 elements in 15 files (only v7, review, side, agents; chat, files, memory, settings have none) |
| Primitives the spec asks for that do not exist | ViewTabs and FilterTabs (decision 82), FieldRow (84), ListDetail as shared (66; exists only in `memory/parts` and only memory uses it), Skeleton as a primitive (77; `SkeletonRows` is inside `InfoList` and four other skeletons are hand-made) |

## 2. What `components/primitives` has

Call sites are JSX elements outside `primitives`.

| Primitive | Props that change the look | Call sites (files) | Notes |
| --- | --- | --- | --- |
| `Button` | `variant` primary / secondary / ghost / danger; `size` sm (28px) / md (32px); `icon` | 112 (39) | No 24px size, no link variant, no touch size; `danger` is a bordered button with red text (decision 81c wants quiet) |
| `IconButton` | `size` sm (24) / md (28); `pressed`; `label` is required | 38 (19) | Glyph 14 / 16 by size; no 20px size (`TreeColumn:75` uses size-5) |
| `Chip` | `bare`, `open`, `warn`; `icon`, `label`, `name` | 3 (2) | Composer chips only; `MenuButton`, `ContextRing`, `EditorStatus`, `CommentsControl` are the same shape by hand |
| `MenuButton` | `alignEnd` | 1 (1) | |
| `Segmented` | options, `value` | 10 (8) | Radio group, 24px, text only |
| `Input`, `Textarea` | none (only `className`) | 21 (13), 8 (7) | One look: 32px, radius md, `border-input-border`, `bg-panel`, `px-3` |
| `Field` | `hint`, `error`, `optional` | 16 (6) | Label + control + hint; not a row |
| `Dialog` | `width` sm / md / lg; `nav`; `footer` | 8 (7) | Padding hard-coded `px-4 sm:px-5`; the `--spacing-dialog` token has 0 uses |
| `Popover` | `side`, `align`, `gap` | 4 (4) | |
| `Menu` | items incl. separator, checked, shortcut | 7 (5) | Context menu at a point |
| `Picker` | sections of rows | 3 (3) | A searchable list; `CommandPalette`, `ComposerMenu`, `ModelPickerPanel` re-implement the same combobox |
| `EmptyState` | `tone` plain / err; `actions` | 7 (7) | Wrapped three times (`memory Empty`, `v7 Empty`, `review Notice`) |
| `InfoSection`, `MoreRow`, `INFO_ROW`, `INFO_ROW_BUTTON`, `SkeletonRows` | `aside`, `slot` | 13 (5), 3 (1), -, -, 13 (11) | Row constants are the closest thing to a ListRow |
| `CommandLine` | `label` | 5 (4) | The "copy line" |
| `Spinner` | `size` (default 12) | 34 (26) | Sizes in use: 10 (8 places), 12 (15), default |
| `StateGlyph`, `StatusIcon`, `RunningDot`, `OrchestratorGlyph` | state, size | 11 (10), 2, 6, 2 | |
| `Glyph` | `size` 14 / 16 only | 97 (54) | The one place icon size is truly enforced |
| `ProviderMark`, `Highlight`, `DayBars`, `Presence`, `Streak`, `StreakLayer`, `Tooltips`, `FloatRoom` | | 3, 5, 1, 27, 0 (lazy), 5, 1, 5 | |

Missing entirely: Checkbox, Radio, Switch (exists in `settings/parts`), Select (exists in `settings/parts`), search field,
Notice / Banner, Skeleton block, Kbd, Badge / Pill, Card / grouped-list frame, Toolbar, SectionHeader, ViewTabs, FilterTabs,
FieldRow, ListRow, ToggleButton, LinkButton, ScrollArea, Table (exists in `shared`), ListDetail.

## 3. Duplicates and near-duplicates

Each group: where, how the copies differ, the one component, what it needs from the others.

### 3.1 Buttons

**A. Quiet text button, hand-rolled** — 32 elements in 24 files. `button` + `hover:bg-hover` + `rounded-sm` + `px-1.5|px-2`
+ `text-xs|text-sm` + `text-fg-2|text-fg-3` + `hover:text-fg`, no border: `chat/CommentsControl.tsx:67`,
`files/EditorStatus.tsx:70`, `files/FileTree.tsx:234`, `files/editor/CommentBox.tsx:109,112`, `review/ReviewHeader.tsx:53,63`,
`settings/AgentPrefsPane.tsx:49`, `shared/Markdown.tsx:82`, `shared/ModelPickerPanel.tsx:209,217`, `side/SidePanel.tsx:104`,
`details/DetailsPanel.tsx:382`, `chat/ToolDetail.tsx:120`, `shared/DataTable.tsx:49,58`, `chat/AgentHeader.tsx:107`,
`chat/Transcript.tsx:213`, `chat/SentComments.tsx:75`, `memory/ContextTab.tsx:165` and more.
Differences: height `h-6` (14) / `h-chip` (9) / `h-7` (11) / `h-row` (10); padding `px-1`, `px-1.5`, `px-2`; text `xs` or `sm`;
gap `1` or `1.5`; `press` present on some, missing on others. `Button` `ghost` is `h-7 px-3 text-sm` or `h-8 px-3`, and
none of the 32 is that size. **Single component:** `Button variant="ghost"` with a new `size="xs"` (24px, `px-2`, `text-xs`)
and `size="sm"` (28px, `px-2`). Nothing else needed except `iconOnly` for the square ones and a `touch` behaviour (3.1 D).

**B. Square icon buttons, hand-rolled** — 12 in 11 files: `chat/CommentsControl.tsx:107` (size-6, `rounded-sm`),
`chat/Composer.tsx:284` (size-7), `chat/ComposerPills.tsx:30` (size-6, `rounded-xs`), `files/TreeColumn.tsx:75` (size-5,
`rounded-2xs`), `settings/parts.tsx:66` (size-6), `dock/TabStrip.tsx:241` (`h-chip w-6`), `dock/Tab.tsx:108`,
`shared/ModelPickerPanel.tsx:299` (size-6, `rounded-xs`), `files/editor/EditorComments.tsx:349`, `chat/ConversationView.tsx:291`
(size-8, `rounded-full`, shadow), `chat/Composer.tsx:374` (the send button: size-7, `rounded-full`, `bg-primary`),
`side/SidePanel.tsx:210` (size-7 submit, `rounded-sm`, `bg-primary`). Radius is `sm`, `xs`, `2xs` or `full` for the same job.
**Single component:** `IconButton` (add `size="xs"` 20px, `shape="round"`, `variant="primary"` for send/submit, `floating`
for the shadowed overlay one; the close "x" in a row uses `size="xs"`).

**C. Link-style button** — 15 elements in 12 files, five of them the identical `rounded-xs text-link underline-offset-2
hover:underline`: `memory/TasksTab.tsx:148,231`, `providers/ConnectSheet.tsx:214`, `settings/ModelsSection.tsx:90`,
`settings/parts.tsx:105`; mono path variants `review/PendingPanel.tsx:124,179`, `chat/SentComments.tsx:45`,
`chat/ToolDetail.tsx:52,82` (`text-fg-2` with underline on hover) and `shared/FileLink.tsx:26` (a CSS class); plain
`underline`: `details/DetailsPanel.tsx:141`, `side/SidePanel.tsx:144`, `v7/Gallery.tsx:194`, `v7/ApprovalCard.tsx:80`.
Differences: colour (`link`, `fg`, `fg-2`), when the underline shows, `font-mono`, radius `xs`. **Single component:**
`LinkButton` (`tone` link / quiet, `mono`) — or `Button variant="link"`.

**D. Touch-target overrides** — 62 elements in 15 files add `max-md:h-10` / `max-sm:h-10` / `max-md:h-bar` / `max-md:size-10`
by hand: v7 (`InputFormCard` 6, `QueueList` 5, `FormFields` 3, `ApprovalCard` 3, `DiffPanel` 2, `TurnFiles` 1), review (`PullList`
6, `ReviewHeader` 4, `PendingPanel` 3, `Composer` 3, `FileList` 2, `DiffPane` 2), `side/SidePanel.tsx` 3, `agents/AgentsPanel.tsx` 3,
`primitives/Picker.tsx` 1. Everything else (chat, files, memory, settings, details, home) has no touch size at all.
**Fix:** touch height lives inside `Button`, `IconButton`, `Chip`, `ListRow`, `Checkbox` (one `@media (pointer: coarse)` or
`max-md:` rule, written once); a feature never writes it.

**E. Toggle buttons** (`aria-pressed`, on = `bg-active text-fg`, off = `text-fg-3`) — 8: `files/FileView.tsx:347,384`,
`memory/SearchTab.tsx:86`, `settings/IntegrationsView.tsx:145` (has a `border` the others lack), `side/SidePanel.tsx:91`,
`details/DetailsPanel.tsx:382`, `v7/DiffPanel.tsx:64`, `chat/ToolDetail.tsx:120`, plus `home/Home.tsx:95` (a card). Also
`Segmented` and `FilterTabs` (not built) are the same idea. **Single component:** `Button` / `IconButton` with `pressed`
(IconButton has it, Button does not) — add `pressed` to `Button`.

### 3.2 List rows

**F. Full-width selectable row button** — 21 elements in 15 files carry `press-row` and the row recipe
`flex … items-center gap-2 rounded-sm px-2 text-sm hover:bg-hover focus-inset`: `agents/AgentsPanel.tsx:61,111`,
`chat/StarterPrompts.tsx:17`, `chat/ToolGroup.tsx:98,126`, `chat/LivePanels.tsx:22`, `chat/CommentsControl.tsx:91`,
`home/Home.tsx:179,190,220`, `memory/parts.tsx:128` (ListRow), `memory/SearchTab.tsx:170`, `review/FileList.tsx:31,87`,
`review/PullList.tsx:289`, `settings/SettingsNav.tsx` (ROW constant), `settings/SettingsPage.tsx:140`, `shell/ProjectItem.tsx`,
`side/SidePanel.tsx:117`, `v7/QueueList.tsx:125`, `v7/TurnFiles.tsx:66`, `shared/ModelPickerPanel.tsx:281`,
`chat/ComposerMenu.tsx:261`, `primitives/Picker.tsx:167`, `primitives/InfoList.tsx` (`INFO_ROW_BUTTON`).
Differences: height `h-row` (28) vs `h-row-nav` (32) vs `h-7` vs `h-8` vs `h-bar` (40) vs `min-h-14`; selected state `bg-active` in
some and `focus-visible:bg-active` in others; `text-fg` vs `text-fg-2` vs `text-fg-3` at rest; leading slot
(`size-4`) written as a span in some. Same-job components with different names: `ListRow` (memory), `INFO_ROW_BUTTON`
(primitives), `FileRow` (review `FileList:65` and `v7/TurnFiles:60`, near-identical), `PullRow`, `OpenRow`, `ProviderRow`,
`IntegrationRow`, `ProjectRow`, `TeamRow`, `TriageRow`, `NavRow`, `ProjectItem`, `SettingsRow`, `RowBody` (shared).
**Single component:** `ListRow` (`size` row 28 / nav 32; `selected`; `leading` slot of 16; `trailing`; `tone`; renders
`button`, `a` or `li > button`), plus `ListRowStatic` for non-interactive rows. `INFO_ROW` becomes its internals.

**G. Same-job pairs, near byte-identical.**
`v7/parts.tsx:35 Kbd` and `review/parts.tsx:57 Key` are the same four lines (`<kbd aria-hidden className="octo-v7-kbd max-sm:hidden">`);
`review/Composer.tsx:76` inlines it a third time; three more kbd styles exist (`shell/CommandPalette.tsx:249`,
`primitives/Tooltips.tsx:158`: `rounded-2xs bg-active px-1 font-sans text-xs`; `shell/Sidebar.tsx:42` and `primitives/Menu.tsx:181`:
plain `text-xs`, differing in colour `fg-2` / `fg-3`). **Single component:** `KeyHint` (`tone`, hides itself under `sm`).

### 3.3 Messages

**H. Notice / banner / error line** — 37 `role=alert|status` elements in 29 files with no shared component, and five
components with the same job and different names: `chat/Composer.tsx:355 Notice` (`mb-2 flex flex-wrap … px-3 text-sm text-fg-2`),
`files/FileView.tsx:481 Notice` (message + `Button` actions), `review/parts.tsx:44 Notice` (this one is an `EmptyState` wrapper, a
different job under the same name), `v7/DiffPanel.tsx:152 Banner` (`min-h-8 … border-b border-line px-3 py-1 text-sm`, `ok|err`
tone), `review/ReviewView.tsx:420 Banners` (two inline `div role=status` with `border-b border-line px-3 py-1.5 text-sm`; note `py-1` vs
`py-1.5` against `Banner`), `v7/parts.tsx:66 ErrorLine` (`text-xs text-err`), `memory/parts.tsx:91 ErrorState`
(`px-4 py-3 text-sm` + retry), `chat/Transcript.tsx:310 TurnBanner`, `app/ProjectWorkspace.tsx LoadError`, `providers/ConnectSheet.tsx:79`,
`providers/ConnectScreen.tsx:46`, `side/SidePanel.tsx:176`, `settings/IntegrationsView.tsx:104`. Inline field messages are written by
hand 19 times as `text-xs text-err | text-warn | text-ok` with `mt-1` or `px-1`/`px-2` (`settings/parts.tsx:90-115` four variants in a row,
`memory/FilesTab.tsx:180`, `notes/NotesPanel.tsx:190`, `review/Composer.tsx:110`, `review/ImageDiff.tsx:41`, `providers/SecretForm.tsx:74`,
`v7/parts.tsx:68`...). Differences: text `xs` vs `sm`; border-b bar vs free text; padding `px-2`, `px-3`, `px-4`; actions to the right or
below. **Single component:** `Notice` (`tone` plain / ok / warn / err; `layout` bar | inline | block; `actions`; `onRetry`); roles
`alert` for err, `status` otherwise, set by the primitive. Empty/centered messages stay `EmptyState`.

**I. Empty state wrappers** — `memory/parts.tsx:107 Empty`, `v7/ChangesView.tsx:186 Empty`, `review/parts.tsx:44 Notice` each wrap
`EmptyState` only to change the prop names (`text` vs `children`, `actions` wrapped in `flex flex-wrap items-center justify-center gap-2`
twice). `v7/DiffPanel.tsx:166 Centered` and `files/FileView NoFolders`, `project/NoProjectsHero`, `shell/OfflineState`,
`chat/EmptyProject` do the same job without it. **Single component:** `EmptyState` with `actions` that lays itself out; delete the wrappers.

**J. Skeletons** — 5 builds of the same "muted bar" (`h-2 rounded-full bg-hover`): `primitives/InfoList.tsx:37 SkeletonRows`,
`settings/parts.tsx:164 SkeletonRow` (`h-3`/`h-2` bars, `min-h-14`), `files/EditorSkeleton.tsx:15`, `shell/Sidebar.tsx:103`,
`chat/ToolGroup.tsx:15` (a `h-row rounded-md bg-code-bg` block), plus empty `aria-busy` placeholders (`chat/ToolDetail.tsx:132`,
`settings/ProjectSections.tsx:114`) and `memory/parts.tsx:83 Loading` (wraps `SkeletonRows`). Loading text with a spinner is hand-written
8 times (`flex h-9 items-center gap-2 text-sm|text-xs text-fg-3 aria-busy`: `providers/ConnectSheet.tsx:74,170`,
`settings/IntegrationsView.tsx:93`...). **Single component:** `Skeleton` (`bar`, `block`, `rows`, `list`) and `Loading` (spinner + text row).

### 3.4 Fields

**K. Native `<input>`, `<select>`, `<textarea>` styled in place** — 21 elements.
- **Checkbox**: 5 `<input type=checkbox className="size-3.5|size-4 accent-[var(--octo-primary)]">` (`review/Composer.tsx:74`, `review/DiffPane.tsx:62`,
  `review/FileList.tsx:79`, `review/ReviewView.tsx:460`, `v7/FormFields.tsx:32`); sizes 14 vs 16; a radio group is faked with `sr-only` input + button chips
  (`v7/FormFields.tsx:90`). **Single component:** `Checkbox`, `RadioGroup`.
- **Select**: 4 native (`review/FileList.tsx:130` `h-10 px-2 text-input-touch`; `review/PullList.tsx:78` `h-8 px-2 text-sm`; `v7/FormFields.tsx:106`
  `h-8 w-full px-2`; `settings/parts.tsx:152` `Select` `h-8 pr-8 pl-3`) and select-like buttons (`project/ProjectDialog.tsx:374`, `shared/ModelPicker.tsx:53`
  with a third look: `border-line-strong bg-raised h-row-nav`). `px-2` vs `px-3`, chevron present only in one. **Single component:**
  `Select` (native, chevron, same height/border/focus as `Input`) and `SelectButton` for the popover-backed ones.
- **Search field**: 8 bare inputs with the same 10-utility class `h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3
  focus:outline-none focus-visible:shadow-none max-sm:text-input-touch` (`chat/ComposerMenu.tsx:221`, `files/TreeColumn.tsx:62`, `primitives/Picker.tsx:116`,
  `settings/IntegrationsView.tsx:120`, `settings/ModelsSection.tsx:144`, `settings/SettingsNav.tsx:31`, `shared/ModelPickerPanel.tsx:189,258`; and
  `shell/CommandPalette.tsx:204`, `side/SidePanel.tsx:200` with small variations) plus three bordered wrapper labels that differ:
  `settings/SettingsNav.tsx:25` (`h-row-nav px-2`, no bg, `focus-within:border-fg`), `settings/IntegrationsView.tsx:117` (`h-row-nav px-3`,
  `focus-within:border-focus`), `settings/ModelsSection.tsx:138` (`h-8 w-64 bg-panel px-3`). The header row that holds them
  (`flex h-bar shrink-0 items-center gap-2 border-b border-line px-3`) is another 5-copy run (`primitives/Picker.tsx:114`,
  `chat/ComposerMenu.tsx:219`, `shared/ModelPickerPanel.tsx:187`, `shell/CommandPalette.tsx:202`, `chat/CommentsControl.tsx:65`).
  **Single component:** `SearchField` (`variant` bordered / bare-in-header, `clearOnEscape`).
- **Textarea**: 2 native (`chat/Composer.tsx:261`, `files/editor/CommentBox.tsx:78`) are deliberate bare editors; give `Textarea` `variant="bare"`.
- Rows of fields: decision 84's `FieldRow` is not built; `Field` stacks only.

**L. Switch** — one implementation, in `settings/parts.tsx:119` (4 call sites). It belongs in primitives (`Switch`).

### 3.5 Containers

**M. Bordered card frame** — 15 elements in 13 files: `rounded-md border border-line bg-raised p-3|p-4|p-card`
(`review/PendingPanel.tsx:121,176`, `review/PullList.tsx:123`, `review/Overview.tsx:31`, `chat/Transcript.tsx:205`), `bg-panel` variants
(`v7/QueueList.tsx:58`, `v7/parts.tsx:19 CardFrame`), `bg-code-bg` (`review/ImageDiff.tsx:39`, `primitives/CommandLine.tsx:9`), `border-line` only
(`chat/DelegationGroup.tsx:41`, `chat/LivePanels.tsx:49`, `v7/Gallery.tsx:205`, `review/SubmitSheet.tsx:182`), and the CSS classes `octo-card` /
`octo-card-dense` (`home/HomeCards.tsx:18`, `home/Home.tsx:163`). Differences: surface (raised / panel / code-bg / none), radius (md vs lg), padding
(`p-1`, `p-2`, `p-3`, `p-4`, `p-card`). **Single component:** `Card` (`surface` raised / panel / code; `padding` none / sm / md; `radius` md).

**N. Grouped-list frame** — 6 identical copies of `flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-panel-edge bg-panel shadow-panel`:
`providers/ConnectScreen.tsx:39,65`, `settings/ModelsSection.tsx:156`, `settings/ProvidersSection.tsx:161`, `settings/SettingsPage.tsx:135`,
`settings/parts.tsx:20 (SettingsGroup)`; and `settings/AgentPrefsPane.tsx:44` (same without `divide-y`). **Single component:** `ListFrame`
(`SettingsGroup` becomes label + `ListFrame`).

**O. Overlay shells** — 6 overlay panels hand-repeat `octo-overlay … rounded-lg border border-transparent bg-overlay … shadow-pop` (`primitives/Menu.tsx:142`,
`primitives/Popover.tsx:112`, `primitives/Dialog.tsx:41`, `chat/ComposerMenu.tsx:211`, `shell/CommandPalette.tsx:194`, `v7/DiffComments.tsx:138`
(`border-line-strong`, `rounded-md`, `p-2`), `review/PendingPanel.tsx:53` (a `role=dialog` docked panel)). Three of them also re-implement the
combobox/listbox keyboard code that `Picker` already has (`CommandPalette`, `ComposerMenu`, `ModelPickerPanel`). **Single component:** `Popover`
and `Dialog` get a `variant="palette"` (wider, no title, search header) and `Picker` takes over the three listboxes; `OverlayPanel` stays internal.

**P. Section headings** — see 4.8. **Scroll areas** — 34 `overflow-y-auto` containers in 31 files with 8 different companion sets
(`overscroll-contain` 22, `overscroll-none` 3, `fade-y` 2, `scroll-quiet` 1, none 8). **Single component:** `ScrollArea` (`fade`, `gutter`).

**Q. Floating pill** — `chat/FloatingComposer.tsx:17` and `chat/CommentsControl.tsx:55` repeat `rounded-full border border-line bg-overlay px-2 text-xs
tabular-nums shadow-float octo-ring-float`; `chat/ConversationView.tsx:291` is the round-button version. **Single component:** `Chip variant="floating"`.

**R. Meters / bars** — `usage/UsageLimits.tsx:42` (`h-1`), `chat/ContextPopover.tsx:57` (`h-1.5`), `memory/ContextTab.tsx:144` (`h-1 w-16`),
`usage/UsageTokens.tsx:79` (`h-0.5`), `primitives/DayBars`. **Single component:** `Meter` (`size`, `segments`).

**S. Other same-name or same-job duplicates found by name:** `chat/CommentCard` (`SentComments.tsx:23`) vs `review/CommentCard` (`PendingPanel.tsx:110`);
`chat/ToolDetail` `DataTable` and `Pairs` vs `shared/DataTable` (lazy aliases, fine, but `Pairs` exists in both); `Card` in `files/editor/CommentBox.tsx:101` vs
`home/HomeCards.tsx:16`; `Figure` in `review/ImageDiff.tsx:25` and `usage/UsageTokens.tsx:89`; `Section` in `review/PullList.tsx:166` and `v7/Gallery.tsx:36`;
`FolderPicker` x3 (two are lazy aliases of `shared/FolderPicker`); `IntegrationsView` x2 (one lazy); `SettingsPage` `ModelSelect` / `ProjectSelect`
(selects of models and projects: both `Select` + options) and `shared/ModelPicker` (a select-like popover); `StateDot` (settings), `StatusMark` (memory),
`StateGlyph` / `StatusIcon` / `RunningDot` (primitives) — four ways to draw a state dot.

## 4. Inconsistencies a person can see

Counts are class occurrences in JSX `className` outside the tokens' definitions (primitives included unless stated).

### 4.1 Control height
Tokens: `h-chip` 24, `h-row` 28, `h-row-nav` 32, `h-strip` 36, `h-bar` 40. In use: `h-row` 44, `h-6` 36, `h-bar` 18, `h-7` 16, `h-chip` 15, `h-8` 14,
`h-row-nav` 9, `h-4` 8, `h-5` 7, `h-10` 7, `h-9` 5, `h-12` 1, `h-16` 1. **The same pixel size is spelled two ways**: 24px is `h-6` (36) and `h-chip` (15); 28px is
`h-7` (16) and `h-row` (44); 32px is `h-8` (14) and `h-row-nav` (9). `h-9` (36px, 5; `providers/ConnectSheet.tsx:74,170`, `settings/IntegrationsView.tsx:93`,
`settings/ProjectSections.tsx:114`) and `h-10` (40, 7 without `max-md:`) are not on any row-height role. `Button` offers 28 and 32 only; 24px controls (the
majority of toolbar buttons) have no primitive size. `min-h-` values: 8 (6), 7 (5), 6 (4), 14 (4), 10 (2), 9 (1), 24 (1).

### 4.2 Corner radius
Scale: 2xs 2, xs 4, sm 6, md 8, lg 10, xl 12. In use: `rounded-sm` 97, `md` 33, `full` 28, `lg` 15, `xs` 15, `2xs` 8, `xl` 2. Outliers by role: icon buttons use
`sm`, `xs` (`chat/ComposerPills.tsx:30`, `shared/ModelPickerPanel.tsx:299`) and `2xs` (`files/TreeColumn.tsx:75`); link buttons use `xs`; cards are `md` (10) or `lg` (5).

### 4.3 Border colour and opacity
`border-line` 56, `border-line-strong` 10, `border-input-border` 8, `border-panel-edge` 7, `border-fg` 2 (+ focus 6), `border-warn/50` 2, `border-err/50` 1, `border-err/60` 1.
Violations of decision 81a (no coloured frames): `v7/parts.tsx:23` (`CardFrame` with `attention` = `border-warn/50`, and `pulse` = `octo-v7-pulse`, which also breaks 81b and
76), `review/SubmitSheet.tsx:138` (`border-err/50` alert frame), `review/FileList.tsx:107` (`border-warn/50` chip). `v7/FormFields.tsx:87` (`border-err/60`) is a validation
error, allowed. Neutral borders differ by surface: settings groups use `panel-edge`, cards `line`, selects/inputs `input-border`, `ModelPicker` `line-strong`.

### 4.4 Focus ring
Global `:focus-visible` is a 2px shadow; rows use `focus-inset` (31 uses outside primitives). Inputs add `focus:outline-none focus-visible:shadow-none` by hand 20/18 times and then
choose their own indicator: `focus:border-fg` (4), `focus-within:border-fg` (2), `focus-within:border-focus` (3; `settings/IntegrationsView.tsx:117`), `focus-visible:bg-active` (2),
`focus-visible:shadow-pop` (1), `focus-visible:shadow-[0_0_0_2px_var(--octo-focus)]` (1), `focus-within:outline-focus` (1), `focus-visible:underline` (5, link buttons).
Fix is in `Input`, `SearchField`, `Select`: one focus treatment.

### 4.5 Icon size and icon-to-label gap
`Glyph` allows only 14 and 16: 94 and 8 uses; consistent. Not through `Glyph`: `Spinner` at `size={10}` (8 places) vs 12 (15 explicit + default), slot boxes `size-4` (20) and
`size-3.5`/`size-6`/`size-8` hand-drawn. Gap between icon and label in buttons: `gap-1` (48 uses overall, e.g. `MenuButton`, `ContextRing`, `ReviewHeader`, `SidePanel:91`), `gap-1.5` (44;
`Button`, `Chip`, `EditorStatus:96`), `gap-2` (165; rows). `Button` and `Chip` use 1.5, `MenuButton` uses 1.

### 4.6 Row height
Rows are `h-row` 28 (`INFO_ROW`, tool rows, tree rows), `h-row-nav` 32 (`ListRow`, sidebar, home), `h-7` (`review/FileList:31`, `v7/QueueList:125`, `v7/TurnFiles:66`), `h-8` (`v7/ApprovalCard:76`, `TurnFiles:32`),
`h-bar` 40 (`home/Home.tsx:220`), `min-h-14` 56 (`SettingsRow`, `SettingsPage:140`), `h-16` (`home/Home.tsx:95`). Two lists of the same files are 28px in one place and 32px in another
(`memory ListRow` 32 vs `INFO_ROW` 28 inside the same Memory tab).

### 4.7 Dialog padding and widths
`Dialog` header `px-4 pt-4 pb-3 sm:px-5`, body `px-4 pb-4 sm:px-5`, footer `px-4 pt-3 pb-4 sm:px-5` — consistent inside, but written as numbers: the `--spacing-dialog` token (20px) has **0 uses**.
Widths: 400 / 520 are literals in `Dialog` (`sm:max-w-[400px]`, `sm:max-w-[520px]`); `lg` uses the token `max-w-dialog-wide`; `CommandPalette` `max-w-[560px]`; popovers `w-[min(420px,…)]`, `w-[min(380px,…)]`,
`w-[min(340px,…)]` (3 different literals). Four dialogs are not `Dialog`: `shell/CommandPalette.tsx:196`, `review/PendingPanel.tsx:53`, `v7/DiffComments.tsx:139`, `notes/NotesPanel.tsx:101 (alertdialog inline)`.

### 4.8 Section heading style
`h2`–`h4` captions `text-xs text-fg-3`: 9 (`settings/parts.tsx:17`, `ConnectScreen:38,64`, `ModelsSection:137`, `SettingsPage:134`, `Sidebar:93`, `AgentPrefsPane:69`, `InfoList:16` (h3),
`chat/CommentsControl:81`). The same with `font-medium`: `review/FileList.tsx:44`, `review/PullList.tsx:169`. Section titles `text-heading text-fg`: 9 (`Dialog`, `ConnectSheet:147`,
`PendingPanel:58`, `PullList:124`, `ReviewHeader:32`, `SubmitSheet:145`, `InputFormCard:42`, `memory/parts:116`, `AgentHeader:81`). Others: `text-sm font-medium text-fg` (`notes/NotesPanel.tsx:78`,
`review/Composer.tsx:71`), `text-base text-fg` (`settings/AgentPrefsPane.tsx:47`), `h2` with no class (`home/HomeCards.tsx:21`), `text-display font-medium` (`settings/SettingsPage.tsx:110`;
the other four page titles are `text-display` only — decision 64e allows two weights, and the token already sets 600, so `font-medium` is a third), `text-title` (3). `text-[11px]`
appears twice (`v7/QueueList.tsx:147`, `review/FileList.tsx:107`); not a scale step.

### 4.9 Text size
`text-xs` 282, `text-sm` 175, `text-heading` 12, `text-base` 10, `text-display` 5, `text-figure` 3, `text-title` 3, `text-[11px]` 2. Decision 64e: "at most three sizes on a screen" is not checked
by any tool for the sizes above.

### 4.10 Touch
62 hand-written touch overrides in 15 files; see 3.1 D. Features without overrides are not touch-sized at all, so the same button is 40px tall in Review and 24px in Files on a phone.

## 5. The ten worst duplication groups (by copies)

| # | Group | Copies | Files |
| --- | --- | --- | --- |
| 1 | Hand-written touch-target override (3.1 D) | 62 | 15 |
| 2 | Inline message / notice / error line (3.3 H) | 37 | 29 |
| 3 | Scroll container with its own companion classes (3.5 P) | 34 | 31 |
| 4 | Quiet text button (3.1 A) | 32 | 24 |
| 5 | Selectable full-width row button (3.2 F) | 21 | 15 |
| 6 | Native checkbox / select / textarea / bare input (3.4 K) | 21 | 17 |
| 7 | Bordered card frame (3.5 M) | 15 | 13 |
| 8 | Link-style button (3.1 C) | 15 | 12 |
| 9 | Square icon button (3.1 B) | 12 | 11 |
| 10 | Search input row: bare input + header row + bordered label (3.4 K) | 8 + 5 + 3 = 16 | 12 |

Runner-up: grouped-list frame x6 (3.5 N), kbd x6 in 3 looks (3.2 G), skeleton bars x5 (3.3 J), overlay shells x6 (3.5 O), toggle buttons x8 (3.1 E).

## 6. Lint baseline

`octo/no-native-controls` (`scripts/eslint/no-native-controls.mjs`, tests in `scripts/eslint/no-native-controls.test.mjs`, wired in `eslint.config.mjs` as **warn**).
Baseline, measured once with `pnpm --filter @octo/ui exec eslint src` at `6ba3e27` plus the rule: **130 warnings** from this rule (109 button, 15 input, 4 select, 2 textarea),
which is exactly the number the inventory script found. Per folder: chat 26, review 15, files 14, settings 14, shared 11, memory 8, v7 7, side 6, details 5, home 5, status 5, shell 4,
agents 3, dock 3, project 2, notes 1, providers 1. The package had 96 other warnings before; total with the rule 226, 0 errors. **The count may only go down;** a batch of the migration lowers it by its folder's number and
the final batch flips the rule to `error` at 0.

Finding while wiring the rule (confirmed and fixed in B0): `eslint.config.mjs` passed `root: "packages/ui/src"` (relative) to `octo/layer-imports`, and the rule does `path.resolve(root)`. `pnpm lint`
runs `eslint .` with the package as the working directory, so the root resolved to `packages/ui/packages/ui/src`, every file looked "outside" and the rule returned early. Seeded check: a scratch file
`primitives/zzScratch.ts` importing `../../app/OctoApp` produced no error from `packages/ui` and the expected `primitives may not import app` error from the repo root. The config now passes
`path.join(import.meta.dirname, UI)`; the same scratch file is reported from `packages/ui`. With the rule live, `eslint src` from `packages/ui` reports 0 real `octo/layer-imports` violations (scratch file removed).

## Current baseline (2026-11-12, after batch 5 and the sessions merge)

Measured with `npx eslint packages/ui packages/agent-client apps/desktop` on the merged tree: **49 warnings** of
`octo/no-native-controls` (the rule's baseline was 130 at `6ba3e27`; the migration batches B1 and B2 cleared Settings,
Memory, Notes, Usage, Agents, Details and the side question; the Sessions tab, `components/sessions`, was written on the
library and adds none). Per folder of `packages/ui/src/components`:

| Folder | Warnings |
| --- | --- |
| `review` | 19 |
| `files` | 14 |
| `chat` | 9 |
| `v7` | 3 |
| `shared` | 2 |
| `dock` | 1 |
| `project` | 1 |
| every other folder (`settings`, `memory`, `notes`, `usage`, `agents`, `details`, `side`, `sessions`, `home`, `shell`, `status`, `commands`, `providers`, `primitives`) | 0 |
| **Total** | **49** |

Batches still open from the table above: B3 (`review`), B4 (`v7`), B5 (`files`), B6 (`shared`), B8 (`shell`, `dock`, `status`
for the one `dock` hit), B9 (`chat`), B7 (`project`), then B10 (rule to `error`). The other lint warnings on the tree
(209 in all, 160 not from this rule) are the older baseline of `no-deprecated`, `no-unnecessary-condition`, `prefer-optional-chain`
and the React hooks rules; the integration pass added none and no error remains.

## Decision 90 — one component library

Final text: `docs/superpowers/specs/2026-11-10-project-harness-ui.md`, "Decision 90 — one component library". The target set of 90d was built in B0 except the names listed under "Not built" in section 8.

## 7. Replacement table for the ten worst groups (B0 result)

Every copy of the ten groups and the one component that replaces it. Locations are those of the inventory at `6ba3e27`; a batch executor re-finds the line by file and tag. Import paths: `../primitives/<Name>`.
Sizes are `xs` 24, `sm` 28, `md` 32, `lg` 40. "Touch" means: delete the hand-written `max-md:h-10` / `max-sm:h-10` / `max-md:h-bar` / `max-md:size-10`; the primitive does it.

### Group 1 (62 touch overrides): the touch rule lives inside `Button`, `IconButton`, `Chip`, `ListRow`, `Checkbox`, `Switch`, `Select`, `TextField`, `SearchField`

| Files (count) | Replacement |
| --- | --- |
| `v7/InputFormCard` (6), `v7/FormFields` (3), `v7/ApprovalCard` (3), `v7/DiffPanel` (2), `v7/TurnFiles` (1) | each element becomes a `Button` / `IconButton` / `Checkbox` / `Select` / `TextField` in B4; delete the override with the migration |
| `v7/QueueList` (5) | `ListRow` (+ `IconButton size="xs"` in `trailing`) |
| `review/PullList` (6), `review/FileList` (2) | `ListRow`, `Select`, `SearchField` |
| `review/ReviewHeader` (4), `review/PendingPanel` (3), `review/Composer` (3), `review/DiffPane` (2) | `Button` / `IconButton` / `Checkbox`; delete the override |
| `side/SidePanel` (3), `agents/AgentsPanel` (3) | `Button` / `IconButton` / `ListRow` |
| `primitives/Picker.tsx` (1: `max-md:h-bar`) | stays until the sweep puts Picker rows on `ListRow`'s height rule (B10) |
| Everything else (chat, files, memory, settings, details, home): no override | gains the touch target by becoming a primitive |

### Group 2 (37 notices, 29 files): `Notice` (`tone` info | warn | error | success; `form` line | block)

| File:line | Replacement |
| --- | --- |
| `chat/Composer.tsx:355 Notice` | `<Notice form="line" tone=... action=...>` |
| `files/FileView.tsx:481 Notice` (message + `Button` actions) | `<Notice form="block" tone="warn" title actions>` |
| `review/parts.tsx:44 Notice` (an `EmptyState` wrapper) | delete; use `EmptyState` directly (a different job) |
| `v7/DiffPanel.tsx:152 Banner` (`ok`/`err`) | `<Notice form="line" tone="success" or "error">` |
| `review/ReviewView.tsx:420 Banners` (two `div role=status`) | `<Notice form="line">` x2 |
| `v7/parts.tsx:66 ErrorLine` (`text-xs text-err`) | `<Notice form="line" tone="error">` |
| `memory/parts.tsx:91 ErrorState` (`px-4 py-3 text-sm` + retry) | `<Notice form="block" tone="error" actions={<Button>Retry</Button>}>` |
| `chat/Transcript.tsx:310 TurnBanner`, `app/ProjectWorkspace LoadError`, `providers/ConnectSheet.tsx:79`, `providers/ConnectScreen.tsx:46`, `side/SidePanel.tsx:176`, `settings/IntegrationsView.tsx:104` | `Notice` block (with `command` for a copy line) or line |
| the 19 inline field messages `text-xs text-err`, `text-warn`, `text-ok` (`settings/parts.tsx:90-115` x4, `memory/FilesTab.tsx:180`, `notes/NotesPanel.tsx:190`, `review/Composer.tsx:110`, `review/ImageDiff.tsx:41`, `providers/SecretForm.tsx:74`, `v7/parts.tsx:68`...) | `<Notice form="line" tone>`; one field's validation text stays `Field error` |
| `review/SubmitSheet.tsx:138` (`border-err/50` alert frame; a decision 81 violation) | `<Notice form="block" tone="error">` (no tone border) |

### Group 3 (34 scroll containers, 31 files): `ScrollArea` (`axis`, `gutter`, `fade`, `contain`)

Companion classes map as: `overflow-y-auto overscroll-contain` -> `<ScrollArea>`; plus `scroll-quiet` -> `gutter="both"`; `scrollbar-gutter: stable` -> `gutter="stable"`; `fade-y` / `fade-x` with `useScrollFade` -> `fade` (the hook runs inside);
`overflow-x-auto` -> `axis="x"`; `overscroll-none` (3) -> `<ScrollArea contain={false}>` only where chaining is wanted, else the default. The 8 containers with none of the companions get containment by default.
The 34 are the `overflow-(y|x)-auto|overflow-auto` matches in JSX `className` outside `primitives` (`rg -n "overflow-(y|x)-auto|overflow-auto" packages/ui/src --glob '!**/primitives/**'`). Monaco, the transcript (`chat/Transcript` owns stick-to-bottom) and the request rail keep their own scrolling; the batch executor lists them as exceptions.

### Group 4 (32 quiet text buttons, 24 files): `Button variant="quiet"` with `size="xs"` (24, `text-xs`) or `size="sm"` (28)

Size rule: old `h-6` / `h-chip` -> `xs`; old `h-7` / `h-row` -> `sm`. `px-1`, `px-1.5`, `px-2`, `hover:bg-hover`, `press` and the colours are inside the primitive; `icon` is the leading glyph; square ones go to `IconButton`.

| File:line | Replacement |
| --- | --- |
| `chat/CommentsControl.tsx:67`, `files/EditorStatus.tsx:70`, `files/FileTree.tsx:234`, `files/editor/CommentBox.tsx:109,112`, `review/ReviewHeader.tsx:53,63`, `settings/AgentPrefsPane.tsx:49`, `shared/Markdown.tsx:82`, `shared/ModelPickerPanel.tsx:209,217`, `side/SidePanel.tsx:104`, `details/DetailsPanel.tsx:382`, `chat/ToolDetail.tsx:120`, `shared/DataTable.tsx:49,58`, `chat/AgentHeader.tsx:107`, `chat/Transcript.tsx:213`, `chat/SentComments.tsx:75`, `memory/ContextTab.tsx:165` and the rest of the 32 | `Button variant="quiet" size="xs"` or `"sm"` by the height rule |
| the 8 toggles: `files/FileView.tsx:347,384`, `memory/SearchTab.tsx:86`, `settings/IntegrationsView.tsx:145`, `side/SidePanel.tsx:91`, `details/DetailsPanel.tsx:382`, `v7/DiffPanel.tsx:64`, `chat/ToolDetail.tsx:120` | `Button variant="quiet" pressed={...}` (or `IconButton pressed`) |
| `home/Home.tsx:95` (a card used as a toggle) | `Card` + `ListRow` or `Button`; the batch executor decides |
| existing `Button variant="ghost"` (36) | rename to `quiet` (same pixels today; `ghost` keeps its old padding until renamed) |
| existing `Button variant="danger"` (7) | no change; it is now quiet with red text (decision 81c) |

### Group 5 (21 selectable full-width rows, 15 files): `ListRow` (`size`, `selected`, `leading`, `title`, `description`, `meta`, `trailing`, `onClick` / `href`)

Height rule: `h-row` / `h-7` -> `size="sm"`; `h-row-nav` / `h-8` -> `size="md"`; `h-bar` / `h-10` -> `size="lg"`; `min-h-14` is a settings row (keep; it composes `ListFrame`). `bg-active` selected -> `selected`; the leading `size-4` span -> `leading`.

| File:line | Replacement |
| --- | --- |
| `agents/AgentsPanel.tsx:61,111`; `chat/StarterPrompts.tsx:17`; `chat/ToolGroup.tsx:98,126`; `chat/LivePanels.tsx:22`; `chat/CommentsControl.tsx:91`; `home/Home.tsx:179,190,220`; `memory/SearchTab.tsx:170`; `review/PullList.tsx:289`; `settings/SettingsPage.tsx:140`; `side/SidePanel.tsx:117`; `shared/ModelPickerPanel.tsx:281`; `chat/ComposerMenu.tsx:261` | `ListRow` (sm or md by the rule) |
| `memory/parts.tsx:128 ListRow` | delete; `ListRow size="md"` with `description` for the two-line form |
| `review/FileList.tsx:31,87` (`FileRow` at `:65`) and `v7/TurnFiles.tsx:66` (`FileRow` at `:60`) | `ListRow size="sm" truncate="middle" leading={glyph} meta={counts}` |
| `v7/QueueList.tsx:125` | `ListRow size="sm"` with `trailing` actions |
| `settings/SettingsNav.tsx` (`ROW` constant), `shell/ProjectItem.tsx` | `ListRow size="md"` |
| `primitives/Picker.tsx:167`, `primitives/InfoList.tsx` `INFO_ROW_BUTTON` | internal; the B10 sweep puts them on `ListRow` |
| `PullRow`, `OpenRow`, `ProviderRow`, `IntegrationRow`, `ProjectRow`, `TeamRow`, `TriageRow`, `NavRow`, `RowBody` (`shared`) | `ListRow` (their body goes into `title` / `description` / `meta`) |

### Group 6 (21 native checkbox / select / textarea / bare input): `Checkbox`, `Select`, `TextArea`, `TextField`

| File:line | Replacement |
| --- | --- |
| `review/Composer.tsx:74`, `review/DiffPane.tsx:62`, `review/FileList.tsx:79`, `review/ReviewView.tsx:460`, `v7/FormFields.tsx:32` (native checkbox) | `Checkbox` (`label`; `hideLabel` + `ariaLabel` in rows; the `control` slot of `ListRow` for a row checkbox) |
| `v7/FormFields.tsx:90` (faked radio group: `sr-only` input + chips) | `Segmented` for 2-4 short options; `RadioGroup` is not built (section 8) |
| `review/FileList.tsx:130`, `review/PullList.tsx:78`, `v7/FormFields.tsx:106`, `settings/parts.tsx:152 Select` (native selects) | `Select` (menu; `size`, `side`); `settings/parts` `Select` is deleted when B1 moves its callers |
| `project/ProjectDialog.tsx:374`, `shared/ModelPicker.tsx:53` (select-like buttons) | `Select` for plain lists; `Picker` + `Chip` for searchable ones |
| `chat/Composer.tsx:261`, `files/editor/CommentBox.tsx:78` (bare textareas) | `TextArea variant="bare"` |
| the 8 bare search inputs (group 10) and other bare inputs | `SearchField` / `TextField variant="bare"` |

### Group 7 (15 bordered card frames, 13 files): `Card` (`surface` raised | panel | code; `padding` none | sm | md | lg; `header`, `footer`)

| File:line | Replacement |
| --- | --- |
| `review/PendingPanel.tsx:121,176`, `review/PullList.tsx:123`, `review/Overview.tsx:31`, `chat/Transcript.tsx:205` (`rounded-md border border-line bg-raised p-3` / `p-4` / `p-card`) | `<Card>` (raised, `padding="md"`; `p-4` -> `lg`) |
| `v7/QueueList.tsx:58`, `v7/parts.tsx:19 CardFrame` (`bg-panel`) | `<Card surface="panel">`; drop the `attention` border (`border-warn/50`) and `octo-v7-pulse` (decision 81) |
| `review/ImageDiff.tsx:39`, `primitives/CommandLine.tsx:9` (`bg-code-bg`) | `<Card surface="code">` (`CommandLine` in the sweep) |
| `chat/DelegationGroup.tsx:41`, `chat/LivePanels.tsx:49`, `v7/Gallery.tsx:205`, `review/SubmitSheet.tsx:182` (`border-line` only) | `<Card surface="panel" padding="none">` or raised, by the surface it sits on |
| `home/HomeCards.tsx:18`, `home/Home.tsx:163` (`octo-card`, `octo-card-dense`) | `<Card>`; the translucent `octo-card` effect is Home-only (keep the class on a wrapper if the owner wants it) |
| runner-up, grouped-list frames: `providers/ConnectScreen.tsx:39,65`, `settings/ModelsSection.tsx:156`, `settings/ProvidersSection.tsx:161`, `settings/SettingsPage.tsx:135`, `settings/parts.tsx:20`, `settings/AgentPrefsPane.tsx:44` | `ListFrame` |

### Group 8 (15 link-style buttons, 12 files): `Button variant="link"` (`mono`, `tone="quiet"`)

| File:line | Replacement |
| --- | --- |
| `memory/TasksTab.tsx:148,231`, `providers/ConnectSheet.tsx:214`, `settings/ModelsSection.tsx:90`, `settings/parts.tsx:105` (`rounded-xs text-link underline-offset-2 hover:underline`) | `Button variant="link" size="sm"` (`xs` in `text-xs` context) |
| `review/PendingPanel.tsx:124,179`, `chat/SentComments.tsx:45`, `chat/ToolDetail.tsx:52,82` (mono, `fg-2`) | `Button variant="link" tone="quiet" mono` |
| `shared/FileLink.tsx:26` (a CSS class) | stays (prose inline code) |
| `details/DetailsPanel.tsx:141`, `side/SidePanel.tsx:144`, `v7/Gallery.tsx:194`, `v7/ApprovalCard.tsx:80` (plain `underline`) | `Button variant="link"` (`tone="quiet"` if it should not read as a link) |

### Group 9 (12 square icon buttons, 11 files): `IconButton` (`size` xs | sm | md | lg; `variant` quiet | primary | round; `round`)

Size rule: `size-6` / `h-chip w-6` -> `xs`; `size-7` -> `sm`; `size-8` -> `md`; `size-5` -> `xs` (20 grows to 24, the one place that changes). Radius comes from the size (6px; 8px at lg).

| File:line | Replacement |
| --- | --- |
| `chat/CommentsControl.tsx:107` (size-6) | `IconButton size="xs"` |
| `chat/Composer.tsx:284` (size-7) | `IconButton size="sm"` |
| `chat/ComposerPills.tsx:30` (size-6, `rounded-xs`) | `IconButton size="xs"` |
| `files/TreeColumn.tsx:75` (size-5, `rounded-2xs`) | `IconButton size="xs"` |
| `settings/parts.tsx:66` (size-6) | `IconButton size="xs"` |
| `dock/TabStrip.tsx:241` (`h-chip w-6`), `dock/Tab.tsx:108` | `IconButton size="xs"` |
| `shared/ModelPickerPanel.tsx:299` (size-6, `rounded-xs`) | `IconButton size="xs"` |
| `files/editor/EditorComments.tsx:349` | `IconButton size="xs"` (a Monaco widget: check the overlay in B5) |
| `chat/ConversationView.tsx:291` (size-8, `rounded-full`, shadow) | `IconButton variant="round" size="md"` |
| `chat/Composer.tsx:374` (send: size-7, `rounded-full`, `bg-primary`) | `IconButton variant="primary" round size="sm"` |
| `side/SidePanel.tsx:210` (size-7 submit, `bg-primary`) | `IconButton variant="primary" size="sm"` |
| every existing `IconButton` import from `primitives/Button` (40 call sites) | import from `primitives/IconButton`; `size="sm"` (old 24) -> `xs`; no `size` (old 28) -> `sm` (the default); the `Button.tsx` export is deprecated |

### Group 10 (16: 8 bare inputs + 5 header rows + 3 bordered labels): `SearchField` (`variant` bordered | header | bare; `shortcut` slot; clear button; Esc clears)

| File:line | Replacement |
| --- | --- |
| `settings/SettingsNav.tsx:25` (bordered label `h-row-nav px-2`) and its input at `:31` | `<SearchField variant="bordered" size="md">` |
| `settings/IntegrationsView.tsx:117` (`h-row-nav px-3`, `focus-within:border-focus`) and its input at `:120` | `<SearchField variant="bordered" size="md">` |
| `settings/ModelsSection.tsx:138` (`h-8 w-64 bg-panel px-3`) and its input at `:144` | `<SearchField variant="bordered" size="md" className="w-64">` |
| `primitives/Picker.tsx:114,116`, `chat/ComposerMenu.tsx:219,221`, `shared/ModelPickerPanel.tsx:187,189` (and `:258`), `shell/CommandPalette.tsx:202,204`, `chat/CommentsControl.tsx:65` (the 5-copy header row `flex h-bar shrink-0 items-center gap-2 border-b border-line px-3` and its input) | `<SearchField variant="header" inputProps={{ role: "combobox", "aria-controls": ..., "aria-activedescendant": ... }} ref={...}>` |
| `files/TreeColumn.tsx:62` (bare input in a row) | `<SearchField variant="bordered" size="xs">` or `variant="bare"`, as the tree header needs |
| `side/SidePanel.tsx:200` (question input) | `<SearchField variant="bare">` (or `TextField variant="bare"` if the glyph is unwanted) |

## 8. What B0 built, and what it did not

New: `IconButton` (own file), `TextField`, `TextArea`, `Select` (menu), `SearchField`, `Checkbox`, `Switch`, `ListRow`, `ListFrame`, `Card`, `Notice`, `ScrollArea`, `SectionHeader`, `Skeleton`, `SkeletonText`, `SkeletonList`, `KeyHint`, `MiddleText`, the gallery and `scripts/gallery-shots.mjs`; `lib/controls.ts`, `lib/listRow.ts`, `lib/truncate.ts`, `lib/refs.ts`.
Extended: `Button` (xs and lg sizes, `quiet`, `link`, quiet `danger`, `pressed`, `loading`, `iconEnd`, `fullWidth`, `mono`, `tone`), `Chip` (token heights, touch, `MiddleText`), `Spinner` (control sizes), `Dialog` and `CommandLine` (new `IconButton`).
Aliased: `ghost` = `quiet`, `Input` = `TextField`, `Textarea` = `TextArea`, `Kbd` = `Key` = `KeyHint`.
Deprecated (`@deprecated`): `Button.tsx`'s `IconButton` (old sizes), `Input`, `Textarea`, `InfoList`'s `SkeletonRows`. Superseded but untouched (feature folders): `settings/parts` `Switch` / `Select` / `SkeletonRow`, `v7/parts` `Kbd` / `ErrorLine` / `CardFrame`, `review/parts` `Key` / `Notice`, `memory/parts` `ListRow` / `Empty` / `ErrorState` / `Loading`, `v7/DiffPanel` `Banner`.
Not built (outside the B0 brief; follow-up): `RadioGroup`, `SelectButton`, `Badge`, `Loading`, `Toolbar`, `ListDetail`, `Meter`, `Dialog variant="palette"`, `Chip variant="floating"`, `Picker` on `ListRow`, `Dialog` on `--spacing-dialog`. Reserved for other executors: `ViewTabs`, `FilterTabs`, `FieldRow`.

## Migration plan

Rule for every batch: do not touch files outside the listed folders; lower the `no-native-controls` count by the batch's number; screenshots dark and light at 1440 / 1100 / 390 of each listed screen,
before and after; the spec's "As built" gets one line per batch.

| # | Batch (folders) | Replacements | Lint count removed | Risk | Screenshot |
| --- | --- | --- | --- | --- | --- |
| **B0** | **Primitives only** (`components/primitives`, `styles.css` tokens, `v7/Gallery` entries) | Create `ListRow`, `ViewTabs`, `FilterTabs`, `FieldRow`, `Checkbox`, `RadioGroup`, `Switch` (moved), `Select` (moved), `SearchField`, `Notice`, `Skeleton`, `Loading`, `Badge`, `KeyHint`, `Card`, `ListFrame`, `Toolbar`, `SectionHeader`, `ListDetail` (moved), `ScrollArea`, `Meter`; add `Button` sizes `xs`, `pressed`, `loading`, `link` variant; `IconButton` `xs`, `round`, `primary`; `Chip floating`; touch sizes inside every control; `Dialog` uses `--spacing-dialog` and named widths; `Input`/`Textarea` `bare`; one focus treatment; `Spinner` sizes. The old copies stay. No feature file changes. Fix the `layer-imports` root path if confirmed (section 6) | 0 | Low (additive); the move of `Switch`/`Select`/`ListDetail` needs re-export stubs so other batches' imports do not break | Gallery page in all variants |
| **B1** | `settings`, `providers` | Switch/Select from primitives; `SearchField` x3; `ListFrame` x6 (3.5 N); `Notice` for the four `parts.tsx` messages; `SkeletonRow` to `Skeleton`; `SectionHeader`; `StateDot` to `StateGlyph`; selects in `AgentPrefsPane`/`ModelsSection` | 15 | Low-medium (many rows; keep the 56px `SettingsRow` height) | Each settings section; Providers list/detail; Connect sheet |
| **B2** | `memory`, `notes`, `usage` | `ListRow`, `ListDetail`, `FilterTabs`, `ViewTabs`; `Empty`/`ErrorState`/`Loading` to primitives; link buttons to `Button link`; `Meter`; `SectionHeader` | 9 | Low | Memory (tasks, files, context, search), Notes, Usage tabs |
| **B3** | `review` | `Notice`/`Key` removed; `Checkbox` x4; `Select` x2; `Banners` to `Notice`; `FileRow`, `PullRow`, `FileList` rows to `ListRow`; `Card` x6; touch sizes dropped (inside primitives); `warn` chip and `SubmitSheet` err frame to `Badge`/`Notice`; `PendingPanel` to `Dialog`/`Sheet` | 15 | Medium (diff view, selection, keyboard) | Picker, PR list, review with comments, submit sheet, 390 wide |
| **B4** | `v7` | `Kbd`, `ErrorLine`, `Banner`, `Empty`, `CardFrame` (drop the `attention` border and `octo-v7-pulse`, decision 81) to primitives; `FormFields` checkbox/radio/select; `QueueBadge` to `Badge`; `TurnFiles` row to `ListRow`; `DiffComments` to `Popover`; touch sizes dropped | 7 | Medium (approvals, forms) | Approval, form, plan, queue, changes view, gallery |
| **B5** | `files` | `EditorStatus`, `FileView` toggles, `CommentBox`, `TreeColumn` search/close, `FileTree` button to primitives; `Notice` (conflict) to `Notice`; `Card` in `CommentBox`; `EditorSkeleton` to `Skeleton` | 14 | Medium-high (Monaco overlays, floating comment widgets) | Editor with problems popover, comment box, conflict notice, tree |
| **B6** | `shared` | `ModelPickerPanel` / `ModelPicker` onto `Picker` + `SelectButton`; `DataTable` buttons; `Markdown` copy button; `FolderPicker` | 11 | Medium (used by chat, settings, project: verify all three) | Model picker in composer and settings; folder picker; a markdown code block and a table |
| **B7** | `details`, `agents`, `side`, `home`, `project` | Rows to `ListRow`; quiet buttons to `Button xs`; side question input to `SearchField bare`; `Home` cards to `Card`; `ProjectDialog` select-like button to `SelectButton`; touch sizes dropped | 21 | Low-medium | Details, Agents, Side question, Home, New project dialog |
| **B8** | `shell`, `dock`, `status` | `CommandPalette` onto `Dialog palette` + `Picker`; `Sidebar`/`ProjectItem` rows to `ListRow`; `Tab`, `TabStrip` buttons to `IconButton xs`; `ProjectTeam`; status bar buttons | 12 | Medium-high (tab strip drag, width stability, palette keyboard) | Tab strip hover/drag/overflow, palette, sidebar, status bar; `width-stability.mjs` |
| **B9** | `chat` (last: the largest and the most visual) | Composer chips onto `Chip`; `SendButton` onto `IconButton primary round`; tool rows and live panels onto `ListRow`; `Notice` in Composer; `ContextRing`, `CommentsControl` onto `Chip`; `ComposerMenu` onto `Picker`; link buttons; floating pill; `Card` for the prompt box | 26 | High (composer layout, streaming, request rail) | Empty chat, working turn, failed turn, queue, composer menus, 390 wide; `flicker.mjs` |
| **B10** | Sweep (`primitives`, `eslint.config.mjs`, spec, `AGENTS.md`) | Delete the old feature-local copies; set `no-native-controls` to `error`; add the audit script (90e); update `ARCHITECTURE.md` known-debt rows and the rule 7 text | 0 (rule at 0) | Low | Full pass of the spacing audit and Gallery |

Order: B0, then B1 and B2 in parallel (lowest risk, they prove the primitives), then B3 and B4, B5, B6, B7, B8 in any order (disjoint folders), B9, B10. Each of B1–B9 depends only on B0.
B3 and B4 both produce `Notice` changes but in disjoint files. B6 touches `shared`, which every feature imports: no other batch may edit `shared` while it runs.

## Not determined

- The ~25 native elements whose class string comes from a variable are counted but not classified by look; the batch executor reads them.
- Visual differences were derived from class strings, not screenshots; nothing was rendered, and no value here is a measured pixel except through the token table (`styles.css`).
- Duplication inside `styles.css` component classes (`octo-card`, `octo-composer`, `octo-v7-*`) was not audited.
- Row and variant tables were produced by script, not by Haiku sub-agents (none could be started); the error rate of such agents is therefore unknown.
