# Handover — status on 2026-11-12 (after batch 5 and the sessions merge)

For whoever continues the work: what exists and how far it is verified, what is open, how work runs, what comes next.
The specs hold the detail; the system overview is [`../ARCHITECTURE.md`](../ARCHITECTURE.md), the monorepo map and
commands are [`../../AGENTS.md`](../../AGENTS.md). The owner's next step is [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md)
(checklist 4).

**Branch:** `claude/harness-ui-v6-completion-8ynrkq`. Last commit before this pass: `ec4bc05` (batch 4). On top of it,
uncommitted when this was written: batch 5 (error catalogue `internal/usererr`, file tree column, review fixes of the shell
and the conversation, slash menu, images, structured errors in the UI, the window report from the context popover, export
through a Blob), the Sessions tab (`docs/superpowers/specs/2026-11-12-project-sessions-design.md`), a fix to the context
window scaling (`scaleTo`), and the integration pass below. Not merged to `main`; PR status not recorded.

## 1. What exists

Marks, four of them: **owner** (verified live by the owner on Linux, runs 1 and 2 of 2026-11-11) · **here** (verified
here on scripted agents, the mock model, the fake router and a fake `gh`, Chromium on demo data) · **built** (built, not
verified) · **designed** (designed, not built). "Status not recorded" where no note says. Only Claude Code has run as a
working agent with a real CLI; Copilot and Grok were run by the owner logged out. Not verified anywhere: Windows, the
macOS window, the Tauri glue in a real webview, touch, screen readers, WebKit for the UI of batches 1 to 5, a real `gh` on
a fork, posting a review, images with any real agent.

### Router (`apps/router`)

- Proxy, autoroute ladder, price rule, `tier: auto` route endpoint, budget stop: **owner** (run 2). The packaged-app check
  is checklist 0.2. A low-tier price against a billed call: **built**.
- Spend restored after a restart, tier hints and their 400s, call records, embedded default configuration: **here**
  (`cargo test -p octo`, `e2e-router.sh`). Compaction for the client (`x-octo-trigger: compact`): **built**.
- 326 tests at the last count recorded (not re-run in this pass: no Rust change).

### Harness (`apps/harness`)

- Bridge, projects, per-project SQLite (**schema 14**; a newer database is refused), file API, events with `seq`, plugins,
  LSP relay: **owner** for what the app used in both runs; routes **here** (Go tests, `e2e-acp-orchestrator.sh`).
- ACP orchestrator with Claude Code, sub-agents, stop, logged-out error: **owner**. Copilot and Grok logged out: **owner**.
  Logged in, and Codex, Cursor, OpenCode, Antigravity, Devin, Droid, omp, pi: **built**.
- Built-in loop with tiers: **built** with a real key. Router client and budget gate: **owner**.
- Error catalogue (`internal/usererr`): every failure a person reads is `message`, `hint`, `command`, `action`, `details`
  (decision 94b; `apps/harness/docs/errors.md`): **here** (catalogue and sweep tests). Real agents' failures: **built**.
- Project sessions (create, resume with `session/load` or a recap, rename, archive, delete; agent sessions with stop and
  messages): **here**; with a real agent: **built** (`apps/harness/docs/sessions.md`).
- Memory M1, M2 (opt-in), M4 (sessions as exchanges), M5 (notes with descriptions), M6 (a task exists only when a turn did
  work; `project.sqlite.pre-m6` backup): M1 partly **owner**; M2 to M6 **here**.
- Slash commands and `/clear`, `remember`, images (upload, image blocks, refusal), side question on the project's agent,
  itemised context report, advisory login probe with recheck and force, usage per model: **here**.
- v7 (changes, approvals, queue, forms, secrets), modes, plans, rewind, steer, always-allow: **here**; a supervised run
  with a real agent: **built**.
