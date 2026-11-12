import type { ReviewBranch } from "@octo/agent-client";

/** Decision 84: the current branch first, then the most recently committed; stable for equal dates. */
export function branchOrder(list: readonly ReviewBranch[]): ReviewBranch[] {
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.commit.date) - Date.parse(a.commit.date));
}

/** A branch with nothing ahead of the base has nothing to review. */
export const hasChanges = (b: Pick<ReviewBranch, "ahead">): boolean => b.ahead > 0;

/** "4 ahead, 1 behind", "7 ahead"; "no changes" when nothing is ahead (behind is then the whole story and stays quiet). */
export function aheadBehindText(b: Pick<ReviewBranch, "ahead" | "behind">): string {
  if (b.ahead === 0) return "no changes";
  return b.behind > 0 ? `${b.ahead} ahead, ${b.behind} behind` : `${b.ahead} ahead`;
}

/** What opens when a row is chosen: the branch against the list's base. */
export function openInput(b: Pick<ReviewBranch, "name">, base: string): { source: "local"; base: string; head: string } {
  return { source: "local", base, head: b.name };
}

/** "↑4 ↓1", "↑7"; "no changes" when nothing is ahead. The words are `aheadBehindText`, for the tooltip. */
export function aheadBehindCompact(b: Pick<ReviewBranch, "ahead" | "behind">): string {
  if (b.ahead === 0) return "no changes";
  return b.behind > 0 ? `↑${b.ahead} ↓${b.behind}` : `↑${b.ahead}`;
}

/**
 * A name cut in the middle (decision 90): the head may truncate, the tail never does, so `mira/billing-retry` reads
 * "mira/bil…ling-retry" and not "mira…". The tail is the last `tail` characters; a name no longer than that has none.
 */
export function splitName(name: string, tail = 12): { head: string; tail: string } {
  if (name.length <= tail * 2) return { head: name, tail: "" };
  return { head: name.slice(0, name.length - tail), tail: name.slice(name.length - tail) };
}
