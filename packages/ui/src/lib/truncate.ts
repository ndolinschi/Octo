/**
 * Middle truncation without a character budget (the CSS does the cutting): the label is split into a head that may shrink
 * with an ellipsis and a tail that never does, so "product-configura…nager" keeps its last characters. A short label is one
 * plain span (null). Used by `MiddleText` (chips, list rows).
 */
export const MIDDLE_MIN_LENGTH = 14;
const MIDDLE_TAIL_MAX = 8;

export function middleSplit(text: string): { head: string; tail: string } | null {
  if (text.length <= MIDDLE_MIN_LENGTH) return null;
  const tail = Math.min(MIDDLE_TAIL_MAX, Math.floor(text.length / 3));
  return { head: text.slice(0, text.length - tail), tail: text.slice(text.length - tail) };
}
