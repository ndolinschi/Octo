# Bots — standing autonomous agents with permissions — design draft

**Date:** 2026-11-11 · **Status:** draft for the owner (request: "add an instance as a bot — a bot can be something
like a developer, an autonomous instance that does things on the computer with permissions, like the bot app in the
references"); not built
**Builds on:** [`2026-11-10-project-harness-design.md`](./2026-11-10-project-harness-design.md),
[`2026-11-10-v7-changes-queue-approvals.md`](./2026-11-10-v7-changes-queue-approvals.md) (approvals),
[`2026-11-10-subscription-agents-design.md`](./2026-11-10-subscription-agents-design.md)

## What a bot is

Today a sub-agent is born for one task and gone when it reports. A **bot** is the opposite: a named, standing agent
with a job ("Developer", "Computer admin", "Release manager"), its own instructions and memory, a **permission
profile** that says what it may do on this computer, and the ability to work **without being watched** — on a task
it was given, on a schedule, or when something happens. It keeps a record of what it did and what it produced.

Reference analysis (the bot app in the owner's screenshots):

| Pattern | Verdict | What we do |
| --- | --- | --- |
| Bots as named identities with a role, listed on the left, each with its latest line | Good: you know who is doing what | Bots are first-class; shown with state and their latest activity line |
| A bot's side panel: Activity and Library (what it produced, by day) | Good | Every bot has Activity and Library (reuses the Details sections and, from v7, per-turn changes) |
| The bot drives programs on the computer (a terminal, a coding CLI) and "hands you the screen" | Powerful; the risk is exactly why permissions exist | Capabilities are explicit and granted per bot; each risky action passes the approval rules |
| Messenger look: bubbles, reactions | Not our language | Not taken |
| A recognisable avatar per bot (coloured blob with eyes) and a list row of avatar, name, latest line (owner, 2026-11-11: "a good example") | Good: a standing identity needs a face | Generated shape-and-hue avatars, see UI decision 41 |
| Each bot is its own separate chat | Conflicts with "everything works through the project" | Bots work **inside projects**; the project's orchestrator stays the single entry point (see below) |

## Model

- **Bot** (global, in the harness registry): `id`, `name`, `role` (one line), `instructions`, `model` (a tier, a
  model id or a subscription agent `acp:<id>[/<model>]`), `permissions` (below), `created_at`. A bot definition can
  be exported/imported as one JSON file.
- **Membership**: a project has a **team** — its orchestrator plus the bots assigned to it. A bot has separate
  memory per project (notes with `author = bot`) and never sees another project's data.
- **How work reaches a bot** — always through the project:
  1. the orchestrator delegates to it by name (`spawn_agent` gains `bot`), like a sub-agent that remembers;
  2. the user addresses it from the orchestrator composer (`@Developer fix the flaky test`) — the orchestrator
     routes it and stays informed (the request and the bot's report are part of the project conversation);
  3. **standing tasks**: a bot may have tasks it runs on its own in a project — on a schedule (cron-like) or on a
     trigger (a file change under a path, a failed command it watches). Each run is an agent run in that project
     with a report posted to the orchestrator conversation as a compact card ("Developer · nightly dependency
     check · 2 files changed · Review").
- **Runs** are ordinary agents in the project database (`agents.bot_id` set), so transcripts, usage, changes and
  approvals all work unchanged. A bot has at most one run at a time per project; further tasks queue.

## Permissions

A permission profile is data, enforced by the harness (never by the prompt):

```ts
type BotPermissions = {
  access: "supervised" | "autonomous";      // supervised: every write/command asks; autonomous: rules below decide
  files: { folder: string; mode: "read" | "write" }[] | "project";   // default: the project's folders, read
  commands: { allow: string[]; ask: string[]; deny: string[] };      // program names / prefixes; default: ask all
  network: "none" | "allowlist" | "any"; hosts?: string[];
  agents: string[];                         // ACP/subscription agents it may drive
  computer: "none" | "screen" | "control";  // phase 3: see the screen / control mouse and keyboard
  limits: { max_run_minutes: number; max_turns: number; budget_usd?: number; runs_per_day?: number };
};
```

- Anything not allowed is asked (approval card, v7) or denied — never silently done. A denied action returns an
  error to the bot so it can adapt.
- **Unattended runs cannot ask** nobody: when a standing task hits an "ask", the run pauses with "Needs you" on the
  project and the bot; it resumes when answered, or ends after a configurable wait.
- Limits are hard stops enforced by the harness (time, turns, spend, runs per day).
- Every action a bot takes is logged with the rule that allowed it (audit trail in Activity).
- `computer` (GUI control) is declared now and built last; phase 1–2 bots act through files, commands and agents.

## Harness

- Registry tables: `bots`, `bot_projects(bot_id, project_id)`, `bot_tasks(id, bot_id, project_id, title, prompt,
  schedule | trigger, enabled, last_run_at, next_run_at)`; per-project `agents.bot_id`.
- API: CRUD `/v1/bots`, `PUT /v1/projects/{pid}/team`, CRUD `/v1/projects/{pid}/bot-tasks`,
  `POST /v1/projects/{pid}/bot-tasks/{id}/run`; events `bot.run.started|finished`, `bot.needs_approval`.
- A scheduler in `harness serve` (in-process; runs missed while the harness was down are skipped, not replayed, and
  shown as skipped).
- Enforcement lives in the tool layer: file tools check the bot's `files`, the command tool checks `commands`,
  remote/ACP tools check `agents` / `network`; approvals reuse v7.

## UI

- **Sidebar**: under Projects, a **Bots** section — one 40px row per bot: generated avatar (UI decision 41) with the state ring, name, latest line
  ("Working in Atlas API", "Needs you", "Idle"). Click opens the bot's page.
- **Bot page** (a tab): Profile (role, instructions, model), **Permissions** as plain-language rows with their
  setting ("Run commands — ask every time", "Write files — orbit-app only", "Network — off"), Projects it works
  in, Standing tasks (schedule, last/next run, enable), Activity (runs, newest first, with the rule log), Library
  (what it produced).
- **In a project**: the team strip and the orchestrator header show bots next to sub-agents (bots keep their name
  and tile); `@` in the composer lists the team; bot reports appear as cards in the orchestrator conversation;
  approvals from a bot name the bot and the rule that triggered the question.
- **Creating a bot**: a dialog with a few starting profiles (Developer — writes code in the project folders, asks
  before commands; Reviewer — read-only; Operator — commands allowed from a list, no writes), each fully editable.

## Phases

1. **Bots as standing team members** — definitions, team membership, per-project memory, delegation by name and
   `@` addressing, permission profiles enforced for files/commands/agents, the Bots section and bot page.
   *Needs v7 approvals first.*
2. **Autonomy** — standing tasks (schedule and triggers), unattended runs with pause-on-ask, limits, audit trail,
   report cards.
3. **Computer control** — screen view and GUI control behind `computer`, with its own approval rules.

## Questions for the owner

1. Is "bots work inside projects, through the orchestrator" right — or should a bot also be reachable on its own,
   outside any project (its own standing conversation, like the reference app)? The draft assumes inside projects,
   matching "everything works through the project".
2. Does "do things on the computer" need GUI control (screen, mouse, keyboard) early, or are files, commands and
   coding-agent CLIs enough for the first two phases? The draft puts GUI control last.
