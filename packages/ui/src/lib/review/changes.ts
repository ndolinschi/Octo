import type { DiffHunk } from "@octo/agent-client";

/** One run of added / removed lines in a file's diff: where `j` and `k` land. */
export type ChangeBlock = {
  side: "new" | "old";
  /** The line to reveal on that side. */ line: number;
  /** Last line of the run on that side. */ end: number;
  /** Where the run sits in the new text (a removal sits at the line after it): what a one-column view reveals. */ at: number;
};

type Run = { at: number; firstNew: number | null; lastNew: number; firstOld: number | null; lastOld: number };

/** The runs of changed lines of a file, top to bottom. A run with additions lands on its first added line, a pure removal on its first removed line. */
export function changeBlocks(hunks: readonly DiffHunk[]): ChangeBlock[] {
  const out: ChangeBlock[] = [];
  for (const h of hunks) {
    let oldAt = h.old_start;
    let newAt = h.new_start;
    let run: Run | null = null;
    const close = () => {
      if (!run) return;
      if (run.firstNew !== null) out.push({ side: "new", line: run.firstNew, end: run.lastNew, at: run.at });
      else if (run.firstOld !== null) out.push({ side: "old", line: run.firstOld, end: run.lastOld, at: run.at });
      run = null;
    };
    for (const l of h.lines) {
      if (l.type === "context") {
        close();
        oldAt += 1;
        newAt += 1;
        continue;
      }
      const r: Run = run ?? { at: newAt, firstNew: null, lastNew: 0, firstOld: null, lastOld: 0 };
      run = r;
      if (l.type === "add") {
        const at = l.new ?? newAt;
        r.firstNew ??= at;
        r.lastNew = at;
        newAt += 1;
      } else {
        const at = l.old ?? oldAt;
        r.firstOld ??= at;
        r.lastOld = at;
        oldAt += 1;
      }
    }
    close();
  }
  return out;
}

export type ChangeStep = { kind: "in"; index: number } | { kind: "file"; dir: 1 | -1 };

/**
 * `j` (dir 1) and `k` (dir -1): the next or previous change in this file; past the last or first one the caller moves to
 * the next or previous file. With no current change, `j` goes to the first and `k` to the last.
 */
export function stepChange(count: number, current: number | null, dir: 1 | -1): ChangeStep {
  if (count === 0) return { kind: "file", dir };
  if (current === null) return { kind: "in", index: dir === 1 ? 0 : count - 1 };
  const next = current + dir;
  return next < 0 || next >= count ? { kind: "file", dir } : { kind: "in", index: next };
}

/** The change block that holds `line` on `side`, or the first one at or after it; null past the last. */
export function blockAt(blocks: readonly ChangeBlock[], side: "new" | "old", line: number): number | null {
  const exact = blocks.findIndex((b) => b.side === side && line >= b.line && line <= b.end);
  if (exact >= 0) return exact;
  const after = blocks.findIndex((b) => b.side === side && b.line >= line);
  return after >= 0 ? after : null;
}

/**
 * The two texts of a file as far as the hunks show it, for the diff editor. Lines the diff does not show are blank,
 * identical on both sides (so they never look changed and the editor folds them), which keeps every shown line at its
 * real line number: a comment's line number is the file's.
 */
export function hunksToTexts(hunks: readonly DiffHunk[]): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const h of hunks) {
    while (before.length < Math.max(0, h.old_start - 1)) before.push("");
    while (after.length < Math.max(0, h.new_start - 1)) after.push("");
    for (const l of h.lines) {
      if (l.type !== "add") before.push(l.text);
      if (l.type !== "del") after.push(l.text);
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}
