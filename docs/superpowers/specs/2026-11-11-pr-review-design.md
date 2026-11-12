# Pull-request review — design

**Date:** 2026-11-11 · **Status:** approved to build after R1 and the v7 UI (owner: "I want to improve code review;
PR review must be good; I must be able to pick a PR and start reviewing it simply and conveniently")
**Builds on:** v7 changes and diffs ([`2026-11-10-v7-changes-queue-approvals.md`](./2026-11-10-v7-changes-queue-approvals.md)),
code comments and language servers (UI spec v5), side questions, sub-agents.

## What exists today

The editor has line comments that are sent to the orchestrator, and the harness records file changes per turn with
diffs. There is no notion of a pull request, no way to list or open one, and nothing is ever posted to a code host.

## The experience

1. **Pick.** "Review" in the sidebar and in the command palette (`Ctrl/Cmd+K` → "Review a pull request"). A list for
   the project's repository: PRs that ask for *your* review first, then the rest; each row has title, author, size
   (files, +/−), checks state, age, and "new commits since your review". Three other ways in: paste a PR URL,
   type a number, or "Review a local branch" (base and head pickers) — the last one needs no code host at all.
2. **Open.** One click. The PR is checked out into its own **git worktree** under the project's data directory —
   the user's working tree is never touched — and a Review tab opens: left, the file list; centre, the diff; right
   (or below when narrow), the conversation for this review. Ready in the time it takes to fetch; the AI pass
   starts in the background and never blocks reading.
3. **Read in a sensible order.** The file list is not alphabetical: the harness orders files as a reader would —
   the core change first, then callers, then tests, then mechanical changes (lock files, generated code, renames,
   formatting) folded at the bottom. Each file shows size, a risk mark from the AI pass, and a "viewed" checkbox
   (remembered per head commit; a file that changed after you viewed it comes back as "changed since viewed").
   `j/k` next/previous change, `]`/`[` next/previous file, `v` viewed, `c` comment, `s` suggestion.
4. **Understand.** Above the diff: the PR description, commits, checks, and a short "what this PR does" written by
   the AI pass with links to the hunks it refers to. Because the worktree is real files, the language server works
   in the diff: hover, go to definition, find references. Select lines → "Ask" opens a side question about that
   hunk ("why is this safe?", "where is this called?") without leaving the review.
5. **Findings, not noise.** The AI pass produces *findings*: file, line range, severity, a one-sentence statement,
   a concrete failure scenario, and where relevant a suggested patch. Each is checked by a second, independent
   pass that tries to refute it; only confirmed and plausible ones are shown, ranked, at most 15 by default. They
   appear as **draft comments in the margin**, visibly the assistant's, with three actions: keep as my comment
   (editable), dismiss (with a reason that tunes the next pass), or "show me" (opens the evidence).
6. **Your own comments.** Line and range comments, multi-line suggestions, file-level and general comments — all
   pending until you submit, exactly like a review on the code host.
7. **Submit.** One button opens a summary: the comments that will be posted, word for word, and the verdict
   (Comment / Approve / Request changes). **Nothing is posted until you press it; the model can never post,
   approve or merge.** Posted under your account.
8. **Come back.** After new commits the list says so; opening the PR shows only what changed since your review,
   which threads were answered or resolved, and re-runs the AI pass on the delta.
9. **Your own PR.** The same screen for a PR you authored, plus "Fix" on a finding or on a reviewer's comment: the
   orchestrator makes the change in the worktree as a normal turn (approvals apply), and you push when satisfied.

## Decisions

1. **Code host through the user's own CLI.** First adapter: GitHub through the `gh` CLI on the user's machine
   (list, view, diff metadata, checks, post a review). The harness never stores a GitHub token; it calls `gh`
   with the user's login. `GH_*` variables are passed to that one command only, not to agents. No `gh` or not
   logged in → the list says so with the command to run, and "Review a local branch" still works. GitLab and
   others implement the same small interface later.
2. **A review is a project object.** Table `reviews`: id, source (`github:owner/repo#n` or `local:base..head`),
   base and head commits, worktree path, state, viewed files, findings, pending comments, the last submitted head.
   Worktrees are removed when the PR is closed or after 14 days unused, never while a review has pending comments.
3. **PR content is untrusted input.** Title, description, comments, and the code itself may contain instructions.
   Review agents run **read-only**: no shell, no network, no secret store, no harness tools that write; their
   findings are data shown to the user. Code from the PR is never executed unless the user asks to run tests, and
   that goes through an approval even in a full-access project.
4. **The AI pass is a fixed workflow, not a free conversation.** Summary and reading order → reviewers per
   dimension in parallel (correctness, tests, security, API and compatibility, simplification) on the diff plus the
   surrounding code → a verifier per finding → ranking and de-duplication. Tiers: reviewers on the standard tier,
   the verifier on the deep tier; subscription agents may fill either role. The effort level is a setting
   (quick / standard / thorough) shown with its typical cost before it runs.
5. **Large PRs.** Above 60 files or 3 000 changed lines the pass reviews by groups, the summary says what it did
   not read closely, and the list offers "review in parts".
6. **Memory.** Dismissal reasons and the user's kept comments are stored per project as review preferences (a
   memory file) and given to the next pass, so it stops raising what this user does not care about.
