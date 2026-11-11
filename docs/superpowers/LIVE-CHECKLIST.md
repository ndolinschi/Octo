# Live checklist 3 — owner's run

Branch `claude/harness-ui-v6-completion-8ynrkq` at `4a22c5f` or later. Everything was checked here against a scripted
agent, a mock model, a fake router and a fake `gh`, in Chromium with demo data. **(first time live)** marks what has
never run against the real thing. Send back: step number, `harness doctor` output, the trace file
(`HARNESS_ACP_TRACE=1`; e-mails and tokens are redacted, prompt text and file contents are not).

## 0. Build
1. Clean clone → `pnpm install`, `pnpm lint`, `pnpm --filter @octo/desktop build`, `bash scripts/install.sh --no-install`.
2. Packaged app with the router switched on: `router.log` no longer says "no usable price entry"; an easy request
   shows `x-octo-price-swap` as in dev **(first time live)**.

## 1. Fixed since run 2 — confirm
1. Usage → Cost shows "≈ $X on your subscription" for Claude Code, not "no price"; Grok counts as a subscription
   unless `XAI_API_KEY` is forwarded.
2. Budget stop: harness and router show the same spend (the last call's classifier cost may still lag by one call —
   say if you see it).
3. `harness doctor` without `--data-dir`: uses the app's data directory and says so; the trace line is right; Grok
   shows logged in / not logged in from `grok models`; Codex is not "available" without its CLI.
4. Logged-out Claude Code reads "Claude Code is not logged in"; the hint appears once.
5. Retry of a failed turn: one copy of the request; "Retrying…" resolves; the project shows **Failed**.
6. A stopped turn shows "Stopped".
7. Memory: trivial questions leave no task; a follow-up joins its task; finished turns close theirs; search finds
   "калькуляторами", "скобками", "молдове", "Кишинев". Optional: `window` context again vs `full` — cache-read
   tokens per turn (the window now moves in steps).
8. Router: `x-octo-tier-hint: low` is honoured; a wrong value is a 400.

## 2. New — first look
1. **Connect first:** with no key and nobody logged in, the app opens the connect screen; a project cannot be
   created with a model that cannot run (422) **(first time live)**. Enter an API key in Settings → Providers:
   the built-in loop works without a restart.
2. **Agent models:** the model picker lists Claude Code's models under "›"; choosing one switches the live session
   **(first time live — whether the adapter advertises models is unknown)**.
3. **Live activity:** during a Claude Code turn you see "Thinking…", "Reading …", tool rows as they start, a plan if
   it publishes one; nothing mute for more than ~10 s without "Still working — no output from Claude Code yet".
   If it stays mute, send the trace: it shows whether the agent sent anything **(first time live)**.
4. **Title bar (macOS):** traffic lights centred in the row, no overlap with the sidebar toggle; dragging by empty
   areas; double-click zooms; full screen moves the toggle to the edge; no "Octo" title strip
   **(first time on macOS)**.
5. Small window (≈ 830×560): New project fits, title and buttons stay put; the folder is chosen from a list
   (Recent, path completion); "Browse…" is absent until the dialog plugin is added.
6. The backdrop does not move; clicking does not flicker **(not reproducible here — WebKit only)**.
7. Opening a file from a full-width conversation: one layout change, no jump.
8. Composer, compact conversation (drag the divider until the conversation is narrow), tab named after the project.
9. Supervised project (`HARNESS_DEFAULT_ACCESS=supervised` or set on the project): approval cards for commands and
   edits, Allow once / for this turn / Deny; a form that asks for a secret stores it without showing it to the
   model; messages sent during a turn queue up; the Changes tab lists edits with a diff and Revert
   **(first time live)**.
10. Memory tab: tasks, facts (superseded struck through), search, "Context" for a turn.
11. Inline completion: set a completion model for the project (Settings → Models), type in a file: ghost text,
    `Tab`, `Ctrl/Cmd+→`, `Esc`; tell me the latency you see **(first time with a real model)**.
12. Settings as a page: every section opens, "Copy diagnostic report" works.
13. PR review (API only, no screen yet): `GET /v1/projects/{id}/prs?folder=…` lists your PRs through your `gh`
    **(first time with a real gh; posting a review is safe to skip)**.

## Known gaps
No PR review screen; the sub-agent line is not in the title bar yet; the Changes diff is cramped in a narrow pane;
Copilot has no login probe; Windows untested.
