# Synara vs Octo: feature gap and the ten agents (2026-11-11)

**Status:** a sub-agent's sourced report; no agent CLI was installed or run. The orchestrator confirmed one claim in code (`apps/harness/internal/acp/process.go` passes `os.Environ()` to ACP children); everything else is as reported. Paths written `S/…` point into the research scratch folder, which is not in the repository.

**Sources.**
- **Synara material** is in `scratchpad/synara/`, written S below:
  - site text (`home.txt`, `pages/*.txt`);
  - docs (`docs/_docs_*.c.txt`);
  - public source clone (`src/repo`, HEAD `12faafc`, 2026-11-11);
  - screenshots (`shots/`);
  - the public ACP registry (`acp-registry.json`).
- **Live public pages** were used only to fill gaps; each is cited by URL.
- **Our side**, marked "Octo:":
  - `docs/superpowers/HANDOVER.md`;
  - `specs/2026-11-10-project-harness-ui.md` (decisions 1–31), `-subscription-agents-design.md`, `-v7-changes-queue-approvals.md`;
  - `specs/2026-11-11-bots-design.md`, `-router-harness-integration.md`;
  - `research/2026-11-10-t3code-gap.md`;
  - `apps/harness/internal/{acp,plugins,orchestrator}`.

All downloaded material was treated as data. Nothing was executed, no agent CLI was installed or run, and nothing was logged in to.

## 1. What Synara is

- **Product.** A free, local-first Electron desktop app for macOS, Windows x64 and Linux x64: "the open-source workspace for AI coding agents".
  - The unit of work is a **thread (task)** in a project.
  - Each task has its own provider session and optionally a managed **git worktree**, plus terminal, browser, diffs and PRs.
  - Sources: S/home.txt, S/src/repo/README.md.
  - Latest release is v1.5.1 (S/pages/install.txt). The site claims about 25.4k downloads and 2.2k stars.
- **Lineage.** A fork of T3 Code: S/src/repo/LICENSE is MIT, "Copyright (c) 2026 T3 Tools Inc." plus the Synara author.
  - Same stack: Bun/Node + Effect WebSocket server (`apps/server`), React client (`apps/web`).
  - It is a one-developer project with a very fast release pace (S/pages/changelog.txt is 270 KB of text).
- **How it runs agents.** It uses the CLIs the user has already installed and logged in to, and never proxies model traffic (S/home.txt). There is one adapter per vendor (S/src/repo/apps/server/src/provider/):

  | Agent | Driver |
  | --- | --- |
  | Claude Code | `@anthropic-ai/claude-agent-sdk` |
  | Codex | `codex app-server` (JSON-RPC) |
  | OpenCode | `opencode serve` (HTTP) or the V2 client |
  | Pi | Pi SDK bundled in-process |
  | Antigravity | `agy -p … --output-format stream-json` plus hooks |
  | Cursor, Grok, Devin, Oh My Pi, Factory Droid | ACP (`acp/*AcpSupport.ts`) |

- **Coordination features:**
  - **Hubs:** coordinator + workers + memory + Library.
  - **Agent Gateway:** a thread-scoped MCP server that lets an agent create, wait on and steer other tasks.
  - **Provider handoffs**, **Automations**, **Thread goals**, **Tasks / Inbox / Kanban**.
- **Pricing.**
  - Free with no account for local use.
  - **Synara Alto** at $9.99/month or $79.99/year adds Remote Connections (pairing code plus fingerprint; relay or managed Cloudflare tunnel), approvals and alerts while away, a public `@handle` profile, and "Synara Bots (coming soon)".
  - Accounts use WorkOS; payments go through Polar.
  - Sources: S/pages/pricing.txt, S/docs/_docs_features_remote-connections.c.txt.
- **Open source.** The desktop app, server and web client are MIT. The repo also has `apps/api` and `apps/profiles`. Whether the relay or tunnel service is in the repo is *unverified*.
- **Already in our references.** Our UI spec's reference **G** (sixth batch: the "Introducing Remote Connections" dialog, phone inbox, model picker) is Synara (S/shots/home-dark.png). Decisions 26–28 already adapt it.

## 2. Feature inventory

Verdicts are take, adapt or skip.