- Pull-request review RV1 with forks and several repositories per folder, branches view: **here** with a fake `gh`; list
  and diff **owner** on a GitHub Enterprise host; posting: **built**. RV3 (AI pass): **designed**.
- Context window scaling: a part that has something never scales to 0 (`scaleTo`, test in
  `context_internal_test.go`): **here** (`-count=20 -race`).

### agent-client (`packages/agent-client`)

- HTTP and SSE client, reducer, message-port bridge, LSP sessions, sessions and structured-error types, optional `Bridge`
  members, token option: **here** (package tests).

### UI (`packages/ui`)

- Workspace, tabs as wide as their title, file view with the tree as a column, comments, LSP, palette, Usage per model,
  settings page (Providers as list and detail, Models in two scopes, Commands), connect screen, Memory (Sessions,
  Knowledge, Files, one search), Notes, side question, review workspace, modes, plans, rewind, queue, approvals, forms,
  slash menu, images, Sessions tab (list, main and agent detail, sidebar rows), structured error notices: **here**
  (599 UI unit tests, Playwright scripts on `?demo=1`). Against a live harness or real agents: **built**.
- Component library (decision 90): primitives and a gallery at `?gallery=1`; 49 `octo/no-native-controls` warnings left
  (per folder in `research/2026-11-12-ui-component-audit.md`): migration **built**, not finished.
- Entry bundle 157.9 kB gzip, budget 158.9, target 158 met (2026-11-13; cuts in the note in `scripts/check-bundle-size.mjs`). Still open there: the composer's slash and image hooks behind a first-use import, the `WorkspaceProvider` split.

### Desktop (`apps/desktop`)

- Sidecars (free ports, login-shell `PATH`, health waits, stop order), installer on Linux: **owner**. Crate tests: **here**.
- macOS title bar (inset 86, traffic lights, drag, zoom, full screen): **built**, Rust not compiled here. Tauri system
  folder dialog: **designed**. `scripts/install.sh` on macOS: **built**.

## 2. UI decisions 79 to 94 (one line each; the full text is in `specs/2026-11-10-project-harness-ui.md`)

