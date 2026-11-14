# `@octo/ui` — architecture

Shell-agnostic React UI for the project harness: sidebar, tab workspace, orchestrator chat, read-only agent
transcripts, file view with a Monaco editor, notes, settings. Hosted by `apps/desktop` (Vite, Tauri) and, later,
`apps/web`. It talks to the harness only through the `Bridge` interface from `@octo/agent-client`.

Design decisions (tokens, spacing, motion, every screen) live in
[`docs/superpowers/specs/2026-11-10-project-harness-ui.md`](../../docs/superpowers/specs/2026-11-10-project-harness-ui.md).
Coding rules: [`.cursor/rules/octo-typescript.mdc`](../../.cursor/rules/octo-typescript.mdc) (same text for Claude
in `.claude/rules/typescript.md`). This file describes structure: what lives where and which way imports go.

## Layers

```text
app/                    OctoApp (props: bridge, bridgeUrl, shell, demo, host), AppShell, ProjectWorkspace
components/<feature>/   chat · files · agents · notes · details · usage · memory · v7 · settings · providers · home · project · shell · side   (screens and their parts)
components/dock/        tab groups, strip, divider, drag layer, TabView = the composition point (hands one feature to another
                        as a prop: the file view's floating composer)
components/primitives/  the component library (decision 90; see "Primitives" below) — import `lib` only
components/shared/      pieces several features use that read app state: Markdown (prose, code highlight), FileLink
                        (InlineCode: a path in prose opens the file through `state/code`), ModelPicker (button) + ModelPickerPanel
                        (lazy list, decision 27), DataTable / TableFrame (decision 44, lazy)
state/                  one provider per concern (see the tree below); state/workspace/layout.ts is pure; the dock group's
                        context (state/workspace/group.tsx) and useFloatingHere live here too
lsp/                    language-server client (hub in the main chunk, the rest loads with Monaco)
lib/                    pure helpers and small hooks: models (names, served model, budget, routing, middle truncation),
                        modelPicker, picker, recap, triage, table, contextMeter, agentGroups, keys, files, buffers (EditorBuffers: Monaco models, type-only import), format, match (+ group ranking), comments, transcript, tools, route,
                        storage, fileLinks, codePalette, highlight (lazy), streak, focus, constants, context, orchestrator
                        (a project's orchestrator state), usage (report arithmetic, chart scale, limits), memory/ (task filters, receipt arithmetic, search form), crumbs
                        (breadcrumb fit), frontMatter, languages, streakPresets (band geometry per start screen) — `*.test.ts` beside them (`pnpm --filter @octo/ui test`)
demo/                   in-memory Bridge with seeded projects (for ?demo= and for scripted checks); its own entry point,
                        `@octo/ui/demo` (`demo/index.ts`), not part of the package root
styles.css              design tokens (@theme), base rules, Monaco widget overrides
scripts/                spacing-audit.mjs (Playwright; fails on off-scale spacing)
```

Allowed imports (a row may import the columns marked ✓), enforced on **resolved paths** by the `octo/layer-imports` ESLint
rule (`scripts/eslint/layer-imports.mjs`) as an error with no exceptions; `import type`, re-exports and `import()` count
like value imports. `node scripts/check-cycles.mjs` (part of `pnpm lint`) fails on any import cycle in `packages/ui/src`
and `apps/desktop/src`.

| from \ to               | lib | lsp | state | primitives | shared | features    | dock | app | demo | `@octo/agent-client` |
| ----------------------- | --- | --- | ----- | ---------- | ------ | ----------- | ---- | --- | ---- | -------------------- |
| `lib`                   | –   |     |       |            |        |             |      |     |      | types                |
| `lsp`                   | ✓   | –   |       |            |        |             |      |     |      | ✓                    |
| `state`                 | ✓   | ✓   | ✓     |            |        |             |      |     |      | ✓                    |
| `components/primitives` | ✓   |     |       | –          |        |             |      |     |      | types                |
| `components/shared`     | ✓   |     | ✓     | ✓          | –      |             |      |     |      | ✓                    |
| `components/<feature>`  | ✓   | ✓   | ✓     | ✓          | ✓      | itself only |      |     |      | ✓                    |
| `components/dock`       | ✓   |     | ✓     | ✓          | ✓      | ✓           | –    |     |      | ✓                    |
| `app`                   | ✓   |     | ✓     | ✓          | ✓      | ✓           | ✓    | –   |      | ✓                    |
| `demo`                  | ✓   | ✓   |       |            |        |             |      |     | –    | ✓                    |
| `src/index.ts`          |     |     | ✓     |            |        |             |      | ✓   |      |                      |

