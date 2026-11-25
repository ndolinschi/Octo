/** The pure part of `useStickToBottom` (`hooks.ts`): what a scroll event means for a view that follows new content. */

/** How long after the reader's own input (wheel, touch, a scroll key, the scrollbar) a scroll counts as theirs. */
export const READER_INPUT_MS = 1000;

/** Keys that scroll the focused scroller (outside a text field), or move focus into view (Tab). */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " ", "Tab"]);

export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/**
 * What one scroll event means for a view that follows new content: `follow` (at the end), `repin` (a following view was
 * moved off the end by something other than the reader: put it back), `let-go` (not following, or the reader went up).
 * WebKit moves `scrollTop` up by itself when content above re-lays out (P1: a long conversation opened 92 px short of the
 * end), with no change of `scrollHeight`, so "scrollTop went down" alone is not the reader: it counts only right after their
 * own input, or when the move is a screenful or more (a page scroll by assistive technology, the browser's find).
 */
export function stickDecision(o: {
  end: boolean;
  following: boolean;
  /** scrollTop went down while the content did not get shorter. */
  movedUp: boolean;
  /** How far it went down, in px. */
  distance: number;
  /** The scroller's visible height. */
  page: number;
  /** ms since the reader's last input inside the scroller (Infinity: none). */
  sinceInput: number;
}): "follow" | "repin" | "let-go" {
  if (o.end) return "follow";
  if (!o.following) return "let-go";
  const reader = o.sinceInput <= READER_INPUT_MS || o.distance >= o.page * 0.9;
  return o.movedUp && reader ? "let-go" : "repin";
}
