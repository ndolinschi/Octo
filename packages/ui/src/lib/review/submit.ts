import type { Review, ReviewVerdict } from "@octo/agent-client";
import { plural } from "./files";

type Target = Pick<Review, "kind" | "repo" | "number" | "source">;

export const VERDICTS: readonly { id: ReviewVerdict; label: string; hint: string }[] = [
  { id: "comment", label: "Comment", hint: "General feedback; no approval either way." },
  { id: "approve", label: "Approve", hint: "You are happy for this to merge." },
  { id: "request_changes", label: "Request changes", hint: "This must change before it can merge." },
];

export function verdictLabel(v: ReviewVerdict): string {
  return VERDICTS.find((x) => x.id === v)?.label ?? v;
}

/** `owner/repo#123` for a pull request, `base..head` for a local review. */
export function reviewTarget(review: Target): string {
  if (review.kind === "github" && review.repo && review.number !== undefined) return `${review.repo}#${review.number}`;
  return review.source.replace(/^(github|local):/, "");
}

/**
 * The text of the submit button: exactly what will be posted and where. A local review says plainly that nothing leaves
 * the machine. `comments` counts the pending comments (general ones too); `hasBody` is a typed review text.
 */
export function submitText(review: Target, verdict: ReviewVerdict, comments: number, hasBody: boolean, replies = 0): string {
  // Replies to existing threads leave with the review too; they are counted apart from the comments ("1 comment and 1 reply").
  const items = [comments > 0 ? plural(comments, "comment") : "", replies > 0 ? plural(replies, "reply", "replies") : ""].filter(Boolean).join(" and ");
  if (review.kind === "local") {
    return items ? `Mark ${items} as submitted (nothing is posted)` : "Mark review as done (nothing is posted)";
  }
  const target = reviewTarget(review);
  const parts = items || (hasBody ? "your review text" : "");
  switch (verdict) {
    case "approve":
      return parts ? `Approve ${target} with ${parts} as you` : `Approve ${target} as you`;
    case "request_changes":
      return parts ? `Post ${parts} and request changes on ${target} as you` : `Request changes on ${target} as you`;
    case "comment":
      return parts ? `Post ${parts} to ${target} as you` : `Post a review to ${target} as you`;
  }
}

/** True when a submit has something to post (the harness refuses an empty review unless it approves). */
export function canSubmit(verdict: ReviewVerdict, comments: number, hasBody: boolean): boolean {
  return verdict === "approve" || comments > 0 || hasBody;
}

export type SubmitProblem = {
  kind: "comments_changed" | "not_logged_in" | "code_host_error" | "empty_review" | "other";
  title: string;
  advice: string;
  command?: string;
};

/** An error of the submit call as a title, what to do, and the command to run when there is one. Everything stays pending. */
export function submitProblem(e: unknown): SubmitProblem {
  const raw: unknown = typeof e === "object" && e !== null && "code" in e ? e.code : "";
  const code = typeof raw === "string" ? raw : "";
  const message = e instanceof Error ? e.message : String(e);
  // The server's own command wins (`BridgeError.command`); "gh auth login" is what a GitHub host needs when it says none.
  const own = typeof e === "object" && e !== null && "command" in e && typeof e.command === "string" && e.command ? e.command : "";
  switch (code) {
    case "comments_changed":
      return {
        kind: "comments_changed",
        title: "Your comments changed while this sheet was open",
        advice: "Nothing was posted. The list below is up to date; read it again and submit once more.",
      };
    case "not_logged_in":
      return {
        kind: "not_logged_in",
        title: "You are not logged in to GitHub",
        advice: "Nothing was posted and every comment is still pending. Log in with the command below, then submit again.",
        command: own || "gh auth login",
      };
    case "code_host_error":
      return {
        kind: "code_host_error",
        title: "GitHub did not accept the review",
        advice: `${message}. Nothing was posted and every comment is still pending. Check the message, fix what it names, and submit again.`,
      };
    case "empty_review":
      return { kind: "empty_review", title: "There is nothing to post", advice: "Add a comment or a review text, or choose Approve." };
    default:
      return { kind: "other", title: "The review was not submitted", advice: `${message}. Every comment is still pending; try again.` };
  }
}

/** One short line after a successful submit. */
export function submittedText(review: Target, verdict: ReviewVerdict, comments: number, posted: boolean): string {
  if (!posted) return `Marked ${plural(comments, "comment")} as submitted. Nothing was posted: this review is local.`;
  const what = verdict === "approve" ? "Approved" : verdict === "request_changes" ? "Requested changes on" : "Reviewed";
  return `${what} ${reviewTarget(review)}${comments > 0 ? ` with ${plural(comments, "comment")}` : ""}. Posted as you.`;
}