7. **Diff view.** Monaco diff, split above 1100px and unified below; whitespace toggle; expand context; renamed
   and moved files paired; images side by side; binary files as a size change; generated files collapsed.

## Build order

- **RV1 — harness.** Code-host interface, `gh` adapter (tested with a fake `gh` on PATH), local-branch source,
  worktrees, the `reviews` store, diff with reading order and "viewed" state, pending comments, submit.
  API: `GET /v1/projects/{id}/prs`, `POST …/reviews`, `GET/PATCH …/reviews/{rid}`, `…/files`, `…/comments`,
  `POST …/submit`. Tests cover: nothing posted without submit; an agent has no path to submit; injection text in a
  PR description does not change tool permissions.
- **RV2 — UI.** List, Review tab, keyboard, comments and suggestions, submit sheet; 390–1920 px; demo data.
- **RV3 — AI pass.** Workflow, findings with verification, draft comments, summary, re-review of a delta.
- **RV4 — own PRs.** "Fix" turns, push, replying to reviewers' threads.

## Acceptance

- From "Review" to reading the first diff: two actions (open the list, pick). Time to first diff = fetch time; the
  AI pass never delays it.
- On a seeded repository with five planted defects and five harmless oddities, the scripted pass reports the
  defects and the verifier drops the oddities (mock model; shows the plumbing, not the judgement).
- A review survives an app restart with comments, viewed marks and findings intact.
- Not verifiable here: finding quality with real models, `gh` against real GitHub (no login in this environment),
  very large PRs. The owner's first real review is the test.

## Open

- Reviewing on the code host's side as well (a bot that comments on its own) — deliberately out: the owner asked
  for *their* review to be easy, and unattended posting is a different trust decision.
- Stacked PRs and merge queues.

## As built — RV1 (harness)

Exact API, shapes and rules: [`apps/harness/docs/review.md`](../../../apps/harness/docs/review.md). Built: code-host interface and `gh` adapter
(`internal/codehost`), local-branch source, git worktrees under `{data-dir}/projects/{pid}/review/{rid}` with the 14-day and closed-PR
cleanup (never with pending comments), the `reviews` store (schema 6: reviews, viewed marks per file blob, findings, comments, last submitted
head), the diff API with reading order (core, callers, tests, other, mechanical; renames paired; binary and image markers; sizes), pending
line / range / suggestion / file / general comments, submit (one atomic review post; preview), `review.updated`, and optional types and methods
in `@octo/agent-client`.

Deviations and additions: a fifth group `other` (docs, config, assets) sits between tests and mechanical; extra routes `GET …/reviews`,
`PATCH …/files/{path}` (viewed), `PATCH …/findings/{fid}` (keep makes a pending comment, dismiss stores the reason), `POST …/submit-preview`;
refresh is `PATCH {refresh:true}`. Local reviews submit to nowhere (comments are marked submitted and returned). No AI pass: findings are only
stored and served; no route creates them.

