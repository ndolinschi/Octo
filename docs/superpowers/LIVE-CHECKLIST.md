# Live checklist 4 — owner's run

The integration branch after the 2026-11-18/19 pass (`git log -1` on the machine says which commit). Sections 0 to E were
written after batch 5 (error catalogue, file tree column, slash menu, images, the Sessions tab); **section F is new
(2026-11-19) and holds what the polish, performance, security and robustness pass could not check.** Everything was
checked here against a scripted agent, a mock model, a fake router and a fake `gh`, in Chromium on Linux on demo data. None of it has run in a macOS window, with a
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

0.3 Existing data directory from an older build (schema before 15). *Expect:* the app starts; each project's database
migrates to 15 and keeps `project.sqlite.pre-v15` next to `project.sqlite`; a project that came from before 14 and had tasks
also keeps `project.sqlite.pre-m6` (a numbered name if one exists). *Send:* `ls` of the project folder and the harness log's
migration lines.

## A. The macOS / WebKit window (only your machine can show this)

A1 **Traffic lights.** Open the app. *Expect:* the three lights sit centred in the top row, 16 pt left of the sidebar
toggle, no overlap; no "Octo" title strip; dragging by an empty part of the top row moves the window; double-click
zooms; full screen moves the sidebar toggle to the edge. *Send:* a screenshot of the top-left 400 × 60 px at normal and
full screen. **(first time on macOS)**

A2 **System folder dialog.** New project → "Browse…". *Expect:* the system's folder dialog opens (the harness runs
`osascript` on macOS) and the chosen folder is added without a label field; cancelling changes nothing. If "Browse…" is
absent, the folder is chosen from the list (Recent, path completion). *Send:* which you saw. **(first time on macOS; the
dialog is the harness's `POST /v1/fs/pick-folder`, tested with fake choosers only)**

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

B11 **Antigravity.** Run the block "B-agy. Antigravity (agy)" below instead (it replaces the old one-step check).
**(no run recorded for Antigravity)**

B12 **Errors in the person's words.** Provoke one of: wrong model, an agent that exits at once, a timeout. *Expect:* one
sentence, one next step, a "Details" fold with the technical text; never "ACP", "exit status", a stack or a tool id.
*Send:* the sentence and the Details text.

B13 **Grok (and every agent) sees the terminal's environment.** Quit Octo, start it from Finder/Dock (not from a terminal), with Grok logged in from a terminal. *Expect:* Settings → Agents shows Grok ready (or "Check again" turns it ready) instead of "Grok is not logged in"; `harness.log` has one line `login shell environment forwarded: <names>` (names only, e.g. LANG, XDG_CONFIG_HOME, SSH_AUTH_SOCK); `harness doctor --data-dir <app data>/harness` lists the same names under "login-shell variables child processes get". If Grok is still "not logged in", run `harness doctor --show-probe-output` and send it with the log line; that separates an environment problem from the probe or login-state itself. **(first time live; the forwarding is verified with fake shells only, not on macOS)**

## B-agy. Antigravity (agy)

Everything here was built from Google's documentation and the CLI changelog only (2026-11-15); no real `agy` has run
with Octo. Before you start: `export HARNESS_ACP_TRACE=1` (or Settings → the same switch) so each agy process writes a
trace under `{data-dir}/traces/`. Send the trace file with any failure (read it first: prompts and file contents are in it).

AG1 **Install or update.** `curl -fsSL https://antigravity.google/cli/install.sh | bash` (or `agy update` if your version
has it), then `agy --version` and `agy acp --help`. *Expect:* 1.5.0 or newer; `acp --help` prints a usage text.
*Send:* both outputs and `which agy`.

AG2 **Doctor sees it.** `harness doctor --data-dir <app data>/harness`. *Expect:* `antigravity (Antigravity): available,
login unknown`, `command:` the path from AG1 (also when it is only in `~/.local/bin`), `version: version 1.x.y (needs
1.5.0 or newer)`, `probe: this agent has no login probe`, `experimental`. *Send:* the antigravity block.

AG3 **Too old is said before the start** (only if you still have an agy older than 1.5.0, or point a copied entry's
`command` at an old one). *Expect:* Settings → Agents: "Antigravity 1.4.x is too old for Octo; it needs 1.5.0 or newer.",
the installer line to copy, "Check again"; after updating, "Check again" turns it ready without a restart. *Send:* the notice.

AG4 **Signed out.** Sign out (`/logout` in an interactive `agy`), restart Octo, pick Antigravity as the project's main agent,
send "hello". *Expect:* one notice "Antigravity is not logged in." with `agy acp --login` to copy and "Check again"; no
browser window opens by itself. *Send:* the notice and the trace's `session/new` answer.

AG5 **Sign in.** `agy acp --login` in a terminal (or sign in inside `agy`), then "Check again" / send again. *Expect:* the
request runs. *Send:* nothing if it works.

AG6 **Main agent, a file edit with an approval.** Project with access **supervised**, Antigravity main agent: "add a line
'hello from agy' to README.md". *Expect:* live activity (Thinking, tool rows), an approval card with Allow / Deny for the
edit (Octo switches agy from its own `auto` mode to `default` in supervised projects); Allow → the file changes and the
change is listed under Changes. *Send:* a screenshot of the card and the trace lines `session/set_mode` and
`session/request_permission`.

AG7 **Full access keeps agy's own mode.** The same request in a project with access **full**. *Expect:* no card for edits
inside the project (agy's `auto` approves them itself); commands that leave agy's sandbox may still ask. *Send:* what asked.

AG8 **Models.** The model chip under Antigravity. *Expect:* the models of your account with agy's names (from agy's own model
picker), the current one marked; choosing one switches it for the next request. *Send:* the list and the trace's
`session/new` answer (`configOptions`).

AG9 **Helper on agy.** In a project whose main agent is Claude Code (or the built-in loop), ask it to "delegate to
antigravity: list the files in src". *Expect:* a sub-agent row "acp:antigravity" that finishes with a report. *Send:* the
row and any error.

AG10 **Plan and Ask.** Switch the composer to Plan, ask for a change. *Expect:* a plan card, no file changed (trace:
`session/set_mode` with `plan`). Ask mode: an answer, no change (agy has no ask mode; Octo denies writes). *Send:* the plan.

AG11 **Stop.** Ask for something long ("run the full test suite and fix failures"), press Stop while a tool runs or while
an approval card waits. *Expect:* the turn ends "Stopped" within about a second, open tool rows end, the card disappears;
the next request answers at once (same agy process: `harness doctor` or `ps` shows one `agy acp` per session). *Send:* the
time it took and the trace's last lines.

AG12 **Resume after a restart.** After a few exchanges, quit and reopen Octo, open the same session, ask "what did I ask
you before?". *Expect:* the answer knows (trace: `session/load` with the stored id; if agy refuses it, Octo starts a new
session with a recap). *Send:* the answer and whether `session/load` succeeded.

