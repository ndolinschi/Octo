# Handover — status on 2026-11-11

For whoever continues the work in a new session. It says what exists, what was verified and by whom, what is open,
how the work is run, and what to do next, in order. It links to the specs instead of repeating them. The system
overview (parts, flows, data locations, every environment variable, status table, specs index) is
[`../ARCHITECTURE.md`](../ARCHITECTURE.md); the monorepo map and commands are [`../../AGENTS.md`](../../AGENTS.md).

**Branch:** `claude/harness-ui-v6-completion-8ynrkq`, to be merged to `main` by pull request (none opened yet);
follow-up work starts from fresh `main`. At the time of writing other executors were editing `packages/ui/src`,
`apps/desktop/src`, `apps/harness` and the specs in the same working tree, uncommitted (memory M2 among them), so the
tree may not build until they finish.

## 1. What exists

| Part | State |
| --- | --- |
| Harness (`apps/harness`) | Projects, orchestrator + nested sub-agents, per-project SQLite, file API, plugin registry (language servers, ACP agents, tool servers), ACP orchestrator with an MCP server, router integration (hints, ledger, budget, compaction, `tier: auto`), usage / cost / limits, v7 (changes and diffs, approvals, queue, forms and secrets), memory M1, settings API over `harness.env`, `harness doctor` + `GET /v1/diagnostics` + ACP wire trace, schema version stamps, child-environment allow-list, eleven agent manifests (embedded) |
| Router (`apps/router`) | Proxy + autoroute ladder; never-pay-more-for-less price rule; route endpoint for delegation; hint and result headers; budget keys; call records and spend persisted in SQLite; `OCTO_EXIT_ON_STDIN_CLOSE` |
| agent-client | HTTP + SSE client, reducer, message-port bridge, LSP sessions; optional `Bridge` members for settings, diagnostics, v7, memory |
| UI (`packages/ui`) | Workspace tabs, orchestrator header and team line, chat, delegation cards, agent transcripts, file view with Monaco, code comments, LSP client, usage tab, command palette, demo bridge. Layer rule as lint errors, no cycles. **Does not yet use** the v7, settings, diagnostics or memory `Bridge` methods |
| Desktop (`apps/desktop`) | Vite host (`BridgeShell`, `HostedApp`, host status and notice screens); Tauri shell with the `octo-sidecar` crate: free ports, login-shell `PATH`, health waits, router first then harness, stop order, stdin-close exit, pid files, `bridge_*` commands; `scripts/dev.sh`, `build-sidecar.sh`, `install.sh` |
| Specs | `specs/` and `research/` are listed with their status in `../ARCHITECTURE.md#specs-index`. Newest: UI decisions 45-48 (aurora while working, small effects, borrowed behaviours, one model name) in the UI spec |

## 2. What was verified, and by whom

Three kinds of evidence exist. Do not mix them in a report.

1. **The orchestrator (the build environment).** No provider key, no vendor agent CLI, no WebKitGTK, no macOS. It ran
   the gates of section 4 and the scripted end-to-end checks against the mock model, the scripted ACP agent
   (`internal/fakeacp`), the fake router and a real router with a mock upstream: `e2e-acp-orchestrator.sh`,
   `e2e-router.sh`, `e2e-v7.sh`, `scripts/test-dev-sh.sh` (plain and `--router --mock`), the `octo-sidecar` tests, frontend
   lint / tests / build / bundle size, and screenshots of the UI on demo data. Counts (tests, bytes) are in each spec's
   "As built" note, taken on the day they were written.
2. **Executors (sub-agents).** Their own acceptance scripts (UI workspace and comments suites, spacing audit, contrast
   tables) are theirs; the orchestrator re-ran the gates but not those scripts. The spec notes say which is which.
