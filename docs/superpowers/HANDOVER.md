# Handover — status on 2026-11-12

For whoever continues the work: what exists and how far it is verified, what is open, how work runs, what comes next.
The specs hold the detail; the system overview is [`../ARCHITECTURE.md`](../ARCHITECTURE.md), the monorepo map and
commands are [`../../AGENTS.md`](../../AGENTS.md).

**Branch:** `claude/harness-ui-v6-completion-8ynrkq`. Code at `7d9fe19` (UI decision 78); this file is the commit on top.
Not merged to `main`; PR status not recorded. The live checklist asks for `4a22c5f` or later; its items still apply.

## 1. What exists

Marks: **verified live by the owner** (the owner's Linux runs 1 and 2 of 2026-11-11) · **verified here on scripted
agents and demo data** (tests, mock model, scripted ACP agent, fake router, fake `gh`, real router with a mock upstream,
Playwright on `?demo=1`) · **built, not verified** · **designed, not built**. No mark recorded: "status not recorded".
Only Claude Code has run as a working agent with a real CLI; Copilot and Grok were run by the owner logged out. Not
verified anywhere: Windows, the macOS window, the Tauri glue in a real webview, touch, screen readers, WebKit for the newer UI.

### Router (`apps/router`)

- Proxy for OpenAI-style, Anthropic Messages and OpenRouter; forwards the caller's credential. **Verified live** (run 2:
  router cost matched the OpenRouter bill).
- Autoroute ladder and price rule (`x-octo-decided-tier`, `x-octo-price-swap`). **Verified live** (run 2; the packaged-app
  check is checklist 0.2). A low-tier price against a billed call: **not verified**.
- `POST /autoroute/v1/route` for `tier: auto`. **Verified live** (run 1: classifier 49–93 ms; easy went to Claude Code,
  hard to the deep tier).
- Budget stop: **verified live** (run 2). Spend restored after a restart, `spent_after_usd`, tier hints and their 400s,
  SQLite call records, embedded default configuration: **verified here** (tests, `e2e-router.sh`).
- Compaction for the client (`x-octo-trigger: compact`): **built, not verified**; the mock upstream cannot produce it.
- 326 tests at the last run of the gates here.

### Harness (`apps/harness`)

- Bridge over HTTP and SSE, projects, per-project SQLite, file API, events with `seq`: **verified live** (the app used it
  in both runs); routes **verified here** (Go tests, `e2e-acp-orchestrator.sh`).
- ACP orchestrator with Claude Code (one session across requests, sub-agents, stop, logged-out error) and `spawn_agent`
  with a fixed tier or agent: **verified live** (runs 1 and 2).
- Copilot and Grok logged out ("not logged in", with the hint): **verified live** (run 2). Logged in: **built, not
  verified**. Run 1's silent Copilot turn: **not reproduced**.
- Codex, cursor, opencode, antigravity, devin, droid, omp and pi: manifests from vendor docs; **built, not verified**,
  no run recorded.
- Built-in loop (Messages API) with tiers: **built, not verified** with a real key (the owner's billed calls went through
  the router; the tests use the mock model).
- Router client (hints, one spend number, budget gate, `tier: auto` fallbacks): **verified live** (runs 1 and 2). Equal
  spend after the last call: checklist 1.2.
