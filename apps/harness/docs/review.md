# Pull-request review (RV1, harness)

Contract: [`docs/superpowers/specs/2026-11-11-pr-review-design.md`](../../../docs/superpowers/specs/2026-11-11-pr-review-design.md). This page is what the harness does, with the exact API. Client types: `@octo/agent-client` (`review.ts`; every `Bridge` member is optional, HTTP bridge only). RV1 has no AI pass: findings can be stored and served but nothing produces them yet (RV3).

Code: `internal/review` (service), `internal/codehost` (interface and the `gh` adapter), `internal/gitx` (git runner, diff parsing), `internal/projectstore/reviews.go` + `migrate_v6_reviews.go` (tables), `internal/bridge/review.go` (routes), `internal/review/reviewtest` (test fixtures: a repository in a path with spaces and Cyrillic, a fake `gh`).

## Safety rules (tested)

1. **Nothing is posted without an explicit submit.** The only write to a code host is `Service.Submit` -> `codehost.PostReview`, reached only by `POST …/reviews/{rid}/submit`. Opening, listing, refreshing, commenting, viewing, preview and findings are reads or local writes. The fake-`gh` call log is asserted to contain no write until submit.
2. **An agent has no path to submit.** No agent-side package (orchestrator, tools, MCP server and relay, ACP, plugins, project service...) imports `internal/review` or `internal/codehost` (checked with `go list -deps`), the harness's tool list (as an ACP orchestrator sees it over MCP) has no review or code-host tool, and the MCP endpoint has no review routes. Residual risk, same as for `POST /approvals/{id}`: the bridge is an unauthenticated loopback API, so an agent with a shell could call it with `curl`; in a supervised project that command stops at an approval card. A bridge auth token is a cross-cutting change not made here.
3. **PR content is data.** Title, description, comments and branch names are stored and returned verbatim as strings. Nothing in the review service feeds them to a model, shell or permission decision (RV1 starts no agent). A test with instruction-like text in all three asserts project `access`, models, approvals and posts unchanged and that the text never reaches an agent transcript. Render it as text, never as markup.

`GH_*` variables of the harness environment go to the `gh` command only. Every other child (git, bash, agents) gets the allow-listed environment, which never contains `GH_TOKEN`.

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
| GET | `/prs?folder=` | `PullRequestList` |
| GET | `/reviews?state=open\|closed` | `{ reviews: ReviewSummary[] }`, most recently used first |
| POST | `/reviews` | `OpenReviewInput` → `Review`; 201 new, 200 when the same source is already open (refreshed) |
| GET | `/reviews/{rid}` | `Review` |
| PATCH | `/reviews/{rid}` | `{ state?: "open"\|"closed", refresh?: boolean }` → `Review` |
| GET | `/reviews/{rid}/files` | `ReviewFiles` |
| GET | `/reviews/{rid}/files/{path...}?context=3&ignore_whitespace=1&since=<commit>` | `ReviewFileDiff` |
| GET | `/reviews/{rid}/files/{path...}?raw=new\|old` | the file's bytes (head or base; ≤ 10 MiB; served with a sandboxing CSP) |
| PATCH | `/reviews/{rid}/files/{path...}` | `{ viewed: boolean }` → `ReviewFile` |
| GET / POST | `/reviews/{rid}/comments` | `{ comments: ReviewComment[] }` / `ReviewCommentInput` → 201 `ReviewComment` |
| PATCH / DELETE | `/reviews/{rid}/comments/{cid}` | `ReviewCommentUpdate` → `ReviewComment` / 204 (pending only; 409 `comment_submitted`) |
| GET | `/reviews/{rid}/findings` | `{ findings: ReviewFinding[] }` (there is no route that creates findings) |
| PATCH | `/reviews/{rid}/findings/{fid}` | `{ status: "kept"\|"dismissed"\|"new", reason?, body? }` → `{ finding, comment? }` (kept makes a pending comment) |
| POST | `/reviews/{rid}/submit-preview` | `SubmitInput` → `Preview` (posts nothing) |
| POST | `/reviews/{rid}/submit` | `SubmitInput` → `SubmitResult` |

