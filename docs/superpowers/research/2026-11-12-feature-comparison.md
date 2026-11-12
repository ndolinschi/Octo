# Feature comparison: Octo, OpenCode, Cursor

**Date:** 2026-11-12 · **Kind:** read-and-run research, no product code changed · **Owner's request:** "check our features
against OpenCode and Cursor ... check every screen and feature ... and add [the missing ones] to us". This report is the
comparison and a ranked gap list. Nothing was built.

Contents: [Method](#1-method-and-limits) · [Our inventory](#2-our-inventory) · [Comparison](#3-comparison-by-group) ·
[Scoreboard](#4-scoreboard) · [Gaps worth closing](#5-gaps-worth-closing) ·
[Things we do that they do not](#6-things-we-do-that-they-do-not) · [Not worth copying](#7-not-worth-copying) ·
[Unverified claims](#8-claims-i-could-not-confirm)

Evidence tags used on every comparison row:

- **[ran]** I saw it on screen in a running build of that product (OpenCode only; Cursor never got past its login wall).
- **[src]** read in OpenCode's source or its docs-site sources in the clone.
- **[doc]** read in Cursor's public documentation (`https://cursor.com/docs/...md`, `https://cursor.com/help/...md`).
- **[spec]** read in our own specs and docs; **[code]** read in our code.
- Anything without a tag, or marked **unverified**, was not confirmed from a primary source.

Our status words: **built** (code exists), **built*** (built, but verified only on the mock model, scripted ACP agent, fake
router or `?demo=1` data; this is true of almost every UI feature, see HANDOVER section 2), **live** (the owner's
2026-11-11 live run covered it), **designed** (spec only), **absent**.

Verdict is against the stronger of the two products on that row: **ahead / parity / behind / absent**.

---

## 1. Method and limits

### What I ran

| Target | What | Result |
| --- | --- | --- |
| OpenCode source | `git clone --depth 1 https://github.com/sst/opencode` into the scratchpad. HEAD `1017760`, dated 2026-11-11. | Read README, `CHANGELOG.md` (v2.2.7), the v2 docs-site sources (`services/site/src/docs/content/*.mdx`, 27 pages plus `cli/`, `build/`, `console/`), `packages/protocol/openapi.json` (139 paths), `packages/core/src`, `packages/gui-plugins/src`, `packages/app/src`, `packages/tui/src` (directory level, selective files). |
| OpenCode build | `npm install --ignore-scripts @opencode/cli@2.2.7` into its own directory. The postinstall only picks a native binary, so I ran the `cli-linux-x64` binary directly with `HOME` and `XDG_*` pointing into the scratchpad. | **Ran.** TUI in `tmux` (140x42), 24 text captures. Web UI through `opencode serve` plus the one-time local `opencode pair` link, driven with Playwright at 1440x900, 24 screenshots. |
| Cursor docs | `https://cursor.com/llms.txt` index, then 45 pages as `.md` (Agent, Plan, Projects, Agents Window, Design mode, Voice, Debug, Review, Worktrees, Run Modes, Rules, Skills, Subagents, Hooks, MCP, Plugins, Cloud Agents, Automations, Bugbot, Rollouts, Router, CLI, Privacy, release notes, help pages for Tab/Ask/Context/Shared transcripts). | Read. Treated as data; nothing in them tried to instruct me. |
| Cursor build | Downloaded the official Linux x64 AppImage (3.29.15) from the link on the official download page, started it under Xvfb with `--no-sandbox` and a scratch profile. Never unpacked or inspected. | **Login wall.** The first and only screen is "Log In / Sign Up". I stopped there (about 6 minutes of the 15 allowed). One screenshot. |
| Our UI | `vite` dev server on port 1471 (stopped afterwards; the other executor's 1461 was untouched), `?demo=1`, Playwright. | 5 screenshots (home with a working project, palette, composer menu, model picker, settings). |

### Where the run stopped, and why

- **OpenCode:** I did not send any prompt. Its picker offers a free hosted model pool that needs no login, but a prompt would
  send the working directory path (which here contains this project's name) to an outside service. Without a model the
  TUI/web screens that appear only during a run (live tool rows, permission prompts, question dock, in-session review
  panel, terminal panel, side-tab layout with data) were **not seen**; they are described from source and docs and tagged
  [src].
- **OpenCode credentials note:** its picker showed "GitHub Copilot" and "Amazon Bedrock" as "Connected from your environment
  variables". The process inherited this sandbox's environment. I did not read, copy or type any credential, and sent no
  prompt, but OpenCode itself may have used those variables to list models. I should have started it with a cleaned
  environment; for any rerun use `env -i`.
- **Cursor:** no screen beyond the login wall; every Cursor claim is [doc] and therefore what Cursor says about itself.
- Network: GitHub web pages return 403 through the proxy (so I could not check the `sst/opencode` to `anomalyco/opencode`
  redirect; see below), docs sites and npm were reachable.

### Which OpenCode repository

The clone came from `sst/opencode`. The checked-in `package.json` and `packages/cli/package.json` name
`https://github.com/anomalyco/opencode` as the repository, the README badges and docs link there, and the npm packages are
now `@opencode/cli` (version 2.2.7, "OpenCode V2" per `CHANGELOG.md`). The clone's HEAD is one day old, so it is the live
line of development. That `sst/opencode` redirects to `anomalyco/opencode` is **unverified** (GitHub pages were blocked);
treat `anomalyco/opencode` as the canonical home and `sst/opencode` as the old one. V1 docs are still in the tree under
`services/site/src/docs/v1/`; this report uses V2 (`content/`) unless it says V1.

### Artefacts

Captures and screenshots are under
`/tmp/claude-0/-home-user-Octo/7c5bf6ed-bfbb-5e95-9ca2-f0157268907d/scratchpad/compare/` (index: `INDEX.md` there). No
third-party screenshot is in the repository.

---

## 2. Our inventory

From `docs/ARCHITECTURE.md` (status table dated 2026-11-11, partly stale), `HANDOVER.md`, `LIVE-CHECKLIST.md`, the specs'
"As built" sections, `apps/harness/docs/*`, and the code. The tree has moved past ARCHITECTURE.md: the v7 UI (changes,
approvals, queue, forms), Memory view, Settings page, providers and connect screen, inline completion and the PR-review API
are merged (git log `cedc10c`, `43968cf`, `3005c95`, `4dee9f1`). I confirmed against code where it mattered.

| Area | Status | Note |
| --- | --- | --- |
| Projects (several folders, one orchestrator conversation each), sidebar, tabs, drag/split, palette | built* | [spec] UI decisions 1-60; one conversation per project is an owner decision |
| Orchestrator + nested sub-agents, delegation cards, transcripts read-only | built*, live (ACP path) | [spec] design; owner ran Claude Code as orchestrator |
| Model tiers fast/balanced/deep, `tier: auto` via router, price rule, budgets, call history | built, live | router classifier answered in 49-93 ms in the owner's run |
| ACP agents (11 manifests), ACP orchestrator, MCP server for agents | built*; Claude Code live; Copilot/Grok only started; 7 never run | [spec] ARCHITECTURE status table |
| Providers/connect screen, Settings page (9 sections), model picker with agent models | built* | LIVE-CHECKLIST marks first-live items |
| Chat: attachments, paste, drop, `@` file mention, composer menu (files, agents, actions), queue | built* | no `/` command registry found; the composer menu is "Attach, mention or run" |
| Live activity (thinking, tool rows, plan, silence notice) | built*; ACP plan/thinking partly | HANDOVER lists "thinking and plan updates dropped" as a gap, LIVE-CHECKLIST says handled |
| Approvals (supervised/full, allow once / for turn / deny), forms and secrets, queue | built* | default access is still `full` until the owner flips it |
| Changes per turn: diff, line comments, revert file / revert turn | built* | no per-hunk accept/reject (read `ChangesView.tsx`) |
| Code pane: Monaco, LSP (plugins), code comments handed to the orchestrator, Markdown preview, file tree | built* | no terminal, no search in files, no quick-open (palette indexes tabs, projects, requests, agents, actions) |
| Inline completion (ghost text, `models.completion`) | built*, latency unverified | single-position; no next-edit |
| PR review: harness API (worktree, reading order, viewed marks, pending comments, submit) | built (harness), UI **absent** | [spec] RV1; no AI pass yet |
| Memory M1 (task records, facts, memory files, FTS search, digest); M2 window context + receipts; Memory tab | built* | M3 embeddings not built |
| Usage, cost, plan limits, budget | built, live | Usage tab (tokens, cost, limits) |
| Settings API, `harness.env`, `harness doctor`, diagnostics, ACP wire trace | built | UI "Copy report" built per Settings page notes |
| Desktop shell: sidecars, ports, PATH, stop order | built; Tauri glue not compiled here | macOS/Windows unverified |
| Built-in loop tools | built | only `bash`, `read_file`, `write_file` (whole file), `list_dir`, `search_files`, plus spawn/notes/memory/forms [code `internal/tools/local/local.go`] |
| Instruction files (AGENTS.md, rules, skills, commands), hooks, MCP *client*, worktree per agent, terminal, export, fork, share, notifications, voice, browser | **absent** | grep of `apps/harness/internal` for AGENTS.md / CLAUDE.md / worktree-for-agents / skill finds nothing |
| Bots (standing agents, schedules), inline-edit, next-edit, web host | designed or absent | `2026-11-11-bots-design.md` is a draft |

---

## 3. Comparison by group

Numbering is for cross-reference from the gap list. "OC" = OpenCode V2, "CU" = Cursor. OC docs paths are relative to
`services/site/src/docs/content/` in the clone; Cursor URLs are `https://cursor.com/docs/<path>.md` unless shown in full.

### A. Getting started and connecting models

**A1. First run, connecting a model** — *parity*
- Ours: built*. Connect screen when nothing can run, agent rows with install/login commands and "Check again", write-only
  key form, router switch; no-key start still works. LIVE-CHECKLIST marks it first-time-live.
- OC: [ran] home shows a prompt box at once; a free hosted pool ("OpenCode Free", about 10 models) and env-var providers
  are usable with no login; `/connect` lists Popular (OpenCode Console, OpenCode Go, OpenAI, Copilot, Anthropic, Google)
  then 100+ "Services". `opencode --wizard` exists. [src] `index.mdx`, `cli/providers.mdx`.
- CU: [ran] login wall ("Log In", "Sign Up") before anything; no account no editor. [doc] quickstart.
- Note: OC's "usable before any account" is a real onboarding edge, but only because OpenCode hosts free models; we have
  no such pool and should not build one.

**A2. Providers and model breadth** — *behind*
- Ours: built. Built-in loop speaks the Anthropic Messages API (direct, or via the router to OpenRouter and similar);
  ACP agents cover vendors' subscriptions. No native OpenAI/Google/local-model provider in the loop [spec providers.md].
- OC: [ran] model picker groups by provider (OpenCode, GitHub Copilot, Amazon Bedrock, ...), search, favorites (Ctrl+F),
  "Connect an integration" (Ctrl+A); catalog comes from models.dev [src `packages/core/src/models-dev`]. Settings has a
  "Models" page to hide models from the picker. [ran] web settings.
- CU: [doc] `models-and-pricing.md` lists about 18 hosted models; bring-your-own keys exist (help `api-keys`, not read).
- Gap: G18.

**A3. Installing and surfaces** — *parity*
- Ours: Tauri desktop app (macOS, Linux); `apps/web` is a README stub; harness is loopback-only.
- OC: [src] one server, four surfaces: TUI (`opencode`), desktop (Electron), web UI served by the same server (`opencode
  pair`, QR, 30-day cookie, optional remote tunnel), ACP server for Zed (`opencode acp`). `index.mdx`, `cli/web.mdx`,
  `cli/acp.mdx`. [ran] web UI and TUI.
- CU: [doc] desktop IDE, Agents Window, CLI (`agent`), web (cursor.com/agents), iOS app, Slack/GitHub/Linear triggers.
- Gap: G21 for the web/remote piece.

### B. Projects, workspaces and folders

**B1. Project model** — *ahead (multi-folder), parity otherwise*
- Ours: a project spans several folders; one orchestrator conversation; sidebar with state glyphs, "needs you" attention.
- OC: [ran] projects are directories; sessions belong to a project; tabs on top or side ("Interface layout: Top tabs / Side
  tabs / Inbox"), Home with project list and session search; `/cd`, `/project`. "References": named outside directories you
  attach to a prompt (`references.mdx`).
- CU: [doc] multi-root workspaces work (worktrees disabled for them); **Projects** (Agents Window) are a coordinator agent
  that plans and delegates to workers over months, on cloud agents, with shared context files, task list/board,
  subscriptions (Slack, PRs, schedule) and multiplayer. `agent/projects.md`.
- Note: Cursor's "Project" is the closest thing to our orchestrator model. It is cloud-first and paid; ours is local and
  works with subscription CLIs.

**B2. Folder picking, recents** — *parity*
- Ours: folder row with Recent and path completion (decision 51); native Browse only after the dialog plugin.
- OC: [ran] server-side folder browser with Recent list and path typing; Settings > Projects.
- CU: standard VS Code open-folder (unverified; not run).

**B3. Multiple parallel conversations per project** — *behind (by design)*
- Ours: one orchestrator conversation per project (owner decision); sub-agents are the parallelism.
- OC: [ran] many sessions per project, tabs, "New session" Ctrl+T, next/previous unread session (Alt+Shift+Arrows), mark
  unread. [src] `CHANGELOG.md` 2.2.7.
- CU: [doc] many agents in the Agents Window, side chats, split panes, `@Chats` to pull one chat into another.
- Gap: partly G6 (export/search), and an owner decision about "side threads"; not ranked as a build.

### C. Chat and composer

**C1. Attachments, images, paste, drop** — *parity*
- Ours: built*. Attach files, paste, drag-drop, pills in the composer [code `components/chat/Composer.tsx`].
- OC: [src] `attachments.mdx`: images (PNG/JPEG/GIF/WebP), PDF up to 20 MiB through `read`, image processing and limits.
  Web composer has a dropzone [src `packages/app/src/composer/dropzone.tsx`].
- CU: [doc] drag-drop and paste images; `.png .jpg .gif .webp .svg` read as vision input.

**C2. `@` mentions** — *behind*
- Ours: `@` file mention only [code placeholder "Ask anything, @ to mention a file"].
- OC: [ran] `@` lists files and skills (`@opencode`, `@report`, `@browser`) in web; TUI `@file#20-45` line ranges
  (`cli/tui.mdx`); agents by name (`@general`).
- CU: [doc] `@` files, folders, Terminals, Chats, git diffs (working state, branch vs main), Browser. `agent/prompting.md`.
- Gap: folded into G5 and G11 (mention a commit/diff, a terminal, another thread).

**C3. Slash commands** — *behind*
- Ours: composer "Attach, mention or run ( / or @ )" menu with Files / Agents / Actions groups [ran in demo]; no user-defined
  commands and no command registry found.
- OC: [ran] about 45 slash commands in the TUI (`/agents /btw /cd /clear /connect /continue /debug /diff /editor /effort
  /exit /goal /help /highlights /init /mcps /models /new /open /pair /plugins /project /q /quit /review /sessions
  /settings /skills /stats /status /themes /thinking /update /usage /variants /web` plus some I did not scroll to);
  web shows `/init /review /goal /model /connect /reload`. Custom commands are Markdown files with arguments, shell
  output injection, attachments, background run (`commands.mdx`).
- CU: [doc] `/` lists skills and commands; modes with `/ask /plan /debug`; CLI has 40 commands incl. `/fork /rewind
  /summarize /resume /rename /sandbox`. `cli/reference/slash-commands.md`.
- Gap: G11.

**C4. Voice** — *absent*
- Ours: none.
- OC: [src] realtime voice sessions (`packages/core/src/voice.ts`, `/api/experimental/voice/*`, composer UI in
  `packages/app/src/voice`). Not run (needs a provider).
- CU: [doc] dictation (mic button, Cmd+Shift+Space) and two-way **voice chat** on Grok Voice; needs a signed-in account.
  `agent/voice-chat.md`.
- Gap: G24.

**C5. Queue and steer while the agent works** — *behind*
- Ours: built*. Messages sent during a turn queue (FIFO, 20, persisted), edit/remove/send now, pause on failure.
- OC: [src] `cli/tui.mdx`: Enter **steers** the active session, Ctrl+X then Enter queues; Settings "Follow-up behavior:
  queue or steer", Ctrl+Enter switches [ran web settings].
- CU: [doc] Enter queues, Cmd+Enter sends now and attaches to the next tool result (steer), drag to reorder queue.
- Gap: G10 (we have the queue, not the steer).

**C6. Side question that does not touch the conversation** — *parity (unverified behaviour)*
- Ours: title bar has "side question" (decision 54); behaviour not exercised by me.
- OC: [ran] `/btw <question>` listed; answer in a dialog, not added to the conversation. [src] `cli/tui.mdx`.
- CU: [doc] side chats (`/side`, `/btw`): a durable chat that uses the parent as hidden context. `agent/overview.md`.

**C7. Context meter and compaction** — *behind*
- Ours: context ring and meter exist (`ContextRing.tsx`, `lib/contextMeter.ts`); auto compaction exists; summary not shown
  ("History compacted" marker is a recorded to-do); no manual compact.
- OC: [src] `compaction.mdx`: auto compaction near the limit, keeps the last 15k tokens beside a summary, `/compact`
  manual, background compaction, compaction model setting, buffer.
- CU: [doc] context ring opens a breakdown (system prompt, tools, rules, skills, MCP, subagents, summary, conversation);
  `/summarize` in CLI. `agent/prompting.md`.
- Gap: G4.

### D. Agent modes, plans and to-dos

**D1. Ask / Plan / Agent / custom modes** — *behind*
- Ours: no modes. Project `access` (supervised/full) is the only dial; the orchestrator never writes files itself (only
  sub-agents do), which is a structural plan-like property but is not exposed.
- OC: [ran] Build and Plan agents, Tab/Shift+Tab to switch, `/agents` picker lists build and plan; plan denies edits, may
  write plan files; `explore` and `general` subagents; custom agents as Markdown or JSONC with own model, permissions,
  steps, hidden/primary/subagent mode (`agents.mdx`).
- CU: [doc] Agent, Ask (read-only), Plan (questions, research, editable plan, "build"), Debug (hypotheses, instrumentation,
  reproduce, cleanup), Custom Modes from skills; Shift+Tab rotates. `agent/plan-mode.md`, `agent/debug-mode.md`.
- Gap: G7.

**D2. To-dos and plans shown in the UI** — *parity (unverified)*
- Ours: ACP plan updates become a plan row when the agent sends one; the orchestrator keeps task records (memory M1)
  shown in the Memory tab.
- OC: [src] plan agent writes plan files; no persistent todo panel found (unverified).
- CU: [doc] plan is a markdown file you edit and "Save to workspace"; Project task list/board with filters
  (release notes 3.26-3.27).

**D3. Long-lived goals and loops** — *absent*
- Ours: none; bots are a draft.
- OC: [ran] `/goal` ("keep working until an objective is met [pause|resume|clear]"); [src] `packages/core/src/plugin/goal/`
  (kickoff, judge, continuation, reminder prompts). Schedules API (`/api/experimental/schedule`, cron-like).
- CU: [doc] `/goal`, built-in `/loop` skill, Automations (schedule or event triggers on cloud agents). `agent/overview.md`,
  `cloud-agent/automations.md`.
- Gap: G16, G23.

### E. Sub-agents, parallel agents, worktrees, background and cloud agents

**E1. Sub-agents** — *parity, ahead in routing*
- Ours: built*, live (ACP). Orchestrator calls `spawn_agent` with tier, `auto`, or an ACP agent; depth nested; delegation
  cards; read-only transcripts; each can be a subscription CLI.
- OC: [src] `subagent` tool: background, returns a session id, parent gets a report when the child goes idle and after later
  rounds; default depth one; permissions control which agents may launch. `agents.mdx`, `tools.mdx`.
- CU: [doc] built-in Explore and Browser subagents (faster model, own context), custom subagents as Markdown, parallel,
  resumable, optional model per subagent, `/in-cloud` and `/autopilot`. `subagents.md`.

**E2. Isolated checkouts (worktrees)** — *behind*
- Ours: git worktrees exist only for PR review (`internal/review`). Agents share the project folders; changes are tracked
  per turn but writes can collide.
- OC: [src] Code Mode namespace `opencode.worktree_create/list/remove`, session move into a worktree; Settings > Worktrees
  page shows disk use [ran: empty list]; `/api/worktree`. `tools.mdx`.
- CU: [doc] Agents Window worktrees per agent, `.cursor/worktrees.json` setup commands, CLI worktrees. `configuration/worktrees.md`.
- Gap: G19.

**E3. Background and cloud agents** — *absent (and out of scope)*
- Ours: sub-agents run inside the harness process on this machine; no cloud.
- OC: [src] background subagents and shells shown "above the composer"; remote tunnel for the server; no hosted agents.
- CU: [doc] Cloud Agents on VMs, self-hosted workers, mobile app, Slack/GitHub/Linear triggers, Automations, Rollouts.
- Verdict note: see section 7; the local-first equivalent is G21 (reach your own machine from a phone/browser).

**E4. Parallel activity visibility** — *parity*
- Ours: team line, state rings, delegation group card with per-agent state and timers, "needs you" in the sidebar.
- OC: [src] "Background activity: show running subagents and shells above the composer" (setting, left/right), inbox view.
- CU: [doc] subagent tray, sidebar unread counts, menu bar icon count.

### F. Model selection, routing, cost, budgets

**F1. Model picker** — *parity*
- Ours: built*. Grouped by provider, agents with a second level, only what can run, "connect" rows, search across levels.
- OC: [ran] described in A2; variants/effort (`/effort`, `/thinking`, `/variants`), F2 cycles recent models.
- CU: [doc] picker, Cmd+/ cycles, Auto with "Optimize For" (Cost / Balance / Intelligence).

**F2. Per-task routing** — *ahead*
- Ours: built, live. Router classifies each delegated task, ranks flat-rate agents and API tiers by remaining limit and
  blended price, never-pay-more-for-less rule, decision stored as a call record.
- OC: [src] `GitHub Copilot Auto` passes routing to Copilot (changelog 2.2.7); a `decisions` generate endpoint exists
  (`/api/experimental/generate/decisions`); no price-aware router found.
- CU: [doc] Cursor Router (Teams/Enterprise only): classifier per request, three optimisation modes, model hidden by
  default. `cursor-router.md`.

**F3. Cost and usage views** — *ahead*
- Ours: built, live. Usage tab: tokens, cost with subscription-equivalent estimates kept out of spend, plan limits.
- OC: [ran] `/usage`, `/stats` exist (usage needs a connected integration, "No integrations found" without one);
  `packages/core/src/usage-limits.ts`; Console has budgets and members (`console/budgets.mdx`).
- CU: [doc] dashboard usage, team admin API, spend limits per user. Not in-app depth.

**F4. Budgets** — *ahead*
- Ours: per-project USD budget with a hard stop before every request, mirrored by the router's 402.
- OC: budgets exist only in the paid Console [src `console/budgets.mdx`]; none for local use found.
- CU: [doc] per-user spend limits via admin API; "Included usage reached" notices (release notes).

**F5. Prompt cache handling** — *parity*
- Ours: up to three `cache_control` breakpoints; cache-read share watched in memory M2.
- OC: [src] `warming.mdx`: periodic cache-warming pings timed from the model's cache TTL; `compaction` reuses the cache.
- CU: not documented in what I read (unverified).

### G. Live activity

**G1. Streaming, thinking, tool rows** — *parity*
- Ours: built*; "Thinking…", "Reading …", tool rows, silence notice after about 10 s; aurora while working (decision 45).
- OC: [ran] settings expose "Thinking: hide", "Tool grouping: auto", "Verbosity", "TPS: on" (tokens per second) in TUI;
  web "Timeline detail: Compact / Advanced". [src] session UI package.
- CU: [doc] thinking blocks toggle (`/show-thinking`), Worked sections, tool cards; not seen.

**G2. Terminal output** — *behind*
- Ours: `bash` results appear in tool rows; no interactive terminal pane.
- OC: [ran] web shortcuts: New terminal Ctrl+Alt+T, Toggle terminal Ctrl+`; Settings > Server "Terminal shell"; [src] pty and
  persistent-pty services, `session/{id}/terminal` read API so the agent can read the user's terminal.
- CU: [doc] agent runs commands in the integrated terminal; `@Terminals` mention.
- Gap: G20.

### H. Approvals, permissions, sandboxing

**H1. Approval prompts** — *behind (rules), parity (prompt)*
- Ours: built*. Supervised vs full; cards with diff or command, Allow / Allow for this turn / Deny with note; ACP permission
  requests arrive as cards; unanswered denied after 30 min; secrets never in model context.
- OC: [src] `permissions.mdx`: rules as `{action, resource, effect}` (allow/ask/deny) with glob resources for read, edit,
  shell, subagent, skill, webfetch, MCP tools; global, per-agent and org policy layers; **Allow once / Allow always / Reject
  with feedback**; saved approvals are project-scoped allow rules that never beat a configured deny; shell scanner splits
  compound commands and `cd` targets; `external_directory` boundary. `--auto` flag and web setting "Auto-accept permissions"
  [ran web settings].
- CU: [doc] Run Modes: Auto-review (allowlist, sandbox, LLM classifier for the rest), Allowlist, Run Everything;
  `permissions.json` user and project, plain-English block instructions. `agent/security/run-modes.md`.
- Gap: G8.

**H2. Sandboxing** — *absent*
- Ours: `bash` runs with the harness's child-env allow-list; file access confined to project folders for ACP; the agent
  process itself is not sandboxed [spec ARCHITECTURE flow 2].
- OC: no OS sandbox found; relies on permission rules and the shell scanner (unverified that none exists).
- CU: [doc] terminal sandbox with network modes and `sandbox.json`.
- Gap: G22.

**H3. Questions and forms from the agent** — *ahead*
- Ours: built*. `request_input` forms, typed fields, secret fields to a per-project store referenced as `secret:<name>`.
- OC: [src] `question` tool, `/api/session/{id}/form`, "New question UI" keyboard dock (experimental, [ran] setting).
- CU: [doc] "Ask questions" tool, agent keeps working while waiting.

### I. Changes, diff review, checkpoints, undo

**I1. Diff review** — *behind*
- Ours: built*. Per turn file lists, diff, line comments, revert file or turn; pre-images capped 256 MiB per project.
- OC: [ran] diff viewer from `/diff`: scope **All / Committed / Uncommitted / Last turn** and a base-branch picker, file list
  with +/- counts, `m` marks a file reviewed (collapses it), `n/p` next/previous file; keybinds in `cli/keybinds.mdx`.
  Web has Ctrl+Alt+R "Open review" (built-in `review` GUI plugin, [src] `packages/gui-plugins/src/review`).
- CU: [doc] Agents Window diffs view, PR tab (Changes, Description, Commits, Checks, Reviews), Cmd+click a diff line
  (release notes 3.26); review depth Quick/Deep. `agent/agent-review.md`.
- Gap: G12, G13.

**I2. Checkpoints, undo, revert** — *behind*
- Ours: revert per file and per turn (files only; the conversation stays).
- OC: [src] `snapshots.mdx`: `/undo` stages a rollback of files and conversation and puts the removed prompt back in the
  composer; `/redo` cancels; sending commits it; per model step snapshots of the active directory (git worktree), ignored
  files and files over 2 MiB skipped. Select an earlier message and choose Revert.
- CU: [doc] automatic checkpoints before significant changes; restore from the timeline, the button on a request, or the
  "+" on a message; files only, local, separate from git. `agent/overview.md`. CLI `/rewind` and `/fork`.
- Gap: G9.

**I3. Reviewing comments back to the agent** — *ahead*
- Ours: built*. Line comments in code and in diffs are pending, attach to the next message, and are exact (owner direction).
- OC: [src] `quote-comment-machine` in the composer package: quote text from a message into a comment; no code-line
  comments found.
- CU: [doc] design-mode notes on the running app; Cmd+L sends an editor selection to chat.

### J. Code editor

**J1. Editor basics** — *parity*
- Ours: Monaco, tree with filter, breadcrumbs, back/forward, Markdown preview, LSP via plugins, problems count in the bar.
- OC: web: file plugin and Ctrl+Alt+P open file [ran shortcuts list]; TUI is not an editor (`/editor` opens `$EDITOR`). LSP
  was a V1 docs page (`v1/content/lsp.mdx`); V2 content has formatters, not LSP (`doom_loop` and `lsp` are not V2
  permission actions, `permissions.mdx`).
- CU: full VS Code fork with extensions. Far ahead of both; not our direction (owner: own app with embedded Monaco).

**J2. Inline completion and next edit** — *behind*
- Ours: built*. Ghost text, Tab, Ctrl+Right word, Esc; 120 ms debounce, abort, LRU, never-sent list, budget stop. Latency
  with a real model unmeasured. No next-edit prediction (spec "Open").
- OC: none found.
- CU: [doc] Tab: multi-line, imports, jump-in-file, cross-file edits, snooze and per-extension switch. `help/ai-features/tab.md`.
- Gap: none ranked; next-edit is L and needs a trained model (section 7).

**J3. Inline edit from a selection (Cmd+K style)** — *absent*
- Ours: none.
- OC: none found.
- CU: not found in the 45 docs pages I read (the current docs foreground Agent; unverified whether the classic Cmd+K
  inline edit still exists in 3.29).
- Gap: G17, low confidence on demand.

**J4. Search, quick open, palette** — *behind*
- Ours: palette (Ctrl+K) searches tabs, projects, requests, agents, actions; tree filter; Monaco find. No project-wide text
  search, no file quick-open [code `CommandPalette.tsx`, demo].
- OC: [ran] TUI Ctrl+P palette (Suggested, VCS, System, Session groups; Switch model, Open diff viewer, Usage statistics,
  Plugins, Pair device, Switch theme, Exit, Ask a side question); web Ctrl+K "Search everything", Ctrl+Shift+F search
  sessions, Ctrl+Shift+O search projects, Ctrl+Alt+P open file.
- CU: [doc] Cmd+P files and Cmd+Shift+F search files inside the Agents Window; Cmd+K conversation search with a local index.
- Gap: G5, G6.

**J5. Problems/diagnostics** — *parity*: ours shows LSP problems in the file bar; OC and CU: unverified in this pass.

### K. PR and code review

**K1. Review of pull requests and local changes** — *behind (UI absent)*
- Ours: harness RV1 is thorough (private worktree, reading order, viewed marks that survive new commits, pending comments,
  suggestion blocks, one atomic submit, nothing posted by agents); **no screen**, no AI findings yet.
- OC: [ran] `/review` ("review changes [commit|branch|pr], defaults to uncommitted") is an agent-run review; GitHub app via
  `opencode github install` for `/opencode` comments on issues and PRs [src `v1/content/github.mdx`, V1 doc].
- CU: [doc] Agent Review (`/agent-review`, after each commit, Source Control tab, Quick/Deep), **Bugbot** on every PR with
  rules in `BUGBOT.md` and `.cursor/config/bugbot.yaml`, PR summaries, Rollouts, PR Routing and Approval.
- Gap: G12 (screen for RV1), and an AI review pass (RV3, already specced).

### L. Memory, rules, instructions, skills

**L1. Project instruction files** — *absent*
- Ours: nothing reads `AGENTS.md`, `CLAUDE.md` or rules for the built-in loop or sub-agents (ACP agents read their own).
  Orchestrator memory is separate and richer.
- OC: [src] `instructions.mdx`: `AGENTS.md` loaded from global, then every directory up from the workspace; nested files
  load when the agent reads or lists that area; `/init` writes one. V2 does not fall back to `CLAUDE.md`.
- CU: [doc] Rules: project rules (`.cursor/rules`, glob-scoped, always/auto/manual), user, team, plus `AGENTS.md` with nested
  support; CLI also reads `CLAUDE.md`. `rules.md`.
- Gap: G1. Our own repo has an `AGENTS.md`, so the harness would read the file its own developers write.

**L2. Memory** — *ahead*
- Ours: built*. Task records, dated facts (superseded kept), memory files, two FTS5 indexes, window context with receipts.
- OC: none beyond instructions and compaction summaries (V2 docs: no memory page).
- CU: [doc] Project "shared context" (Agent Store) syncing across machines; Rules; no per-user memories page in the llms
  index (an older Memories feature appears gone; unverified).

**L3. Skills** — *absent*
- Ours: none.
- OC: [ran] `/skills` lists built-ins (OpenCode, Report, Browser); [src] `skills.mdx`: `SKILL.md` in `.opencode/skills/<id>`,
  catalogs, frontmatter, permissions per skill ID, `skill` tool.
- CU: [doc] open Agent Skills standard (`SKILL.md`), `/` menu, Custom Modes, scripts in skills, sync to cloud agents.
- Gap: G11.

**L4. Custom commands** — *absent*: OC Markdown/JSON commands with arguments and shell injection (`commands.mdx`); CU
  commands as Markdown, being migrated into skills (`skills.md`, "Migrating rules and commands to skills"). Gap: G11.

### M. MCP, tools, plugins, extensions

**M1. MCP** — *behind*
- Ours: the harness is an MCP **server** for ACP orchestrators (`/mcp/v1/projects/{pid}`); plugin "tool servers" use a
  custom remote-tool protocol [spec ARCHITECTURE, `examples/remotetool`]. I found no standard MCP client for the
  built-in loop (stdio or HTTP, OAuth). Unverified beyond a grep.
- OC: [ran] `/mcps`, Settings > Extensions (MCPs, Plugins, Skills), `opencode mcp` CLI; [src] `mcp-servers.mdx` (566
  lines): local and remote, OAuth with token refresh fixes in 2.2.7, tools reached through Code Mode by default, per-server
  `codemode: false`, resources and prompts.
- CU: [doc] `mcp.json` project/global, one-click install, OAuth (static redirect), env interpolation, enterprise allowlist,
  tool approval via Run Mode, images as context, MCP Apps.
- Gap: G14.

**M2. Built-in tools** — *behind*
- Ours: `bash`, `read_file`, `write_file` (whole file), `list_dir`, `search_files`; no patch/edit, no glob, no web.
- OC: [src] `tools.mdx`: read (offset, negative offset, near-name suggestions), glob, grep, edit, write, patch, shell,
  webfetch, websearch, image generate, question, skill, subagent, execute (Code Mode JS), session and worktree utilities,
  browser namespace in the desktop app.
- CU: [doc] search files and folders, web, fetch rules, read (images), edit, shell, browser, image generation, ask questions,
  Instant Grep (local index, no embeddings upload). `agent/overview.md`, `agent/tools/search.md`.
- Gap: G2.

**M3. Plugins and extension API** — *parity (different shape)*
- Ours: plugin manifests for language servers, ACP agents and tool servers; Settings > Editor > Plugins.
- OC: [src] `plugins.mdx` and `build/plugins/`: server plugins and GUI plugins (every non-core desktop feature is a built-in
  GUI plugin: terminal, review, files, browser, SSH, WSL, updater, goal, btw, sources, pairing); [ran] `/plugins` empty list.
- CU: [doc] Plugins bundle rules, skills, subagents, commands, MCP, hooks; marketplace, team marketplaces, Agent Plugins open
  standard. `plugins.md`.

**M4. Hooks** — *absent*
- Ours: none.
- OC: [src] plugin hooks (`packages/core/src/plugin/hooks.ts`); formatters run after edits (`formatters.mdx`).
- CU: [doc] `hooks.md`: command and prompt hooks at agent-loop events (before shell execution, stop, ...), user and project
  scope, cloud support, partner integrations.
- Gap: G15.

### N. Sessions, history, search, export

**N1. History, resume, search** — *behind*
- Ours: the project keeps one persistent conversation; sessions resumed after restart; memory search by tool and API.
- OC: [ran] `/sessions`, Home with "Search sessions"; `opencode session` CLI; `--continue`; export/import
  (`/api/experimental/session/{id}/export`, `/import`); stats. [src]
- CU: [doc] Cmd+K searches transcripts with a local index; `/resume`, `/fork`; shared transcripts (Teams/Enterprise).
- Gap: G6.

**N2. Fork and share** — *absent*
- Ours: none (single conversation by design).
- OC: [src] `/api/session/{id}/fork`, `fork-machine`; no public share link in V2 docs (V1 had a share feature; unverified
  that V2 dropped it).
- CU: [doc] share team/public link with best-effort secret redaction, "Fork to Cursor", 50 shares/day. `help/ai-features/shared-transcripts.md`.
- Gap: export only (G6); fork and share are owner decisions.

### O. Settings and customisation

**O1. Settings surface** — *parity*
- Ours: page with search; sections General, Appearance, Providers, Models, Agents, Editor, Usage and budget, Memory, Privacy
  and data, About; notifications, sound and density deliberately not built.
- OC: [ran] web: Providers, Models, Extensions, Projects, Worktrees, Preferences, Appearance, Notifications, Shortcuts, Server,
  Experimental, About. TUI settings: theme, colour mode, animations, sidebar, scrollbar, scroll on send, thinking, markdown,
  tool grouping, verbosity, transcript images, TPS.
- CU: [doc] Cursor Settings (Models, Agents > Approvals & Execution, Git & PRs, Tab, Voice), Customize page for plugins,
  skills, MCP, subagents, rules, commands, hooks per user/workspace/team scope.

**O2. Themes, fonts** — *behind (low value)*
- Ours: light/dark/system theme, backdrop, reduce motion.
- OC: [ran] 30+ named themes (matrix, nord, tokyonight, solarized, ...), colour mode, UI/Code/Terminal font pickers.
- CU: themes via VS Code; [doc] help `themes` (not read).

**O3. Keybindings** — *behind*
- Ours: fixed shortcuts (palette Ctrl+K, tabs, history); no editor.
- OC: [ran] web Settings > Shortcuts lists about 25 actions, each reassignable, "Reset to defaults"; TUI leader key and a
  `cli.json` keybind map (`cli/keybinds.mdx`, 410 lines).
- CU: standard VS Code keybindings; [doc] `help/customization/keyboard-shortcuts`.
- Gap: low; fold into G5 if done.

### P. Notifications, privacy, remote

**P1. Notifications** — *absent*
- Ours: none (Settings notes "no feature behind them"); menu-bar/dock badge not built.
- OC: [ran] web Settings > Notifications: desktop notification and sound per event (agent complete or needs attention,
  permission needed, question, error); [src] TUI `attention.ts` and attention sounds; "mark unread" dots.
- CU: [doc] unread counts, menu bar icon count, chimes, iOS push and Live Activity.
- Gap: G3.

**P2. Privacy** — *ahead for local-first*
- Ours: no cloud; loopback bridge, secrets store, redactor, child-env allow-list, never-sent list for completion, wire trace
  with secrets removed. Privacy section has diagnostics copy.
- OC: [src] provider calls go direct; `network.mdx` proxies and CAs; Console workspaces and policies for orgs.
- CU: [doc] Privacy Mode (no training), zero retention for voice, enterprise controls; code is sent to Cursor's backend.

**P3. Multi-device and remote** — *absent*
- Ours: loopback only; the review doc notes the bridge has no auth token (cross-cutting change not made).
- OC: [ran] `opencode pair` prints a one-time link (expires in 5 minutes) and QR; web UI over SSH tunnel or an end-to-end
  encrypted remote address; server password; sessions last 30 days; `opencode service` background server. [src] `cli/web.mdx`.
- CU: [doc] web app, iOS app with voice and Siri, Remote SSH in Agents Window, self-hosted workers.
- Gap: G21.

### Q. Keyboard, onboarding, accessibility, errors

**Q1. Keyboard-first** — *parity*
- Ours: palette, tab drag and keys (Ctrl+1..9, MRU Ctrl+Tab, reopen), Esc rules, turn rail focus paths.
- OC: [ran] leader-key chords, Ctrl+P palette, Shift+Tab agents, F2 recent models; web Alt+Arrows between sessions; `?` help
  in the diff viewer.
- CU: [doc] Shift+Tab modes, Cmd+K, Cmd+/, Cmd+Shift+D, many more.

**Q2. Onboarding and empty states** — *parity*
- Ours: connect screen, empty project hero with starter prompts, home recap and heat counts.
- OC: [ran] TUI and web both open on a single prompt with a rotating example ("What is the tech stack of this project?");
  "highlights" screen after an update (`/highlights`).
- CU: [doc] first-project guide; not run beyond the login screen.

**Q3. Accessibility** — *unknown*
- Ours: contrast >= 4.5:1, 24 px targets, reduced motion; screen reader, touch and forced colours unverified.
- OC: unverified (not tested).
- CU: [doc] release notes 3.26-3.27 mention screen-reader landmarks, restore-checkpoint announcements, reduced motion fixes.

**Q4. Error handling and recovery** — *ahead (diagnostics)*
- Ours: no silent failures rule, `harness doctor`, copyable diagnostics, wire trace, retry without a duplicate message,
  budget and router-down messages, pending approvals survive a reload.
- OC: [src] model retry (`model-retry.ts`), tool-input repair, "Report" skill that collects diagnostics and files a GitHub issue
  with `gh`; `opencode debug`.
- CU: [doc] `/logs`, `/copy-request-id`, `/feedback`; Agent troubleshooting pages.

---

## 4. Scoreboard

Counts over the rows above (a row with two verdicts counts once, as the weaker).

| Verdict | Rows |
| --- | --- |
| ahead | F2 routing, F3 usage, F4 budgets, H3 forms and secrets, I3 comments to agent, L2 memory, P2 privacy, Q4 diagnostics, B1 multi-folder |
| parity | A1, A3, B2, C1, C6, D2, E1, E4, F1, F5, G1, J1, J5, M3, O1, Q1, Q2 |
| behind | A2, B3, C2, C3, C5, C7, D1, E2, G2, H1, I1, I2, J2, J4, K1, M1, M2, N1, O2, O3 |
| absent | C4, D3, E3, H2, J3, L1, L3, L4, M4, N2, P1, P3 |
| unknown | Q3 |

Reading: we are strongest where the product is about *who runs the work and what it costs* (routing, budgets, subscriptions,
memory). We are weakest in the daily-loop ergonomics both competitors share: instruction files, modes, undo, notifications,
search, and a richer tool set.

---

## 5. Gaps worth closing

Twenty-five, ranked by user value divided by effort (first the small high-value ones, then medium, then large). Sizes: S up
to 1 day, M 2-4 days, L more. "Where" names the package and the spec to extend; each would also update that spec's "As built"
and the harness docs page, per the working rules. How the others work is described in my words, not copied.

**G1. Project instruction files for the built-in loop and sub-agents** · S · rank 1
- *User gets:* the same `AGENTS.md` (and optional rules) guidance in every orchestrator and sub-agent turn that a developer
  already keeps for other tools; our own repository has one. Today the built-in loop starts blind to it.
- *Others:* OC reads a global file plus every `AGENTS.md` from the workspace upward, and loads nested ones when the agent
  reads or lists that directory; `/init` drafts one. CU has glob-scoped rule files and nested `AGENTS.md`, and its CLI also
  reads `CLAUDE.md`.
- *Where:* harness `internal/orchestrator` (system-prompt assembly, memory window block) and `internal/files`; UI shows the
  loaded files as a row in the context tray (`ContextRing`). Spec: new section in `orchestrator-memory-design.md` (the
  receipt should list instruction files and their size).
- *Dependencies:* none. *Risks:* prompt size (cap and report it); do not read `CLAUDE.md` for ACP agents (they do it
  themselves; duplicate injection); injection from untrusted repos (treat as the project owner's text, but show it).

**G2. Edit, glob and web tools in the built-in loop** · S · rank 2
- *User gets:* faster, cheaper, safer edits (a small replacement instead of rewriting a whole file) and the ability to look
  at documentation pages.
- *Others:* OC ships read with offsets and near-name hints, glob, grep, a string-replace edit, a multi-file patch, webfetch
  and websearch, each with its own permission action. CU's agent edits by suggested diffs and has web search and fetch.
- *Where:* harness `internal/tools/local` (new tools next to `write_file`; reuse `confine.go`, the change tracker and the
  approval hook so supervised mode and per-turn revert keep working); fetch needs an allow-list setting and the redactor.
  Spec: `2026-11-10-project-harness-design.md`, tools section.
- *Dependencies:* none. *Risks:* web fetch reads untrusted pages (mark results as data; no instruction following); size caps.

**G3. Desktop notifications for done / needs approval / failed** · S · rank 3
- *User gets:* long runs stop needing a watched window; a phone-less version of "come back now".
- *Others:* OC has per-event desktop notifications and sounds plus unread dots; CU has unread counts, a menu-bar count and
  chimes.
- *Where:* desktop (`src-tauri` notification plugin, capability file) driven by events the UI already folds
  (`project.attention`, `approval.requested`, `turn.finished`); a Settings > General row. No harness change.
- *Dependencies:* Tauri notification plugin; focus detection so a visible window is not nagged. *Risks:* macOS permission
  prompt; Linux notification daemon varies (unverified here, no WebKit/Tauri build in this environment).

**G4. "History compacted" marker, manual compact, and a context breakdown** · S · rank 4
- *User gets:* knowing when the agent no longer sees early messages, a button to compact before a big task, and a view of what
  fills the window.
- *Others:* OC compacts near the limit, keeps recent tokens beside a summary and has `/compact`; CU's ring opens a split of
  prompt, tools, rules, skills, MCP, summary and conversation, `/summarize` compacts.
- *Where:* harness already stores compactions and context receipts (memory M2); UI: marker row in the conversation and a
  popover on `ContextRing`; agent-client: `Bridge` member for "compact now" (client first, per the Bridge rule). Spec:
  UI spec part 2 and memory spec M3.
- *Dependencies:* G1 adds a "rules" slice. *Risks:* compaction cost shows in usage; label it.

**G5. File quick-open and search in files** · S · rank 5
- *User gets:* jump to any file from the keyboard, and find text across the project without asking the agent.
- *Others:* CU has Cmd+P and Cmd+Shift+F inside its agent window; OC web has Ctrl+Alt+P open file and Ctrl+K "search
  everything".
- *Where:* ui palette (`CommandPalette.tsx` gets a Files group fed by the existing files API) and a search tab backed by the
  harness's `search_files` implementation exposed as a bridge call (`internal/tools/local/search.go`, `internal/files`).
- *Dependencies:* none. *Risks:* large trees (reuse the filter's 200-directory / 5,000-entry limits).

**G6. Export a conversation, and search past requests** · S · rank 6
- *User gets:* a Markdown/JSON file of a project's conversation (for a bug report or to hand to another tool) and a find box
  over past requests.
- *Others:* OC exports and imports sessions as files and searches them from Home; CU searches transcripts with a local index
  and can share a redacted link (cloud).
- *Where:* harness (read endpoint over messages, redactor reused); UI action in the title bar "..." menu; search can reuse
  memory's FTS (`memory/search`). Spec: `project-harness-design.md` bridge API.
- *Dependencies:* none. *Risks:* exports must pass the redactor; say that redaction is best-effort.

**G7. Plan and Ask modes** · M · rank 7
- *User gets:* "think before touching files": a mode in which nothing writes, ending in an editable plan the user approves,
  and a read-only Q&A mode; Shift+Tab to cycle.
- *Others:* OC has a read-only Plan agent next to Build (Tab switches; plan files may be written). CU rotates Agent / Plan /
  Ask / Debug, asks clarifying questions first, saves the plan as a Markdown file and offers to build it.
- *Where:* harness project field `mode` (`agent|plan|ask`) enforced where `access` is enforced today (`orchestrator` tool
  gating: no sub-agent with `write_file`/`bash`, no delegation to write-capable ACP agents); plan stored as a note
  (existing notes API); UI composer chip and key, plan card with "Build". Spec: new short design under
  `docs/superpowers/specs/`, plus `v7` approvals for the "Build" handoff.
- *Dependencies:* G1 helps plans follow rules. *Risks:* ACP agents ignore harness modes unless started with a read-only
  permission profile (unverified per agent); Debug mode is better as a skill (G11).

**G8. "Allow always" rules and reject-with-feedback** · M · rank 8
- *User gets:* approval cards stop repeating for `git status` or one folder; deny can carry a reason that the agent reads
  (we have the note; make it a saved rule choice).
- *Others:* OC saves proposed patterns (shell prefix, skill id) as project allow rules that never override a deny, and a
  reject can carry feedback; rules are `{action, resource, effect}` in config. CU keeps an allowlist and a `permissions.json`
  with plain-English block rules reviewed by a classifier.
- *Where:* harness `approval` + `permission` (rule store in `project.sqlite`, matched before creating a card; the redactor
  and child-env rules unchanged); UI: a third button and a "Rules" list in project Settings. Spec: v7 spec "As built".
- *Dependencies:* the default access flip to `supervised` (HANDOVER) makes this urgent. *Risks:* a too-broad pattern becomes
  a hole: show the pattern before saving; shell splitting needs care (OC built a scanner for compound commands).

**G9. Rewind to a message (files and conversation, prompt restored)** · M · rank 9
- *User gets:* "that went wrong, take me back to before I asked": files return to that point, the conversation hides what
  followed, and the original text returns to the composer to edit; redo before sending.
- *Others:* OC stages `/undo` with snapshots per model step and `/redo`; CU has checkpoints on every request and CLI
  `/rewind`; neither touches git history.
- *Where:* harness `changes` already holds per-turn pre-images and a revert; add "revert turns >= N" plus message
  hiding in `projectstore` (soft-delete flag, so memory and usage stay consistent); UI: "Rewind" on a request in the turn
  rail and `Ctrl+Z`-style palette action. Spec: v7 spec and memory spec (task records must follow the rewind).
- *Dependencies:* none. *Risks:* bash side effects are not undone (say so, as OC does); memory facts digested from a rewound
  turn must be superseded.

**G10. Steer a running turn** · M · rank 10
- *User gets:* a correction delivered at the agent's next tool boundary instead of waiting in a queue or cancelling.
- *Others:* OC's Enter steers and a chord queues; CU's "send now" appends to the latest tool result; both keep in-flight work.
- *Where:* harness `orchestrator/queue.go` plus `agent.Loop` (inject a user block with the next tool results); ACP
  orchestrator path: `session/prompt` during a turn is agent-specific (**unverified**; fall back to queue). UI: the composer
  already shows queue; add the "Send now" key. Spec: v7 queue section.
- *Dependencies:* none. *Risks:* sub-agents do not receive the message (say so); duplicate with queued send-now.

**G11. Skills, custom commands and a real `/` menu** · M · rank 11
- *User gets:* reusable playbooks ("release notes", "tdd", a Debug mode) as Markdown files, invoked from `/`; the same file
  format other tools use.
- *Others:* both implement a `SKILL.md` standard (frontmatter, scoped to files, loaded on demand, permission per skill) and
  Markdown commands with arguments; CU can keep a skill active as a Custom Mode.
- *Where:* harness loads `.octo/skills` and the cross-tool directories into the orchestrator catalogue (one tool `skill`);
  ui `ComposerMenu` gets a `/` registry (commands, skills, built-ins like `/compact`, `/rewind`, `/btw`). Spec: new design,
  linked from the UI spec's composer section.
- *Dependencies:* G1 (shared file discovery), G4, G9 give built-in commands. *Risks:* skills can contain scripts, so run
  them through approvals; name collisions with ACP agents' own commands.

**G12. A review screen: working tree, base branch, last turn, PRs** · M · rank 12
- *User gets:* one place to read everything an agent changed (or a PR), mark files reviewed, comment, and hand comments back
  to the orchestrator; the harness API for this already exists.
- *Others:* OC's diff viewer scopes All/Committed/Uncommitted/Last turn with a base picker and reviewed marks; CU has a PR tab
  and an Agent Review pass with depth levels and a Bugbot on pull requests.
- *Where:* ui `components/v7/` (reuse `DiffEditor`, `DiffComments`) on the `review` Bridge members (agent-client
  `review.ts`); decision list in `2026-11-11-pr-review-design.md` (RV2 screen); AI findings (RV3) later.
- *Dependencies:* none for the screen. *Risks:* real `gh` never tried against GitHub (first live run); large PRs.

**G13. Per-hunk accept / reject in Changes** · M · rank 13
- *User gets:* keep the good part of a file, drop the rest, without reverting the whole file.
- *Others:* CU's diff view reviews and accepts per change; OC reviews per file with reviewed marks and rolls back whole steps.
- *Where:* harness `changes` + `diff` (apply reverse hunk to the file, re-snapshot); ui `ChangesView`. Spec: v7 "As built".
- *Dependencies:* G12 shares the diff widgets. *Risks:* conflicts with edits the agent makes afterwards; refuse while a
  turn is writing that file.

**G14. A standard MCP client in the built-in loop** · M (L with OAuth) · rank 14
- *User gets:* the large MCP ecosystem (issue trackers, databases, browsers) for built-in-loop agents, configured in one file.
- *Others:* both read an `mcp.json`-style config, support local and remote servers and OAuth, ask approval per tool, and OC
  lists them in Settings > Extensions.
- *Where:* harness `internal/plugins` (new `mcp` server kind next to tool servers) and `internal/tools/remote`; approvals
  through `permission`; Settings > Editor > Plugins shows state. Spec: `workspace-plugins-acp-design.md`.
- *Dependencies:* G8 (per-tool rules). *Risks:* tool results are untrusted data; a server's env must go through the
  child-env allow-list; stdio servers run as the user.

**G15. Hooks** · M · rank 15
- *User gets:* "run the formatter after every write", "block `git push`", "log every command" without changing the agent.
- *Others:* CU has command and prompt hooks at loop events (before shell, stop, ...), user and project scope; OC runs
  formatters after edits and exposes plugin hooks.
- *Where:* harness (a small event-to-command dispatcher in `orchestrator` around tool calls, using the child-env
  allow-list); config in project settings; Spec: new.
- *Dependencies:* G8. *Risks:* hooks are code execution from a repository: require the user to enable per project.

**G16. `/goal`: work until an objective is met** · M · rank 16
- *User gets:* hand over "make CI green" and come back; a judge step decides whether to continue, with pause/resume.
- *Others:* OC's goal plugin has kickoff, judge, continuation and reminder prompts; CU's `/goal` plus `/loop` skill.
- *Where:* harness `orchestrator` (loop controller around turns with the budget gate and the max-turns cap as hard stops);
  ui chip with pause. Spec: bots design is the home (phase 1 without schedules).
- *Dependencies:* G7, G8. *Risks:* runaway cost: budget gate must count judge calls; unattended approvals time out (30 min).

**G17. Inline edit from a selection** · M · rank 17 (low confidence)
- *User gets:* select code, type an instruction, review a diff in place.
- *Others:* classic Cmd+K in Cursor (**unverified** that it still exists, not in the docs I read); OC none.
- *Where:* ui editor action + harness `POST .../edit` mirroring the completion endpoint (own model setting, budget, redaction);
  result is a change entry so revert works. Spec: inline-completion design "Open".
- *Dependencies:* G2. *Risks:* none new; value depends on whether users work in our editor (owner decides).

**G18. An OpenAI-compatible provider path in the built-in loop** · M · rank 18
- *User gets:* GPT, Gemini, local models and gateways without an ACP CLI.
- *Others:* OC's catalog (models.dev) covers 100+ providers; CU hosts a curated list.
- *Where:* harness `anthropicclient` is the only client. First check whether the router's OpenAI-style proxy already allows
  this through `ANTHROPIC_BASE_URL=.../autoroute` with a translating upstream (**unverified**); if not, add a second
  client behind the same `agent.Loop` interface. Spec: `router-harness-integration.md`, providers doc.
- *Dependencies:* none. *Risks:* tool-call and cache semantics differ per provider; prompt caching is Anthropic-specific.

**G19. A worktree per sub-agent** · L · rank 19
- *User gets:* parallel agents that cannot overwrite each other, each with its own checkout and setup commands, result merged
  or pushed as a branch.
- *Others:* CU creates a worktree per agent and runs a setup script from `.cursor/worktrees.json`; OC exposes worktree
  create/list/remove to agents and a Settings page with disk use.
- *Where:* harness (reuse `internal/gitx` and the review worktree code; `spawn_agent` option `isolated`), `changes` per
  worktree, UI delegation card shows branch and "bring back". Spec: new, plus v7 changes.
- *Dependencies:* G12 (reviewing the result). *Risks:* disk and dependency install time; non-git folders; multi-folder
  projects (Cursor disables worktrees for multi-root; we would need a rule).

**G20. Terminal pane** · L · rank 20
- *User gets:* run a command next to the code without leaving the app; read the agent's `bash` output live in a real terminal.
- *Others:* OC has persistent pty services and a terminal plugin with Ctrl+` toggle, and a read API so the agent can see
  the user's terminal; CU integrates the VS Code terminal and `@Terminals`.
- *Where:* harness (pty relay endpoint, same loopback rules and approval model as `bash`), ui dock tab with xterm.js (new
  dependency; bundle budget is tight: lazy chunk), desktop none. Spec: code-pane design.
- *Dependencies:* none. *Risks:* a loopback pty is full shell access; needs the bridge auth token (P3) before any remote use.

**G21. Reach your harness from a phone or browser (pairing + auth token)** · L · rank 21
- *User gets:* watch and approve a long run from the couch; the "web" host planned in `apps/web`.
- *Others:* OC prints a one-time link and QR, uses a server password and a 30-day cookie, offers an encrypted remote tunnel;
  CU does it through its cloud (not comparable).
- *Where:* harness bridge auth (token header, per the open note in `review.md`), `apps/web` host using the existing
  `Bridge`, desktop settings switch. Spec: desktop-ui design (web host) and packaging design.
- *Dependencies:* the auth token is cross-cutting and should come first. *Risks:* exposing an unauthenticated shell-capable API
  is the main danger; default off, loopback unless asked.

**G22. Sandbox for built-in `bash`** · L · rank 22
- *User gets:* a safer `full` access: commands run with network and file limits.
- *Others:* CU runs terminal commands in an OS sandbox with network modes and falls back to a classifier-reviewed prompt;
  OC relies on rules and a shell scanner.
- *Where:* harness `tools/local` (bubblewrap on Linux, Seatbelt on macOS; none on Windows), settings in `harness.env`.
  Spec: v7 approvals. *Dependencies:* G8. *Risks:* platform matrix; false sense of safety (Cursor itself says its
  classifier "is not a security boundary").

**G23. Scheduled and event-triggered runs (bots)** · L · rank 23
- *User gets:* nightly dependency check, "fix every new bug report" as standing agents.
- *Others:* CU Automations and Project subscriptions; OC has a schedule API (experimental).
- *Where:* harness (existing bots draft: runs as agents with `bot_id`), router unchanged. Spec: `2026-11-11-bots-design.md`
  (owner questions 1-2 are open). *Dependencies:* G16, G8. *Risks:* unattended writes; budget caps per bot.

**G24. Voice dictation** · M · rank 24
- *User gets:* speak a prompt into the composer.
- *Others:* CU has dictation and a spoken agent conversation (account required); OC has realtime voice sessions in source.
- *Where:* ui composer; a transcription call through a configured provider (the harness would need an audio endpoint) or the
  webview's own speech API (availability in Tauri webviews is **unverified**). Low priority: needs a provider we do not use.

**G25. Browser tool and annotate-on-the-page** · L · rank 25
- *User gets:* the agent can open the running app, look at it, and the user can point at an element to direct a change.
- *Others:* CU's built-in browser with Design Mode annotations and CSS edit; OC's desktop browser plugin and `browser`
  Code Mode namespace.
- *Where:* desktop (a second webview) plus harness tools; or skip and let an ACP agent with a browser MCP do it (G14).
  *Risks:* large; page content is untrusted. Defer behind G14.

---

## 6. Things we do that they do not

Protect these in any refactor; do not "simplify" them toward the others.

1. **Price-aware per-task routing across API tiers and subscription CLIs.** One decision picks the cheapest able option
   (flat-rate agents with limit left first), with the never-pay-more-for-less rule and the decision recorded. OC and CU route
   only inside their own catalogue; CU's router is Teams/Enterprise and opaque (F2).
2. **Subscription-aware cost.** Estimates for flat-rate agents are shown as "on your subscription" and never counted as spend;
   hard project budget before every request, mirrored by the router's 402 (F3, F4).
3. **One orchestrator over many vendors' agents.** Claude Code, Copilot, Grok and others run as sub-agents or as the
   orchestrator under one transcript, one approval surface, one change tracker. OC's Claude Agent provider reuses a Claude
   login but replaces its tools and drops its settings, hooks and memory (`claude-agent.mdx`); CU's own agents only.
4. **Multi-folder projects** with confined file access, versus single-directory projects in OC.
5. **Orchestrator memory** (task records with exact quotes, dated and superseded facts, FTS across inflected text, context
   receipts showing what was sent). Neither competitor has a comparable local store.
6. **Secrets never reach the model.** `request_input` secret fields go to a per-project store referenced as `secret:<name>`;
   redactor on everything stored or sent; child-environment allow-list; diagnostics that cannot contain a secret (tested).
7. **Exact line comments** in code and diffs as pending review input to the orchestrator.
8. **Failure transparency:** `harness doctor`, copyable diagnostic report, ACP wire trace, "no silent failures" rule,
   retry without duplicate, pending approvals surviving a reload.
9. **Review safety design** (RV1): nothing posts without an explicit submit, no agent path to submit, PR text treated as data.
10. **Local-only by construction:** nothing leaves the machine except the model traffic the user configured.

---

## 7. Not worth copying

| Feature | From | Why not |
| --- | --- | --- |
| Cloud agents, VMs, self-hosted worker pools, mobile app, Slack/Linear/GitHub triggers | CU | Needs a hosted service and billing; against the local-first model. The local equivalent is G21. |
| Origin (git hosting), Rollouts, Security Agents, PR Routing and Approval, Grok bot | CU | Separate SaaS products on top of Cursor's cloud; no overlap with the harness. |
| Team and enterprise admin: SSO, SCIM, team marketplaces, Admin API, model access control | CU, OC Console | Out of scope for a single-owner tool. |
| OpenCode Console, Go and Zen plans, free hosted model pool | OC | A business model, not a feature; we also have no model to host. |
| Next-edit prediction, Instant Grep index | CU | Needs trained models or an index service; ours is a chat-model completion by design. Revisit only with measured latency. |
| Code Mode (`execute` JavaScript that calls tools) | OC | Clever for token savings but a second execution surface to secure; our MCP and tool results are already capped. |
| Cache-warming pings | OC | Spends tokens to save tokens; we measure cache-read share first (memory M2 receipts). |
| Leader-key TUI, 30+ TUI themes, sounds, "wordmark" sounds | OC | Style, not capability. Themes could follow the token system later at low priority. |
| Microsoft Office / Figma plugins, SSH and WSL GUI plugins | OC | Windows and remote-dev are out of scope per HANDOVER. |
| Debug mode as a hard-coded mode | CU | Better delivered as a skill after G11. |
| Canvases (agent-built interactive pages) | CU | Overlaps with Markdown preview; revisit only if users ask for dashboards. |
| Multiplayer Projects, shared transcripts, team shares | CU | Needs accounts and a backend; export (G6) covers the local need. |
| Voice chat with a spoken agent | CU | Account-bound realtime service; dictation (G24) is the most we would consider. |
| Max Mode, legacy request-based plans | CU | Billing artefacts. |

---

## 8. Claims I could not confirm

- Every statement about Cursor behaviour is from its documentation, not from running it. The app stopped at the login screen.
- OpenCode screens that appear only during a model run were not seen (live tool rows, permission prompts, question dock,
  in-session review panel, terminal panel, side-tab layout with data, Code Mode, browser). They are from source and docs.
- The OpenCode slash list was read from a scrolling menu with gaps; the entries between `/init` and `/mcps` and between
  `/quit` and `/review` were not read, so the count of "about 45" is approximate.
- `sst/opencode` redirecting to `anomalyco/opencode`: not confirmed (GitHub web blocked).
- That OpenCode V2 has no public share link, no code-line comments, no OS sandbox, no persistent todo panel: absence found by
  searching the V2 docs and source names, not by exhaustive reading.
- That Cursor still ships classic Cmd+K inline edit in 3.29: not in the docs I read.
- That our harness has no standard MCP client and that no part of the harness reads `AGENTS.md`: found by grepping
  `apps/harness/internal` and reading `internal/tools/local/local.go`; ACP agents may read their own files.
- Whether a Tauri webview supports the speech API, whether Tauri notifications behave on Linux, and whether ACP agents
  accept a mid-turn message: not testable here.
- Our own "built*" rows are as verified as the HANDOVER says: demo data, mock model, scripted agent. I looked at the UI on
  `?demo=1` only (5 screenshots) and did not run the harness.
- ARCHITECTURE.md's status table lags the tree (it still says the v7 UI, Settings and first-run are not built; the code and
  `LIVE-CHECKLIST.md` say they are). Treat the inventory in section 2 as the more current reading.
