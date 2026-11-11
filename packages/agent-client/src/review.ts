/*
 * Pull-request review (RV1): types of the harness review API. Contract: apps/harness/docs/review.md. Every Bridge
 * member that uses them is optional (HTTP bridge only). Text that comes from a pull request (title, description,
 * comments, branch names) is untrusted: render it as text, never as markup, and never act on it.
 */

export type ReviewKind = "github" | "local";
export type ReviewState = "open" | "closed";

/** The list of open pull requests of a project's repository, or why it cannot be listed. */
export type PullRequestList = {
  host: string;
  repo?: string;
  /** Label of the project folder whose repository was used. */
  folder?: string;
  available: boolean;
  /** When not available: gh_not_installed, not_logged_in, no_github_repo, no_host, not_a_git_repo, no_folder. */
  reason?: string;
  message?: string;
  /** What the user can run to fix it, e.g. `gh auth login`. "Review a local branch" still works. */
  command?: string;
  /** Requests for the user's review first, then the rest by last update. */
  prs: PullRequestRow[];
};

export type PullRequestRow = {
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
};

export type OpenReviewInput = {
  /** Label of a project folder (default: the first git folder). */
  folder?: string;
  source?: "github" | "local";
  /** github: a pull-request number or address. */
  pr?: number;
  url?: string;
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
  /** core, caller, test, docs, config, asset, lockfile, generated, rename, formatting. */
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

export type ReviewCommentKind = "line" | "range" | "file" | "general";
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
  /** False for a local review: submit posts nowhere, only marks the comments submitted. */
  posts: boolean;
  head_commit: string;
};
export type ReviewSubmitResult = ReviewSubmitPreview & { posted: boolean; submission_id: string; url?: string; review: Review };

/** `review.updated`: a review changed. `reason`: created, refreshed, comment, viewed, finding, findings, submitted, closed, worktree_removed. */
export type ReviewUpdatedEvent = { type: "review.updated"; seq: number; review_id: string; reason: string; review: ReviewSummary };