Event `review.updated` `{ seq, review_id, reason, review: ReviewSummary }`; `reason` is `created`, `refreshed`, `comment`, `viewed`, `finding`, `findings`, `submitted`, `closed` or `worktree_removed`.

### Shapes

```text
PullRequestList  { host, repo?, folder?, available, reason?, message?, command?, prs: PullRequestRow[] }
PullRequestRow   { number, title, author, draft, url, head_ref, base_ref, head_sha, additions, deletions, changed_files,
                   created_at, updated_at, checks: "success"|"failure"|"pending"|"none", review_requested, review_decision?, labels?,
                   review: null | { id, head_commit, last_submitted_head?, new_commits, new_since_submitted, pending_comments } }
ReviewSummary    { id, source, kind, title, state, head_commit, last_submitted_head?, pending_comments, updated_at, last_used_at }
Review           { id, source ("github:o/r#n" | "local:base..head"), kind: "github"|"local", folder, repo?, number?, title, body, author?, url?,
                   base_ref, head_ref, base_commit (merge base), head_commit, worktree_path, worktree_present, state: "open"|"closed",
                   last_submitted_head?, last_submitted_at?, created_at, updated_at, last_used_at, pending_comments,
                   meta: { draft?, pr_state?, mergeable?, review_decision?, labels?, checks_state?, checks?: [{name,state,bucket,workflow?,url?}],
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
ReviewComment    { id, review_id, kind: line|range|file|general, path?, side?: new|old, line?, start_line?, body, suggestion?, finding_id?,
                   state: pending|submitted, submission_id?, created_at, updated_at, submitted_at? }
CommentInput     { path?, side?, line?, start_line?, body, suggestion?, finding_id? }   // no path = general; path only = file; line (+start_line) = line/range
ReviewFinding    { id, review_id, path, start_line, end_line, severity, statement, scenario?, patch?, evidence?, verdict?, rank, status: new|kept|dismissed,
                   dismiss_reason?, created_at, updated_at }
SubmitInput      { verdict: "comment"|"approve"|"request_changes", body?, comment_ids? }
Preview          { verdict, body, comments: ReviewComment[], payload? (the exact JSON sent to GitHub), posts, head_commit }
SubmitResult     Preview + { posted, submission_id, url?, review: Review }
```

Comment rules: the path must be a changed file; a line comment's line (and `start_line`) must be inside a diff hunk (3 lines of context), else 400 `line_not_in_diff` (GitHub's rule, checked early). `side: "old"` comments on the removed side. General comments are appended to the review body. A suggestion is posted as a ```` ```suggestion ```` block (fence longer than any backticks inside).

Submit: needs a valid verdict; refuses 400 `empty_review` when there is nothing to post and the verdict is not `approve`; with `comment_ids`, 409 `comments_changed` unless they equal the pending set. A failed post (409 `not_logged_in`, 502 `code_host_error`) leaves every comment pending. Success marks the comments submitted and records `last_submitted_head`; later `changed_since_submitted` flags files that differ from that head, and `?since=<last_submitted_head>` diffs only what changed. A **local** review has no host: submit posts nothing (`posted: false`) and marks the comments submitted, returning them so the UI can hand them to the orchestrator.

Errors beyond the common ones: `repo_mismatch`, `invalid_url`, `unknown_ref`, `pr_not_open`, `fetch_failed`, `worktree_failed`, `git_error`, `path_not_in_diff`, `invalid_side`, `empty_comment`, `comment_too_large`, `review_closed`, `invalid_verdict`.

## Storage

Schema version 6 (`migrate_v6_reviews.go`, idempotent `CREATE TABLE IF NOT EXISTS`): `reviews`, `review_viewed` (path, head blob, head commit: a mark is "viewed" while the file's blob is unchanged, "changed since viewed" after), `review_findings`, `review_comments`. A review survives a restart with comments, viewed marks and findings (tested).

## Not verified here

`gh` against real GitHub (the adapter is tested against a fake `gh` script only; the JSON field names follow `gh`'s documented `--json` fields), fork pull requests, very large pull requests, finding quality (no AI pass yet), Windows.
