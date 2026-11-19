# Handover — status on 2026-11-19 (after the polish, performance, security and robustness pass)

**What the last pass did (2026-11-18 and 2026-11-19, `git log --oneline c29ae1e..HEAD`).** A review-driven pass over the
whole product, built and checked in this environment only: the dock tool tabs share one anatomy, the sidebar and the file-tree
column resize, folders compact (decision 98), the composer's chip is the real branch and picks another (decision 100), "Add to
chat" from the editor and the tree, "Ask first" is the one name of the permission level, first opens of every lazy surface are
instant, long conversations scroll and drag cheaper, changing project no longer blinks (decision 99), the macOS traffic lights
are aligned from the owner's screenshots, remote Markdown images wait for the person, the webview has a CSP, the file API
refuses writes into `.git`, `git` runs hardened, a remote phone may only allow or deny one request at a time, the data
directory has private modes and a lock, a damaged or missing project is listed as unavailable instead of stopping the start,
terminals and runs left by a killed harness are stopped at the next start, `harness --version` exists, and CI gained an
end-to-end job and the web client's tests. The detail, with what was measured and what was not, is in the "As built" sections
of the UI spec from "work-surface polish (2026-11-18)" to "last performance gaps (2026-11-19)", and in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md#status). **All of it was verified here (the mock model, scripted agents, Chromium on
Linux) and nothing on macOS, in WebKit or Safari, in the Tauri runtime, or with a real agent CLI or a real Ollama.** The
documentation was brought in line with the code on 2026-11-19, and the first end-user guide is
[`../user-guide/README.md`](../user-guide/README.md).

**Last counts, 2026-11-19 (this is the one place counts are kept; run the suites for today's):** `@octo/ui` 1016 tests,
`@octo/agent-client` 189, `@octo/web` 17, `@octo/desktop` 44, all passing; Go: 58 packages, all passing (`go test ./...`,
without `-race`); `cargo test -p octo` 351 tests in 31 test binaries, all passing (built with `CARGO_PROFILE_DEV_DEBUG=0`, the disk was nearly full). Entry bundle 160.39 kB gzip against a budget of 161.00
(`node scripts/check-bundle-size.mjs`).

For whoever continues the work: what exists and how far it is verified, what is open, how work runs, what comes next.
The specs hold the detail; the system overview is [`../ARCHITECTURE.md`](../ARCHITECTURE.md), the monorepo map and
commands are [`../../AGENTS.md`](../../AGENTS.md). The owner's next step is [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md)
(checklist 4, with the checks of the 2026-11-19 pass added as section F).

**Branch:** `claude/clever-pascal-s2lr5b` is the integration branch of the pass (the work branches are merged into it);
nothing is pushed or merged to `main` from here. PR status not recorded.

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
- Tests: `cargo test -p octo` (count in the line at the top). No router behaviour changed in this pass except readable upstream errors (`apps/router/docs/README.md`).

### Harness (`apps/harness`)

- Bridge, projects, per-project SQLite (**schema 15**; a newer database is refused untouched), file API, events with `seq`, plugins,
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
  (UI unit tests, Playwright scripts on `?demo=1`). Against a live harness or real agents: **built**.
- Component library (decision 90): primitives and a gallery at `?gallery=1`; 49 `octo/no-native-controls` warnings left
  (per folder in `research/2026-11-12-ui-component-audit.md`): migration **built**, not finished.
- Entry bundle 160.39 kB gzip, budget 161.00 (2026-11-19). The budget was raised by hand as features landed (history in the header of `scripts/check-bundle-size.mjs`); lazy-only exports are kept out of modules the entry imports. Still open there: the `WorkspaceProvider` split.
- The 2026-11-18/19 pass (list at the top): **here**, Chromium on Linux only, on demo data and, for the file tree, the branch chip, the Markdown images and the CSP, against a real `harness serve` on the mock model. Not verified: macOS, WebKit, the Tauri window, a phone by eye, a real agent.

### Desktop (`apps/desktop`)

- Sidecars (free ports, login-shell `PATH`, health waits, stop order), installer on Linux: **owner**. Crate tests: **here**.
- macOS title bar (traffic lights at `{24, 22}`, inset 86, drag, zoom, full screen): **built**; the geometry is asserted on the
  dev server (`apps/desktop/scripts/traffic-lights.mjs`), the real window was not seen after the 2026-11-19 change; Rust not
  compiled here. The CSP in `tauri.conf.json`: **built**, not run in the Tauri runtime. The folder dialog behind "Browse…"
  is the harness's (`POST /v1/fs/pick-folder`: `osascript`, PowerShell, `zenity` or `kdialog`): **built**, not run on
  macOS or Windows here. `scripts/install.sh` on macOS: **built**.

## 2. UI decisions 79 to 100 (one line each; the full text is in `specs/2026-11-10-project-harness-ui.md`)

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
95. Every popup list takes the keys at once (`popupNav`); a session can be deleted (what goes, what stays).
96. Parallel sessions: the sidebar is a tree of projects and sessions; every main session is open and runs at once.
97. Forms are built from a JSON schema (one renderer).
98. Compact folders in the file tree (a chain of single-child directories is one row; `chain` on `GET /files`).
99. Changing project never blinks (a project is shown only when it can be painted complete in one frame).
100. The composer's chip is the real branch and picks another; a refused switch offers a worktree. (Written as a second
    "98"; renumbered 2026-11-19.)