| Feature | Synara (source) | Ours | Verdict | Why |
| --- | --- | --- | --- | --- |
| Many agent CLIs on the user's subscriptions | 10 agents, a different driver per vendor (S/docs/_docs_providers.c.txt; S/src/repo/apps/server/src/provider/Layers/*Adapter.ts) | Partial. ACP only. Manifests for Copilot, Grok and Codex (Octo: `plugins-examples/subscription-agents`), Claude and Gemini (`acp-agents`). Never run against real CLIs (HANDOVER) | adapt | Stay ACP-only: 9 of 10 have an ACP path (§5). Per-vendor SDK drivers are what makes Synara heavy |
| Child-environment hygiene | Strips `ANTHROPIC_*`, `OPENAI_*`, `XAI_*` and similar from provider children (S/src/repo/apps/server/src/provider/providerProcessEnv.ts) | **No**: `cmd.Env = os.Environ()` plus manifest env (Octo: `apps/harness/internal/acp/process.go`) | take | The harness's own `ANTHROPIC_API_KEY` (or `mock`) leaks into Claude/Pi children; `XAI_API_KEY` into Grok. Subscription runs can become per-token or fail |
| Login / health checks | "Authenticated" shown only after a confirmed health check; headless probes that never open a browser (S/docs/_docs_features_provider-accounts.c.txt; `acp/CursorAcpCommand.ts` "headless") | Partial: `auth.probe` and `logged_in` (subscription spec S1.5) | adapt | Add "unknown" as a first-class state; never start interactive auth from a probe |
| Auth-method choice in ACP | Chooses per agent: API key only when its env var is set, otherwise the cached token or device pairing (`acp/DroidAcpSupport.ts`, `DevinAcpSupport.ts`, `GrokAcpSupport.ts`) | Tries every "unattended" method in the offered order (Octo: `internal/acp/auth.go`) | take | Droid's `device-pairing` may start an interactive pairing; an API-key method without its key fails noisily |
| Several accounts per vendor | Accounts with their own home or env, model-picker tabs, per-account usage, terminal aliases such as `claude-work` (S/docs/_docs_features_provider-accounts.c.txt) | Partial: one env override (`OCTO_CODEX_HOME`) | adapt | Fits the router's "flat-rate first" and the bots' per-bot agents; skip the terminal aliases |
| Coordinator with workers (**Hubs**) | One coordinator chat, workers with different providers, shared instructions and `MEMORY.md`, a versioned Library, linked repos (S/docs/_docs_features_hubs.c.txt) | **Yes, at the core**: one orchestrator per project, notes, multi-folder (Octo: project-harness-design; HANDOVER §1) | adapt mechanics | Same model. Take the mechanics in the next four rows, not the separate "Hubs" area |
| Parallel-worker cap and persistent queue | Default 3, configurable 1–8; extra tasks wait in a durable queue; pause stops new starts (hubs doc) | No: only `MaxDepth` (Octo: `internal/config/config.go`); no concurrency cap found | take | Cost and rate-limit control; a natural router hook |
| Idempotent delegation | A stable task key per decision; a retry or wake reuses it; a different plan under the same key is refused (hubs doc §1.0.8; agent-gateway `requestId`) | No | take | Crash and retry safety for long orchestrator runs |
| Worker approvals in the coordinator chat | Pending approvals of a worker appear above the coordinator composer: Approve once / Always this session / Decline / Cancel. "Agents have no tool for approving a worker" (hubs doc) | Planned: v7 approvals; ACP auto-approves today (HANDOVER) | take | Exactly what v7 + bots need; the rule that an agent cannot approve is the key line |
| Brief carries the original request | The human request and attachment references travel with the brief; context labels mark human / server / other-agent text (hubs doc 1.0.8) | No (the orchestrator writes the brief) | take | Prompt-injection hygiene and fidelity; cheap |
| Access-mode inheritance | Workers inherit the coordinator's mode unless overridden; an unsupported "Auto" falls back to "Ask" (hubs doc 1.0.4) | No modes yet (v7) | take with v7 | One rule, stated once |
| Provider-native sub-agents shown | Claude/Codex child agents get child conversations, a roster of at most 20, Stop all (S/docs/_docs_features_subagents.c.txt) | Partial: our own sub-agents are read-only tabs; an ACP agent's own children are not shown | adapt | Show ACP `Task` tool calls as nested runs (Cursor does this; cursor doc) |
| Agent Gateway (MCP for agents) | Thread-scoped MCP tools: `synara_context`, `_capabilities`, `_create_thread(s)` (1–20, `requestId`), `_wait_for_threads`, `_send_message`, `_interrupt_thread`, to-do tools (S/docs/_docs_workflows_agent-gateway.c.txt) | Designed: S2 exposes harness tools to an ACP orchestrator over MCP (subscription spec S2) | adapt | Confirms S2's shape. Take `capabilities` (no guessing model ids), `wait` instead of polling, and batch create with a request id |
| Provider handoff | Same thread continues on another agent; bounded recap; native state not carried over; blocked while background tasks run (S/docs/_docs_workflows_handoffs.c.txt; S/home-full-dark.png) | No | adapt | For us: "continue this run with agent X" from a delegation row, and automatic fallback when an agent is logged out or rate-limited (§3.3) |
| Steer vs queue | Per-provider "steer an active turn" capability (Claude, Codex, Pi yes; others no); otherwise queue (providers doc) | Planned: v7 queue; steering is a non-goal | adapt | Add `steer: bool` per agent in the manifest; the UI offers steering only where it exists |
| Thread goals | `/goal` with pause/resume; bounded autonomous continuation; "your message wins"; marked blocked after 3 turns on the same blocker (S/docs/_docs_features_thread-goals.c.txt) | No | adapt | A project goal for the orchestrator; feeds bots' standing tasks |
| Automations | Schedules and heartbeats, natural-language stop conditions, failure policy (1 / 3 / 5 / keep), run history, created disabled for review (S/docs/_docs_workflows_automations.c.txt) | Designed: bots' standing tasks (Octo: bots-design) | adapt | Take the failure policy, stop conditions and disabled draft into the bots spec |
| Tasks / Kanban / Inbox | To-dos delegated with Start; attention board (Draft / In progress / Awaiting you / Done); Inbox with daily recap; agents maintain to-dos via MCP (`requestId`, no delete) (S/docs/_docs_features_tasks-and-inbox.c.txt) | Partial: Home triage and recap (decision 26) | adapt | A project backlog the orchestrator maintains. Skip a separate Kanban |
| Saved recaps | Daily recap saved to the account, readable when the source computer is offline; no prompt text (tasks doc) | No | skip for now | Needs an account and cloud |
| Library | Deliverables versioned in git, restore, optional push (hubs doc) | Partial: Details → Files / Activity (decisions 17, 22) | adapt | A versioned per-project "Library" folder is cheap; v7 blobs help |
| Worktrees per task | Managed worktree, branch, base ref (S/docs/_docs_workflows_worktrees.c.txt) | No (t3code gap, "later") | take | Parallel writing sub-agents share one folder today |
| Diffs, checkpoints, revert | "Edited N files" card with Undo / Review, revert guarded while a turn runs (S/home-full-dark.png; overview) | Planned: v7 changes | take (v7) | Already ranked first in the T3 gap |
| Git actions and PRs | Commit / push / PR menu, PR workspace, stacked PRs, a "Fix" button that bundles review comments, auto-fix CI (overview) | No | later | Large; start with "commit + PR text" via a sub-agent tool |
| Plan / debug modes, `/review`, `/fork`, `/side`, `/export` | Slash commands (S/docs/_docs_reference_slash-commands.c.txt; S/src/repo/assets/prod/readme-split-view-dark.png) | No | adapt partly | `/export` and `/review` are cheap; plan mode later |
| Usage and limits per account | Limits and pace per account; "banked resets" for Codex; Droid usage from credentials (codex, droid docs) | Partial: `/v1/usage`, `/v1/limits` (usage design) | adapt | Show "unknown" rather than zero; skip resets |
| Connectors (outbound MCP) | Catalogue plus custom HTTPS MCP; credentials never passed to providers; support differs per agent (S/docs/_docs_features_connectors.c.txt) | Partial: tool-server plugins | later | Their per-agent support table is worth keeping |
| External MCP (inbound) | Paired local clients get scoped, revocable access (worktree-only and approval-required by default) (S/docs/_docs_workflows_external-mcp.c.txt) | No | adapt later | The same MCP surface as S2; scoped tokens |
| Project import | Imports local Codex / Claude conversations | No | skip | Our unit is the project orchestrator |
| Remote Connections | Pairing code, fingerprint, approve device, relay or tunnel; paid (remote doc) | Out of scope (decision G) | skip now | Needs auth on `harness serve`; revisit with bots |
| Computer Use, iOS simulator, AppSnap, browser | macOS beta; simulator panel; window capture; embedded browser (docs) | No | skip | Bots phase 3 at most |
| Terminal panels | One terminal session per chat (terminal doc) | No | later | Per-project PTY |
| Inline visuals, media | Charts and tools in chat (beta), images, PDF viewer (overview) | Partial: Markdown and code | skip now | — |
| Customisation | Theme editor, density, provider order, favourites, JSON keymap, "What's new" dialog (customization doc) | Partial (decisions 27, 28) | adapt | We already took favourites and the dialog anatomy |
| Headless server | `synara-server` tarball (headless doc) | Yes: `harness serve` | — | We are server-first already |