- Usage, cost and limits (a flat-rate agent's cost is an estimate, not spend): **verified live** for run 1's defects; the
  fixes wait for checklist 1.1.
- Memory M1 (task records, facts, memory files, FTS5 search, digest): **verified live** for some word forms and the task
  rules (run 2); the rest **verified here**.
- Memory M2 (window context and receipts, opt-in): **verified here** (300 scripted exchanges). Run 2 measured the first
  version 15% dearer than `full` on a caching provider, so it stays opt-in. The stepped window is **built, not verified**.
- Live activity (thinking, plan, tool rows, "quiet" notice), settings API over `harness.env`, providers
  (`GET /v1/providers`, `422`, `409`, live key), v7 API (changes, approvals, queue, forms, secrets), inline completion
  endpoint: **verified here**. Real agents' chunks (checklist 2.3), a supervised run (2.9), completion latency (2.11).
- Pull-request review RV1 (list, worktrees, comments, one atomic submit): **verified here** with a fake `gh`; list and diff
  **verified live** with a real `gh` on a GitHub Enterprise host (owner, run 2); posting a review is not verified. The AI pass (RV3): **designed, not built**.
- Bridge API token, `harness doctor`, `GET /v1/diagnostics`, ACP wire trace, schema versions (now 6; a newer database is
  refused), child environment allow-list, files, plugins, LSP relay: **verified here** (the owner's report is checklist 1.3
  and 1.4).

### agent-client (`packages/agent-client`)

- HTTP and SSE client, reducer, message-port bridge, LSP sessions, optional `Bridge` members, token option: **verified
  here** by the package tests.

### UI (`packages/ui`)

- Workspace tabs, title bar as the header (decision 54), conversation, composer, delegation cards, transcripts, Usage,
  palette, files with Monaco, comments, LSP client: **verified here** on demo data.
- One model control in the composer, title bar and project dialog; sub-agents in the title bar (decision 34): **verified
  here** (usability pass, 2026-11-12; 383 unit tests).
- Settings page, providers pane, connect screen (decisions 53, 58, 59): **verified here** on demo data, not against a live
  `/v1/providers`. Settings has one scope only.
- Memory view, review workspace RV2 (pick, diff, comments, submit), inline completion UI: **verified here** on demo data;
  not against a real harness, real GitHub or a real model.
- Approval cards, forms, queue and the Changes tab (v7 UI, mounted in `cedc10c`): verification status not recorded.
- Layer rules, the cycle check and the spacing audit: **verified here** (`pnpm lint`, `pnpm audit:spacing`).

### Desktop (`apps/desktop`)

- Tauri shell with the `octo-sidecar` crate (free ports, login-shell `PATH`, health waits, router before harness, stop
  order, stdin-close exit): **verified live** (run 2: sidecars exit with the app in under a second). The crate's tests:
  **verified here** with fake binaries.
- `scripts/install.sh`: one pass on Linux, **verified live** (run 2). macOS: **built, not verified**.
- macOS title bar (overlay, traffic lights, drag, double-click zoom, full screen): **built, not verified**; the Rust side
  is not compiled here.
- Tauri system folder dialog: **designed, not built**. "Browse…" is absent until the dialog plugin is added (checklist 2.5).
- Host screens; `scripts/dev.sh` (`pnpm dev:all`) and `scripts/test-dev-sh.sh`, plain and `--router --mock`: **verified here**.

### Designed, not built

Parity backlog B1–B10 (`specs/2026-11-12-parity-backlog.md`): approved, no commits. Bots (`specs/2026-11-11-bots-design.md`):
draft. Savings view I3. Subscription routing through the router S3b: not recommended; an owner decision.

## 2. Open UI decisions not built yet

Decisions 64–78 in [`specs/2026-11-10-project-harness-ui.md`](specs/2026-11-10-project-harness-ui.md); designed, with no
"As built" note. Brackets say what exists.

64. Calm, evenly distributed screens: one job per bar, one filled button per surface, whitespace instead of borders.
65. Context indicator with a breakdown popover, "Compact now" and "≈" estimates. [A ring exists; no popover.]
66. Memory as one header row and one list-and-detail frame, not tabs. [Four tabs in one control today.]
67. The frame: tabs in the top row, three levels, width floors, the conversation tab as the project breadcrumb.
68. Project commands in the top row: two pinned, a "Run" menu, output in a tab.
69. Nothing flickers or jerks, with frame tests. [`pnpm ui:flicker` is not in `package.json`.]
70. Composer highlights `@file`, `/command` and `#task`; a long paste becomes an attachment.
71. A folder has no label field; "Browse…" comes first. [The label field is still there, decision 51.]
72. Provider marks, a preferred model and roles; connected means selectable; `PUT /v1/providers/{id}/prefs`.
73. A status bar: branch and changes, running commands, agents working, spend, connection.
74. Settings in two scopes, Defaults and the project. [One scope today.]
75. Remove every element that does not help the user do or decide something (Home's recap and statistics).
76. Motion only while work is in progress; tests on `document.getAnimations()`.
77. Skeletons for anything slower than 150 ms; the cached pull-request list with `stale: true`; the picker layout.
78. Review as a workspace: all open PRs, whole screen, threads inline, check out, run. [RV2 has diff, comments, submit.]

## 3. In progress

- Nothing else is in progress in this worktree. Decisions 64–78 exist as documents only; item 1 builds them.

## 4. Next, in order

1. agent model picker with provider marks, preferred model and roles; folder Browse and no label field; shared empty
   states; clickable context indicator
2. harness: model discovery, connected-means-selectable, provider prefs, system folder dialog
3. harness parity B1–B7
4. harness review additions: all PRs, threads, checkout, project commands
5. merge the macOS traffic-light fix and the Tauri folder dialog (uncompiled Rust, owner must run `OCTO_DEBUG_CHROME=1`)
6. the frame: tabs in the top row, three levels, width floors, status bar
7. no-flicker and motion tests
8. Memory, Changes and Review on one list+detail frame
9. settings scopes
10. project commands UI
11. composer highlighting
12. Home clean-up and skeletons
13. notifications, quick open, skills

Notes: item 1 has the UI part of decision 72, item 2 its harness part. Items 3 and 13 are the parity backlog (B1–B7,
B8–B10). `OCTO_DEBUG_CHROME` is not in this branch's code yet; item 5 adds it.

## 5. What is open

- **The owner's run.** [`LIVE-CHECKLIST.md`](LIVE-CHECKLIST.md) (checklist 3) is written and not run. Send back the step
  number, the `harness doctor` output and the trace file.
- **Default access.** `HARNESS_DEFAULT_ACCESS` is still `full` (`apps/harness/cmd/harness/serve.go`), though the UI shows
  approval cards. The flip to `supervised` is a decision; the parity backlog wants "allow always" (B4) first.
- **Owner decisions.** S3: a or b (default a). Bots questions 1–2. Grok in automated tests: an API key in CI, the
  subscription on a developer machine (default).
- **Gaps in the specs.** A router that dies after start is not watched. An ACP `session/load` may count a continued
  agent's counters twice. No "History compacted" marker (gap G4 of the comparison). A note edited mid-turn is not
  announced to an ACP agent.
- **Security.** `bash` is not sandboxed and can read the bridge token file as the harness's user; a supervised project
  stops the command at an approval card (see [`specs/2026-11-11-pr-review-design.md`](specs/2026-11-11-pr-review-design.md)).
- **Code debt.** `packages/ui` Q5 ([`plans/2026-11-10-frontend-code-quality.md`](plans/2026-11-10-frontend-code-quality.md)):
  `WorkspaceProvider.tsx` (543 lines at v6.3) and `lib/streak.ts` (354) not split; not measured again.
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
