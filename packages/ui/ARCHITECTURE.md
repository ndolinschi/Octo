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
components/<feature>/   chat · files · agents · notes · project · shell   (screens and their parts)
components/dock/        tab groups, strip, divider, drag layer, TabView = the composition point
components/primitives/  Button, Dialog, Menu, Popover, Field, Tooltips, Glyph, status glyphs
state/                  one provider per concern (see the tree below); state/workspace/layout.ts is pure
lsp/                    language-server client (hub in the main chunk, the rest loads with Monaco)
lib/                    pure helpers and small hooks: files, format, match, comments, transcript, tools, route, storage
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
    └ RequestsProvider    cached request lists (external store)
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

There is no automatic check yet; verify with `pnpm --filter @octo/desktop build` and read the chunk sizes.

## Routing, persistence, side effects

- Hash routes (`lib/route.ts`): `#/p/{projectId}`, `#/p/{projectId}/a/{agentId}`; a guarded route can hold a
  navigation while files are unsaved.
- `localStorage` only through `lib/storage.ts` (prefix `octo.`, guarded): `octo.theme`, `octo.seen`,
  `octo.layout.{projectId}`, `octo.fileTree.{projectId}`, `octo.comments.{projectId}`. Stored values are validated
  on read; stale entries are dropped silently.
- Network: only through the `Bridge`. Polling (health, project list) is in `state/app.tsx`; SSE in `state/project.tsx`.
- Global keyboard shortcuts are registered in `AppShell` (palette) and `WorkspaceProvider` (tabs), in the capture
  phase so they work inside Monaco.

## Public API

`src/index.ts`: `OctoApp`, `OctoAppProps`, `HostCapabilities`, `createDemoBridge` and its option types; plus
`@octo/ui/styles.css`. Hosts must `@import "tailwindcss"` before the stylesheet.

## Verification

`pnpm --filter @octo/ui lint` is the type-check. There is no unit-test runner in this package yet; pure modules
should get `node:test` tests as in `@octo/agent-client`. Visual and interaction behaviour is checked with
Playwright scripts against the demo bridge (`?demo=1`, knobs `?demo=one|many|empty`, `?lsp=…`, `?plugins=none`)
and with `scripts/spacing-audit.mjs`.

## Known debt (audit of 2026-11-10)

Measured at the time: 114 files, ~14k lines; 14 files over 250 lines; 120 effects; 84 type casts; 13 non-null
assertions; 0 `any`; 0 unit tests. Do not add to this list; reduce it when you touch the code.

| Debt | Where | Direction |
| --- | --- | --- |
| Providers that own several concerns | `state/code.tsx` (files, tree, index, save, LSP), `state/workspace/WorkspaceProvider.tsx` (layout, persistence, shortcuts, palette) | Split into hooks composed by a thin provider |
| Every SSE event re-renders all `useProject()` consumers | `state/project.tsx` | Actions context + state context, as in `state/nav.tsx` |
| Note actions compute from captured state | `state/project.tsx` | Reducer actions |
| `state` and `lsp` import from components | `state/code.tsx`, `lsp/manager.ts` → `components/files/buffers` | Move `EditorBuffers` below components |
| `files` ↔ `dock` import each other; features import `chat/Markdown`, `files/fileIcons`, `files/FileTree` | `files/FileView.tsx`, `dock/TabView.tsx`, `chat/ComposerMenu.tsx`, `notes/NotesPanel.tsx` | Shared pieces move to `primitives` / `lib` |
| Untyped tab memory (`Map<string, unknown>` + casts) | `WorkspaceProvider`, `FileView`, `AgentsPanel`, `useOrchestratorComposer` | One typed `useTabMemory` hook |
| Ids are plain strings; the `\u0000` separator is re-implemented | `layout.ts`, `lib/files.ts`, `state/code.tsx`, `dock/tabInfo.ts` | Branded `TabId` / `FileKey`, one owner each |
| Cross-component DOM queries | `WorkspaceProvider`, `dock/drag.ts`, `ProjectDialog` | Refs, context, one owning module |
| Hand-written "latest ref" effects (≈15), duplicated debounce-persist, per-key JSON parsing, 13 copies of the error-message expression | `state/*`, `lib/*` | `useLatest`, `usePersistentState` with a key registry, one `errorMessage` |
| Large components mixing loading, layout and keyboard | `files/FileView.tsx`, `files/editor/EditorComments.tsx`, `chat/Composer.tsx`, `files/FileTree.tsx`, `project/ProjectDialog.tsx` | Extract hooks |
| Repeated long class strings; hard-coded breakpoints in CSS classes and JS | `chat/Composer*`, `shell/CommandPalette`, `files/TreeColumn`, `AppShell` | Row / MenuItem / OverlayPanel primitives; named constants |
| List / listbox / menu keyboard handling written per overlay | `Menu`, `CommandPalette`, `ComposerMenu`, `TabStrip` | Shared hooks in `primitives` |
| No ESLint, no formatter, no unit tests; `strict` only | package config | Shared `tsconfig.base.json` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (≈150 fixes here), ESLint (typescript-eslint, react-hooks, import boundaries), `node:test` for pure modules |
| Demo fixtures are exported from the package root | `src/index.ts` | A `@octo/ui/demo` subpath |
