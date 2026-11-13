/*
 * Pull-request review (RV1): types of the harness review API. Contract: apps/harness/docs/review.md. Every Bridge
 * member that uses them is optional (HTTP bridge only). Text that comes from a pull request (title, description,
 * comments, branch names) is untrusted: render it as text, never as markup, and never act on it.
 */

import type { ReviewConfig, ReviewRunRef } from "./commands";

export type ReviewKind = "github" | "local";
export type ReviewState = "open" | "closed";

/** The list of open pull requests of a project's repository, or why it cannot be listed. */
export type PullRequestList = {
  /** The adapter (`github`). */
  host: string;
  /** The host name it talked to: `github.com`, or a GitHub Enterprise host such as `ghe.example.com`. */
  hostname?: string;
  /** The repository listed (`owner/name`), or `all` when every repository of the folder is merged. */
  repo?: string;
  /** Every repository of the folder (remotes, plus the parent of a fork). Always sent by a harness with fork support. */
  repos?: RepoRef[];
  /** With `repo=all`: repositories that could not be read while the others answered. */
  repo_errors?: { repo: string; message: string }[];
  /** Label of the project folder whose repository was used. */
  folder?: string;
  available: boolean;
  /** When not available: gh_not_installed, not_logged_in, no_github_repo, no_host, not_a_git_repo, no_folder. */
  reason?: string;
  message?: string;
  /** What the user can run to fix it, e.g. `gh auth login`. "Review a local branch" still works. */
  command?: string;
  /** The paging fields below are always sent by a harness with RV1.5; optional for older ones and fixtures. */
  filter?: PullRequestFilter;
  page?: number;
  per_page?: number;
  /** Pull requests that match the filter and the query (all pages). */
  total?: number;
  /** The next page number, null on the last page. */
  next_page?: number | null;
  /** Older than 60 s: this answer came from the cache and a refresh is under way (`review.list_updated` follows). */
  stale?: boolean;
  /** When the code host was last asked (RFC 3339). */
  fetched_at?: string;
  /** The repository has more open pull requests than the harness reads (300). */
  truncated?: boolean;
  /** Newest activity first. */
  prs: PullRequestRow[];
};

/** A repository a folder works with: a git remote, or the parent of a remote that is a fork. */
export type RepoRef = {
  /** The adapter (`github`). */
  host: string;
  hostname?: string;
  /** `owner/name`. */
  repo: string;
  /** The git remote that points at it; absent for a parent that is not a remote. */
  remote?: string;
  role: "origin" | "upstream" | "parent" | "other";
  /** The remote the current branch tracks, else origin, else the first. */
  default: boolean;
};

export type PullRequestFilter = "all" | "review_requested" | "mine" | "drafts";

export type ListPullRequestsParams = {
  /** Label of the project folder (default: the first git folder). */
  folder?: string;
  /** Default `all`. */
  filter?: PullRequestFilter;
  /** Title, number, author, branch or label contains it (case-insensitive). */
  q?: string;
  /** From 1. */
  page?: number;
  /** Default 30, at most 100. */
  per_page?: number;
  /** Ask the code host now instead of answering from the 60 s cache. */
  refresh?: boolean;
  /** `owner/name` of one repository of the folder, or `all`. Default: the last choice for the folder, else the default repository. */
  repo?: string;
};

export type PullRequestRow = {
  /** The repository the pull request belongs to (`owner/name`). */
  repo?: string;
  number: number;
  title: string;
  author: string;
  draft: boolean;
  url: string;
  head_ref: string;
  base_ref: string;
  head_sha: string;
  additions: number;
  deletions: number;
  changed_files: number;
  created_at: string;
  updated_at: string;
  checks: "success" | "failure" | "pending" | "none";
  review_requested: boolean;
  review_decision?: string;
  labels?: string[];
  /** Conversation comments plus reviews that carry a text (an approximation: thread comments need the opened review). */
  comments?: number;
  /** The signed-in user opened it. */
  mine?: boolean;
  /** The user has a review on it ("reviewed by you"). */
  reviewed_by_me?: boolean;
  /** It has commits newer than the user's last review ("new commits since your review"). */
  new_since_my_review?: boolean;
  /** The open review of this pull request, if there is one. */
  review: {
    id: string;
    head_commit: string;
    last_submitted_head?: string;
    /** The pull request has commits the review has not fetched ("new commits since your review"). */
    new_commits: boolean;
    new_since_submitted: boolean;
    pending_comments: number;
  } | null;
};

