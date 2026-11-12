# Pull-request review (RV1, harness)

Contract: [`docs/superpowers/specs/2026-11-11-pr-review-design.md`](../../../docs/superpowers/specs/2026-11-11-pr-review-design.md). This page is what the harness does, with the exact API. Client types: `@octo/agent-client` (`review.ts`; every `Bridge` member is optional, HTTP bridge only). RV1 has no AI pass: findings can be stored and served but nothing produces them yet (RV3). RV1.5 adds the all-pull-requests list, existing threads, check out, project commands and the per-project review configuration (sections below and [`commands.md`](./commands.md)).

Code: `internal/review` (service), `internal/codehost` (interface and the `gh` adapter), `internal/gitx` (git runner, diff parsing), `internal/projectstore/reviews.go` + `migrate_v6_reviews.go` (tables), `internal/bridge/review.go` (routes), `internal/review/reviewtest` (test fixtures: a repository in a path with spaces and Cyrillic, a fake `gh`).

## Safety rules (tested)

1. **Nothing is posted without an explicit submit.** The only write to a code host is `Service.Submit` -> `codehost.PostReview`, reached only by `POST …/reviews/{rid}/submit`. Opening, listing, refreshing, commenting, viewing, preview and findings are reads or local writes. The fake-`gh` call log is asserted to contain no write until submit.
2. **An agent has no path to submit.** No agent-side package (orchestrator, tools, MCP server and relay, ACP, plugins, project service...) imports `internal/review` or `internal/codehost` (checked with `go list -deps`), the harness's tool list (as an ACP orchestrator sees it over MCP) has no review or code-host tool, and the MCP endpoint has no review routes. Residual risk, same as for `POST /approvals/{id}`: the bridge is an unauthenticated loopback API, so an agent with a shell could call it with `curl`; in a supervised project that command stops at an approval card. A bridge auth token is a cross-cutting change not made here.
3. **PR content is data.** Title, description, comments and branch names are stored and returned verbatim as strings. Nothing in the review service feeds them to a model, shell or permission decision (RV1 starts no agent). A test with instruction-like text in all three asserts project `access`, models, approvals and posts unchanged and that the text never reaches an agent transcript. Render it as text, never as markup.

`GH_*` variables of the harness environment go to the `gh` command only. **Hosts.** The host a call talks to comes from the folder's git remote (read as configured, before any `url.<base>.insteadOf`; `https://`, `ssh://` and `git@host:o/r` forms; the remote that names the repository, else `origin`). A non-`github.com` host (GitHub Enterprise) is passed to every `gh` call as `GH_HOST=<host>`, and to `gh api` also as `--hostname <host>` (`gh api` does not infer it from the folder). It wins over a `GH_HOST` left in the environment; a folder whose remotes name no host (a local path) leaves the environment's `GH_HOST` alone. `PRList.hostname` and `Repo.host` say which host was used; opening by URL on another host than the folder's is `400 repo_mismatch`. Every other child (git, bash, agents) gets the allow-listed environment, which never contains `GH_TOKEN`.

## Code host: `gh`

The adapter runs the `gh` found on `PATH` when a call is made, as the user the CLI is logged in as; the harness stores no token. Commands: `gh repo view`, `gh pr list` (twice: all open, and `--search review-requested:@me`), `gh pr view`, `gh pr checks`, `gh api --method POST repos/O/R/pulls/N/reviews --input -` (submit; one atomic call with the verdict, body and every inline comment). No `gh`, not logged in or no GitHub remote: `GET …/prs` answers 200 with `available: false`, a `reason` (`gh_not_installed`, `not_logged_in`, `no_github_repo`, `no_host`, `not_a_git_repo`, `no_folder`), `message` and the `command` to run; other calls answer 409 with that code. Local-branch reviews never call `gh`.

## Worktrees and refs

A review's checkout is `{data-dir}/projects/{pid}/review/{rid}` (`git worktree add --detach`); the user's working tree, index and branch are never touched (tested: same `git status`, same branch, dirty file intact). The repository gets private refs `refs/octo/review/{rid}/head|base` (GitHub) and worktree admin files under `.git/worktrees`. The PR head is fetched as `refs/pull/N/head` from the remote whose URL names the repository (else `origin`). The diff is `merge-base(base, head)..head` (what GitHub shows). Refresh (`PATCH {refresh:true}`, or opening the same source again) re-fetches, moves the worktree and keeps viewed marks.

