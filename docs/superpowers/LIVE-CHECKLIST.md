# Live checklist — owner's run

Branch `claude/harness-ui-v6-completion-8ynrkq`. Everything below was checked here only against a scripted agent, a
mock model and a fake router; the points marked **(first time live)** have never run against the real thing.

For any failure send back: the step number, `harness doctor` output (or Settings → diagnostics when it exists), and
the trace file from `{data-dir}/traces/` if step 0.3 was on. Read the trace before sending: it contains prompt text
and file contents (tokens are redacted).

## 0. Build and start

1. Clean clone, `pnpm install`, `pnpm lint`, `pnpm --filter @octo/desktop build` — all pass (the type error from the
   last run is gone).
2. `bash scripts/install.sh --no-install` — one pass over prerequisites; the app bundle is built; icons accepted.
3. Start with tracing: `HARNESS_ACP_TRACE=1 pnpm dev:all` (or put `HARNESS_ACP_TRACE=1` in `{data-dir}/harness.env`
   for the installed app). With port 8790 busy it moves to the next free port and prints the addresses.
4. `kill -9` the desktop app → `pgrep -fa 'harness|octo'` shows no sidecar left **(first time live)**.
5. Light system theme → the start screens are light from the first frame **(first time live)**.

## 1. Diagnostics

1. `cd apps/harness && go run ./cmd/harness doctor` — Claude Code, Copilot, Grok are listed first; each says ready /
   not logged in / not installed with the install and login text. Tell me where the text is wrong for your install
   (**the Grok command line and all install commands are unverified**).
2. No key or token value appears anywhere in the output.

## 2. Each agent as orchestrator (Claude Code, then Copilot, then Grok)

Create a project with that agent as orchestrator and:

1. Ask a question about a file in the project → an answer; the header shows the agent.
2. Ask it to delegate ("use a sub-agent to list the TODOs") → a sub-agent row appears, linked to the tool call; the
   tool row reads `spawn_agent`, not `mcp__octo-harness__…`.
3. Second request in the same project → same session (it remembers the first).
4. Stop mid-answer → the turn ends as cancelled.
5. Log the agent out (or use one that is not logged in) and send a request → the turn **fails visibly** with what to
   do. If it shows "Idle" with nothing, send the trace — this is the Copilot case from last time.
6. Usage → the agent's cost is shown as "≈ $X on your subscription" and is **not** in the spent total or the budget.

## 3. Each agent as sub-agent

Built-in orchestrator (API key or router), `spawn_agent` with `agent: copilot`, then `grok`, then `claude-code`: the
sub-agent reads a file and answers; logged out → a failed row with the hint.

## 4. Router

1. `pnpm dev:all -- --router` with `OCTO_ROUTER_UPSTREAM_KEY`: an easy task → response headers / call record show
   `x-octo-decided-tier` and `x-octo-price-swap: 1` when a cheaper higher tier served it **(first time live)**.
2. Start-up log names the inverted ladder and which tiers are served by which.
3. Set a small project budget → when the router's spend passes it, the orchestrator's next request is not sent and
   the message names both numbers; the harness and the router show the same spend.
4. Check one billed call against `apps/router/config/prices.toml` for the low tier (0.051 / 0.567 was taken from
   your message, not from a bill).

## 5. v7 on the API (the UI for it is not built)

`bash apps/harness/scripts/e2e-v7.sh` passes on your machine. Optional by hand: `POST /messages` during a turn
answers 202 queued; `GET /v1/projects/{id}/changes` lists files changed by a bash command.

## 6. Memory (API only; no screen yet)

1. After a few requests: `GET /v1/projects/{id}/tasks` — one record per request, goal filled; with a side model,
   facts appear a moment after the turn. Judge the facts: useful or noise? **(first time with a real model)**
2. `GET /v1/projects/{id}/memory/search?q=<a detail from an early request, in another word form>` finds it; a
   query about something never discussed says nothing matches.
3. Optional: `PATCH` the project with `{"memory":{"context":"window"}}`, work for a while, ask about something older
   than five messages → does the orchestrator search? `GET …/turns/{messageId}/context` shows what it had.
   Compare cache-read tokens per turn with `full` mode in Usage.

## 7. UI part 2 (in progress — look, do not sign off)

Tables in answers; model picker lists ACP agents; rings distinguishable without colour; Ctrl+Tab stays in its group;
Home streak. Known open: served vs chosen model name in the header, cut header text, P9 first-run screen, approval
cards, changes view, memory view, aurora effect, inline completion.

## Not covered by anything yet

macOS install / Gatekeeper / Cmd+Q, Windows, touch and trackpad drag, screen readers, a month-long project.
