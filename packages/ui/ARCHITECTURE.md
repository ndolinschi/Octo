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
components/<feature>/   chat · files · agents · notes · details · usage · home · project · shell   (screens and their parts)
components/dock/        tab groups, strip, divider, drag layer, TabView = the composition point
components/primitives/  Button, Dialog, Menu, Popover, Field, Tooltips, Glyph, status / file glyphs (OrchestratorGlyph), InfoList
                        rows, FloatRoom, Segmented, DayBars (day chart), backdrop (group-level streak request),
                        Streak (lazy canvas) + StreakLayer
state/                  one provider per concern (see the tree below); state/workspace/layout.ts is pure
lsp/                    language-server client (hub in the main chunk, the rest loads with Monaco)
lib/                    pure helpers and small hooks: files, format, match (+ group ranking), comments, transcript, tools, route,
                        storage, fileLinks, codePalette, highlight (lazy), streak, focus, constants, context, orchestrator
                        (a project's orchestrator state), usage (report arithmetic, chart scale, limits), crumbs
                        (breadcrumb fit), frontMatter, languages — `*.test.ts` beside them (`pnpm --filter @octo/ui test`)
demo/                   in-memory Bridge with seeded projects (for ?demo= and for scripted checks)
styles.css              design tokens (@theme), base rules, Monaco widget overrides
scripts/                spacing-audit.mjs (Playwright; fails on off-scale spacing)
```

Allowed imports (a row may import the columns marked ✓):

| from \ to | lib | lsp | state | primitives | features | app | `@octo/agent-client` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lib` | – | | | | | | types |
| `lsp` | ✓ | – | | | | | ✓ |
| `state` | ✓ | ✓ | ✓ | | | | ✓ |
| `components/primitives` | ✓ | | | – | | | types |
| `components/<feature>` | ✓ | ✓ | ✓ | ✓ | only through `dock/TabView` | | ✓ |
| `app` | ✓ | | ✓ | ✓ | ✓ | – | ✓ |
| `demo` | ✓ | | | | | | ✓ |

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

1. A host creates a `Bridge` (`createHttpBridge`, the message-port bridge, or `createDemoBridge`) and renders `OctoApp`.
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
- Demo fixtures (`demo/seedFiles.ts`, `demo/lsp.ts`) and other heavy, optional code load with `import()`.
- Home, Details, Usage and Integrations are lazy chunks (`React.lazy` in `app/AppShell` and `dock/TabView`), as are the
  streak canvas (`primitives/Streak`) and the highlighter (`lib/highlight`).

`node scripts/check-bundle-size.mjs` (CI runs it after the desktop build) sums the gzip size of the entry chunk and its
`modulepreload` chunks and fails above the budget recorded in the script (measured size + 3 kB); lazy chunks are not counted.

## Routing, persistence, side effects

- The sidebar lists projects only (decision 23): each row's orchestrator state comes from `useOrchestrators`
  (live agents of the open project, else `listAgents` cached per `updated_at`). The per-project request lists the
  sidebar used to expand are gone (with their expand state and retry path); requests are reached through the turn rail
  and the palette.
- Hash routes (`lib/route.ts`): `#/p/{projectId}`, `#/p/{projectId}/a/{agentId}`; a guarded route can hold a
  navigation while files are unsaved.
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

`src/index.ts`: `OctoApp`, `OctoAppProps`, `HostCapabilities`, `createDemoBridge` and its option types; plus
`@octo/ui/styles.css`. Hosts must `@import "tailwindcss"` before the stylesheet.

## Verification

`pnpm --filter @octo/ui lint` is `tsc --noEmit` (strict flags from the root `tsconfig.base.json`) plus ESLint
(`eslint.config.mjs`: typescript-eslint type-checked, react-hooks, jsx-a11y, and the import boundaries of the table
above — violations of the debt rows below are warnings until Q4). `pnpm --filter @octo/ui test` runs the `node:test`
tests beside the pure modules. Visual and interaction behaviour is checked with
Playwright scripts against the demo bridge (`?demo=1`, knobs `?demo=one|many|empty`, `?lsp=…`, `?plugins=none`)
and with `scripts/spacing-audit.mjs`.

## Known debt (audit of 2026-11-10)

Measured at the time: 114 files, ~14k lines; 14 files over 250 lines; 120 effects; 84 type casts; 13 non-null
assertions; 0 `any`; 0 unit tests. Q2 added the unit tests, Q3 the shared helpers (rows removed below). Do not add to
this list; reduce it when you touch the code.

| Debt | Where | Direction |
| --- | --- | --- |
| Providers that own several concerns | `state/code.tsx` (files, tree, index, save, LSP), `state/workspace/WorkspaceProvider.tsx` (layout, persistence, shortcuts, palette) | Split into hooks composed by a thin provider |
| Every SSE event re-renders all `useProject()` consumers | `state/project.tsx` | Actions context + state context, as in `state/nav.tsx` |
| Note actions compute from captured state | `state/project.tsx` | Reducer actions |
| `state` and `lsp` import from components | `state/code.tsx`, `lsp/manager.ts` → `components/files/buffers` | Move `EditorBuffers` below components |
| `files` ↔ `dock` import each other; features import `chat/Markdown`, `files/fileIcons`, `files/FileTree` | `files/FileView.tsx`, `dock/TabView.tsx`, `chat/ComposerMenu.tsx`, `notes/NotesPanel.tsx` | Shared pieces move to `primitives` / `lib` |
| Cross-component DOM queries | `WorkspaceProvider`, `dock/drag.ts`, `ProjectDialog` | Refs, context, one owning module |
| Large components mixing loading, layout and keyboard | `files/FileView.tsx`, `files/editor/EditorComments.tsx`, `chat/Composer.tsx`, `files/FileTree.tsx`, `project/ProjectDialog.tsx` | Extract hooks |
| Repeated long class strings; arbitrary-pixel breakpoints in CSS classes (`max-[560px]`, `@max-[360px]/…`) that no JS constant mirrors | `chat/Composer*`, `shell/CommandPalette`, `files/TreeColumn`, `IntegrationsView`, `DelegationGroup` | Row / MenuItem / OverlayPanel primitives; `@theme` breakpoint tokens where a value repeats |
| `ProjectId` / `AgentId` are plain strings (they come from `@octo/agent-client` types, which this step does not touch) | `state/project.tsx`, `lib/route.ts`, everything keyed by project or agent | Brand them in `@octo/agent-client` with parsers there, then use the brands here |
| List / listbox / menu keyboard handling written per overlay | `Menu`, `CommandPalette`, `ComposerMenu`, `TabStrip` | Shared hooks in `primitives` |
| ESLint warnings (108 at the end of Q3, 121 at the end of Q1: 21 import-boundary, 15 `prefer-optional-chain`, 16 `no-unnecessary-condition`, 3 `!`, 7 `set-state-in-effect`, 3 `refs`, 7 `exhaustive-deps`, 35 jsx-a11y, rest React Compiler rules and deprecations); casts: 179 by the Q1 counting script (188 before Q3, tests included) | `eslint.config.mjs` (counts: `pnpm lint`) | Each step Q4–Q5 removes its warnings (boundaries Q4, hooks / a11y Q5) and turns the rule into an error |
| Demo fixtures are exported from the package root | `src/index.ts` | A `@octo/ui/demo` subpath |