## 3. Top gaps worth taking, ranked for an orchestrator-first product

1. **Delegation mechanics from Hubs, built into our orchestrator.** No new "Hub" area.
   - **Harness:** `max_parallel` per project (default 3) and a durable delegation queue in project SQLite (queued → starting → working → waiting → done/failed/cancelled).
   - `spawn_agent` gains `task_key`. A replay with the same key returns the existing run; a different brief under the same key is refused.
   - The brief stores the user's original request id and attachment refs alongside the orchestrator's text, with provenance labels in the prompt.
   - Pausing a project stops new starts.
   - **UI:** delegation rows show "Queued · 2 ahead". The team strip (decision 23) shows the cap ("3 of 3 running").
   - **Router:** the queue is where the I-spec budget check runs before a start.
2. **Approvals routed to the orchestrator conversation (v7 + bots).**
   - Every pending ACP `session/request_permission` from any depth surfaces above the project composer: Approve once / Always for this run / Decline / Cancel run.
   - Rule: **no tool lets an agent approve another agent's request**.
   - Workers inherit the project's access mode; an agent that cannot honour it falls back to "Supervised".
   - Bots' permission profiles plug in here.
3. **Handoff and fallback by the orchestrator, not by the user picking a vendor.**
   - A run can be continued by another agent: "Continue with…" on a delegation row, or automatically.
   - Automatic triggers: the agent is logged out, rate-limited (ACP error or limits), or over budget.
   - The receiving run gets a bounded recap, the same folder or worktree, and the original brief. Native state is not transferred.
   - The router ranks candidates "flat-rate first" (router-harness integration principle 4).
   - Guard: block a handoff while the source run has live tool calls.