**Cleanup.** The worktree and refs of a review are removed when it is closed (the PR left the open list and `gh pr view` says closed or merged, or `PATCH {state:"closed"}`) and when it was unused for 14 days (`last_used_at`, touched by reads and writes of the review), **never while it has pending comments**. Sweeps run at start, every 6 hours, on closing, and after listing PRs. A closed review reopened with `PATCH {state:"open"}` gets its worktree back.

## Reading order

`computeFiles` classifies each changed file (`group`, `reason`) and sorts: `core` (changed source, most changed lines first), `callers` (source files that only reference names declared in changed core files: out-edges > in-edges), `tests`, `other` (docs, config, assets), `mechanical` (folded: `lockfile`, `generated` by path or by a "Code generated / DO NOT EDIT / @generated" header, pure `rename` (100 %, no edits), `formatting` (nothing changes with `-w`)). A rename with edits stays reviewable and is paired (`old_path`). Binary files: `binary`, `old_size`/`new_size`, `image` (content type) and raw bytes via `?raw=`. The caller analysis is a heuristic on declared names, bounded to 400 files.

## API

All under `/v1/projects/{pid}`. Errors: `{ "error": { "code", "message", "command"? } }`.

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/prs?folder=&filter=all\|review_requested\|mine\|drafts&q=&page=&per_page=&refresh=1` | `PullRequestList` (see "All open pull requests") |
| GET | `/reviews?state=open\|closed` | `{ reviews: ReviewSummary[] }`, most recently used first |
| POST | `/reviews` | `OpenReviewInput` → `Review`; 201 new, 200 when the same source is already open (refreshed) |
| GET | `/reviews/{rid}` | `Review` |
| PATCH | `/reviews/{rid}` | `{ state?: "open"\|"closed", refresh?: boolean }` → `Review` |
| GET | `/reviews/{rid}/files` | `ReviewFiles` |
| GET | `/reviews/{rid}/files/{path...}?context=3&ignore_whitespace=1&since=<commit>` | `ReviewFileDiff` |
| GET | `/reviews/{rid}/files/{path...}?raw=new\|old` | the file's bytes (head or base; ≤ 10 MiB; served with a sandboxing CSP) |
| PATCH | `/reviews/{rid}/files/{path...}` | `{ viewed: boolean }` → `ReviewFile` |
| POST | `/reviews/{rid}/checkout` | `{ mode: "workspace"\|"working_copy", confirm? }` → `CheckoutResult` (see "Check out") |
| DELETE | `/review-workspace` | 204; points the project back at its own folders |
| GET | `/reviews/{rid}/threads?refresh=1` | `ReviewThreads` (the code host's existing review threads) |
| GET / POST | `/reviews/{rid}/comments` | `{ comments: ReviewComment[] }` / `ReviewCommentInput` → 201 `ReviewComment` |
| PATCH / DELETE | `/reviews/{rid}/comments/{cid}` | `ReviewCommentUpdate` → `ReviewComment` / 204 (pending only; 409 `comment_submitted`) |
| GET | `/reviews/{rid}/findings` | `{ findings: ReviewFinding[] }` (there is no route that creates findings) |
| PATCH | `/reviews/{rid}/findings/{fid}` | `{ status: "kept"\|"dismissed"\|"new", reason?, body? }` → `{ finding, comment? }` (kept makes a pending comment) |
| POST | `/reviews/{rid}/submit-preview` | `SubmitInput` → `Preview` (posts nothing) |
| POST | `/reviews/{rid}/submit` | `SubmitInput` → `SubmitResult` |

Event `review.workspace` `{ seq, review_workspace }`: the project's active review workspace was set or cleared (`null`).

Event `review.list_updated` `{ seq, folder }`: the cached list of that folder was refreshed in the background; ask again.

Event `review.updated` `{ seq, review_id, reason, review: ReviewSummary }`; `reason` is `created`, `refreshed`, `comment`, `viewed`, `finding`, `findings`, `submitted`, `closed` or `worktree_removed`.

### All open pull requests (RV1.5)

`GET /prs` lists every open pull request of the folder's repository, newest activity (`updated_at`) first. `filter`: `all` (default), `review_requested`, `mine` (the signed-in user opened it), `drafts`; an unknown value is `400 invalid_filter`. `q` keeps rows whose title, author, branch, label or number contains it (case-insensitive; `#12` works). `page` from 1, `per_page` default 30, at most 100; `total` counts all matches, `next_page` is the next number or `null`. The harness reads at most 300 open pull requests (`truncated: true` beyond that).