Features reach each other only through `dock/TabView`, which composes them (for example it passes the chat feature's
floating composer to the file view as a render prop) or the app shell, which fills the slots the chat leaves open through
`state/chatSlots` (approvals and forms at the end of the transcript, the queue above the composer; the v7 components).
A hook or context several layers need (`useGroup`, `useFloatingHere`) is app state and lives in `state/`.

Window frame (decisions 67, 73): the top row is the dock groups' tab strips (`dock/TabStrip`: tabs, "+", the conversation's sub-agent
chips and, in the last group, the project's "⋯" from `shell/ProjectBar`); `shell/TitleBar` is only the window controls floating over
the corner (sidebar toggle, back/forward) and a drag strip for Home and Settings. The bottom row is `components/status/StatusBar`; the
open project fills its ends through `state/statusSlots` (`ProjectStatus`). Group width floors: `state/workspace/floors`. There is no header
row in the sidebar or the conversation (`ChatHeader` and `SettingsDialog` are gone); Settings is the page
`components/settings` at `#/settings/<section>`. New features: `v7/` (approvals, forms, queue, Changes tab), `memory/`
(Memory tab), `providers/` and `lib/providers` (connect screen and sheet, provider list, model-picker data),
`files/editor/completion/` (inline completion).

## Primitives (decision 90: one component library)

A feature composes primitives and never styles a native control (`octo/no-native-controls`). Every primitive has a header
comment with its purpose, props, variants, sizes and when NOT to use it; `?demo=1&gallery=1` renders all of them (a lazy chunk,
`primitives/Gallery`; `packages/ui/scripts/gallery-shots.mjs` screenshots it in dark and light). Sizes come from one scale
(`lib/controls.ts`, tokens `--spacing-ctl-xs|sm|md|lg` = 24/28/32/40 in `styles.css`); the touch target (`touch:` variant,
`touch-hit` utility) lives inside the primitives.

| Group    | Primitives                                                                                                                                                                            | Notes                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Actions  | `Button` (primary, secondary, quiet, danger, link; xs-lg; icon, iconEnd, pressed, loading, fullWidth), `IconButton` (quiet, primary, round; xs-lg), `Chip`, `MenuButton`, `Segmented` | `ghost` = `quiet`; `Button.tsx`'s `IconButton` is deprecated (old sizes sm 24 / md 28) |
| Fields   | `TextField`, `TextArea` (one focus rule: border turns `fg`), `Select` (menu), `SearchField` (bordered, header, bare), `Checkbox`, `Switch`, `Field`                                   | `Input` / `Textarea` are deprecated aliases                                            |
| Lists    | `ListRow` (28/32/40, two-line, slots, selection), `ListFrame`, `SectionHeader`, `ScrollArea`, `MiddleText`, `Picker`, `Menu`, `InfoList` rows                                         | `INFO_ROW*` and `SkeletonRows` are superseded                                          |
| Messages | `Notice` (line, block; info, warn, error, success), `EmptyState`, `Skeleton`, `SkeletonText`, `SkeletonList`, `Spinner`                                                               | no coloured borders (decision 81); skeletons pulse only with `shimmer`                 |
| Surfaces | `Card` (raised, panel, code), `Dialog`, `Popover`, `Tooltips`, `CommandLine`, `KeyHint` (`Kbd`, `Key` aliases)                                                                        |                                                                                        |
| Marks    | `Glyph`, `StateGlyph`, status glyphs, `ProviderMark`, `Highlight`, `DayBars`, `Presence`, `Streak` + `StreakLayer`, file icons                                                        |                                                                                        |

