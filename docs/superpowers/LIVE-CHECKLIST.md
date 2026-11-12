# Live checklist 4 — owner's run

Branch `claude/harness-ui-v6-completion-8ynrkq`, the commit after batch 5 (error catalogue, file tree column, slash menu,
images, the Sessions tab) — `git log -1` on the machine says which. Everything below was checked here against a scripted
agent, a mock model, a fake router and a fake `gh`, in Chromium on demo data. None of it has run in a macOS window, with a
real `gh` on your fork, or with Copilot, Grok or Antigravity logged in. **(first time live)** marks what has never run
against the real thing.

**What to send back for any step that does not behave:** the step number (for example `B7`), one sentence on what you
saw, a screenshot, and for an agent the output of `harness doctor --show-probe-output` and the wire trace
(`HARNESS_ACP_TRACE=1`; e-mails and tokens are redacted, prompt text and file contents are not). The in-app "Copy
diagnostic report" in Settings is the short version of the same.

## 0. Build and start

0.1 Clean clone → `pnpm install`, `pnpm lint`, `pnpm --filter @octo/desktop build`, `node scripts/check-bundle-size.mjs`,
`bash scripts/install.sh --no-install`, then the real install. *Expect:* every command passes; the bundle line says
"within budget". *Send:* the last 20 lines of the failing command.

0.2 Packaged app with the router switched on. *Expect:* `router.log` has no "no usable price entry"; an easy request
shows `x-octo-price-swap` as in dev. *Send:* `router.log`.

0.3 Existing data directory from an older build (schema before 14). *Expect:* the app starts; each project's database
migrates; a project that had tasks keeps `project.sqlite.pre-m6` next to `project.sqlite` (M6 clean-up backup, a numbered
name if one exists). *Send:* `ls` of the project folder and the harness log's migration lines.

## A. The macOS / WebKit window (only your machine can show this)

A1 **Traffic lights.** Open the app. *Expect:* the three lights sit centred in the top row, 16 pt left of the sidebar
toggle, no overlap; no "Octo" title strip; dragging by an empty part of the top row moves the window; double-click
zooms; full screen moves the sidebar toggle to the edge. *Send:* a screenshot of the top-left 400 × 60 px at normal and
full screen. **(first time on macOS)**

A2 **System folder dialog.** New project → "Browse…". *Expect:* if the dialog plugin is not in this build, "Browse…" is
absent and the folder is chosen from the list (Recent, path completion); if present, the system dialog opens and the
chosen folder is added without a label field. *Send:* which of the two you saw. **(first time on macOS; the Tauri dialog
plugin is designed, not built)**

A3 **A long prompt.** Paste about 60 lines into the composer, then type at the end. *Expect:* the box grows up to its
cap and then scrolls; nothing in the window jerks, flickers or changes width while you type; the caret never jumps.
*Send:* a screen recording, if it flickers. (Chromium here: `flicker.mjs` passes; WebKit not tried.)

A4 **Opening files, tree column.** Open the Files tool; click a file, then another with a very long line, then a short
one. *Expect:* the tree is a column on the left and stays; picking a file changes only the editor's content (decisions 85
and 94a); no pane changes width by a pixel (decision 79); the tree keeps its scroll. *Send:* a recording of the three
clicks. (This was reported three times from macOS; the fix is verified in Chromium only.)

A5 **Maximise.** With a pull request or a file open: `Ctrl/Cmd+Shift+Enter`, then `Esc`. *Expect:* the group takes the
whole window and goes back to the same layout; double-click on the tab does the same.

A6 **Small window** (about 830 × 560, then 390 wide if you can resize that far). *Expect:* the sidebar becomes a drawer;
New project fits; nothing scrolls sideways; the conversation turns compact.

A7 **Light and dark.** Switch the theme in Settings. *Expect:* every screen of A1–A6 reads in both; no
coloured frames around approval, form, plan or failed-turn cards (decision 81). *Send:* a screenshot of the one that
does not.

## B. Real agents: Claude Code, Copilot, Grok, Antigravity

