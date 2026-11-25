/**
 * Middle truncation without a character budget (the CSS does the cutting): the label is split into a head that may shrink
 * with an ellipsis and a tail that never does, so "product-configura…nager" keeps its last characters. A short label is one
 * plain span (null). Used by `MiddleText` (chips, list rows, the status bar, the sidebar's project meta). Names shown beside
 * others that share their head (a project's folders) and folder chains use `distinctSplit` (`lib/distinctSplit.ts`, kept
 * out of the entry chunk), which builds on this. Lengths count code points, so a cut never splits a surrogate pair.
 */
export const MIDDLE_MIN_LENGTH = 14;
const MIDDLE_TAIL_MAX = 8;

/** `distinct`: the tail is what tells the name apart; the head gives way first (`MiddleText`). */
export type MiddleSplit = { head: string; tail: string; distinct?: true };

export function middleSplit(text: string): MiddleSplit | null {
  const chars = Array.from(text);
  if (chars.length <= MIDDLE_MIN_LENGTH) return null;
  return cutAt(chars, chars.length - Math.min(MIDDLE_TAIL_MAX, Math.floor(chars.length / 3)));
}

export function cutAt(chars: string[], at: number): MiddleSplit {
  const head = chars.slice(0, at).join("");
  const tail = chars.slice(at).join("");
  // A space at the cut would collapse at the edge of either span ("Claude Code ·Sonnet"): it moves to the tail's start as
  // a no-break space, which keeps its width.
  if (!/\s$/.test(head) && !/^\s/.test(tail)) return { head, tail };
  return { head: head.trimEnd(), tail: ` ${tail.trimStart()}` };
}