Frame (decision 95f): `Panel` (+ `PanelFilters`, `PanelBody`, `PanelEmpty`, `DetailHeader`), the one frame of every tool tab; keep it out of the entry chunk (tool tabs are lazy). Reserved, being built by other batches: `FieldRow`. Not yet built (audit group list): `RadioGroup`,
`SelectButton`, `Badge`, `Loading`, `Toolbar`, `ListDetail`, `Meter`, `Dialog variant="palette"`.

## Providers

```text
HostProvider              embedding capabilities (openFile, pickFolder, theme) — all optional
└ AppProvider             bridge, health polling, project list, config, theme preference
  └ NavProvider           request jumps, request in view, leave guard, palette hooks (actions / state split)
    └ RequestsProvider    cached request lists + the orchestrator's latest reply, for the palette and Home (4 in flight)
      └ ActivityProvider  cache of agent lists, transcripts and plugins for the sidebar / Home / Details (4 in flight);
                          the open project publishes its live agents into it (`useOrchestrators`, state/orchestrators.ts)
      └ ProjectProvider   one project: SSE subscription → reducer (agent-client applyEvent), notes
        └ WorkspaceProvider   dock layout (pure layout.ts), persistence, routing, shortcuts, tab memory
          └ FileViewProvider  tree column width / open state
            └ CodeProvider    open files, directory cache, file index, save / conflict, language-server hub
              └ CommentsProvider   pending code comments
                └ Dock → TabView → Chat · Agent · File · Agents · Notes …
```

## Data flow

1. A host creates a `Bridge` (`createHttpBridge`, the message-port bridge, or `createDemoBridge` from `@octo/ui/demo`) and renders `OctoApp`.
2. `ProjectProvider` subscribes to the project's SSE stream; each event goes through the pure reducer from
   `@octo/agent-client` (`applyEvent`, `withAgents`, `withMessages`) into `ProjectState`.
3. Components read state from context and call bridge methods for writes; the resulting events update the state.
   Nothing in the UI writes to disk or runs commands itself.
4. File events reach the editor through `useProject().onEvent`, not a second connection.

## Lazy-loading boundary

