/** Decision 79: split only when each side keeps at least this much room, else one column. */
export const SIDE_MIN_PX = 480;
/** The divider and the two gutters between the sides. */
const SPLIT_OVERHEAD_PX = 40;

export type ReviewDiffPrefer = "split" | "unified" | "auto";
export type ReviewDiffLayout = "split" | "unified";

/**
 * Which layout the diff gets. The width floor wins over every preference: a split pane narrower than two sides of
 * `SIDE_MIN_PX` is unreadable (the owner's screenshot), so `prefer: "split"` still falls back to one column there.
 * Before the first measure (`null`) the answer is unified: it never needs sideways room.
 */
export function reviewDiffLayout(prefer: ReviewDiffPrefer, paneWidth: number | null): ReviewDiffLayout {
  if (prefer === "unified" || paneWidth === null) return "unified";
  return paneWidth >= SIDE_MIN_PX * 2 + SPLIT_OVERHEAD_PX ? "split" : "unified";
}