3. **The owner's live Linux run (2026-11-11).** Real Claude Code over ACP as orchestrator, a real router, the real
   classifier (answered in 49-93 ms; an easy task went to Claude Code on the subscription, a hard one to the deep tier).
   It found: a flat-rate agent's cost counted as spend (fixed: estimates are not spend), two budget numbers (fixed:
   one), sidecars surviving a killed app (fixed: stdin-close exit), install and first-run defects (P8b), and a silent
   Copilot turn that was **not reproduced** (the wire trace is there to catch it). Copilot and Grok were started by the
   owner; the other seven agent manifests have never been run.

**Not verified anywhere:** a billed upstream call and the low-tier price against it; real models using memory search; the
Tauri glue compiled in this environment (CI compiles it); `scripts/install.sh` on macOS and the installed app; the Tauri
window and themes in a real webview; touch, screen reader and forced colours in the UI; each real agent CLI's handling of
MCP servers, `session/load`, tool titles and permission requests; Windows.

## 3. What is open

- **Owner decisions:** S3 a or b (default a: the route endpoint; b, proxying vendors' private endpoints, is not built and
  not recommended); Grok in automated tests (no documented headless login: test with an API key in CI, the subscription on
  a developer machine); bots questions 1-2 (`specs/2026-11-11-bots-design.md`). The router ladder decision is closed by
  the price rule (`specs/2026-11-11-router-harness-integration.md`, "Decisions after the owner's live run").
- **Defaults waiting on the UI:** `HARNESS_DEFAULT_ACCESS` is `full` until approval cards exist, then it flips to
  `supervised`; ACP permission requests are auto-approved in a `full` project.
- **Gaps recorded in specs:** a router that dies after a successful start is not watched; an ACP `session/load` into a new
  process may count a continued agent's counters twice once; linking an MCP `spawn_agent` call to the agent's tool-call row is
  a heuristic; thinking and plan updates of ACP agents are dropped; the compaction summary is not shown in the UI (a
  "History compacted" marker is to do); settings and the harness writing `harness.env` at the same moment were not tested.
- **Doc debt:** differences between specs and code are listed in `../ARCHITECTURE.md#known-contradictions`. The owner
  checklist `docs/superpowers/LIVE-CHECKLIST.md` (R1 item 7) is not written.
- **Code debt:** `packages/ui` Q5 (split `WorkspaceProvider.tsx`, `lib/streak.ts`, providers; `plans/2026-11-10-frontend-code-quality.md`);
  the harness items of `research/2026-11-11-synara-gap.md`; the open majors of `research/2026-11-11-ui-review-v6.2.md`.

## 4. Working rules

**Roles.** One orchestrator session decides, writes contracts (specs with numbered acceptance criteria), briefs, verifies
independently, commits, and reports to the owner. Executors do bounded pieces of work in the shared working tree: Go and
client code, UI where visual judgment matters, documentation, read-only research, read-only review. The owner reviews
finished work and tries what cannot be tried here.

**The loop for each feature.** Look (read the code, measure instead of guessing) → write the contract and commit it →
dispatch executors only on disjoint paths (one per directory: `apps/harness`, `packages/agent-client`, `packages/ui`,
`apps/desktop`, docs) → brief like a peer (goal, files to read first, exact scope, constraints, mandatory verification, a
final report that separates "ran" from "did not run") → verify independently (re-run the gates, read key screenshots,
run the live stack for behaviour claims) → commit per finished piece, only when its gates pass → review as a separate
read-only agent → show the owner what is still wrong or unproven.

**Rules that are easy to break.**

- Executors never run git write commands (add, commit, push, checkout, stash); the orchestrator commits after review.
- Every harness started by a test or script sets `HARNESS_NO_BUILTIN_PLUGINS=1`; otherwise the router can pick
  `acp:claude-code` and the harness fetches an adapter with `npx`.
- No third-party agent CLI and no provider key in this environment. Test with `examples/mockllm`, `examples/fakeacp`,
  `internal/fakerouter`. Say "not verified" for anything that needs the real thing.
- A change to the shared `Bridge`: client first (`types.ts`, `client.ts`, message-bridge allow-list, tests), then the UI's demo
  bridge if the member is not optional. The UI does not type-check until both are done.