For each agent, first `harness doctor --show-probe-output` (add `--data-dir` of the app if you want the app's state).
*Expect:* the agent's command, its login probe and the probe's own output; logged out reads "… is not logged in" with the
hint once. *Send:* the whole output.

B1 **Model lists and choosing a model.** Composer → the model chip. *Expect:* the agent's models appear under its name
(from the adapter's own list, or "The agent picks its own model" when it advertises none); choosing one switches the live
session; the chip shows the agent's name and the model, never an id. *Send:* the list you see and what the adapter
advertises (wire trace, `session/new` answer). **(first time live for models of Copilot and Grok)**

B2 **"Check again" and "Use anyway".** Log the agent out in a terminal (or pick an agent you are not logged in to) and
send a request. *Expect:* one notice in the person's words ("Copilot is not logged in", the hint, a copy button for the
login command) with Check again; after logging in, Check again turns it ready and the request goes out; for an agent
whose login the probe cannot confirm, "Use anyway" sends once without the check. *Send:* the notice's text and the
doctor output.

B3 **A turn with live activity.** Send a request that reads files and runs a command. *Expect:* "Thinking…", "Reading …",
tool rows as they start (one row each: glyph, verb, detail, time), a plan when the agent publishes one; if nothing
arrives for about 10 s the line says "Still working — no output from <agent> yet". *Send:* the wire trace if it stays
mute. **(first time live for every agent but Claude Code)**

B4 **Tasks only for real work, without an API key (M6).** With no API key, ask a question; then ask for a change that
edits a file. *Expect:* the question leaves a record in Memory → Sessions and no task; the change makes one task with its
files and state; a repeat of the same request joins the task instead of making a second. In an old project:
`project.sqlite.pre-m6` exists and the Memory tasks list is shorter than before. *Send:* a screenshot of Memory and the
backup's `ls`.

B5 **Side question on the agent.** `Ctrl/Cmd+;`, ask something about the code. *Expect:* it runs in a read-only session
of the project's own agent, is not added to the conversation, has its own stop; with nothing able to answer, one notice
says so. *Send:* the notice or the trace. **(first time live)**

B6 **Slash menu, including the agent's own commands.** Type `/` at the start of the composer. *Expect:* Octo's commands
(`/mode`, `/model`, `/memory`, `/settings`, `/help`, `/clear`, `/context`) and the commands the agent advertises, each
with its description; ↑/↓ and Enter pick; Esc closes; an agent command is sent to the agent. *Send:* the list you see and
`GET /v1/projects/{id}/slash-commands`.

B7 **`/clear` with the carried summary.** After a few exchanges, `/clear`. *Expect:* the chat is tidied with a marker;
nothing is deleted (Memory → Sessions still has the old session); the new session starts with a short summary of the old
one; finished tasks close. *Send:* the marker's text and the first reply after it.

B8 **`remember`.** Tell the agent "remember that deploys go through the staging branch first". *Expect:* a note or fact
appears in Memory → Knowledge with its subject; the next session's prompt carries it (Context report). *Send:* the
Knowledge row and the Context report.

B9 **Images.** Paste or drop a picture into the composer, then send. *Expect:* a chip with a thumbnail and size; sending
carries it; an agent that does not accept images says so before sending ("… can't read images, so it would ignore
these") and keeps the message in the box. Try each agent and write down which accepts them. *Send:* the table
agent → accepts or not, and the harness's refusal text. **(first time live)**

B10 **Sessions.** Open "Show sessions" from the palette (or the sidebar chevron on a project with several sessions).
- New session: a fresh conversation; the old one stays in the list.
- Resume an old session: *Expect:* the context is rebuilt from that session (the ACP `session/load` when the agent
  supports it, else a recap) and the next reply knows what that session discussed. *Send:* the first reply and
  `GET /v1/projects/{id}/sessions`.
- Open an agent session from a delegation row ("Open session") and from the "N agents" button. *Expect:* the Sessions tab
  with that agent selected.
- Message a finished sub-agent. *Expect:* "Continued" (it works again) when its conversation was kept, a plain sentence
  when it was not; a working agent takes a "Steered" message. *Send:* the sentence you got. **(first time live)**

B11 **Antigravity after `agy update`.** Run `agy update`, then pick Antigravity. *Expect:* it starts in agent mode; if
its command is rejected the notice says the version may not support the Agent Client Protocol and names `agy`; after the
update it works. *Send:* the notice and the doctor output. **(no run recorded for Antigravity)**

B12 **Errors in the person's words.** Provoke one of: wrong model, an agent that exits at once, a timeout. *Expect:* one
sentence, one next step, a "Details" fold with the technical text; never "ACP", "exit status", a stack or a tool id.
*Send:* the sentence and the Details text.

## C. Review on your fork with a real `gh`

C1 **Repository menu.** Open "Review a pull request" in a folder whose remote is a fork. *Expect:* every open pull request
with filter tabs and search; a repository menu (fork, parent, All) appears because the folder has several repositories;
the list is instant from the cache on the second open. *Send:* a screenshot and `gh auth status`.

C2 **Open by address or number.** Paste a pull request URL, then a bare number. *Expect:* it opens against the right
repository; a number that exists in both gets a choice, not a guess.

C3 **Threads, reply, check out.** Open a pull request with comments. *Expect:* files with thread counts; inline threads;
a reply is saved in the submit sheet; "Check out" offers a read-only workspace or a branch in the folder and lists dirty
files first. *Send:* what failed and the harness log lines.

C4 **Submit.** Submit a review with one comment on a throw-away pull request. *Expect:* one atomic review on GitHub with
your replies. **(posting is not verified anywhere — use a pull request you can delete)**

C5 **Commands in a review.** Run a project command while a review is open. *Expect:* it runs in the checked-out
workspace; "Run: name" shows its output in a tab.

## D. Memory, notes, usage, context

D1 **Memory** opens on Sessions: every request and its answer is a row that opens in place; search finds words in any
form ("калькуляторами"); Knowledge groups facts by subject; Files lists the memory files. *Send:* a screenshot of
anything that looks wrong at about 480 px wide.

D2 **Notes with descriptions.** Add a note with a description. *Expect:* the Context report lists its title and
description in the index; pinned notes whole; the agent can `read_note` and `search_notes`.

D3 **Usage per model.** Usage tab → By model; Settings → Usage by project. *Expect:* one row per model or agent-model,
input, cached, output, total, requests, cost; a subscription agent says "≈ $X on your subscription"; budget stop shows
the same spend in the harness and the router. *Send:* the table if a number looks wrong.

D4 **Context report.** The context ring → "Open context details", and `/context`. *Expect:* the whole window, itemised
by tool, file, note and message kind; "Compact now" works and says what it saved.

D5 **Export.** Project "⋯" → Export conversation. *Expect:* a Markdown file downloads; if it fails, a notice with the
harness's message appears under the top row.

## E. Known gaps and what is not verified

- **Not verified anywhere:** the macOS window and the Tauri glue in a real webview; WebKit for all newer UI (the file
  tree, sessions, memory); Windows; touch; screen readers; a real `gh` on a fork; posting a review; Copilot, Grok and
  Antigravity logged in; images with any real agent; `session/load` with a real agent; completion latency with a real
  model; the entry bundle on a cold start over a slow disk.
- **Entry bundle** is 163.6 kB gzip against the 158 target (budget 164.6 in `scripts/check-bundle-size.mjs`).
- **Not built:** the Tauri folder dialog, review RV3 (the AI pass), parity B8–B10, the savings view, bots, subscription
  routing through the router, embeddings for Memory search.
- **Known debt:** 49 native controls outside `primitives` (lint warning `octo/no-native-controls`; per-folder counts in
  `research/2026-11-12-ui-component-audit.md`); review findings of rounds 1 and 2 that batch 5 did not close.
- **Known quirks:** `Settings → Commands` still has the "Settings for" project row (Models no longer does); Copilot has
  no login probe beyond the advisory one.