Verified: the three safety tests (nothing posted without submit; no agent path to submit: import graph, MCP tool list, MCP routes; PR text is
data), worktrees leave the user's working tree untouched, repositories with spaces and Cyrillic in paths, the migration from the previous
version, restart survival, all against a fake `gh` that is the only `gh` on PATH. Not verified: real `gh` and GitHub (no login here), fork PRs,
very large PRs, finding quality (RV3), the residual risk that an agent with a shell could call the unauthenticated loopback API (supervised
projects stop that command at an approval card).

## As built — bridge token

Closes the residual risk named above (an agent with a shell calling the unauthenticated loopback API: approving its own request, submitting a review).

- **Enforced:** `harness serve` requires `Authorization: Bearer <token>` on every `/v1/**` route (including settings, files, approvals and `POST .../submit`), with a 401 `unauthorized` body; `/health` and a CORS preflight are open; the MCP routes keep their per-session tokens; the two SSE routes also accept `?token=`. Constant-time comparison. Token from `HARNESS_API_TOKEN` or generated per start into `{data-dir}/api-token` (0600); `--no-api-token` / `HARNESS_NO_API_TOKEN=1` switch it off. Clients send it: agent-client (`token` option), desktop dev (`VITE_HARNESS_API_TOKEN`), the Tauri shell (per-run token, `bridge_url` returns `{ url, token }`), `scripts/dev.sh`, `test-dev-sh.sh`, the three e2e scripts. Details: harness README "Bridge API token".
- **Kept from agents:** not in the child environment (test, also with the operator allow-list naming it), not in doctor or diagnostics (test), redacted in ACP traces and the diagnostics log tail (tests), not logged (test), the data directory refused by the file API and the file tools even when a project folder contains it (tests).
- **What it does not stop, plainly.** The `bash` tool is not sandboxed: it runs `bash -c` with the harness's own privileges and the project folder as working directory; nothing confines it. A command such as `cat {data-dir}/api-token`, or reading the harness's environment from `/proc`, succeeds as the same OS user (the test `TestBashIsNotConfinedToTheDataDir` pins this so a change shows). So an agent in a `full`-access project that can run commands can still read the token and call the API, including `submit`; in a supervised project the command stops at an approval card, which is the earlier mitigation and still the only one for that case. The token does stop: processes without that access, a web page in a browser, any agent whose only reach is the harness's file tools or file API, and the harness's own children by environment. Proposed next step: run bash and ACP agents in an OS-level sandbox or as a separate user that cannot read the data directory or the harness process, or make `submit` need an interactive confirmation that does not travel over HTTP (a native dialog in the shell). Neither is built.
- **Verified:** Go tests (`internal/apitoken`, `internal/bridge` auth and file tests, `cmd/harness` serve token tests, childenv, acptrace, local), agent-client and desktop tests, sidecar tests with fake binaries (fresh token per run, environment only, not seen by the router), the three e2e scripts. **Not verified:** the Tauri shell itself (`src-tauri/src/lib.rs` cannot be compiled here without WebKitGTK; `cargo fmt --check` and the sidecar tests pass), a real browser `EventSource` with `?token=` (the client builds the URL and the server accepts it; no browser was run), Windows.


## As built — RV2 (UI)

Code: `packages/ui/src/components/review/` (all lazy: `TabView` loads `ReviewTab` on first use), pure logic in `packages/ui/src/lib/review/`
(reading-order grouping, change blocks and `j`/`k` stepping, comment-position rules, submit text and problems, key map, pull input; tests in
`review.test.ts`), demo data in `packages/ui/src/demo/review*.ts`. Registered as a dock tool tab `"review"` (singleton, like Changes), a sidebar row
"Review" under "Search", the palette entry "Review a pull request" (when a project is open) and the "+" picker (through `TOOL_TABS`).