- The three persistence layers (harness, router, shell) share no file. Do not import Tauri in `packages/ui`.
- A behaviour change updates the spec's "As built" section and the feature's doc page in the same commit.
- A stop hook asks to commit whenever the tree is dirty; while an executor is mid-edit the tree does not build, so commit
  when it finishes. The container is ephemeral: whatever is not pushed is lost, including the scratchpad (screenshots,
  review reports). UI executors wipe their screenshot folders: copy what you want to keep.
- Owner feedback that arrives late can be forwarded to a running executor as a numbered addendum.

**Gates per area** (from the repo root unless a `cd` is shown):

| Area | Commands |
| --- | --- |
| Router | `cargo fmt --check` · `cargo clippy -p octo --all-targets -- -D warnings` · `cargo test -p octo` (remove proxy variables from the environment first) |
| Harness | `cd apps/harness && gofmt -l . && go vet ./... && go test -race ./...` |
| Harness end to end | `bash apps/harness/scripts/e2e-acp-orchestrator.sh` · `cargo build -p octo && bash apps/harness/scripts/e2e-router.sh` · `bash apps/harness/scripts/e2e-v7.sh` (each needs Go and python3, touches only a temp dir) |
| agent-client | `pnpm --filter @octo/agent-client lint` · `pnpm --filter @octo/agent-client test` · `pnpm --filter @octo/agent-client format:check` |
| ui | `pnpm --filter @octo/ui lint` · `... test` · `... format:check`; with a dev server up: `node packages/ui/scripts/spacing-audit.mjs --url http://localhost:1420` must print `total=0`; drive `?demo=1` with Playwright in dark and light at 1440, 1100, 390 and read the screenshots |
| desktop | `pnpm --filter @octo/desktop lint` · `... test` · `... build` · `node scripts/check-bundle-size.mjs` |
| whole frontend | `pnpm lint` (includes `scripts/check-cycles.mjs`) · `pnpm format:check` · `pnpm test:scripts` |
| Shell | `cd apps/desktop/src-tauri && cargo test -p octo-sidecar` (python3 for the router tests); `cargo check` needs the sidecar binaries (`bash scripts/build-sidecar.sh --no-router`) and WebKitGTK |
| Dev stack | `pnpm test:dev-sh` and `pnpm test:dev-sh -- --router --mock` |
| Live (owner) | `bash apps/harness/scripts/test-subscriptions.sh [agent ...]` (or `all`); `harness doctor` for the report |

## 5. How to run

```bash
git submodule update --init --recursive && pnpm install
pnpm dev:all                    # harness (no key needed) + UI at http://localhost:1420; `-- --mock` adds the mock model;
                                # `-- --router` puts the router in front (needs OCTO_ROUTER_UPSTREAM_KEY or --mock)
pnpm --filter @octo/desktop dev # UI only; add ?demo=1 for demo data (?demo=one|many|empty, ?lsp=..., ?plugins=none)
pnpm install:app                # build both sidecars and the Tauri app, install it (owner's machine)
cd apps/harness && go run ./cmd/harness doctor     # what the harness sees on this machine
```

Mock-model triggers in a user message: `quick` (no delegation), `[write]`, `[acp]`; the fake ACP agent understands
`[silent]`, `[refuse]`, `[max-tokens]`, `[crash]`; the memory tests use `[search: ...]`, `[recall: id]`, `[mem-create: ...]`,
`[task-update: ...]`, `[fact: ...]`, `[goal: ...]`, `[quote: ...]`, `[decision: ...]`.

## 6. Next steps, in order

