import type { PullRequestRow } from "@octo/agent-client";

/**
 * What the "paste a URL or type a number" field holds: a number (`123` or `#123`), a pull-request address, or neither.
 * The harness validates the address against the project's repository; this only tells the forms apart.
 */
export type PullInput = { kind: "number"; pr: number } | { kind: "url"; url: string };

export function parsePullInput(text: string): PullInput | null {
  const t = text.trim();
  if (!t) return null;
  const num = /^#?(\d{1,7})$/.exec(t);
  if (num?.[1]) {
    const pr = Number(num[1]);
    return pr > 0 ? { kind: "number", pr } : null;
  }
  return /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/.test(t) ? { kind: "url", url: t } : null;
}

export const CHECKS_LABEL: Record<PullRequestRow["checks"], string> = {
  success: "Checks passed",
  failure: "Checks failing",
  pending: "Checks running",
  none: "No checks",
};

/** Rows that ask for the user's review come first; the API already sends them so, this keeps it when it does not. */
export function orderRows(rows: readonly PullRequestRow[]): PullRequestRow[] {
  const rank = (r: PullRequestRow) => (r.review_requested ? 0 : 1);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** The small status words of a row, in the order they matter. */
export function rowStatus(r: PullRequestRow): string[] {
  const out: string[] = [];
  if (r.draft) out.push("Draft");
  if (r.review_requested) out.push("Review requested");
  if (r.review?.new_commits) out.push("New commits since your review");
  else if (r.review) out.push(r.review.pending_comments > 0 ? `${r.review.pending_comments} pending` : "Review open");
  return out;
}

/** What the list says when the host cannot be used, by reason. */
export function unavailableTitle(reason: string | undefined): string {
  switch (reason) {
    case "gh_not_installed":
      return "The GitHub CLI is not installed";
    case "not_logged_in":
      return "You are not logged in to GitHub";
    case "no_github_repo":
      return "This repository is not on GitHub";
    case "not_a_git_repo":
      return "This folder is not a git repository";
    case "no_folder":
      return "This project has no folder";
    default:
      return "Pull requests are not available here";
  }
}

/** A failed list call as one plain sentence and a next step; the technical text is the caller's "Details" (decision 94b). */
export function listFailure(raw: string): { message: string; hint: string } {
  const hint = "Check the connection and refresh. You can still review a local branch: pick Local branches above.";
  if (/resolve host|network|unreachable|timed out|timeout|connection|offline|dns/i.test(raw)) return { message: "Could not reach the code host.", hint };
  return { message: "The code host did not answer the list request.", hint };
}

/** The review id `github:owner/repo#12` as a person says it: `owner/repo #12`. */
export function reviewSourceText(source: string): string {
  return source.replace(/^(github|local):/, "").replace("#", " #");
}