AG13 **Images and "/".** Paste a screenshot and ask about it; type `/`. *Expect:* agy reads the image; the "/" menu lists
agy's own commands under Octo's. *Send:* the image answer and the list.

AG14 **Sign out mid-way.** Sign out in a terminal while Octo is open, send a request. *Expect:* "Antigravity is not logged
in." (not a crash or a silent turn), then AG5 brings it back. *Send:* the notice and agy's own error text from the trace.

AG15 **Report.** `harness doctor --json --data-dir <app data>/harness > doctor.json` and the trace files of the run.
*Send:* both, and the steps that did not match their *Expect*. When all pass, the `antigravity` entry can get
`"verified": true` in `plugins-examples/subscription-agents/plugin.json`.

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
- **Entry bundle** is 160.39 kB gzip against a budget of 161.00 (`scripts/check-bundle-size.mjs`, 2026-11-19).
- **Not built:** review RV3 (the AI pass), parity B8–B10, the savings view, bots, subscription routing through the router,
  embeddings for Memory search, applying a worktree's work back to the main checkout, a file-system watcher, rename / delete /
  new file in the file tree, a licence file, signed builds and an updater.
- **Known debt:** 49 native controls outside `primitives` (lint warning `octo/no-native-controls`; per-folder counts in
  `research/2026-11-12-ui-component-audit.md`); review findings of rounds 1 and 2 that batch 5 did not close.
- **Known quirks:** `Settings → Commands` still has the "Settings for" project row (Models no longer does); Copilot has
  no login probe beyond the advisory one.

## F. What the 2026-11-19 pass could not check (polish, performance, security, robustness)

Everything in this pass was verified on Linux in Chromium on demo data, and against a real `harness serve` on the mock
model for the file tree, the branch chip, the Markdown images and the CSP. These are the checks that need your machine.
Send back what the other sections ask: the step number, one sentence, a screenshot.

F1 **Traffic lights, with the guide.** On the Mac: the app's binary inside `Octo.app/Contents/MacOS/` started from a terminal with `OCTO_DEBUG_CHROME=1` set (or
`OCTO_DEBUG_CHROME=1 pnpm --filter @octo/desktop tauri dev`). *Expect:* a 1 px magenta line across the top row at its
control centre; the three lights' centres, the sidebar toggle, back and forward all sit on it; the red light's left edge is on
the glyph column of the sidebar's Home / Search / Review rows (24 pt); the green light is 4 pt from the toggle. The configured position
is logged (a line starting `octo chrome:`, on stderr and in the web inspector's console). *Send:* a screenshot of
the top-left 400 x 60 px, and the logged line. If the lights are off by n points, change `y` in `tauri.macos.conf.json` and
`MAC_LIGHTS_Y` in `src/windowChrome.ts` by n. Also say your macOS version: on 15 and older the lights are 20 pt apart, not
23, and the gap to the toggle would be 10 pt. **(first time after the 2026-11-19 change; macOS 26 drawing measured from your screenshots)**

F2 **The CSP in the Tauri window.** Open the web inspector of the app and its console. Use chat, Files (open a file: Monaco),
Terminal (type a command), Browser (a local dev site), Review, Settings. *Expect:* no "Content Security Policy" violation in the
console and nothing blocked in the UI. Then ask an agent to answer with `![x](https://example.com/a.png)`. *Expect:* a chip
with the host and "Load image", and no request until you press it. *Send:* the console's violation lines, if any, with what you
were doing. **(first time: the CSP ran in Chromium only, as a response header)**

F3 **Safari / WebKit.** `pnpm dev:all -- --mock`, open `http://localhost:1420` in Safari. Walk: a long prompt (A3), opening
files (A4), changing project from the sidebar (no blink), a long conversation's scroll, the branch picker, the file tree's
compact folders, the Terminal and Browser tabs. With Playwright's WebKit: `node packages/ui/scripts/project-switch.mjs --url
http://localhost:1420 --browser webkit`. *Send:* what flickers, jumps or looks different from Chromium. **(only Playwright's
Linux WebKit ran, for the premium pass; nothing since)**

