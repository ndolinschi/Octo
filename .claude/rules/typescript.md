---
paths:
  - "packages/**/*.ts"
  - "packages/**/*.tsx"
  - "apps/desktop/**/*.ts"
  - "apps/desktop/**/*.tsx"
  - "apps/web/**/*.ts"
  - "apps/web/**/*.tsx"
---

<!-- Same text as .cursor/rules/octo-typescript.mdc — change both. -->

# Octo — writing TypeScript and TSX

Applies to `packages/ui`, `packages/agent-client`, `apps/desktop`. Architecture and the list of known debt:
[`packages/ui/ARCHITECTURE.md`](../../packages/ui/ARCHITECTURE.md). Existing code breaks some of these rules; do not
add new violations, and fix the ones in code you touch when the fix is small. Design rules (tokens, spacing,
motion) are in `packages/ui/COMPONENTS.md` and `packages/ui/ARCHITECTURE.md` and are not repeated here.

## Module boundaries

1. Imports point one way: `lib` ← `lsp` ← `state` ← `components/primitives` ← `components/<feature>` ← `app`.
   `lib` imports nothing above it; `state` and `lsp` never import from `components`; `primitives` import only `lib`.
2. Features (`chat`, `files`, `agents`, `notes`, `project`, `shell`) do not import each other. `dock/TabView` is the
   one place that composes them. Something two features need moves down to `primitives` or `lib`.
3. `monaco-editor` is imported as a value only in `components/files/monaco.ts`; everywhere else `import type`.
   Anything used only by the editor, the streak or the highlighter loads through `import()`.
4. `packages/ui` never imports `@tauri-apps/*` and never touches platform APIs; a host passes `HostCapabilities`.
   `packages/agent-client` has no React and no DOM types. `apps/desktop` is wiring only.
5. Export only what another file imports. `index.ts` is the package's public API; no deep imports across packages.

## Components

6. One component, one job. Split when a file passes ~250 lines or a component body has more than ~8 hooks or
   3 effects: behaviour (keyboard, measurement, persistence, data loading) goes to a `use*.ts` hook next to it,
   layout stays in the component.
7. Reuse before writing: rows, menu items, overlays, dialogs, focus traps, roving lists and listboxes live in
   `components/primitives`. If the same run of five or more utility classes appears twice, make it a primitive or
   a named class constant.
8. Accessibility behaviour (focus trap, roving focus, active descendant, focus return) is implemented once in
   `primitives` and composed; a feature never re-implements it.
9. Inline `style` only for values measured or computed at run time (drag position, measured size). No arbitrary
   pixel classes (`w-[440px]`) where a token exists; breakpoints, timings and layout constants are named
   constants (`lib/`), defined once.

## State and effects

10. A provider owns one concern. Split a context into a stable actions context and a state context (see
    `state/nav.tsx`) so consumers of actions do not re-render on every event.
11. Actions never close over reactive state to compute the next state — dispatch to a reducer or use the
    updater form. Context values are memoised; actions are stable.
12. No effect for derived state or for resetting state when a prop changes: compute during render, or use `key`.
    Effects are for synchronising with something outside React.
13. Every effect that adds a listener, timer, observer or subscription returns its cleanup. Use the shared
    `useLatest` helper (`lib/hooks.ts`) instead of a hand-written "copy to ref in a layout effect".
14. Do not reach across components with `document.querySelector`. Use refs, context, or one owning module for a
    `data-*` protocol (`dock/drag.ts`, `chat/turnTracking.ts`).
15. Persisted state goes through `lib/storage.ts` with the key declared in one registry and the stored value
    validated on read — never `JSON.parse(x) as T`.

## Types

16. No `any`, no `@ts-ignore`, no `as unknown as`. A cast needs a reason a type guard cannot give; DOM event
    targets use `instanceof`; discriminated unions are narrowed with `switch`, not cast.
17. No non-null `!` unless the line carries a comment stating the invariant. Prefer a helper that cannot fail.
18. Ids are branded types (`TabId`, `FileKey`, `ProjectId`, `AgentId`) built and parsed only by their owning
    module (`lib/files.ts`, `state/workspace/layout.ts`). The `\u0000` separator never appears anywhere else.
19. The packages compile with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (`tsconfig.base.json`):
    handle the `undefined` of an indexed read; do not assign `undefined` to an optional property — omit it (or build the
    object with a conditional spread).

## Errors, comments, tests

20. Do not swallow errors. An empty `catch` states in a comment where the failure surfaces to the user; error text
    comes from the shared `errorMessage(e)` (`lib/format.ts`). Every user-visible error names a next step.
21. Comments say why, or cite the spec decision. No banners, no narration of what the next line does. When
    behaviour changes, the spec's "As built" section changes in the same commit.
22. Pure logic lives in React-free modules and ships with a `*.test.ts` beside it (`node:test`, as in
    `packages/agent-client`). New reducers, parsers, formatters, matchers and layout operations are not done
    without tests. Behaviour that needs a browser is verified with a Playwright script and the result reported.

## Before you finish

```bash
pnpm lint                                  # tsc --noEmit + eslint for agent-client, ui, desktop: zero errors, no new warnings
pnpm format:check                          # `pnpm format` fixes
pnpm --filter @octo/agent-client test
pnpm --filter @octo/ui test
pnpm --filter @octo/desktop build
node scripts/check-bundle-size.mjs         # initial JS (gzip) within budget
node packages/ui/scripts/spacing-audit.mjs --url http://localhost:1420   # with the dev server running; must print total=0
```

Report what you ran and what you did not. Do not claim a behaviour works unless you exercised it.