79. A pane's width comes from the layout state only, never from what it shows.
80. A folder has no label anywhere.
81. No coloured frames: a card that waits for you has a neutral border; the glyph and the one filled button say so.
82. View tabs (a hairline under the row) and filters never look alike.
83. A tab is as wide as its title.
84. Fields in a row share one baseline (`FieldRow`); local review is a list, not a form.
85. Opening a file changes nothing but the editor's content (one `FileView` per group, the tree is a column).
86. Tokens per model, per project, in Usage; across projects in Settings; on the turn line.
87. The composer does not glow.
88. `/context` shows the whole window, itemised down to each tool and file.
89. Providers is a list and a detail with equal rows.
90. One component library: extend primitives, do not repeat them.
91. UI review round 1: a to k (backdrop, one "needs you" card, one activity row, four controls in the composer row, ...).
92. A keyboard shortcut is never a boxed letter inside a control.
93. Memory is Sessions, Knowledge and Files under one search, read in compact prose.
94. UI review round 2: a to g (the tree stays a column, errors in the person's words, pinned commands look like buttons, one
    Requests group in the palette, an agent's label never its id, narrow chat, ...).

## 3. In progress

Nothing. The tree holds finished work only; the integration pass left it staged and uncommitted for the coordinator.

## 4. Next, in order

1. **Review fixes not done.** Rounds 1 and 2 of `research/2026-11-12-ui-review-round-1.md` list 27 findings; batch 5 closed
   the ones named in its commit; which are still open: status not recorded. Walk the list against the screens (the tour,
   `node packages/ui/scripts/ui-tour.mjs`) and close the rest.
2. **Library migration batches left.** 49 native-control warnings (folders and counts in the component audit); then lower the
   lint rule to an error.
3. **Entry bundle.** Target met (157.9 kB). Further: slash and image hooks behind a first-use import, `WorkspaceProvider` split (Q5 of
   `plans/2026-11-10-frontend-code-quality.md`); keep lazy-only exports out of modules the entry imports.
4. **Parity B8 to B10** (`specs/2026-11-12-parity-backlog.md`).
5. **Review RV3**, the AI pass (`specs/2026-11-11-pr-review-design.md`).
6. The Tauri system folder dialog and the macOS title bar fix (uncompiled Rust; the owner runs `OCTO_DEBUG_CHROME=1`).
7. Whatever checklist 4 sends back.

## 5. What is open

- **The owner's run:** [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md) (checklist 4) is written and not run.
- **Default access.** `HARNESS_DEFAULT_ACCESS` is still `full` (`apps/harness/cmd/harness/serve.go`), though the UI shows
  approval cards. Flipping to `supervised` is an owner decision.
- **Owner decisions.** S3: a or b (default a). Bots questions 1 and 2. Grok in automated tests: an API key in CI, the
  subscription on a developer machine (default).
- **Gaps in the specs.** A router that dies after start is not watched. An ACP `session/load` may count a continued
  agent's counters twice. A note edited mid-turn is not announced to an ACP agent.
- **Security.** `bash` is not sandboxed and can read the bridge token file as the harness's user; a supervised project
  stops the command at an approval card.
- **Known quirks.** `Settings → Commands` still has a "Settings for" project row. The harness test suites passed with
  `-race` here; two earlier load-dependent flakes (`TestContextEndpoint`, a digest wait in `memory_life_test.go`) were
  fixed in this pass and need a full `go test -race ./...` on a quiet machine to confirm.
- **Doc debt.** Spec and code differences: [`../ARCHITECTURE.md`](../ARCHITECTURE.md#known-contradictions).

## 6. Working rules

**Roles.** One orchestrator session decides, writes contracts (specs with numbered acceptance criteria), briefs, verifies
independently, commits and reports. Executors do bounded pieces: Go and client code, UI where visual judgment matters,
documentation, read-only research and review.

**Models.** Sonnet writes code, tests and UI. Haiku does research, documentation and small mechanical edits, each with an
exact contract. Opus only when the owner asks. The orchestrator re-runs every gate itself before committing.

**Worktrees.** An executor first runs `git reset --hard <work branch>` in its worktree and checks `git log --oneline -1`.
It never uses `git stash` (the stack is shared); it sets work aside with a WIP commit, and commits only when briefed.

**Third-party CLIs.** No third-party agent CLI runs with this sandbox's environment. Run one only with an empty
environment (`env -i`), and only on the owner's machine for anything that needs a login.

**The loop for each feature.** Look (measure, do not guess) → contract, committed → executors on disjoint paths
(`apps/harness`, `packages/agent-client`, `packages/ui`, `apps/desktop`, docs) → verify independently → commit per
finished piece → read-only review → tell the owner what is still wrong or unproven.

**Rules that are easy to break.**

- Executors never run git write commands unless the brief names one; the orchestrator commits after review.
- Every harness started by a test or script sets `HARNESS_NO_BUILTIN_PLUGINS=1`, or the router may pick
  `acp:claude-code` and the harness fetches an adapter with `npx`.
- No vendor CLI and no provider key here: test with `examples/mockllm`, `examples/fakeacp`, `internal/fakerouter`; say
  "not verified" for anything that needs the real thing.
- A change to the shared `Bridge`: client first (`types.ts`, `client.ts`, the message-bridge allow-list, tests), then the
  UI's demo bridge if the member is not optional.
- The harness, the router and the shell share no file. Do not import Tauri in `packages/ui`.
- A behaviour change updates the spec's "As built" section and the feature's doc page in the same commit.
- Commit when a finished piece's gates pass. The container is ephemeral: anything uncommitted or unpushed is lost,
  including the scratchpad. UI executors wipe their screenshot folders; copy what to keep.
- Late owner feedback goes to a running executor as a numbered addendum.

**Gates per area** (from the repo root unless a `cd` is shown):

| Area | Commands |
| --- | --- |
| Router | `cargo fmt --check` · `cargo clippy -p octo --all-targets -- -D warnings` · `cargo test -p octo` (proxy variables removed) |
| Harness | `cd apps/harness && gofmt -l . && go vet ./... && go test -race ./...` (CI also runs `go build`) |
| Harness end to end | `bash apps/harness/scripts/e2e-acp-orchestrator.sh` · `cargo build -p octo && bash apps/harness/scripts/e2e-router.sh` · `bash apps/harness/scripts/e2e-v7.sh` |
| agent-client | `pnpm --filter @octo/agent-client lint` · `... test` · `... format:check` |
| ui | `pnpm --filter @octo/ui lint` · `... test` · `... format:check`; with a dev server up, `pnpm --filter @octo/ui audit:spacing` prints `total=0`; `packages/ui/scripts/layout-shift.mjs` for layout shift |
| desktop | `pnpm --filter @octo/desktop lint` · `... test` · `... build`, then `pnpm check:bundle` |
| whole frontend | `pnpm lint` (includes `scripts/check-cycles.mjs`) · `pnpm format:check` · `pnpm test:scripts` (`scripts/eslint/`) |
| Shell | `cd apps/desktop/src-tauri && cargo test -p octo-sidecar`; `cargo check` needs `bash scripts/build-sidecar.sh --no-router` and WebKitGTK |
| Dev stack and installer | `pnpm test:dev-sh` · `pnpm test:dev-sh -- --router --mock` · `bash scripts/install.sh --no-install` |
| Live (owner) | `bash apps/harness/scripts/test-subscriptions.sh [agent ...]` (or `all`); `harness doctor` for the report |

## 7. How to run

```bash
git submodule update --init --recursive && pnpm install
pnpm dev:all                    # harness (no key) + UI at :1420; `-- --mock` adds the mock model; `-- --router` adds the router
pnpm --filter @octo/desktop dev # UI only; ?demo=1 for demo data (also ?providers=none, ?review=...)
pnpm install:app                # build both sidecars and the Tauri app, install it (owner's machine)
cd apps/harness && go run ./cmd/harness doctor     # what the harness sees on this machine
```

Mock triggers: `quick`, `[write]`, `[acp]` in a message; `[silent]`, `[refuse]`, `[max-tokens]`, `[crash]` for the fake
ACP agent; memory markers in `apps/harness/docs/memory.md`.

## 8. Where the older handovers went

Older handovers: `git log -- docs/superpowers/HANDOVER.md`. Design direction: the UI spec's "Principles" section.

## Working rule (owner, 2026-11-12) — executors check what they changed; the full gates run once, at merge

Many executors running every gate at once made the machine crawl. From now on:
- **An executor runs only what its change can break.**
  - UI change: `pnpm --filter @octo/ui exec tsc --noEmit`, `eslint` and `prettier --check` on the files it touched,
    the `*.test.ts` files next to what it changed (`node --test` on those files, or the package test once at the
    end), and the browser scripts against **the dev server** (`vite` on its own port) for the screens it changed.
    No `pnpm --filter @octo/desktop build`, no bundle check, no Tauri or sidecar build.
  - agent-client change: its `tsc`, its tests, and `tsc` of `packages/ui`.
  - Harness change: `gofmt`, `go vet` and `go test -race` for the packages it touched and the ones that import them
    (`go list -deps`/reverse deps), plus the one e2e script that covers the feature. Not the whole tree, not every
    e2e script.
  - Never a Rust or Tauri build unless the change is in Rust.
- **The orchestrator runs the full set once per merge**: lint, format, cycles, all package tests, the production
  build, the bundle budget, the whole Go tree with `-race`, every e2e script, sidecar tests when Rust changed, and
  the browser scripts on the merged tree.
- One heavy command at a time per executor; no parallel test runs.
