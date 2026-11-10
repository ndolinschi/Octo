# Frontend code-quality pass — plan

**Date:** 2026-11-10 · **Status:** approved by the owner; runs after UI v6.1 and before v7
**Scope:** `packages/ui`, `packages/agent-client`, `apps/desktop` (TypeScript only). No visual or behavioural change.
**Inputs:** the audit summarised in [`packages/ui/ARCHITECTURE.md`](../../../packages/ui/ARCHITECTURE.md) ("Known debt"),
the rules in [`.cursor/rules/octo-typescript.mdc`](../../../.cursor/rules/octo-typescript.mdc).

The pass is a refactor: every step keeps the UI pixel-identical and the gates green. It is split so that each
step can be verified and committed on its own.

## Steps

**Q1 — Tooling (mechanical enforcement first)**
- `tsconfig.base.json` at the repo root, extended by the three packages: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`; one target. Fix the resulting errors (about 150 in
  `packages/ui`, 20 in `packages/agent-client`) with real handling, not casts or `!`.
- ESLint flat config at the root for the three packages: `typescript-eslint` (type-aware strict),
  `react-hooks`, `jsx-a11y`, import boundaries matching the table in `ARCHITECTURE.md` (errors for `lib` →
  up, `state`/`lsp` → `components`, `primitives` → features, value imports of `monaco-editor` outside
  `components/files/monaco.ts`, `@tauri-apps/*` in `packages/ui`), `no-explicit-any`, `no-non-null-assertion`,
  `no-empty`. Rules that current code cannot meet yet start as warnings with a counted baseline, listed in the report.
- Prettier with the Tailwind class-order plugin; one formatting commit, nothing else in it.
- `lint` = `tsc --noEmit && eslint .` in each package; a `test` script in `packages/ui` (`node:test` + `tsx`, as
  in `packages/agent-client`); the CI workflow runs lint, tests and build for the frontend packages and prints
  the initial chunk's gzip size (fails above the recorded budget + 3 kB).

**Q2 — Tests for pure logic** (before touching the code they protect)
`state/workspace/layout.ts`, `lib/route.ts`, `lib/files.ts`, `lib/comments.ts`, `lib/format.ts`, `lib/match.ts`,
`lib/transcript.ts`, `lib/tools.ts`, `lsp/uri.ts`, `lsp/convert.ts`, `lsp/rpc.ts`, the project reducer, the file-view
preference codec. Behaviour as it is today, including edge cases the specs name.

**Q3 — Shared helpers and types**
`useLatest`, `errorMessage`, `usePersistentState` + a preference key registry in `lib/storage.ts`, a required-
context factory, branded `TabId` / `FileKey` with their only constructors and parsers in `layout.ts` /
`lib/files.ts`, a typed `useTabMemory`, named constants for breakpoints, timings and layout sizes. Replace every
hand-written copy.

**Q4 — Boundaries**
Move `EditorBuffers` below components; move `Markdown`, file glyph lookup and text highlight to `primitives` /
`lib`; remove the `files` ↔ `dock` two-way import; contexts that are app state move to `state/`; demo fixtures
behind an `@octo/ui/demo` subpath export; `apps/desktop/src/App.tsx` keeps wiring only (bridge selection becomes
a pure, tested function). After this step the import-boundary lint rules are errors with no exceptions.

**Q5 — Providers and large components**
Split `state/code.tsx` (open files, tree, index, save, intel) and `WorkspaceProvider` (layout state, persistence,
shortcuts, palette registration) into hooks composed by thin providers; split `state/project.tsx` into actions
and state contexts with reducer-driven note actions; extract hooks from `FileView`, `EditorComments`, `Composer`,
`FileTree`, `ProjectDialog`; replace cross-component DOM queries with refs or registries; shared list / listbox /
menu keyboard hooks and row / menu-item / overlay primitives for the repeated class strings.

## Acceptance criteria

1. `pnpm --filter @octo/ui lint`, `pnpm --filter @octo/agent-client lint` and the desktop type-check pass with
   the strict flags above; ESLint reports zero errors; the warning baseline is recorded and lower than at the start.
2. No `any`, no `@ts-ignore`; casts and non-null assertions are each at most half of the audit's count
   (84 and 13 in `packages/ui`), every remaining one with a reason.
3. No file in `packages/ui/src` (outside `demo/` fixtures and `styles.css`) is longer than 300 lines; no
   component has more than 3 effects.
4. Import boundaries hold with no exceptions (lint errors, not warnings).
5. Unit tests exist for every module listed in Q2 and run in CI.
6. No visible change: the screenshot set of v6.1 (all states, dark and light, 1440 / 1100 / 390) is pixel-
   identical before and after, apart from documented anti-aliasing noise; the spacing audit stays at 0; the
   scripted acceptance checks of v6 and v6.1 all pass; no console errors.
7. Initial bundle does not grow (± 1 kB gzip); Monaco chunk unchanged.
8. `ARCHITECTURE.md`'s debt table is updated: resolved rows removed, anything deferred stated with a reason.

## Execution

Sonnet builds (code and tests); one step per agent run, committed by the orchestrator after its gates and the
before/after screenshot comparison; an independent read-only review of the result at the end. Q1 and Q2 can
start as soon as v6.1 is committed; Q3–Q5 run in order.
