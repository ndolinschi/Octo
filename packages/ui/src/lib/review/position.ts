import type { DiffHunk, ReviewCommentInput } from "@octo/agent-client";

export type Side = "new" | "old";
export type LineRun = { start: number; end: number };

/** Lines of context GitHub (and the harness) accept around a change. */
export const COMMENT_CONTEXT = 3;

/**
 * The runs of lines a comment may sit on, per side: changed lines and up to three lines of context around them, inside
 * one hunk (the harness's `line_not_in_diff` rule, checked here first so the "+" only offers what will be accepted).
 */
export function commentableRuns(hunks: readonly DiffHunk[], side: Side): LineRun[] {
  const runs: LineRun[] = [];
  for (const h of hunks) {
    const changed = h.lines.flatMap((l, i) => (l.type === "context" ? [] : [i]));
    let run: LineRun | null = null;
    for (const [i, l] of h.lines.entries()) {
      const line = side === "new" ? l.new : l.old;
      const onSide = side === "new" ? l.type !== "del" : l.type !== "add";
      const near = changed.some((c) => Math.abs(c - i) <= COMMENT_CONTEXT);
      if (onSide && near && line !== undefined) {
        if (run && line === run.end + 1) run.end = line;
        else {
          run = { start: line, end: line };
          runs.push(run);
        }
      }
    }
  }
  return runs;
}

export function lineInDiff(hunks: readonly DiffHunk[], side: Side, line: number): boolean {
  return commentableRuns(hunks, side).some((r) => line >= r.start && line <= r.end);
}

/** A range comment needs both ends in one run (one hunk). */
export function rangeInDiff(hunks: readonly DiffHunk[], side: Side, start: number, end: number): boolean {
  const [a, b] = start <= end ? [start, end] : [end, start];
  return commentableRuns(hunks, side).some((r) => a >= r.start && b <= r.end);
}

export type Anchor = { side: Side; start: number; end: number };

/** The anchor with its ends in order. */
export function normalizeAnchor(a: Anchor): Anchor {
  return a.start <= a.end ? a : { ...a, start: a.end, end: a.start };
}

/** Why an anchor cannot take a comment, in words that say what to do; null when it can. */
export function anchorProblem(hunks: readonly DiffHunk[], a: Anchor, suggestion: boolean): string | null {
  const n = normalizeAnchor(a);
  if (suggestion && n.side === "old") return "A suggestion replaces lines of the new version. Select lines on the right (the new side) instead.";
  if (rangeInDiff(hunks, n.side, n.start, n.end)) return null;
  const single = n.start === n.end;
  const where = single ? `Line ${n.start}` : `Lines ${n.start}–${n.end}`;
  if (!single && lineInDiff(hunks, n.side, n.start) && lineInDiff(hunks, n.side, n.end))
    return `${where} cross a gap between two changes. Keep a range inside one change, or comment on each part.`;
  return `${where} ${single ? "is" : "are"} not part of the diff. The code host takes comments on changed lines and up to three lines around them; pick one of those, or leave a file comment.`;
}

/** The API input for a comment on an anchor: one line is `line`, a range adds `start_line`. */
export function lineCommentInput(path: string, a: Anchor, body: string, suggestion?: string): ReviewCommentInput {
  const n = normalizeAnchor(a);
  return {
    path,
    side: n.side,
    line: n.end,
    ...(n.start < n.end ? { start_line: n.start } : {}),
    body,
    ...(suggestion !== undefined ? { suggestion } : {}),
  };
}

export const fileCommentInput = (path: string, body: string): ReviewCommentInput => ({ path, body });
export const generalCommentInput = (body: string): ReviewCommentInput => ({ body });

/** "src/a.ts:12", "src/a.ts:12–14", "src/a.ts", or "General". */
export function commentWhere(c: { path?: string; line?: number; start_line?: number }): string {
  if (!c.path) return "General";
  if (c.line === undefined) return c.path;
  return c.start_line !== undefined && c.start_line < c.line ? `${c.path}:${c.start_line}–${c.line}` : `${c.path}:${c.line}`;
}

/** The text of lines `start..end` (1-based) of a text; what a suggestion editor is prefilled with. */
export function linesOf(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join("\n");
}

/** The API's error for a comment as one sentence with a next step. */
export function commentError(code: string | undefined, message: string): string {
  switch (code) {
    case "line_not_in_diff":
      return "That line is not part of the diff. The code host takes comments on changed lines and up to three lines around them. Pick a changed line, or leave a file comment.";
    case "path_not_in_diff":
      return "That file is not part of this review any more. Refresh the review and try again.";
    case "empty_comment":
      return "Write something before adding the comment.";
    case "comment_too_large":
      return "That comment is too long. Shorten it or split it in two.";
    case "review_closed":
      return "This review is closed. Reopen it to comment.";
    case "comment_submitted":
      return "That comment was already posted and cannot be changed.";
    case "invalid_side":
      return "Comments on removed lines go on the left side; suggestions go on the right.";
    default:
      return `The comment was not saved: ${message}. Try again.`;
  }
}

/** The `code` of a bridge error ("line_not_in_diff", "comments_changed", ...), or undefined for anything else. */
export function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null || !("code" in e)) return undefined;
  return typeof e.code === "string" ? e.code : undefined;
}