4. **A worktree for each writing sub-agent.**
   - `spawn_agent{isolation:"worktree", base?}` creates `git worktree add` under the project data dir.
   - Changes (v7) are recorded per worktree. Merge back is an explicit orchestrator step, reviewed in the Changes view.
   - Read-only runs keep the shared folder.
5. **Provider hygiene and accounts (small, urgent).**
   - Scrub `ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GOOGLE_*`/`GEMINI_*` keys and base-URL variables from ACP child environments, unless the manifest asks for them via `${NAME}`.
   - Prefer named auth methods and skip interactive ones.
   - Several accounts per agent: a manifest or settings entry `accounts: [{id, label, env:{HOME-like vars}}]`, with usage and login probes per account.
6. **Project goal with bounded continuation (`/goal`).** This is the bots' standing-task primitive in its smallest form.
   - The orchestrator keeps working across turns toward an observable outcome.
   - It stops on a user message, a pending approval, a failure, a budget hit, or the same blocker three times ("blocked").
   - It has a visible timer and pause/resume.
7. **Standing tasks with stop conditions and a failure policy (bots spec addendum).**
   - Created disabled for review; exact agent and model validated before enabling.
   - Heartbeat vs dedicated runs.
   - "Stop after N consecutive failures" (default 3).
   - Stop condition evaluated after each successful run.
   - Run history with reasons.
8. **Project backlog and Library.**
   - The orchestrator maintains to-dos via tools (`todo_create` with `request_id`, list, update; no delete) shown on Home triage.
   - A per-project Library folder versioned in git (restore, optional push) holds deliverables.
   - This extends decision 17.

## 4. UI patterns (from screenshots)