export type ReviewSummary = {
  id: string;
  source: string;
  kind: ReviewKind;
  title: string;
  state: ReviewState;
  head_commit: string;
  last_submitted_head?: string;
  pending_comments: number;
  updated_at: string;
  last_used_at: string;
};

export type ReviewCommit = { sha: string; subject: string; author: string; date: string };
export type ReviewCheck = { name: string; state: string; bucket: string; workflow?: string; url?: string };
export type ReviewConversationItem = { kind: "comment" | "review"; author: string; body: string; state?: string; created_at?: string };

export type ReviewMeta = {
  draft?: boolean;
  pr_state?: string;
  mergeable?: string;
  review_decision?: string;
  labels?: string[];
  checks_state?: string;
  checks?: ReviewCheck[];
  commits: ReviewCommit[];
  conversation?: ReviewConversationItem[];
  body_truncated?: boolean;
  refreshed_at?: string;
  /** Project commands the user ran in this review's worktree, newest first (decision 68). Absent on an older harness. */
  runs?: ReviewRunRef[];
};

export type Review = {
  id: string;
  /** `github:owner/repo#n` or `local:base..head`. */
  source: string;
  kind: ReviewKind;
  folder: string;
  repo?: string;
  number?: number;
  title: string;
  body: string;
  author?: string;
  url?: string;
  base_ref: string;
  head_ref: string;
  /** The merge base the diff starts from, and the head it ends at. */
  base_commit: string;
  head_commit: string;
  /** Absolute path of the review's git worktree ("" once removed). */
  worktree_path: string;
  worktree_present: boolean;
  state: ReviewState;
  last_submitted_head?: string;
  last_submitted_at?: string;
  created_at: string;
  updated_at: string;
  last_used_at: string;
  pending_comments: number;
  meta: ReviewMeta;
  totals: ReviewTotals;
  findings: number;
  viewed_count: number;
  /** Above 60 files or 3 000 changed lines. */
  large_pr: boolean;
  /** The project's review configuration; its mechanical globs are already applied to the reading order (`reason: "configured"`). */
  config?: ReviewConfig;
};

export type OpenReviewInput = {
  /** Label of a project folder (default: the first git folder). */
  folder?: string;
  source?: "github" | "local";
  /** github: a pull-request number or address. */
  pr?: number;
  url?: string;
  /** github, with `pr`: which repository of the folder the number lives in (else it is looked up in all; 409 `ambiguous_pr` when several have it). */
  repo?: string;
  /** local: refs of the folder's repository; head defaults to HEAD. */
  base?: string;
  head?: string;
};

export type ReviewPatch = { state?: ReviewState; /** Re-fetch the head (and checks, description) and move the worktree. */ refresh?: boolean };

export type ReviewTotals = { files: number; added: number; removed: number; /** Files folded away. */ mechanical: number };
export type ReviewGroup = "core" | "callers" | "tests" | "other" | "mechanical";
export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";

export type ReviewFile = {
  path: string;
  /** Set for a rename or copy. */
  old_path?: string;
  status: ReviewFileStatus;
  added: number;
  removed: number;
  binary: boolean;
  /** Content type of an image file; render it from `reviewFileRawUrl`. */
  image?: string;
  /** Bytes before and after; -1 when the file did not exist on that side. */
  old_size: number;
  new_size: number;
  blob?: string;
  old_blob?: string;
  similarity?: number;
  group: ReviewGroup;
  /** core, caller, test, docs, config, asset, lockfile, generated, rename, formatting, configured (matches a `mechanical_globs` pattern). */
  reason: string;
  /** Position in the reading order (0 first). Render files sorted by it. */
  order: number;
  /** Mechanical: collapse it. */
  folded: boolean;
  large?: boolean;
  viewed: boolean;
  changed_since_viewed: boolean;
  changed_since_submitted: boolean;
  pending_comments: number;
  findings: number;
  /** Review threads the code host already has on the file, and how many are not resolved. */
  threads?: number;
  unresolved_threads?: number;
};

