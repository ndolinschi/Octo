# `@octo/ui` — agent instructions

Shared React UI (React 19, Tailwind 4, Monaco). Read first:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — layers, allowed imports, providers, lazy boundary, known debt.
- [`.cursor/rules/octo-typescript.mdc`](../../.cursor/rules/octo-typescript.mdc) — how to write TS/TSX here.
- [`docs/superpowers/specs/2026-11-10-project-harness-ui.md`](../../docs/superpowers/specs/2026-11-10-project-harness-ui.md) — design decisions; the v6 section at the top is current.

## Commands

```bash
pnpm install
pnpm --filter @octo/desktop dev                 # http://localhost:1420/?demo=1 (in-memory demo data)
pnpm --filter @octo/ui lint                     # tsc --noEmit && eslint . (errors fail; warnings are the debt baseline)
pnpm --filter @octo/ui format:check             # prettier; `pnpm --filter @octo/ui format` rewrites
pnpm --filter @octo/ui test                     # node:test + tsx, *.test.ts beside the code
pnpm --filter @octo/agent-client test
pnpm --filter @octo/desktop build               # also reports chunk sizes
node scripts/check-bundle-size.mjs              # after the build: initial JS gzip must stay within the budget
node packages/ui/scripts/spacing-audit.mjs --url http://localhost:1420   # must print total=0
```

Demo knobs: `?demo=one|many|empty`, `?lsp=fail-once|slow|exit`, `?plugins=none`. Without `?demo` the app uses the
harness at `VITE_HARNESS_BRIDGE_URL` (default `http://127.0.0.1:8790`).

## Rules that are easy to break

- No `@tauri-apps/*`, no platform APIs: hosts pass `HostCapabilities`.
- The strict flags (`tsconfig.base.json`) and the ESLint config (`eslint.config.mjs`, repo root) enforce the rules above:
  import boundaries, `any`, `!`, empty blocks, type-only imports. Fix an error; do not add `eslint-disable` or
  `@ts-expect-error` without a reason on the same line. A new warning counts as a new violation.
- Imports go one way (`lib` ← `lsp` ← `state` ← `primitives` ← features ← `app`); features meet only in `dock/TabView`.
- `monaco-editor` as a value only in `components/files/monaco.ts`; heavy optional code behind `import()`.
- Spacing, row heights, radii and colours come from the tokens in `styles.css`; the audit must stay at zero.
- New `Bridge` methods: change `@octo/agent-client` first, then implement them in `src/demo/bridge.ts`.
- A design change updates the spec's "As built" section in the same commit.

## Verifying UI work

Type-checking is not evidence that a screen works. Drive the real UI with Playwright against `?demo=1` (and the
live harness for behaviour that needs it), in dark and light, at 1440, 1100 and 390 wide; read the screenshots;
check the console is clean. Say what you checked and what you did not.