1. **R1 — ready for the owner's daily use** (the R1 section at the end of `specs/2026-11-11-packaging-design.md` is the
   bar). Harness side is built (items 3-6: agents first-class with install and login hints, failures never silent, doctor
   and trace, data safe across updates). Left: (1) prove the branch builds from a clean clone (`pnpm install && pnpm lint
   && pnpm --filter @octo/desktop build`, `scripts/install.sh`, CI green at HEAD; state unknown at the time of writing);
   (2) the first-run screen and Settings "Models and keys" (P9, below); (4) check that every failure reaches the user as a
   visible message in the UI, including the router-down and budget-reached cases; (5) Settings "Copy report" on
   `getDiagnostics` and the trace switch; (7) write `docs/superpowers/LIVE-CHECKLIST.md`: install, first run, one task per
   agent (Claude Code, Copilot, Grok) as orchestrator and as sub-agent, router on and off, quit and kill, what to send back
   (the doctor report and the trace file). Then the owner's live run; every agent-specific path stays unverified until it.
2. **UI v7 and P9 first-run.** v7 UI (`specs/2026-11-10-v7-changes-queue-approvals.md`, decisions 43 and 44 of the UI
   spec): changes and diffs per turn, queue, approval cards (which also receive ACP permission requests), forms and the
   secret field, tables; then flip `HARNESS_DEFAULT_ACCESS` to `supervised`. P9: first-run screen ("How should Octo run
   agents?": agents found with ready / not logged in / not installed, or an API key) and Settings on `getSettings` /
   `putSettings` with "Restart to apply" through `bridge_restart`; demo states `?demo=1&firstrun=...`. Also UI part 2
   (decisions 24, 26-28, 30, 31, 37-40, 45-48; show `served_model`; thinking and plan updates). The demo bridge needs the
   optional members for the demo states. Decision 42 is the bar for every pass.
3. **Memory M2 and M3** (`specs/2026-11-11-orchestrator-memory-design.md`, `apps/harness/docs/memory.md`). M2 (window
   context, receipts, tool-result clearing) is in the working tree, uncommitted: review it against the spec's M2 acceptance
   items (300 scripted turns stay under the caps, a five-message window is exactly five, cache-read share does not drop
   by more than 10 points, receipts match what was sent), then commit and update the spec's "As built". M3: the UI view of
   task records, facts, memory files and the receipt; embeddings only after the owner's first month with receipts.
4. **Inline completion** (`specs/2026-11-11-inline-completion-design.md`): `models.completion`, `POST
   /v1/projects/{id}/complete`, Monaco provider, Settings row, status item. Latency with a real model is the owner's
   measurement.
5. **I3 — savings view** (`specs/2026-11-11-router-harness-integration.md`, section I3): Usage → Cost "Auto-routing" (actual
   cost vs the same tokens at the hinted tier, tokens handled by flat-rate agents, marked as an estimate) and the project
   budget as `spent / budget` in the orchestrator header.
6. **Bots** (`specs/2026-11-11-bots-design.md`) after the owner answers questions 1-2; builds on v7 approvals.
7. Later: Q5; the harness items of the Synara gap report; a "History compacted" marker; a watch on a router that dies
   after start; signed builds, auto-update and Windows are out of scope until the owner says otherwise.

## 7. Where the older handovers went

The 2026-11-10 handovers (v6 pass, shelved VS Code direction, the screenshot references that are gone, the v6 brief) were
superseded by the specs' "As built" sections and by this file. `git log -- docs/superpowers/HANDOVER.md` has them. The
owner's design direction still stands: a premium desktop agent tool, balanced and exact spacing, comments in code exact,
own app with an embedded Monaco editor (not a VS Code fork), one orchestrator conversation per project, projects spanning
several folders, sub-agent transcripts read-only; use references for structure and finish only, never copy another
product's name, icons or assets.

## Roles (owner, 2026-11-11, replaces earlier wording)

Always delegate to the selected models: **Opus 5.5 — review** (and UI/design work the owner assigns to it),
**Sonnet 5.5 — writing code and tests**, **Haiku 5.5 — research**. The orchestrator decides, writes contracts,
re-runs the gates itself and commits; independent review of each pass goes to an Opus reviewer.

### Cost rule (owner, 2026-11-11, later the same day)

Opus spends too much: **do as much as possible with Sonnet** — code, tests, UI implementation and routine review.
Opus only where the owner asks for it or for a final design/review pass on something already working. Haiku for
research. Fewer, narrower briefs; hand back at the first green state.