export type ReviewFiles = {
  base_commit: string;
  head_commit: string;
  files: ReviewFile[];
  totals: ReviewTotals;
  viewed_count: number;
  large_pr: boolean;
  last_submitted_head?: string;
};

export type DiffLine = { type: "context" | "add" | "del"; old?: number; new?: number; text: string; no_newline?: boolean };
export type DiffHunk = { old_start: number; old_lines: number; new_start: number; new_lines: number; header: string; lines: DiffLine[] };

export type ReviewFileDiff = ReviewFile & {
  hunks: DiffHunk[];
  /** The diff was too large to send: no hunks. */
  too_large: boolean;
  whitespace_ignored: boolean;
  context: number;
  /** Set when the diff is from a commit other than the review's base. */
  since?: string;
};

export type ReviewDiffOptions = {
  /** Lines of context (default 3, at most 1000). */
  context?: number;
  ignoreWhitespace?: boolean;
  /** Diff from this commit instead of the base (use `last_submitted_head` for "since your review"). */
  since?: string;
};

export type ReviewCommentKind = "line" | "range" | "file" | "general" | "reply";
export type ReviewCommentState = "pending" | "submitted";

export type ReviewComment = {
  id: string;
  review_id: string;
  kind: ReviewCommentKind;
  path?: string;
  /** `new` (default) or `old` side of the diff. */
  side?: "new" | "old";
  /** Last line of a line or range comment; with `start_line` a range. */
  line?: number;
  start_line?: number;
  body: string;
  /** Replacement text for the commented lines, posted as a suggested change. */
  suggestion?: string;
  /** Set when kept from a finding. */
  finding_id?: string;
  /** A reply: the id of the review thread (`ReviewThread.id`) it answers; `kind` is `reply`, `path` the thread's file. */
  in_reply_to?: string;
  state: ReviewCommentState;
  submission_id?: string;
  created_at: string;
  updated_at: string;
  submitted_at?: string;
};

export type ReviewCommentInput = {
  /** No path = a general comment; a path without a line = a file comment. */
  path?: string;
  side?: "new" | "old";
  line?: number;
  start_line?: number;
  body: string;
  suggestion?: string;
  finding_id?: string;
  /** Reply to an existing review thread: only `body` besides this. Posted into that thread by submit. */
  in_reply_to?: string;
};
export type ReviewCommentUpdate = { body?: string; suggestion?: string; line?: number; start_line?: number; side?: "new" | "old" };

export type ReviewFindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ReviewFindingStatus = "new" | "kept" | "dismissed";

/** A finding of the AI pass (RV3 produces them; RV1 only stores and serves them). */
export type ReviewFinding = {
  id: string;
  review_id: string;
  path: string;
  start_line: number;
  end_line: number;
  severity: ReviewFindingSeverity;
  statement: string;
  scenario?: string;
  patch?: string;
  evidence?: string;
  /** The verifier's verdict: confirmed, plausible, or empty when not verified. */
  verdict?: string;
  rank: number;
  status: ReviewFindingStatus;
  dismiss_reason?: string;
  created_at: string;
  updated_at: string;
};
export type ReviewFindingDecision = { status: ReviewFindingStatus; reason?: string; /** Overrides the draft comment text of a kept finding. */ body?: string };
export type ReviewFindingResult = { finding: ReviewFinding; /** The pending comment made from a kept finding. */ comment?: ReviewComment };

