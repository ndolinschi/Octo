# `@octo/ui` — agent instructions

Shared React UI (React 19, Tailwind 4, Monaco). Read first:

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — layers, allowed imports, providers, lazy boundary, known debt.
- [`COMPONENTS.md`](./COMPONENTS.md) — the component library (primitives and shared composites, who uses each), design tokens, the tool-tab anatomy, how to add a tool tab or a card, what each check script verifies.
- [`.cursor/rules/octo-typescript.mdc`](../../.cursor/rules/octo-typescript.mdc) — how to write TS/TSX here.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`COMPONENTS.md`](./COMPONENTS.md) — layout and component library.

## Commands

```bash
pnpm install
pnpm --filter @octo/desktop dev                 # http://localhost:1420/?demo=1 (in-memory demo data)
pnpm --filter @octo/ui lint                     # tsc --noEmit && eslint . (errors fail; warnings are the debt baseline)
pnpm --filter @octo/ui format:check             # prettier; `pnpm --filter @octo/ui format` rewrites
pnpm --filter @octo/ui test                     # node:test + tsx, *.test.ts beside the code
pnpm --filter @octo/agent-client test
pnpm --filter @octo/desktop test                # bridge selection (pure function)
pnpm test:scripts                               # from the repo root: the layer-imports ESLint rule (pnpm lint also runs scripts/check-cycles.mjs)
pnpm --filter @octo/desktop build               # also reports chunk sizes
node scripts/check-bundle-size.mjs              # after the build: initial JS gzip must stay within the budget
node packages/ui/scripts/spacing-audit.mjs --url http://localhost:1420   # must print total=0
node packages/ui/scripts/flicker.mjs --url http://localhost:1420   # decisions 69/76: per-frame stability while typing a long prompt; no running animation on idle screens
node packages/ui/scripts/project-switch.mjs --url http://localhost:1420   # decision 99: every way of changing project (sidebar, tree, composer selector, new session, Home, palette, back/forward) paints the next conversation complete in one frame, no blank, no fill-in; `--theme light`, `--cpu 4`, `--shots DIR`
node packages/ui/scripts/width-stability.mjs --url http://localhost:1420   # decision 79: must print "width-stability: ok" (also at --width 900 --height 600)
node packages/ui/scripts/frame-colours.mjs --url http://localhost:1420   # decision 81: no warn/error/accent border, outline or ring (approval, form, plan, failed turn, review screens)
node packages/ui/scripts/scroll-on-send.mjs --url http://localhost:1420   # rule: sending scrolls to the sent message and re-pins to the bottom
node packages/ui/scripts/slash-commands.mjs --url http://localhost:1420   # every Octo slash command (typed, with an argument, from the menu, by click; `--phone`): the result is checked; must print "slash-commands: ok"
node packages/ui/scripts/stick-on-open.mjs --url http://localhost:1420   # a long conversation opens at its end and lets go only when the reader scrolls (wheel, keys, stream)
node packages/ui/scripts/composer-fit.mjs --url http://localhost:1420   # the composer grows a line at a time, then scrolls; also with the script fallback (no field-sizing)
node packages/ui/scripts/scroll-anchor.mjs --url http://localhost:1420   # 30 steps up the Stress test: the text under the eyes never jumps (native and manual anchoring)
node packages/ui/scripts/editor-context-menu.mjs --url http://localhost:1420 --browser webkit --ua-macos   # the editor's context menu stays open (WebKit with a macOS user agent)
node packages/ui/scripts/ui-tour.mjs --url http://localhost:1420 --out /tmp/tour   # (then `python3 packages/ui/scripts/tour-sheets.py /tmp/tour` for one contact sheet per group and theme) every screen in dark and light at four sizes (PNG + INDEX.md + MISSING.txt); `--only chat`, `--theme dark`, `--small`
```