**Good, with notes for our decisions:**
- **Two-tone headlines** ("Bring your own agents. Works with…"; "Introducing Remote Connections. Control…"). Shots: S/shots/home-full-dark.png, S/shots/home-dark.png. Already decision 28. Keep the lead-in at about 55% luminance, same weight.
- **Announcement dialog anatomy:** dithered or ASCII art band, a mono tracked eyebrow ("NEW IN SYNARA 1.5"), two-tone title, one paragraph, price in mono at the left, two buttons. Confirms decision 28. The concrete devices in the band ("MacBook Air — This computer" ↔ "Studio — Online · 3 agents running") are a good idea: art that carries real state.
- **Composer footer as context** (S/src/repo/assets/prod/readme-workspace-light.png, readme-split-view-dark.png): `+`, access mode with a shield glyph ("Full access" in amber, "Ask for approval" neutral), then model and effort on the right. Confirms decision 30. The colour carries the risk level. Take: amber only for full access.
- **"Edited N files +372 −185 · Undo · Review" card inline in the transcript,** with per-file rows and counts. This is the right shape for v7 changes inside the orchestrator transcript; per-run cards fit our delegation rows.
- **"Worked for 6m 34s ›" collapsible turn summary** above the answer. A quiet way to fold tool noise; we could fold the orchestrator's own tool calls the same way.
- **Handoff picker** sectioned "Continue in this thread" / "Continue in a new thread" (S/shots/home-full-dark.png). Groups by consequence, not by vendor. Use the same split for our "Continue with…" menu.
- **Sidebar thread rows with meta line:** glyph, project, PR number, branch. We keep project rows (decision 23); add branch or worktree to delegation rows when worktrees land.
- **Slash menu with "Built-in" / "Provider" sections** and right-aligned `/command` hints (readme-split-view-dark.png). Matches decision 10; take the section split.
- **Remote "Computers you can control" list:** online dot, OS, "3 agents running", "last seen 2h ago", disabled Open when offline. A good pattern for a future list of bots or machines.

**Bad, to avoid:**
- **Vendor logos as the main identity everywhere** (agent grid, picker, sidebar glyphs). This is provider-first, which our users do not think in (decision 27). It also uses third-party marks.
- **Thread-list sidebar** grouped Today / Yesterday with dozens of tasks. This is the "pick a session" model decision 23 removed. The mixed-language task titles in their own screenshot show how noisy it gets.
- **Feature sprawl in navigation:** rail, Kanban, Pull requests, Automations, Hubs, Tasks, Inbox, Studio, now renamed. The docs need "Stable vs Beta" boxes on nearly every page (S/shots/docs-hubs-dark.png). Keep few top-level areas: Home, Projects, later Bots.
- **Promo dialog over the product on first load** with a price. Ours announces only state ("router detected", "agent needs login").
- **Heavy saturated orange accent** for links and eyebrows. Our rule is that colour means state.
- **Small-text density** in the real app (11–12px meta lines in light mode). Keep our 13/14px floor.

## 5. Ten agents connection table

Confidence levels: **documented** = vendor docs; **registry** = the ACP registry entry; **Synara src** = what Synara spawns; **secondary** = third-party; **unverified** = not confirmed.