Each row gains `comments` (conversation comments plus reviews with a text; thread comments are only known once the review is opened, see `…/threads`), `mine`, `reviewed_by_me` and `new_since_my_review` (the user's latest review is on an older commit than the head). They need the signed-in user's login: one extra `gh api user --hostname <host>` per half hour (a failure leaves the three flags false, never an error).

**Cache.** The list of a folder is cached in memory for 60 s. A call inside that time answers from the cache (`stale: false`, `fetched_at` = the earlier fetch) without calling `gh`. An older cache is still answered at once, with `stale: true`, and one background refresh starts; when it is in the harness emits `review.list_updated {folder}` and the next call answers fresh. `?refresh=1` fetches synchronously. The first call (no cache) fetches synchronously. Filtering, search and paging run on the cached list; the `review` link of each row is always read from the store (a review opened a second ago shows). Reviews of pull requests that left the open list are closed by each fetch, as before.

### Existing review threads (RV1.5)

`GET …/reviews/{rid}/threads` returns the review threads the code host already has on the pull request: `{ threads: [{ id, path, side: "new"|"old", line?, start_line?, original_line?, resolved, outdated, comments: [{ id, author, body, created_at, url?, commit?, in_reply_to?, line?, original_line? }] }], counts_by_path: { path: comments }, unresolved_by_path: { path: unresolved threads }, fetched_at?, error? }`. A thread's `id` is the host's thread id; its comments are in order, the first is the root and a later one has `in_reply_to` = the root's numeric `id`. `line` is the last line (`start_line` the first of a range, `side: "old"` the removed side); an **outdated** thread (`outdated: true`, the code moved) has no current line on the host, so `line` is its `original_line`: list it apart, not in the diff. The data comes from one read-only GraphQL query (`gh api graphql`, `reviewThreads(first:50)` paged up to 10 pages, 100 comments per thread; the test asserts it contains no mutation), which gives the grouping, the resolved state and the positions in one call; REST review comments carry no resolved state.

Threads are fetched with the review (open, `PATCH {refresh:true}`) and stored in the project database (`review_threads`), so the file list can carry `threads` and `unresolved_threads` per file and the route answers without a host call. A review whose threads were never fetched fetches them on the first read; `?refresh=1` fetches now and emits `review.updated` with reason `threads`. A failed fetch never fails opening or refreshing a review: a read then answers with the stored threads and `error`, or, with none stored, the host error (502 `code_host_error`, or 409 `not_logged_in`...). A local review has `threads: []` and asks no host.

**Replies.** `POST …/comments { in_reply_to: <thread id>, body }` makes a pending comment of kind `reply` (`path` = the thread's file, no line; a reply has a body and nothing else: 400 `invalid_request`; 400 `unknown_thread` when the stored threads have no such id, so refresh them first; a local review has no threads). It is edited with `PATCH {body}` only and counts in the file's `pending_comments`. Submit posts the review as before (replies are not in its payload), then each reply as its own call, `gh api --method POST repos/O/R/pulls/N/comments/<root comment id>/replies` (`--hostname` as for the review). `submit-preview` lists them as `replies: [{ comment_id, thread_id, in_reply_to_comment, body }]`. A submit that is only replies with the verdict `comment` and no summary posts no review at all. If a reply fails after the review was posted, the call answers 200 with `reply_errors: [{ comment_id, message }]`, the review's comments are submitted and the failed reply stays pending; if nothing at all could be posted the call fails and everything stays pending. A reply whose thread is gone from the refreshed threads blocks the submit with 409 `thread_missing`. Thread bodies are untrusted external text, like every host text: stored and returned verbatim, never executed and never given to an agent by this code path (tests: thread text with instructions leaves the project's access, models and approvals unchanged and never reaches an agent transcript).

### Check out (RV1.5)

`POST …/reviews/{rid}/checkout { mode, confirm? }`. Unknown mode: 400 `invalid_mode`.

**`workspace`** marks the review's worktree as the project's active review workspace and answers `{ mode: "workspace", workspace: { review_id, path, title } }`. `GET /v1/projects/{pid}` then has `review_workspace: { review_id, path, title }` (`null` otherwise) and the event `review.workspace` is sent; `DELETE …/review-workspace` clears it (204, also when none). The UI points the three consumers at it: (1) the **file API** (`/files`, `/files/content`) accepts the folder `@review` (or the worktree's absolute path) as a root while the workspace is active and answers 404 `not_found` for both otherwise; it stays confined to the worktree (`..` is 400), and it is **read-only**: `PUT /files/content` there is 409 `review_workspace_read_only`, because refreshing the review moves the worktree (`checkout --force`) and would discard edits; (2) the **language server**: `POST …/lsp/{server}/sessions?workspace=review` starts it with the worktree as root and as the only workspace folder (`name: "@review"`), 409 `no_review_workspace` when none is active; (3) **search**: the harness has no project-wide file search route (the editor searches through the file API), so there is nothing to point. A swept worktree is made again (the review is re-fetched); a closed review is 409 `review_closed`; closing a review (or the sweep) that is the active workspace removes the worktree and clears the workspace. Agents never see the workspace: their roots are the project's folders only.

**`working_copy`** switches the project's own folder (the review's `folder`) to the local branch `review/<number>-<slug of the title>` (ASCII lower case, at most 40 characters; `review/7-pr` when the title has none). Only a pull request can (400 `not_a_pull_request` for a local review). Nothing is forced or discarded:

1. Look first: the branch the folder is on and `git status`. Uncommitted changes (tracked or untracked) and no `confirm`: **409 `dirty_working_copy`** with `error.files: [{ path, status: modified|added|deleted|renamed|copied|untracked|conflicted, code }]` (`code` is git's two letters) and nothing changed. A detached HEAD whose commits no branch or tag contains and no `confirm`: 409 `detached_head`.
2. `git fetch` of `refs/pull/N/head` (from the remote that names the repository, as for the review) into the private ref `refs/octo/review/{rid}/checkout`.
3. No such branch: `git switch --create` at the head (`created: true`). The branch exists at the head: switch to it (`already_on_branch: true` when the folder was on it). The branch is behind the head: switch and `git merge --ff-only` (`fast_forwarded: true`). The branch has commits the pull request does not: **409 `branch_diverged`**, branch and folder untouched. Uncommitted changes that conflict with the target: git refuses, **409 `checkout_conflict`**, nothing changed (with `confirm`, changes that do not conflict are carried over).

Answer: `{ mode: "working_copy", folder, branch, previous_branch?, commit, created?, already_on_branch?, fast_forwarded? }`; the review emits `review.updated` with reason `checked_out`.

### Review configuration per project (RV1.5)

`Project.review: { commands: string[], mechanical_globs: string[], prefer: "split"|"unified"|"auto" }` (set with `PATCH /v1/projects/{pid}`; a `review` object replaces the whole configuration and missing fields take their defaults `[]`, `[]`, `auto`; a patch without it leaves it; 400 `invalid_request` for an unknown `prefer`, more than 20 command names or 100 globs, an empty or duplicate name, an empty glob or one starting with `!`). Stored in `project_settings`. It is returned with every review as `config` and does two things in the harness: `mechanical_globs` fold matching files into the `mechanical` group with reason `configured` in the reading order (the built-in lock file / generated rules win first; the cached order is keyed by the globs, so a change applies at once and counts in `totals.mechanical`); `commands` and `prefer` are carried for the UI (the header's "Run" menu offers those project commands, `prefer` picks the diff view; the AI-pass depth of decision 78 belongs to RV3 and is not stored yet). Glob syntax: `*` stays inside a directory, `**` crosses directories, `?` is one character, a pattern without `/` matches a file name in any directory, a trailing `/` names a directory, a leading `/` is ignored; everything else is literal.

### Shapes

```text
PullRequestList  { host, hostname?, repo?, folder?, available, reason?, message?, command?, filter, page, per_page, total,
                   next_page: number|null, stale, fetched_at?, truncated?, prs: PullRequestRow[] }
PullRequestRow   { number, title, author, draft, url, head_ref, base_ref, head_sha, additions, deletions, changed_files,
                   created_at, updated_at, checks: "success"|"failure"|"pending"|"none", review_requested, review_decision?, labels?,
                   comments, mine, reviewed_by_me, new_since_my_review,
                   review: null | { id, head_commit, last_submitted_head?, new_commits, new_since_submitted, pending_comments } }
ReviewSummary    { id, source, kind, title, state, head_commit, last_submitted_head?, pending_comments, updated_at, last_used_at }
Review           { id, source ("github:o/r#n" | "local:base..head"), kind: "github"|"local", folder, repo?, number?, title, body, author?, url?,
                   base_ref, head_ref, base_commit (merge base), head_commit, worktree_path, worktree_present, config: { commands, mechanical_globs, prefer }, state: "open"|"closed",
                   last_submitted_head?, last_submitted_at?, created_at, updated_at, last_used_at, pending_comments,
                   meta: { runs?: [{ id, name, status, exit_code, started_at, finished_at? }] (commands run in the worktree, see commands.md), draft?, pr_state?, mergeable?, review_decision?, labels?, checks_state?, checks?: [{name,state,bucket,workflow?,url?}],
                           commits: [{sha,subject,author,date}], conversation?: [{kind:"comment"|"review",author,body,state?,created_at?}],
                           body_truncated?, refreshed_at? },
                   totals: { files, added, removed, mechanical }, findings, viewed_count, large_pr }
OpenReviewInput  { folder?, source?: "github"|"local", pr?, url?, base?, head? }   // local: head defaults to HEAD
ReviewFiles      { base_commit, head_commit, files: ReviewFile[], totals, viewed_count, large_pr, last_submitted_head? }
ReviewFile       { path, old_path?, status: added|modified|deleted|renamed|copied|typechange, added, removed, binary, image?, old_size, new_size
                   (-1 = absent), blob?, old_blob?, similarity?, group: core|callers|tests|other|mechanical, reason, order, folded, large?,
                   viewed, changed_since_viewed, changed_since_submitted, pending_comments, findings }
ReviewFileDiff   ReviewFile + { hunks: [{ old_start, old_lines, new_start, new_lines, header, lines: [{ type: context|add|del, old?, new?, text, no_newline? }] }],
                   too_large, whitespace_ignored, context, since? }
ReviewComment    { id, review_id, kind: line|range|file|general|reply, in_reply_to?, path?, side?: new|old, line?, start_line?, body, suggestion?, finding_id?,
                   state: pending|submitted, submission_id?, created_at, updated_at, submitted_at? }
CommentInput     { path?, side?, line?, start_line?, body, suggestion?, finding_id?, in_reply_to? }   // no path = general; path only = file; line (+start_line) = line/range
ReviewFinding    { id, review_id, path, start_line, end_line, severity, statement, scenario?, patch?, evidence?, verdict?, rank, status: new|kept|dismissed,
                   dismiss_reason?, created_at, updated_at }
SubmitInput      { verdict: "comment"|"approve"|"request_changes", body?, comment_ids? }
Preview          { verdict, body, comments: ReviewComment[], replies: [{ comment_id, thread_id, in_reply_to_comment, body }],
                   payload? (the exact JSON sent to GitHub; absent when only replies are posted), posts, head_commit }
SubmitResult     Preview + { posted, submission_id, url?, review: Review, reply_errors?: [{ comment_id, message }] }
```

Comment rules: the path must be a changed file; a line comment's line (and `start_line`) must be inside a diff hunk (3 lines of context), else 400 `line_not_in_diff` (GitHub's rule, checked early). `side: "old"` comments on the removed side. General comments are appended to the review body. A suggestion is posted as a ```` ```suggestion ```` block (fence longer than any backticks inside).

Submit: needs a valid verdict; refuses 400 `empty_review` when there is nothing to post and the verdict is not `approve`; with `comment_ids`, 409 `comments_changed` unless they equal the pending set. A failed post (409 `not_logged_in`, 502 `code_host_error`) leaves every comment pending. Success marks the comments submitted and records `last_submitted_head`; later `changed_since_submitted` flags files that differ from that head, and `?since=<last_submitted_head>` diffs only what changed. A **local** review has no host: submit posts nothing (`posted: false`) and marks the comments submitted, returning them so the UI can hand them to the orchestrator.

Errors beyond the common ones: `repo_mismatch`, `invalid_url`, `unknown_ref`, `pr_not_open`, `fetch_failed`, `worktree_failed`, `git_error`, `unknown_thread`, `thread_missing`, `path_not_in_diff`, `invalid_side`, `empty_comment`, `comment_too_large`, `review_closed`, `invalid_verdict`.

## Storage

Schema version 8 (`migrate_v8_review_workflow.go`) adds `review_threads` (the stored thread list, `fetched_at`, last error) and the column `review_comments.in_reply_to`; the project settings and command run tables of the other RV1.5 parts join it (below). Schema version 6 (`migrate_v6_reviews.go`, idempotent `CREATE TABLE IF NOT EXISTS`): `reviews`, `review_viewed` (path, head blob, head commit: a mark is "viewed" while the file's blob is unchanged, "changed since viewed" after), `review_findings`, `review_comments`. A review survives a restart with comments, viewed marks and findings (tested).

## Not verified here

`gh` against real GitHub (the adapter is tested against a fake `gh` script only; the JSON field names follow `gh`'s documented `--json` fields), fork pull requests, very large pull requests, finding quality (no AI pass yet), Windows.