F4 **A Tauri bundle build on a machine with the system libraries.** macOS: `bash scripts/install.sh` (Xcode command-line
tools, Go, Rust, Node, pnpm needed). Linux: the WebKitGTK development packages, then `pnpm install:app -- --no-install`
(prints the AppImage path). *Expect:* the bundle builds and starts; Octo appears; the harness and router sidecars start and stop
with it (`pgrep harness` and `pgrep octo` are empty after closing the window). *Send:* the last 20 lines of a failing build.
**(the shell has never been compiled in the build environment; CI only runs `cargo check`)**

F5 **Process clean-up on macOS.** Open a terminal tab and start a run (Processes tab, a command that sleeps). Find the
`harness` process of the app (`pgrep -f 'harness serve'`) and `kill -9` it; the app shows its failure screen; press Retry or
reopen the app. *Expect:* the shell and the run you started are gone (`ps`), and the new harness is up. Then quit the app
normally: no `harness`, `octo`, shell or agent process is left. *Send:* `ps` output after each step. **(compiled for macOS,
never run there; Linux was run)**

F6 **Real agents: approvals.** In a project with access "Ask first" and Claude Code (then Copilot or Grok) as the agent, ask
for a change that edits a file and runs two commands, one of them compound (`ls; echo hi`). *Expect:* an approval card per
request; "Allow once", "Allow for this request" (offered for a simple command, not for the compound one), "Always", "Deny"; with
several waiting, one card with "Allow all for this request"; the scope's wording names what it covers (the program, or the
host). *Send:* a screenshot of each card and which scopes the agent's own permission request offered. **(only the scripted agent
asked for permission)**

F7 **A real Ollama.** Install Ollama, `ollama pull qwen2.5-coder:1.5b`, leave it stopped. Settings → Providers → Ollama.
*Expect:* "Not running" with `ollama serve` to copy and "Check again". Run `ollama serve`, press "Check again". *Expect:* Ready.
Then type in an editor with inline completion on. *Send:* the completion's latency (feel: under half a second or not) and what
it suggested. **(the probe was tested with a closed port and a listener, not with Ollama)**

F8 **Remote access with a real tunnel and phone.** Install `cloudflared`, Settings → Remote access → turn on (read the
warning), scan the QR code or type the code on the phone, allow the phone on the computer. *Expect:* the phone shows your
projects; it can send, answer an approval with Allow or Deny, and stop; "Always" and "for this request" are not offered, and a
direct `POST` of them is refused (`remote_decision_forbidden`); settings, file writes and the Browser tab are not
available. Turn it off: the phone loses access at once. *Send:* a screenshot of the phone's approval card and any refusal text.
**(only a fake `cloudflared` ran)**

F9 **The branch picker on your repository, with a worktree.** Click the branch chip on the new-session screen of a project in
a git repository (macOS paths). *Expect:* the branch you are on; switching to a clean branch works and the chip follows; with
uncommitted tracked changes the picker refuses and offers "Start in a worktree from <branch>"; choosing it makes a new session
in a worktree and leaves the main checkout as it was. Run a real agent in that worktree and ask for an edit. *Send:* a
screenshot of a refusal; the worktree's path; whether the agent edited the worktree and not the main checkout.

F10 **The router's stored text.** Switch the router on (Settings → Providers → router, with a provider key), send one request,
then run `sqlite3 <app data>/router/history.sqlite "SELECT count(*) FROM calls WHERE request_payload IS NOT NULL;"`.
*Expect:* more than 0, the request text is stored (the default `store_payloads = true`).
*Decide:* keep the default, or ask for `store_payloads = false` in the app's generated `history.toml`. *Send:* your decision.

F11 **A file made outside Octo.** In a terminal outside Octo, create a file in the project folder. *Expect (known gap):* it does
not appear in the Files tree until you collapse and open its folder again. *Send:* nothing, unless it appears by itself
(then the note in HANDOVER item 8 is stale).

F12 **Scroll feel.** Open `?demo=1` Stress conversation in the app's window (or a real conversation of 100 turns) and scroll
up fast, then press Send. *Expect:* no judder you can see; the sent message lands at the end. *Send:* a screen recording if it
stutters. **(at 4x CPU in Chromium the target was not met; this is the real-machine answer)**