| Agent | Vendor | Third-party drive | Exact command and args | Headless auth | Model selection | ACP registry id | Licence / terms | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | Anthropic | ACP adapter (Synara uses the Agent SDK instead) | `npx -y @agentclientprotocol/claude-agent-acp`; registry also ships binary `claude-agent-acp` | Claude login via `claude`; `claude auth status` "where supported"; `ANTHROPIC_API_KEY` is per-token; Synara keeps one config dir per account via `CLAUDE_CONFIG_DIR` | ACP session config / set_model; aliases `opus` etc. | `claude-acp` (0.106.0, licence "proprietary") | Adapter by Anthropic, Zed, JetBrains; subscription use by a third-party client is governed by Anthropic's terms (*unverified* for our case) | registry + Synara docs |
| Codex | OpenAI | ACP adapter, or `codex app-server` JSON-RPC (Synara) | `npx -y @agentclientprotocol/codex-acp` | `codex login` / `codex login --device-auth`, `codex login status`; `CODEX_HOME` | ACP session options; effort Low–Ultra | `codex-acp` (2.6.0, Apache-2.0) | Adapter Apache-2.0; CLI Apache-2.0 | registry + S/docs codex. **Already in subscription-agents** |
| Cursor | Cursor (Anysphere) | Native ACP | `cursor-agent acp` (registry and Synara); Cursor docs show `agent acp`; optional `-e <endpoint>` before `acp` (Synara) | `cursor-agent login` (browser); `CURSOR_API_KEY` or `--api-key`; `CURSOR_AUTH_TOKEN` / `--auth-token`; client sends `authenticate` with `methodId:"cursor_login"`; status via `cursor-agent status` | Not documented for ACP; Synara uses ACP select options; `cursor-agent models` lists | `cursor` (2026.11.05, proprietary) | Cursor ToS | documented (cursor.com/docs/cli/acp) + registry |
| OpenCode | Anomaly (open source) | Native ACP (Synara uses `opencode serve` HTTP instead) | `opencode acp` | Provider credentials configured inside OpenCode (`/connect`, config); per-provider env vars | Not documented for ACP; models are `provider/model` from OpenCode config | `opencode`, `opencode-v2` (2.2.7, MIT) | MIT; upstream model providers' own terms | documented (opencode.ai/docs/acp) + registry |
| Antigravity | Google | Native ACP since agy v1.5.0 (2026-11-04); registry ships a separate `agy-acp-server`; Synara uses print mode | `agy acp` (check with `agy acp --help`); registry: `./agy_acp_server.par --uid=` | Keyring + Google sign-in from interactive `agy`, or `agy acp --login` (interactive); no env var documented | Not documented for ACP; print mode uses `--model` (Synara src) | `antigravity-acp` (1.4.5, proprietary) | Google terms; a developer asked whether wrapping is ToS-compliant (discuss.ai.google.dev, unanswered in my sources) | documented (antigravity.google/docs/cli/acp) + registry |
| Grok Build | xAI | Native ACP | `grok agent stdio`. Synara: `grok --permission-mode default agent --no-leader [-m M] [--reasoning-effort E] [--always-approve] stdio` | Cached account (`grok login`, device flow); `XAI_API_KEY` (per-token, may lose to the cached session); ACP methods `xai.api_key`, `cached_token` (Synara src) | `-m` and `--reasoning-effort` at start-up only; `grok models` | `grok-build` (npx `@xai-official/grok@1.0.81 agent stdio`, proprietary) | xAI ToS | registry + Synara docs/src; x.ai/cli returned 403. **Already in subscription-agents** |
| Devin CLI | Cognition | Native ACP | `devin acp [--model M]` | `devin auth login` (`--force-manual-token-flow` for SSH); `devin auth status`; ACP server reads `WINDSURF_API_KEY` if set; methods `windsurf-api-key`, `cached_token` | `--model` (env `DEVIN_MODEL`) = default for new ACP sessions; `devin models list --format json` | `devin` (3000.12.43, proprietary) | Cognition platform terms | documented (docs.devin.ai/cli/reference/commands) + registry |
| Pi | Earendil (open source) | No native ACP. Third-party adapter `pi-acp` spawns `pi --mode rpc`; Synara embeds the SDK | `npx -y pi-acp` (needs `pi` on PATH, Node 22+) | Pi's `/login` (subscription) or provider API keys; adapter offers only terminal auth (`pi-acp --terminal-login`) | Via the client's model selector; `/model` not implemented in the adapter | `pi-acp` (0.0.34, MIT, by an individual) | MIT; MVP; no MCP; history support contradictory in its README | registry + github.com/svkozak/pi-acp README |
| Oh My Pi | can1357 (open source) | Native ACP mode | `omp acp` (Synara src; the package has an `Acp` command, "ACP server over stdio"); a third-party guide says `omp --mode acp` | Interactive `omp` sign-in, creds in `~/.omp`; ACP method `agent`; profile dir via `PI_CODING_AGENT_DIR` | ACP session config (Synara: CLI flags "not authoritative"); `omp models --json`; thinking off…max | **Not in the registry** | Licence not checked (*unverified*) | Synara src + secondary (npm typings, instagit) |
| Factory Droid | Factory | Native ACP | Synara: `droid exec --output-format acp [-m M] [-r E] [--append-system-prompt …]`; registry: `npx droid@1.8.0 exec --output-format acp-daemon` with `DROID_DISABLE_AUTO_UPDATE=true`, `FACTORY_DROID_AUTO_UPDATE_ENABLED=false` | Browser device pairing from interactive `droid`; `FACTORY_API_KEY` (documented); ACP methods `factory-api-key`, `device-pairing` | `-m/--model`, `-r/--reasoning-effort` documented for `droid exec`; also ACP config | `factory-droid` (1.8.0, proprietary) | Factory terms | Factory's usage line lists `acp` but does not describe it (docs.factory.com/cli/droid-exec/overview) + registry + Synara src; `acp` vs `acp-daemon` difference *unverified* |