- **Pick.** Rows for the open project's repository: review-requested first, then the rest; title, author, files, `+/−`, checks glyph (with words for
  assistive tech), age, "Review requested", "Draft", "New commits since your review". "Reviews in progress" (`listReviews`) resumes an open review.
  `available:false` shows the API's message and command with a copy button. Open by pasted address or number (Enter opens) and "Review a local
  branch" (base `main`, head defaults to the current branch of the project folder, read from the recent-folders list, else `HEAD`). A failed open says why inline.
- **Review tab.** Header: title, author, branches, checks, commits, totals, viewed progress, Refresh, Pending, Submit; "Description, conversation,
  checks" opens the pull request's own text (Markdown rendered through a component set that never fetches images and opens links outside; each block
  is labelled as written by its author and "Octo does not act on it"). Left: files grouped (core, callers, tests, other, mechanical folded), each with a
  "viewed" checkbox, "changed" mark, pending-comment count and size; below 760 px the list is a picker (select with groups, previous/next). Centre: Monaco
  diff through the injected `loadMonaco` (the dock passes the files feature's loader), split when the window is ≥ 1100 px and the diff pane ≥ 720 px,
  else unified; whitespace toggle (API `ignore_whitespace` and Monaco); "Expand context" (API `context=1000`, nothing folded); images side by side from
  the raw endpoint; binary files as a size change; too-large notice; renamed-only notice. Keys `j k ] [ v c s`, registered on the review's own root in the
  capture phase (they work inside Monaco, never in a text field).
- **Comments.** Gutter "+" on commentable lines of either side, or `c` / `s` on the selection (or on the change `j` landed on). The "+" is offered only
  where the harness will accept the comment (changed lines and three lines around them, one run per comment: `lib/review/position.ts`); the API's
  `line_not_in_diff` is still explained inline if it comes back. The comment box is docked under the diff (it never covers the code); a suggestion adds a
  second editor prefilled with the selected lines (new side only). File and general comments, edit and delete in the "Pending" panel, which also lists
  findings with keep / dismiss (reason) / undo when the API returns any.
- **Submit.** A sheet with verdict (Comment / Approve / Request changes), optional text and the `submit-preview` word for word (verdict, text, every
  comment with its suggestion). The button says what happens: "Post 4 comments to owner/repo#123 as you"; a local review says "Mark … as submitted
  (nothing is posted)". It sends exactly the comment ids the preview showed. `comments_changed` (reloads and says so), `not_logged_in` (command with copy),
  `code_host_error` and others keep everything pending. After success: the result line and a link to the review.
- **Demo.** Six pull requests (two ask for review, #476 has new commits since your review with a pending comment, one draft); #482 is a 14-file review
  across all groups with an image, a binary file, a rename with edits, a pure rename, a generated file, a lock file too large to show, an existing
  conversation, four commits, four checks and two findings; every method including submit (`posted:true` for GitHub, `false` for local). Knobs on the page
  URL: `?review=nogh|notloggedin|empty|fail` (comma separated; `submitlogin` makes the first submit answer `not_logged_in`; `fail` also makes the first
  submit answer `code_host_error`). Diffs come from real line diffs of two texts per file, so context and whitespace options work.

Registration edits outside the owned files (all small): `state/workspace/layout.ts` (tool name), `components/primitives/glyphs.ts` (glyph),
`components/dock/tabInfo.ts` (tab info), `components/dock/TabView.tsx` (lazy mount, own Monaco loader), `state/workspace/WorkspaceProvider.tsx` (palette
action, `openTool` on the workspace API), `state/nav.tsx` (`WorkspaceApi.openTool`), `components/shell/Sidebar.tsx` + `app/AppShell.tsx` (row and its
callback), `demo/bridge.ts` (one wrapper line), `styles.css` (a `/* review */` block at the end).

Verified (Playwright, Chromium, demo bridge, dev server): list (normal, not logged in, gh missing, fail), open a pull request, `j k ] [ v`, a line
comment, a multi-line suggestion, Pending panel, submit sheet, submit (GitHub and local), the not-logged-in submit error; dark and light; 1440 (unified in a
half-width pane, split with the sidebar closed), 1100, 830, 640, 390 widths with no horizontal page scroll; console clean in all runs. Not verified: real
`gh` and GitHub, other browsers, the live harness over HTTP (the demo bridge stands in), screen-reader output, very large pull requests (list virtualisation
is not built), comments on removed lines in the one-column layout (the gutter of the removed side exists only in split view), "Ask" about a hunk and the AI
summary (RV3), the 14-day cleanup interplay in the UI.

## As built — RV1.5 (harness)

Requirements: UI decisions 68, 77 (the caching sentence) and 78. Contract and exact shapes: `apps/harness/docs/review.md` and `apps/harness/docs/commands.md`;
client types in `@octo/agent-client` (`review.ts`, `commands.ts`, all additive and optional). Schema 8 (`migrate_v8_review_workflow.go`, its own file):
`review_threads`, `project_settings`, `command_runs` and the column `review_comments.in_reply_to`.

1. **All open pull requests.** `GET /prs?filter&q&page&per_page&refresh` (newest activity first; filters all, review_requested, mine, drafts; rows gain
   `comments`, `mine`, `reviewed_by_me`, `new_since_my_review`); a 60 s per-folder cache answered at once with `stale`/`fetched_at`, refreshed in the
   background and announced by `review.list_updated {folder}`. **GitHub Enterprise:** the host is read from the folder's remote and passed to every `gh`
   call as `GH_HOST` and to `gh api` as `--hostname`; a fake `gh` that, like a gh logged in to the enterprise host only, fails without them is the test.
   `comments` counts conversation comments plus reviews with text (an approximation; thread comments come with the opened review).
2. **Threads.** One read-only GraphQL query (`reviewThreads`) gives threads with path, side, lines, resolved, outdated, comments and `in_reply_to`;
   `GET …/threads` (+ `?refresh=1`), counts per file, fetched with the review and stored. A pending comment with `in_reply_to: <thread id>` is a reply that
   submit posts as `POST pulls/N/comments/ID/replies` after the review (replies-only submits post no review; a failed reply stays pending and is reported).
   Thread text is untrusted data (safety tests: verbatim, no effect on the project, never in an agent transcript).
3. **Check out.** `POST …/checkout`: `workspace` sets `project.review_workspace` (file API root `@review`, read-only; language server `?workspace=review`;
   `DELETE /review-workspace`); `working_copy` switches the project folder to `review/<n>-<slug>`: dirty working copy is 409 with the file list unless
   confirmed, fast-forward only, diverged branches and conflicting edits are refused, never forced (tests: clean, dirty, already on branch, diverged,
   detached, conflict).
4. **Project commands (decision 68).** `commands` project field, suggestions, run/stop/list/get, events, 4 concurrent, 5 MB cap; started only by the user's
   HTTP call (import-graph test and an agent-turn test; no approval in a supervised project); runs tied to a review appear in `meta.runs`.
5. **Review configuration.** `Project.review` (`commands`, `mechanical_globs`, `prefer`), applied to the reading order and returned as `Review.config`.

Decisions made while building: the workspace is read-only for the file API (refreshing a review force-moves its worktree); `mine` and `reviewed_by_me` need
one `gh api user` call per half hour; `pinned` is limited to two per project in the harness as in decision 68; the AI-pass depth setting of decision 78 is
not stored (RV3). Shared files touched: `internal/bridge/bridge.go` (two lines), `internal/bridge/lsp.go` (the `workspace=review` parameter),
`cmd/harness/serve.go` (commands service), `internal/projectstore/migrate.go` (version 8 and one call), `internal/project/{dto,input,service,files,errors}.go`.

Verified: unit and API tests with the fake `gh` and temporary local repositories (`go test -race ./...`), the scripted e2e scripts, agent-client tests.
Not verified: real `gh` against GitHub or an enterprise host (field names of `latestReviews`/`comments`, the GraphQL schema of an old GHES version), thread
positions on a real pull request (`line` null for outdated threads is handled from the documented schema), forks, very large lists (300 read),
Windows (bash, process groups), real dev servers as commands.