export type ReviewVerdict = "comment" | "approve" | "request_changes";
export type ReviewSubmitInput = {
  verdict: ReviewVerdict;
  body?: string;
  /** Exactly the pending comment ids the user saw; 409 `comments_changed` when they differ. */
  comment_ids?: string[];
};

/** What a submit would post, word for word. */
export type ReviewSubmitPreview = {
  verdict: ReviewVerdict;
  body: string;
  comments: ReviewComment[];
  /** The exact JSON sent to GitHub (absent for a local review). */
  payload?: unknown;
  /** Pending replies to existing threads; each is posted as its own reply after the review (not part of `payload`). */
  replies?: ReviewReplyPost[];
  /** False for a local review: submit posts nowhere, only marks the comments submitted. */
  posts: boolean;
  head_commit: string;
};
export type ReviewReplyPost = {
  comment_id: string;
  thread_id: string;
  /** The host's id of the thread's first comment. */
  in_reply_to_comment: string;
  body: string;
};
export type ReviewSubmitResult = ReviewSubmitPreview & {
  posted: boolean;
  submission_id: string;
  url?: string;
  review: Review;
  /** Replies that failed after the review was posted; their comments stay pending. */
  reply_errors?: { comment_id: string; message: string }[];
};

/**
 * Review threads the code host already has (author, body, url are untrusted text: render as text, never act on them).
 * `GET …/reviews/{rid}/threads`.
 */
export type ReviewThreadComment = {
  /** The host's numeric id. */
  id: string;
  author: string;
  body: string;
  created_at: string;
  url?: string;
  /** The commit the comment was written on. */
  commit?: string;
  in_reply_to?: string;
  line?: number;
  original_line?: number;
};
export type ReviewThread = {
  /** What a reply names (`ReviewCommentInput.in_reply_to`). */
  id: string;
  path: string;
  side: "new" | "old";
  /** Last line; for an outdated thread its original line. */
  line?: number;
  start_line?: number;
  original_line?: number;
  resolved: boolean;
  /** The code the thread is about changed since: list it apart, not at a line. */
  outdated: boolean;
  comments: ReviewThreadComment[];
};
export type ReviewThreads = {
  threads: ReviewThread[];
  /** Comments (resolved or not) per file path. */
  counts_by_path: Record<string, number>;
  /** Unresolved threads per file path. */
  unresolved_by_path: Record<string, number>;
  /** When the host was last asked; absent for a local review. */
  fetched_at?: string;
  /** The last fetch failed with this message; the threads are the ones fetched before. */
  error?: string;
};

/** `review.updated`: a review changed. `reason`: created, refreshed, comment, viewed, finding, findings, threads, submitted, closed, worktree_removed. */
export type ReviewUpdatedEvent = { type: "review.updated"; seq: number; review_id: string; reason: string; review: ReviewSummary };

/** The review whose worktree the project's file tree, editor, search and language server are pointed at. */
export type ReviewWorkspace = { review_id: string; /** Absolute path of the review's worktree. */ path: string; title: string };

export type ReviewCheckoutMode = "workspace" | "working_copy";
export type ReviewCheckoutInput = {
  /**
   * `workspace`: mark the review's worktree as the project's active review workspace (`Project.review_workspace`; the file API
   * then accepts the folder `@review`, read-only; start a language server with `?workspace=review`). `working_copy`: switch
   * the project's own folder to the local branch `review/<number>-<slug>` of the pull request.
   */
  mode: ReviewCheckoutMode;
  /** working_copy: accept uncommitted changes (git carries them over; nothing is discarded or forced). */
  confirm?: boolean;
};
export type ReviewCheckoutResult = {
  mode: ReviewCheckoutMode;
  /** workspace: the project's active review workspace now. */
  workspace?: ReviewWorkspace;
  /** working_copy: */
  folder?: string;
  branch?: string;
  /** The branch the folder was on ("" when detached). */
  previous_branch?: string;
  /** The pull request head the branch is at now. */
  commit?: string;
  created?: boolean;
  already_on_branch?: boolean;
  /** An existing branch was moved forward to the pull request's newer head. */
  fast_forwarded?: boolean;
};
/** An uncommitted change reported by 409 `dirty_working_copy` (`BridgeError.files`). */
export type ReviewDirtyFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
  /** git's two-letter code. */ code: string;
};