Every UI script takes `--browser chromium|webkit` (`scripts/browser.mjs`; WebKit is Playwright's Linux build, not Safari).

Scripts and tab flags: a script about a tab the default flags hide opens the app with the flag it needs, in its own URL: `spacing-audit.mjs` (default `--query demo=1&tabs=all`), `panel-measure.mjs` and `ui-tour*.mjs` (`tabs=all`; the tour's `boot` adds it to any `demo=` query without a `tabs` knob), `width-stability.mjs` (`tabs=memory`), `slash-commands.mjs` (`/memory` case: `tabs=memory`) and `picker-keys.mjs` (the "+" menu's "Session:" entry: `tabs=sessions`). The rest run the default experience. The composer "+" menu lists "Session: …" only when that menu has something to run (make default, move to worktree, or "Show all sessions" while the `sessions` flag is on), so `picker-keys.mjs` asserts it is absent with the default flags. `slash-commands.mjs` reloads the app for each of about 40 cases: a full run is 4 to 6 minutes (`--verbose` prints each case as it ends).

Demo and tab-flag knobs: `?demo=one|many|empty`, `?lsp=fail-once|slow|exit`, `?plugins=none`, `?claude=empty|loggedout`, `?accounts=claude|all` (Claude Code gets a second account "Work", logged out, and the default accounts are named "Personal"; `all` adds Codex's "Second"; a demo login prints a fake link and code and turns logged in after Enter or 3 s), `?limit=<provider id>` (e.g. `?accounts=claude&limit=claude-code`: turns on that account fail with the plan-limit notice and its "Use another account" button), `?refresh=fail|none`, `?providers=none|owner` (the owner's live set of twelve), `?ollama=down` (Ollama not running; with `?recheck=ok` "Check again" starts it), `?router=on`, `?remote=on|missing`, `?tabs=all|none|<comma-list>` (e.g. `?tabs=sessions,memory` or `?tabs=all,-notes`). By default (`DEFAULT_TAB_FLAGS` in `src/lib/tabFlags.ts`), the `sessions` (dock tool tab + top-bar `[data-sessions-button]` picker), `agents`, `notes`, `details`, `usage`, and `memory` tool tabs are `false`, while `files`, `browser`, `terminal`, `processes`, `changes`, `review`, and `side` — plus left-sidebar `SessionTree`, `/new`, and `session:<id>` / `agent:<id>` tabs — are `true`; the Go harness and `@octo/agent-client` are unaffected. Without `?demo` the app uses the
harness at `VITE_HARNESS_BRIDGE_URL` (default `http://127.0.0.1:8790`).

## Rules that are easy to break

- No `@tauri-apps/*`, no platform APIs: hosts pass `HostCapabilities`.
- The strict flags (`tsconfig.base.json`) and the ESLint config (`eslint.config.mjs`, repo root) enforce the rules above:
  import boundaries, `any`, `!`, empty blocks, type-only imports. Fix an error; do not add `eslint-disable` or
  `@ts-expect-error` without a reason on the same line. A new warning counts as a new violation.
- Imports go one way (`lib` ← `lsp` ← `state` ← `primitives` ← `shared` ← features ← `dock` ← `app`; `demo` sees only `lib` and `lsp`), enforced as lint errors with no exceptions and no cycles (`octo/layer-imports`, `scripts/check-cycles.mjs`). Features meet only in `dock/TabView`, which passes one feature to another as a prop or slot. Shared code moves down: a piece two features need goes to `components/shared` (it may read `state`) or `primitives` (it may not); app state to `state/`.
- `monaco-editor` as a value only in `components/files/monaco.ts`; heavy optional code behind `import()`.
- Spacing, row heights, radii and colours come from the tokens in `styles.css`; the audit must stay at zero.
- New `Bridge` methods: change `@octo/agent-client` first, then implement them in `src/demo/bridge.ts`. Demo code is exported only from `@octo/ui/demo` and hosts load it with `import()`; the package root never mentions it.
- The window's top row (decision 67) is the dock groups' tab strips (`dock/TabStrip`, with `shell/ProjectBar`'s team chips and "⋯"); `shell/TitleBar` is only the window controls and a drag strip, and the status bar (decision 73) is `components/status` (the project fills it through `state/statusSlots`). Settings is a page, not a dialog. Features may not import each other: the shell fills `state/chatSlots` (approvals, queue) and `dock/TabView` mounts the Changes (`v7/`) and Memory (`memory/`) tabs. New views are lazy (`readyLazy` + `registerWarm`); the bundle budget in `scripts/check-bundle-size.mjs` is raised only by hand with a reason in its header (it has been, several times).
- A design change updates the spec's "As built" section in the same commit.

## Verifying UI work

Type-checking is not evidence that a screen works. Drive the real UI with Playwright against `?demo=1` (and the
live harness for behaviour that needs it), in dark and light, at 1440, 1100 and 390 wide; read the screenshots;
check the console is clean. Say what you checked and what you did not.