**Connectable today through our ACP-only harness:** 9 of 10.
- 7 native: Cursor, OpenCode, Antigravity, Grok, Devin, Droid, Oh My Pi.
- 2 via official adapters: Claude Code, Codex.
- Pi only through a third-party MVP adapter.

## 6. Draft manifests (plugin `subscription-agents` additions; not written to the repo)

```json
{
  "agents": [
    {
      "id": "cursor",
      "label": "Cursor",
      "command": "cursor-agent",
      "args": ["acp"],
      "env": { "CURSOR_API_KEY": "${CURSOR_API_KEY}" },
      "auth": {
        "probe": ["cursor-agent", "status"],
        "hint": "Run cursor-agent login once (browser), or start the harness with CURSOR_API_KEY set. Some installs name the binary agent."
      }
    },
    {
      "id": "opencode",
      "label": "OpenCode",
      "command": "opencode",
      "args": ["acp"],
      "env": {},
      "auth": {
        "hint": "Start opencode once and connect a model provider with /connect; models are named provider/model."
      }
    },
    {
      "id": "antigravity",
      "label": "Antigravity",
      "command": "agy",
      "args": ["acp"],
      "env": {},
      "auth": {
        "hint": "Needs Antigravity CLI 1.5.0 or newer (agy acp --help). Sign in once with agy, or agy acp --login, in a terminal."
      }
    },
    {
      "id": "devin",
      "label": "Devin CLI",
      "command": "devin",
      "args": ["acp"],
      "modelArg": ["--model", "{model}"],
      "env": { "WINDSURF_API_KEY": "${WINDSURF_API_KEY}" },
      "auth": {
        "probe": ["devin", "auth", "status"],
        "hint": "Run devin auth login (add --force-manual-token-flow over SSH), or set WINDSURF_API_KEY. List models with devin models list --format json."
      }
    },
    {
      "id": "droid",
      "label": "Factory Droid",
      "command": "droid",
      "args": ["exec", "--output-format", "acp"],
      "modelArg": ["-m", "{model}"],
      "env": {
        "FACTORY_API_KEY": "${FACTORY_API_KEY}",
        "DROID_DISABLE_AUTO_UPDATE": "true",
        "FACTORY_DROID_AUTO_UPDATE_ENABLED": "false"
      },
      "auth": {
        "hint": "Run droid once and finish the browser device pairing, or start the harness with FACTORY_API_KEY set (needed on headless machines)."
      }
    },
    {
      "id": "omp",
      "label": "Oh My Pi",
      "command": "omp",
      "args": ["acp"],
      "env": { "PI_CODING_AGENT_DIR": "${OCTO_OMP_DIR}" },
      "auth": {
        "hint": "Run omp once and sign in (credentials in ~/.omp); omp models --json must list at least one model."
      }
    },
    {
      "id": "pi",
      "label": "Pi (community ACP adapter)",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {},
      "auth": {
        "hint": "Needs pi on PATH. Run pi and /login (or set a provider API key) first. pi-acp is a third-party MVP adapter."
      }
    }
  ]
}
```

Notes on the draft:
- **Claude Code** is already in `acp-agents` (`npx -y @agentclientprotocol/claude-agent-acp`). Move it into `subscription-agents` with `"auth": {"probe": ["claude","auth","status"], …}` only after the env scrub below lands; otherwise the harness's `ANTHROPIC_API_KEY` is inherited.
- **Exit codes are unverified.** The probes for Cursor and Devin assume exit 0 means logged in.
- **Droid's `modelArg`:** Synara warns that CLI model flags are "not authoritative in every ACP release". Drop `modelArg` if the ACP config option works.