## 3. In progress

Nothing. The tree holds finished work only. The branches of the pass are merged into the integration branch; the
documentation commits of 2026-11-19 sit on top of it.

## 4. Next, in order

The first block needs the owner; the second needs a machine this environment does not have; the third is work that can be
done here.

1. **Licence and third-party notices.** There is no `LICENSE` file and no notices file. The owner must choose a licence; then
   add `LICENSE`, a third-party notices file (the dependency licences of the pnpm, Cargo and Go trees, and the bundled
   Monaco, xterm and fonts), and the licence field in `package.json`, `Cargo.toml` and the installer metadata.
2. **Release engineering.** Signing and notarisation on macOS, a signing story on Windows (not supported by `install.sh`
   today), the updater, a release workflow that builds the bundles. Until then the app is built from source
   (`pnpm install:app`).
3. **A Tauri bundle build on a machine with the system libraries.** Nothing here has compiled the shell (no WebKitGTK, no
   macOS): CI runs `cargo check` and the sidecar crate's tests; no job builds the bundle.
4. **Run [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md)** (checklist 4, sections A to F): the real-Mac check of the traffic lights
   (`OCTO_DEBUG_CHROME=1`) and of the CSP in the Tauri window; a run in real Safari / WebKit; real agents (Copilot, Grok,
   Antigravity logged in; images, `session/load`, approvals in a supervised project); a real Ollama; a real `gh` on a fork;
   the macOS process clean-up (compiled for macOS, never run there).
5. **Owner decision: the router's `store_payloads` default.** The router stores request and response text in its history
   database unless `[history] store_payloads = false` (`apps/router/config/history.toml`, `default_history_store_payloads`
   in `src/config.rs`); the desktop shell's generated `history.toml` does not set it, so the app's router stores them
   (locally, 30 days of call records). Decide the default, and whether the app should say so in Settings.
6. **Router: a truncated upstream SSE stream ends as 200 with no error event** (`apps/router/docs/README.md`; the stream
   relay has no hook for it).
7. **Scroll at 4x CPU.** Frames over 50 ms in the Stress conversation went from 49-51 to 43-45 of 60; the target of 15 is
   not met (UI spec, "last performance gaps"). A variant that never unmounts turns cut CPU by only 17 %; the next lever is
   less work per mounted turn.
8. **No file-system watcher.** A file created outside the harness (a terminal, another editor) does not appear in the tree
   until its folder is listed again; there is no `file.changed` for it.
9. **No rename, delete or new file or folder in the tree**, and no harness route for them.
10. **Scripts and CI.** `e2e-parity.sh`, `e2e-remote.sh` and `e2e-sessions.sh` still hardcode their ports (8840-8843, 18842)
    and are not in CI; `go test -race` is not in CI (too slow on a loaded runner; its duration was not measured on a quiet
    machine); `@octo/web` and `@octo/agent-client` are still version 0.1.0 while the rest is 0.2.0.
11. **Review findings and library migration.** Rounds 1 and 2 of `research/2026-11-12-ui-review-round-1.md` (27 findings): which
    are still open is not recorded; walk the list against the tour (`node packages/ui/scripts/ui-tour.mjs`). The
    `octo/no-native-controls` warnings (49 at the last count recorded, per folder in the component audit) are not finished.
12. **Features designed or half built:** parity B8-B10 (`specs/2026-11-12-parity-backlog.md`); review RV3, the AI pass;
    parallel sessions phases 4-5 (coordination tools, memory modes) and applying a worktree's work back to the main
    checkout (no route or button was found in the code; the user does it with git); Ollama alone
    cannot leave the connect screen (needs a tool-capable flag per Ollama model, UI spec owner decision F5).
13. Whatever checklist 4 sends back.

## 5. What is open

