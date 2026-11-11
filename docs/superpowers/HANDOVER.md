# Handover — status on 2026-11-11

**Branch:** `claude/harness-ui-v6-completion-8ynrkq`, to be merged to `main` by pull request; follow-up work starts
from fresh `main`. The sections below are earlier handovers; "How to run" and "How the work was orchestrated" are
still accurate, their status tables are superseded by this one.

| Area | State | Verified by the orchestrator | Not verified |
| --- | --- | --- | --- |
| UI v6.2 and v6.3 part 1 (`specs/2026-11-10-project-harness-ui.md`, decisions 23, 25, 29, 32–36) | Built | Frontend gates, screenshots | Touch, screen reader, Tauri shell, live backend |
| Frontend quality Q1–Q4 (`plans/2026-11-10-frontend-code-quality.md`) | Layer rule as lint errors, no cycles, `@octo/ui/demo` | Gates | Pixel comparison (executor's numbers only) |
| Router ↔ harness I1 (`specs/2026-11-11-router-harness-integration.md`) | Hints, result headers, one ledger, project budget, compaction applied | Both apps' gates, `apps/harness/scripts/e2e-router.sh` | Compaction and `ceiling`/`fixed` jointly on the real router; a real upstream |
| Harness: context breakdown, side question, compaction markers | Built (API); UI not yet | Go gates | — |
| Child environment allow-list (bash tool, ACP agents, language servers, probes); `served_model` on agents | Built | Go gates | `HARNESS_CHILD_ENV_ALLOW` on a running server |
| Orchestrator on an ACP agent — S2 (`specs/2026-11-10-subscription-agents-design.md`, `apps/harness/docs/acp-orchestrator.md`) | Built | Go gates, `scripts/e2e-acp-orchestrator.sh` | **Any real CLI or MCP client** — scripted agent only |
| Eleven agent manifests (`plugins-examples/subscription-agents`) | Written | — | None was run |

## Next, in order

1. Owner's live run: `harness serve` with a logged-in Claude Code and `models.orchestrator: "acp:claude-code"`;
   `apps/harness/scripts/test-subscriptions.sh`.
2. UI part 2: decisions 24, 26–28, 30, 31, 37–40; show `served_model`; thinking / plan updates of ACP agents; the
   open majors of `research/2026-11-11-ui-review-v6.2.md`; decision 42 is the bar for every pass.
3. v7 (`specs/2026-11-10-v7-changes-queue-approvals.md`): changes and diffs (incl. files changed through bash, by
   a before/after snapshot of the folder), queue, approvals — which also receive ACP permission requests
   (`internal/permission`) and the forms of decision 43; tables (decision 44).
4. Q5; bots (`specs/2026-11-11-bots-design.md`); I2 / I3; the harness items of
   `research/2026-11-11-synara-gap.md`; SQLite persistence of router call records.

Open owner decisions: router ladder (inverted by price); S3 a or b (default a); Grok in tests; bots questions 1–2.

---

# Earlier handover (2026-11-10, later session)

**Branch:** `claude/harness-ui-v6-completion-8ynrkq` (continues `claude/project-harness-ui-redesign-qdnem2`; no pull request opened).
The section below this one is the earlier handover and is still accurate for how to run things and how the work is orchestrated.

## Done and committed in this session

| Area | State | Verified by the orchestrator |
| --- | --- | --- |
| UI v6 and v6.1 (spec: `specs/2026-11-10-project-harness-ui.md`, decisions 1–22) | Built | Gates, spacing audit at 0, live run on the mock stack (gopls, code comments, ACP turn, tabs) |
| Frontend code quality Q1–Q3 (`plans/2026-11-10-frontend-code-quality.md`) | Strict tsconfig, ESLint with boundaries, Prettier, CI job, 203 unit tests, shared helpers, seven defects fixed | Gates; pixel comparison reported by the sub-agent |
| Harness usage Phase A (`specs/2026-11-10-usage-design.md`) | `/v1/usage`, `/v1/limits`, prices.toml, ACP usage | Go gates; live on an existing data dir |
| Harness cost fixes (`research/2026-11-10-cost-audit.md`) | Prompt caching, context caps, balanced default orchestrator | Go gates only; caching benefit not measured on long loops |
| Router cost fixes | Compaction once, classifier fallback, max_tokens default, same-tier retry, budget by price, reported cost first; prices corrected against the OpenRouter catalogue | cargo fmt / clippy / 199 tests |
| Subscription agents S1 (`specs/2026-11-10-subscription-agents-design.md`) | Manifests for Copilot, Grok, Codex; ACP authenticate and model selection; login probes; live tests behind `-tags subscription` | Go gates; **never run against the real CLIs** |
| Rules and docs | `.cursor/rules/octo-typescript.mdc` = `.claude/rules/typescript.md`; `packages/ui/ARCHITECTURE.md`; `AGENTS.md` for ui, agent-client, desktop | — |

## Stopped midway: UI pass v6.2 (last commit, marked wip)

The sub-agent was stopped on the owner's request. The commit builds, lints with 0 errors and its 242 unit tests
pass, but it is **unreviewed and incomplete**: no acceptance scripts, spacing audit, screenshots or live run were
done on it, and its "As built (v6.2)" section is not written. Its brief (what it was building):

- Decision 23 — the UI reads as "a project's orchestrator at work" (sidebar = projects with orchestrator state,
  orchestrator header, team strip, Home about orchestrators, no "session/chat" wording).
- Decision 21b — the bolder dithered streak (hot core, 3px grain, translucent cards), compared side by side with
  the owner's references (`refs` 18–20; the reference images lived in the session scratchpad and are gone).
- A Usage tab (Tokens / Cost / Limits) on `getUsage` / `getLimits`.
- The findings of `research/2026-11-10-ui-review-v6.1.md` (seven P1, about fifteen P2) and one confirmed app race
  (the composer is rendered in two trees in `ConversationView` and loses focus after a project is created).

To resume: read the diff of the wip commit against its parent, decide what is finished, then re-run the brief's
verification (gates, `spacing-audit.mjs`, acceptance scripts, screenshots dark/light, live run) before trusting it.

## Open decisions for the owner

1. **Router ladder.** By the catalogue prices the `high` model is the cheapest and `low` costs about 22× more
   (`apps/router/docs/ladder-cost-check.md`). Either point all tiers at the `high` model or rebuild the ladder. The
   order was left unchanged; the router logs a warning at start-up.
2. **Subscriptions in the router.** Recommended: routing decisions in the harness (S3a). Proxying vendors' private
   endpoints (S3b) was not built and needs an explicit decision.
3. **Real-CLI check for S1.** Run `apps/harness/scripts/test-subscriptions.sh` on a machine with the subscriptions.

## Next, in the agreed order

1. Finish and verify v6.2, then an independent review of it.
2. Code quality Q4 (module boundaries) and Q5 (split providers and large components).
3. v7 (`specs/2026-11-10-v7-changes-queue-approvals.md`): changes per turn with diffs, message queue, approvals.
4. Subscription agents S2 (orchestrator on a subscription) after S1 is proven on real CLIs.
5. Cost follow-ups not built: orchestrator history compaction, a per-project budget (the harness does not send
   `x-octo-budget-key` yet).

Not verified anywhere: a real model or API key, real ACP agents, the Tauri shell, WebKit.

---

# Handover — project harness, UI and workspace

**Date:** 2026-11-10
**Branch:** `claude/project-harness-ui-redesign-qdnem2` (no pull request opened)
**Last commit of the batch:** `wip(ui): spacing tokens, flipped surfaces, chat header and model selector`

This file is for whoever continues the work in a new session. It says what exists,
how to run it, what was and was not verified, what is unfinished, and how the work
was orchestrated.

## 1. What exists

| Area | Path | State |
| --- | --- | --- |
| Harness (Go) | `apps/harness` | `harness serve`: projects, per-project SQLite, orchestrator + nested sub-agents, notes, confined file API, plugin registry, ACP sub-agents, language-server relay, scripted mock model and fake ACP agent |
| Bridge client (TS) | `packages/agent-client` | HTTP + SSE client, project state reducer, message-port bridge, file / plugin / LSP session methods |
| UI (React + Tailwind 4) | `packages/ui` | Two-level sidebar, tab workspace (dock), chat, delegation cards, read-only agent tabs, Monaco editor with code comments and an LSP client, command palette, settings with plugins |
| Browser / Tauri host | `apps/desktop` | Vite host for the UI; `?demo=1` runs on in-memory demo data |
| Router | `apps/router` | Untouched |

Design documents (`docs/superpowers/specs/`):

- `2026-11-10-project-harness-design.md` — projects, bridge API contract.
- `2026-11-10-project-harness-ui.md` — UI design, tokens, workspace, motion and craft rules.
- `2026-11-10-code-pane-design.md` — file API and editor.
- `2026-11-10-workspace-plugins-acp-design.md` — tabs, code comments, plugins, LSP, ACP, acceptance criteria.
- `2026-11-10-vscode-agents-window-design.md` — **shelved** VS Code fork direction, kept for its findings.

Design skills are vendored at `.cursor/skills/interfaces` (submodule).

## 2. How to run

```bash
git submodule update --init --recursive
pnpm install

# UI only, on demo data
pnpm --filter @octo/desktop dev            # http://localhost:1420/?demo=1

# Full stack without an API key (three terminals)
cd apps/harness && go run ./examples/mockllm
cd apps/harness && ANTHROPIC_API_KEY=mock go run ./cmd/harness serve \
  --base-url http://127.0.0.1:8791 --plugins-dir ./plugins-examples/go-tools
pnpm --filter @octo/desktop dev            # http://localhost:1420
```

Mock-model triggers in the user message: `quick` (answer without delegating),
`[write]` (a sub-agent writes `octo-demo-note.md`), `[acp]` (delegate to the first
plugin ACP agent; build `./examples/fakeacp` and use `plugins-examples/fake-acp`).
Demo-mode knobs: `?demo=one`, `?demo=many`, `?lsp=fail-once|slow|exit`, `?plugins=none`.

Gates:

```bash
cd apps/harness && gofmt -l . && go vet ./... && go test -race ./...
pnpm --filter @octo/agent-client test
pnpm --filter @octo/ui lint
pnpm --filter @octo/desktop build
```

All four passed on the last commit (Go suite last run at `710ed98`; no Go changes since).

## 3. Verified and not verified

Verified by the orchestrator directly:

- Go: formatting, vet, race tests in every package; the real `gopls` test
  (`TestGoplsDiagnosticsAndHover`) runs and passes.
- Live stack with the mock model (before the tab workspace): delegation tree, file
  edit → saved on disk, conflict refusal, agent write refreshing an open tab,
  tool-row file links.
- Type-check, build and client tests after every UI pass; selected screenshots read.

Reported by sub-agents, not re-run by the orchestrator:

- UI scripted suites (workspace: 57 of 58; comments/LSP: 75 of 75), contrast tables,
  frame-sequence motion checks.

Not verified at all:

- Anything against a real model (no API key in the environment).
- ACP with a real agent (Claude Code, Gemini CLI, Codex) — only the scripted fake.
  The commands in `plugins-examples/acp-agents` come from secondary sources.
- The UI's LSP client against a real language server — only the demo fake. `gopls`
  is proven at the harness level only.
- The tab workspace, comments and LSP UI on the live harness (only on demo data).
- The Tauri shell (`cargo check` not run); Windows paths and process handling.
- Independent review of the UI after the workspace, comments and v6 passes.

## 4. Unfinished: the v6 pass (stopped midway)

The last commit is a partial pass. It builds and renders, but it is not reviewed.

Done in it: spacing-scale tokens, flipped surfaces (near-black window, lighter
panels), chat header (project / request, working state, token total), composer with
an orchestrator model selector, sidebar Search row.

Not done (the full brief is section 6 below plus the owner's references):

1. **Spacing audit.** A script that fails on off-scale paddings/gaps, row heights
   outside the defined set, unequal insets and misaligned shared edges; run before
   and after, to zero violations. Measured problems before the pass: insets of
   5/6/7/8/9px, chat panel flush against the sidebar, 32px and 28px rows mixed,
   Chat tab label hugging its right edge, different selected-row shapes.
2. **Turn rail** (`components/chat/TurnRail.tsx` exists; check wiring): a marker per
   request with a hover card (first lines, status) and click-to-scroll.
3. **File view like the owner's reference:** breadcrumb row with back/forward and
   view controls, editor edge to edge, file tree as a collapsible column on the
   right of the file view (replacing the separate Files tab), file-type icons.
4. **"Filter files"** field in the tree.
5. **Markdown preview** with a Preview / Source toggle, centred measure.
6. **Floating composer** with status chips when the Chat tab is not visible.
7. **Design doc** section for v6 (scale, semantic tokens, row anatomy, new contrast
   table) — not written.

Defects visible in the partial build's screenshots:

- No gap between the status glyph and the role name in delegation rows.
- "Jump to latest" overlaps transcript text.
- The read-only bar wraps to two lines in a narrow group.
- The chat header overlaps the first transcript line when scrolled.

Earlier known limitations still open: no drag-and-drop in the narrow single-strip
mode; comment boxes are not reachable with Tab from inside the editor; the problems
popover can extend over the next panel; Ctrl/Cmd+K is captured before Monaco;
back/forward stay enabled on WebKit; ACP token counts are approximate; ACP agents
run unsandboxed with auto-approved permissions.

## 5. Suggested next steps, in order

1. Finish v6 (section 4), then run an **independent review** of the result.
2. **Live verification** on the real harness: workspace, comments (sent block
   reaches the orchestrator), LSP with real `gopls` through the UI, an `[acp]` turn.
3. Fix what the review and the live run find; re-shoot screenshots for the owner.
4. Update `AGENTS.md` for the current structure; add CI for the new Go packages if
   the workflow needs it (the Go workflow already runs `go test ./...`).
5. Decide the fate of `apps/desktop/src-tauri` (never exercised in this work).
6. Follow-ups from the specs: orchestrator context compaction; a "Changes" view for
   agent edits; permission prompts for ACP agents.

## 6. Owner's direction and references

- Feel: a premium desktop agent tool; earlier versions were rejected as "AI slop".
  The owner's latest notes: comments in code must be exact; paddings and margins
  must be balanced; the code view should work like the referenced agent IDE (file
  tabs, breadcrumb, tree on the right, floating composer).
- References were screenshots supplied in chat (two desktop agent tools and an
  open-source agent app). They lived in the session's temporary directory and are
  **gone** — ask the owner to attach them again. Use them for structure, proportion
  and finish only; do not copy another product's name, logo, icons or assets, and do
  not add features the product does not have.
- Decisions already made by the owner: own app (not a VS Code fork) with an embedded
  Monaco editor; one orchestrator conversation per project; projects span several
  folders; sub-agent transcripts are read-only.

## 7. How the work was orchestrated

Hub and spoke: one orchestrator session makes decisions, writes contracts, verifies
and commits; sub-agents do bounded pieces of work in the shared working tree.

| Role | Model | Used for |
| --- | --- | --- |
| Orchestrator | the session's own model | Specs, acceptance criteria, briefs, independent verification, commits, user updates |
| Design + UI build | Opus | Anything in `packages/ui` where visual judgment matters |
| Code + tests | Sonnet | Go packages, `packages/agent-client`, mechanical UI seams |
| Research | Haiku | Web research with sources; never touches files |
| Independent review | Opus (the owner asked for the orchestrator's own model next time) | Read-only review with the `better-interface` skill |

The loop for each feature:

1. **Look** — read the code and the owner's references; measure instead of guessing
   (pixel samples, `getBoundingClientRect`).
2. **Decide and write a contract** — a spec with exact API shapes and numbered
   acceptance criteria, committed before any code.
3. **Dispatch in parallel only on disjoint paths** — one agent per directory
   (`apps/harness`, `packages/agent-client`, `packages/ui`). Agents never run git
   write commands; each gets its own dev-server port.
4. **Brief like a peer** — goal, files to read first, exact scope, constraints,
   mandatory verification (commands, scripted checks, screenshots), and a short
   final report format that separates "ran" from "did not run".
5. **Verify independently** — re-run the gates, read key screenshots, run the live
   stack for behaviour claims. Report sub-agent self-checks as theirs.
6. **Commit per finished piece** — only when its gates pass; never mid-flight.
7. **Review as a separate agent** — read-only, evidence-based, ranked findings; feed
   them into the next build pass.
8. **Show the owner** — screenshots plus what is still wrong or unproven.

Practical notes:

- A stop hook asks to commit whenever the tree is dirty. While an agent is mid-edit
  the tree does not build; commit when the agent finishes.
- Changing the shared `Bridge` interface breaks the UI type-check until the UI's demo
  bridge implements the new methods. Sequence: client change → UI change.
- UI agents regenerate and wipe their screenshot folders; copy what you want to keep
  before sending it.
- Late owner feedback can be forwarded to a running agent as a numbered addendum
  instead of starting a new pass.
- Sub-agents run long (20–70 minutes for UI passes). Keep the owner updated and send
  interim screenshots from the agent's dev server.
- The container is ephemeral: anything not pushed is lost, including the scratchpad
  (screenshots, review reports, the shelved VS Code extension and fork recipe).
