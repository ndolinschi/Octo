import type { ReviewCheckoutResult, ReviewDirtyFile } from "@octo/agent-client";

const STATUS_WORD: Record<ReviewDirtyFile["status"], string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  untracked: "new, not tracked",
  conflicted: "conflicted",
};

export function dirtyStatusWord(s: ReviewDirtyFile["status"]): string {
  return STATUS_WORD[s];
}

/** The most files listed before "and N more". */
export const DIRTY_SHOWN = 8;

export function dirtyList(files: readonly ReviewDirtyFile[]): { shown: ReviewDirtyFile[]; more: number } {
  return { shown: files.slice(0, DIRTY_SHOWN), more: Math.max(0, files.length - DIRTY_SHOWN) };
}

/** Conflicts in the working copy: the harness refuses them even when confirmed, so the sheet says so instead of offering it. */
export function hasConflicts(files: readonly ReviewDirtyFile[]): boolean {
  return files.some((f) => f.status === "conflicted");
}

/** The command that returns the folder to where it was, or null when there is nothing to return to. */
export function goBackCommand(r: Pick<ReviewCheckoutResult, "previous_branch" | "already_on_branch">): string | null {
  if (r.already_on_branch) return null;
  return r.previous_branch ? `git switch ${r.previous_branch}` : "git switch -";
}

/** One sentence after a check out: which branch you are on now. */
export function checkoutSentence(r: ReviewCheckoutResult): string {
  if (r.mode === "workspace") return "The file tree and editor now show this pull request (read-only copy). Your own folder is untouched.";
  const branch = r.branch ?? "the review branch";
  if (r.already_on_branch) return `You were already on ${branch}.`;
  const how = r.created ? "Created and switched to" : r.fast_forwarded ? "Switched to and moved forward" : "Switched to";
  return `${how} ${branch}${r.commit ? ` at ${r.commit.slice(0, 7)}` : ""}.`;
}