/** `review.workspace`: the project's active review workspace was set or cleared (null). */
export type ReviewWorkspaceEvent = { type: "review.workspace"; seq: number; review_workspace: ReviewWorkspace | null };

/** `review.list_updated`: the cached pull-request list of `folder` was refreshed in the background; ask for it again. */
export type ReviewListUpdatedEvent = { type: "review.list_updated"; seq: number; folder: string };

/** One local branch of a folder, with its distance from the base (`GET /review/branches`). */
export type ReviewBranch = {
  name: string;
  current: boolean;
  /** Commits the branch has that the base lacks. */
  ahead: number;
  /** Commits the base has that the branch lacks. */
  behind: number;
  commit: { sha: string; subject: string; author?: string; date: string };
};

export type ReviewBranchList = {
  folder: string;
  base: string;
  /** The default branch of the default remote ("" when none can be told). */
  default_base: string;
  /** The current branch first, then newest last commit first; at most 200. */
  branches: ReviewBranch[];
  truncated?: boolean;
};

export type ListReviewBranchesParams = {
  /** Label of the project folder (default: the first git folder). */
  folder?: string;
  /** The branch the counts are against; default: `default_base`. Unknown: 400 `unknown_ref`. */
  base?: string;
};

/** One entry of the repository picker. `key` is what to pass as `repo` (`owner/name`, or `all`). */
export type RepoMenuItem = {
  key: string;
  label: string;
  /** The dim text after the label: `origin`, `upstream`, `parent` or the remote's name; none for "All repositories". */
  detail?: string;
  selected: boolean;
};

export type RepoMenu = {
  /** False with a single repository: show the repository as plain text, not a menu. */
  show: boolean;
  /** What the trigger shows: the selected repository's `owner/name`, or "All repositories". */
  current: string;
  /** The repositories in the harness's order, "All repositories" last. */
  items: RepoMenuItem[];
  /** Rows show their repository only when "All repositories" is selected. */
  rowsShowRepo: boolean;
};

export const ALL_REPOSITORIES = "All repositories";

/**
 * The model of the picker's repository menu (pure): a menu when the folder has more than one repository, the
 * "All repositories" choice last (only then), the selected one from `list.repo`.
 */
export function repoMenu(list: Pick<PullRequestList, "repo" | "repos">): RepoMenu {
  const repos = list.repos ?? [];
  const all = list.repo === "all";
  const selectedRepo = all ? undefined : (list.repo ?? repos.find((r) => r.default)?.repo);
  const items: RepoMenuItem[] = repos.map((r) => ({
    key: r.repo,
    label: r.repo,
    detail: r.role === "other" ? (r.remote ?? "other") : r.role,
    selected: r.repo.toLowerCase() === selectedRepo?.toLowerCase(),
  }));
  const show = repos.length > 1;
  if (show) items.push({ key: "all", label: ALL_REPOSITORIES, selected: all });
  return { show, current: all ? ALL_REPOSITORIES : (selectedRepo ?? repos[0]?.repo ?? ""), items, rowsShowRepo: show && all };
}

/**
 * The choices a refusal offers (`repo_mismatch`, `invalid_repo`, `ambiguous_pr` carry `BridgeError.repos`): one button per
 * repository, each retrying with `repo` = `key`. Empty when the error names none.
 */
export function refusalRepoChoices(err: { code?: string; repos?: RepoRef[] }): { key: string; label: string; detail: string }[] {
  if (err.code !== "repo_mismatch" && err.code !== "invalid_repo" && err.code !== "ambiguous_pr") return [];
  return (err.repos ?? []).map((r) => ({ key: r.repo, label: r.repo, detail: r.role === "other" ? (r.remote ?? "other") : r.role }));
}