- **The owner's run:** [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md) (checklist 4) is written and not run.
- **Default access.** New projects are `supervised` ("Ask first"): `HARNESS_DEFAULT_ACCESS` defaults to `supervised`
  (`v7Env` in `apps/harness/cmd/harness/serve.go`). Earlier versions of this file and of `docs/ARCHITECTURE.md` said `full`;
  that was wrong. Projects made before v7 are `full` and keep it.
- **Owner decisions.** S3: a or b (default a). Bots questions 1 and 2. Grok in automated tests: an API key in CI, the
  subscription on a developer machine (default). The router's `store_payloads` default (above). The licence (above).
- **Gaps in the specs.** A router that dies after start is not watched. An ACP `session/load` may count a continued
  agent's counters twice. A note edited mid-turn is not announced to an ACP agent.
- **Security.** `bash` is not sandboxed and can read the bridge token file as the harness's user; a supervised project
  stops the command at an approval card. A paired phone cannot grant "always" or "for this request"; it can allow or deny one
  request. The webview CSP allows `https:` images (only after "Load image") and loopback `http`/`ws` on any port.
- **Known quirks.** `Settings → Commands` still has a "Settings for" project row. Comments in the code still call the
  branch picker "decision 98" (it is 100).
- **Doc debt.** Spec and code differences: [`../ARCHITECTURE.md`](../ARCHITECTURE.md#known-contradictions).

### Later (owner, 2026-11-14: "remember this, we will do it later") — Octo on iOS

Not started, no spec. The owner asked whether a framework can run Octo on iOS. Answer given: Tauri 2 (the desktop
shell's framework) builds for iOS, but only the UI can run there — iOS does not let an app start child processes, so
the harness and router sidecars, the subscription agent CLIs, `bash`, language servers and git worktrees stay on a
computer. Options, in the order recommended: (1) a remote client — the UI on the phone connects to a harness on the
owner's Mac or a server (connection screen, address and token, TLS or a private network), built with Tauri 2 mobile;
(2) a web app added to the home screen, served by the harness (`apps/web` is the stub for it) — the quickest way to
see it on a phone; (3) the Go harness embedded as a library (gomobile) with the built-in loop only — large, and a
reduced product. Before any of them: the UI has never been run in WebKit (every check was in Chromium); known risks
are the CSS masks of the vendor marks, the scroll correction of lazily mounted turns, and the composer's height
fallback. Parallel sessions and the client-side session cache fit the remote client (start on the Mac, answer
approvals and read on the phone). Building needs a Mac with Xcode and an Apple developer account; it cannot be built
or checked in the Linux build environment. First step when taken up: a short spec of the remote client.

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
| Harness | `cd apps/harness && gofmt -l . && go vet ./... && go test ./...` (what CI runs, with `go build`); `go test -race -timeout 30m ./...` before touching concurrency code, not in CI |
| Harness end to end | `bash apps/harness/scripts/e2e-acp-orchestrator.sh` · `cargo build -p octo && bash apps/harness/scripts/e2e-router.sh` · `bash apps/harness/scripts/e2e-v7.sh` |
| agent-client | `pnpm --filter @octo/agent-client lint` · `... test` · `... format:check` |
| ui | `pnpm --filter @octo/ui lint` · `... test` · `... format:check`; with a dev server up, `pnpm --filter @octo/ui audit:spacing` prints `total=0`; `packages/ui/scripts/layout-shift.mjs` for layout shift, `project-switch.mjs` for changing project |
| web | `pnpm --filter @octo/web test` · `... build` |
| desktop | `pnpm --filter @octo/desktop lint` · `... test` · `... build`, then `pnpm check:bundle` |
| whole frontend | `pnpm lint` (includes `scripts/check-cycles.mjs`) · `pnpm format:check` · `pnpm test:scripts` (`scripts/eslint/`) |
| Shell | `cd apps/desktop/src-tauri && cargo test -p octo-sidecar`; `cargo check` needs `bash scripts/build-sidecar.sh --no-router` and WebKitGTK |
| Dev stack and installer | `pnpm test:dev-sh` · `pnpm test:dev-sh -- --router --mock` (both in CI) · `bash scripts/install.sh --no-install` |
| Live (owner) | `bash apps/harness/scripts/test-subscriptions.sh [agent ...]` (or `all`); `harness doctor` for the report |

## 7. How to run

```bash
git submodule update --init --recursive && pnpm install
pnpm dev:all -- --mock          # harness + the mock model + UI at :1420 (no key; OCTO_DEV_PORT_BASE=N moves every port); `-- --router` adds the router
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