**Needs a harness change:**
1. **Environment scrub** (`internal/acp/process.go`). Today the child gets `os.Environ()`.
   - Strip `ANTHROPIC_*`, `OPENAI_*`, `XAI_*`, `GROK_CODE_*`, `GEMINI_*`/`GOOGLE_GENAI_*`, and `*_BASE_URL` (Synara's list: `providerProcessEnv.ts`).
   - Only manifest `env` re-adds them.
   - Affects Claude, Grok, Pi, OpenCode and Oh My Pi.
2. **Auth-method preference** (`internal/acp/auth.go`). Manifest `auth.methods: ["factory-api-key","cached_token",…]` in preference order, plus `auth.skip`.
   - Use an API-key method only when its env var is present.
   - Never call `device-pairing`, terminal or `--login` style methods unattended.
   - Needed for Droid, Devin, Grok, Pi (terminal only) and Cursor (`cursor_login`).
3. **`modelArg` placement** (`plugins/env.go`: `ArgsFor` appends at the end). Grok needs `-m`/`--reasoning-effort` before `stdio`. Support a `{modelArgs}` placeholder inside `args`, or `modelArgPosition`.
4. **Effort at start-up:** `effortArg` (Grok `--reasoning-effort`, Droid `-r`), tied to decision 27's Effort block.
5. **Run-wide permission flags:** `accessArgs` per access mode. Example: Grok `--always-approve` for full access, because "some Grok builds deny before emitting an ACP permission request" (Synara src).
6. **Capability flags in the manifest:** `steer` (live follow-up), `mcp` (accepts client MCP servers; Pi, Devin and Antigravity have no connectors per Synara), `compact` (Devin `/compact`).
7. **Accounts:** several env profiles per agent (isolated home folders), each with its own probe and usage.

## 7. Not verified / open questions

- None of the commands were run. Every exit code, auth-method `type` and model-option shape is taken from docs, the registry or Synara's source.
- Droid `--output-format acp` (Synara) vs `acp-daemon` (registry): which is current, and whether `acp` reads multiple sessions.
- Cursor's binary name: `agent` (docs) vs `cursor-agent` (registry, Synara). Whether `cursor-agent status` exits non-zero when logged out.
- Antigravity: whether `agy acp` and the registry's separate `agy-acp-server` are the same thing. The ACP auth methods it advertises. Terms for third-party use.
- Grok: what `--no-leader` does. Whether `-m` after `stdio` is rejected. x.ai/cli returned 403.
- Oh My Pi: the official docs page for `omp acp` (I found only npm typings and a third-party guide); its licence.
- Pi: `pi-acp` requires "pi v0.81.0+" while Synara bundles Pi SDK 1.4.0; version compatibility is unclear.
- Whether Claude Code prefers an inherited `ANTHROPIC_API_KEY` over the subscription login in ACP adapter mode. Likely, *unverified*; the env-scrub fix is right either way.
- Subscription use through a third-party client under each vendor's terms (Anthropic, Google, xAI, Cursor, Cognition, Factory): not legally reviewed.
- Synara figures (downloads, stars, testimonials) are marketing. Hubs and Agent Gateway behaviour is from docs only; I did not run the app.
- Whether Synara's hosted relay or API is open source.

## Most telling Synara screenshots

1. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/home-full-dark.png` — agent grid, handoff picker, "Edited N files" card, Git actions menu, terminal mock, composer with access mode, remote computers list.
2. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/home-dark.png` — announcement dialog (two-tone title, eyebrow, art band with live device state).
3. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/docs-hubs-dark.png` — Hubs (coordinator / workers / Library), the nearest analogue to our orchestrator.
4. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/remote-dark.png` — Remote Connections and Alto.
5. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/pricing-dark.png` — Free vs Alto, "Synara Bots coming soon".
6. `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/shots/docs-tasks-dark.png` — Tasks / Kanban / Inbox docs.

The best real-app screenshots are in the source, not in `shots/`:
- `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/src/repo/assets/prod/readme-workspace-light.png` (thread, changed files, PR pane, composer footer)
- `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/synara/src/repo/assets/prod/readme-split-view-dark.png` (slash menu with Built-in/Provider sections, "Ask for approval", simulator pane)

Downscaled crops: `/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/work/crops/`.

Web sources used:
- https://cursor.com/docs/cli/acp
- https://opencode.ai/docs/acp/
- https://antigravity.google/docs/cli/acp/
- https://docs.devin.ai/cli/reference/commands.md
- https://docs.factory.com/cli/droid-exec/overview.md
- https://github.com/svkozak/pi-acp
- https://cdn.jsdelivr.net/npm/@oh-my-pi/pi-coding-agent@15.2.4/dist/types/commands/acp.d.ts
- https://zed.dev/acp/agent/factory-droid
- https://instagit.com/can1357/oh-my-pi/how-to-setup-acp-zed-editor/
