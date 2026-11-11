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
