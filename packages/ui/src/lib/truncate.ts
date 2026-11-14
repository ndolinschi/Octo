/**
 * Middle truncation without a character budget (the CSS does the cutting): the label is split into a head that may shrink
 * with an ellipsis and a tail that never does, so "product-configura…nager" keeps its last characters. A short label is one
 * plain span (null). Used by `MiddleText` (chips, list rows).
 */
export const MIDDLE_MIN_LENGTH = 14;
const MIDDLE_TAIL_MAX = 8;

export function middleSplit(text: string): { head: string; tail: string } | null {
  if (text.length <= MIDDLE_MIN_LENGTH) return null;
  const n = Math.min(MIDDLE_TAIL_MAX, Math.floor(text.length / 3));
  const head = text.slice(0, text.length - n);
  const tail = text.slice(text.length - n);
  // A space at the cut would collapse at the edge of either span ("Claude Code ·Sonnet"): it moves to the tail's start as
  // a no-break space, which keeps its width.
  if (!/\s$/.test(head) && !/^\s/.test(tail)) return { head, tail };
  return { head: head.trimEnd(), tail: `\u00a0${tail.trimStart()}` };
}