The initial bundle must stay lean (budget and measured sizes are in the spec's "As built" sections).

- `monaco-editor` is imported as a value **only** in `components/files/monaco.ts`, reached through `import()`
  from `CodeEditor`. Everything that needs Monaco types uses `import type`.
- The language-server client (`lsp/manager`, `session`, `rpc`, `convert`, `uri`) loads with that chunk;
  `lsp/hub.ts` is the small seam that stays in the main chunk.
- The demo bridge and its fixtures are not in the package root: they sit behind the `@octo/ui/demo` subpath export, which
  `apps/desktop` loads with `import()` only for `?demo=` (`useBridge`). A normal start downloads none of it (initial
  bundle 211.2 → 195.1 kB gzip). Inside the demo, `seedFiles.ts` and `lsp.ts` still load with `import()` as well.
- Home, Details, Usage, Memory, Changes, Settings, the connect screen/sheet, the approval/queue slots and Markdown are lazy chunks (`React.lazy` in `app/AppShell` and `dock/TabView`), as are the
  streak canvas (`primitives/Streak`) and the highlighter (`lib/highlight`).
- v6.3 part 2 moved these out of the initial bundle too (initial 188.8 kB gzip): the file view (`files/FileView` and its
  tree, crumbs, editor host), Agents, Notes, the side question, the "+" tab picker and the all-tabs list (`dock/TabPicker`,
  `dock/AllTabsPicker`), the model picker's list, the composer's "+" menu, the comments control, the Markdown preview,
  sent comments, the agent header, tool details (`chat/ToolDetail`) and the table frame. `AppShell` warms the file view,
  the tab picker and the model picker 1.5 s after start; the composer's menu is prefetched when the composer takes focus.

`node scripts/check-bundle-size.mjs` (CI runs it after the desktop build) sums the gzip size of the entry chunk and its
`modulepreload` chunks and fails above the budget recorded in the script (measured size + 3 kB); lazy chunks are not counted.

## Routing, persistence, side effects

- The sidebar (UI decision 96, `PREFS.sidebarView`): "Projects and sessions" (default; `sessions/SessionTree`, a lazy chunk
  asked for at start: project rows with their main sessions, `state/sessionIndex` = `listAllSessions` per `updated_at` plus
  the open project's live list), "Sessions" (the same component, flat) or "Projects" (`shell/ProjectList`, lazy: one row per
  project, its state from `useOrchestrators`). Requests are reached through the turn rail and the palette.
- Hash routes (`lib/route.ts`): `#/p/{projectId}` (the session the conversation tab showed last, else the default),
  `#/p/{projectId}/s/{sessionId}`, `#/p/{projectId}/a/{agentId}`; a guarded route can hold a navigation while files are
  unsaved. An unknown or deleted session is a gone state (`resolveSessionRoute`, `sessions/SessionGone`).
- Parallel sessions (decision 96): a conversation is one main session's. `state/session.tsx` `SessionScope` re-provides the
  project (its root agent as the orchestrator, `scopeState` from agent-client: its queue, last turn, outcomes, approvals,
  forms, attention; `running`, `send`, `cancel`, its events) and the app's bridge addressed to it (`sessionBridge`), so the
  conversation, the composer and the v7 slots need no session argument. Chat shows `WorkspaceValue.chatSessionId`; a main
  session's `session:<sid>` tab is its own conversation (two sessions side by side).
- `localStorage` only through `lib/storage.ts` (prefix `octo.`, guarded). Every key is declared once in its `PREFS`
  registry (`theme`, `seen`, `layout.{projectId}`, `fileTree.{projectId}`, `comments.{projectId}`); a value is read and
  written through a codec that validates on read (missing or malformed text becomes a valid default), and state that
  mirrors a key uses `usePersistentState(key, codec, { debounceMs })`. Formats are those written since v6; a change
  needs a codec that still reads the old text. The codec of a value lives next to its type (`layoutCodec` in
  `state/workspace/layout.ts`, `commentsCodec` in `lib/comments.ts`, `seenCodec`, `treePrefCodec`, `themeCodec`).
- Ids are branded: `TabId` is built and parsed only in `state/workspace/layout.ts` (`CHAT`, `toolTab`, `agentTab`,
  `fileTab`, `parseTabId`) and `FileKey` only in `lib/files.ts` (`fileKey`, `parseFileKey`, `splitKey`, `keyFolder`,
  `keyInFolder`, `isRootKey`). The NUL separator of file keys is private to `lib/files.ts`; ESLint (`no-restricted-syntax`,
  error) forbids it anywhere else.
- Shared hooks and helpers: `useLatest` (`lib/hooks.ts`, the "latest props in a ref" pattern), `errorMessage`
  (`lib/format.ts`), `createRequiredContext` (`lib/context.ts`: provider plus a hook that throws outside it), per-tab view
  memory as typed slots (`state/workspace/tabMemory.ts`, `useTabMemory`; `USAGE_VIEW` holds the Usage tab's controls), tab
  DOM ids (`state/workspace/ids.ts`, moved from `dock/` so the workspace can focus a newly opened file's panel), named breakpoints, timings and layout sizes in
  `lib/constants.ts` (the drawer breakpoint is also the `--breakpoint-drawer` token in `styles.css`; a test keeps them equal).
- Network: only through the `Bridge`. Polling (health, project list) is in `state/app.tsx`; SSE in `state/project.tsx`.
- Global keyboard shortcuts are registered in `AppShell` (palette) and `WorkspaceProvider` (tabs), in the capture
  phase so they work inside Monaco.

## Public API

`src/index.ts`: `OctoApp`, `OctoAppProps`, `HostCapabilities`; `@octo/ui/demo`: `createDemoBridge` and its option types;
`@octo/ui/styles.css`. Hosts must `@import "tailwindcss"` before the stylesheet.

## Verification

`pnpm --filter @octo/ui lint` is `tsc --noEmit` (strict flags from the root `tsconfig.base.json`) plus ESLint
(`eslint.config.mjs`: typescript-eslint type-checked, react-hooks, jsx-a11y, and the import boundaries of the table
above, all errors). `pnpm --filter @octo/ui test` runs the `node:test`
tests beside the pure modules. Visual and interaction behaviour is checked with
Playwright scripts against the demo bridge (`?demo=1`, knobs `?demo=one|many|empty`, `?lsp=…`, `?plugins=none`)
and with `scripts/spacing-audit.mjs`.

## Known debt (audit of 2026-11-10)

Measured at the time: 114 files, ~14k lines; 14 files over 250 lines; 120 effects; 84 type casts; 13 non-null
assertions; 0 `any`; 0 unit tests. Q2 added the unit tests, Q3 the shared helpers, Q4 the import boundaries (rows removed below). Do not add to
this list; reduce it when you touch the code.

| Debt                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                               | Direction                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Providers that own several concerns                                                                                                                                                                                                                                                                                                                                                     | `state/code.tsx` (files, tree, index, save, LSP), `state/workspace/WorkspaceProvider.tsx` (layout, persistence, shortcuts, palette) | Split into hooks composed by a thin provider                                               |
| Every SSE event re-renders all `useProject()` consumers                                                                                                                                                                                                                                                                                                                                 | `state/project.tsx`                                                                                                                 | Actions context + state context, as in `state/nav.tsx`                                     |
| Note actions compute from captured state                                                                                                                                                                                                                                                                                                                                                | `state/project.tsx`                                                                                                                 | Reducer actions                                                                            |
| Cross-component DOM queries                                                                                                                                                                                                                                                                                                                                                             | `WorkspaceProvider`, `dock/drag.ts`, `ProjectDialog`                                                                                | Refs, context, one owning module                                                           |
| Large components mixing loading, layout and keyboard                                                                                                                                                                                                                                                                                                                                    | `files/FileView.tsx`, `files/editor/EditorComments.tsx`, `chat/Composer.tsx`, `files/FileTree.tsx`, `project/ProjectDialog.tsx`     | Extract hooks                                                                              |
| Repeated long class strings; arbitrary-pixel breakpoints in CSS classes (`max-[560px]`, `@max-[360px]/…`) that no JS constant mirrors                                                                                                                                                                                                                                                   | `chat/Composer*`, `shell/CommandPalette`, `files/TreeColumn`, `IntegrationsView`, `DelegationGroup`                                 | Row / MenuItem / OverlayPanel primitives; `@theme` breakpoint tokens where a value repeats |
| `ProjectId` / `AgentId` are plain strings (they come from `@octo/agent-client` types, which this step does not touch)                                                                                                                                                                                                                                                                   | `state/project.tsx`, `lib/route.ts`, everything keyed by project or agent                                                           | Brand them in `@octo/agent-client` with parsers there, then use the brands here            |
| List / listbox / menu keyboard handling written per overlay                                                                                                                                                                                                                                                                                                                             | `Menu`, `CommandPalette`, `ComposerMenu`, `TabStrip`                                                                                | Shared hooks in `primitives`                                                               |
| ESLint warnings (83 in `packages/ui` at the end of Q4, 104 before it, 121 at the end of Q1: 11 `prefer-optional-chain`, 16 `no-unnecessary-condition`, 3 `!`, 7 `set-state-in-effect`, 3 `refs`, 7 `exhaustive-deps`, 25 jsx-a11y, rest React Compiler rules and deprecations; the import-boundary rule has none); casts: 179 by the Q1 counting script (188 before Q3, tests included) | `eslint.config.mjs` (counts: `pnpm lint`)                                                                                           | Q5 removes its warnings (hooks / a11y) and turns those rules into errors                   |
