import { EDITOR_MIN_GROUP } from "./constants";

/** The tree column nobody has dragged (stored width 0): this share of the file view, between the two bounds. */
const AUTO_SHARE = 0.4;
const AUTO_FLOOR = 220;
const AUTO_CEIL = 360;

/**
 * Where a file view's tree goes (decisions 85, 94a), from the view's width and the stored column width alone: a column at
 * the left edge, or a page of the group (the group shows the tree or the editor, never both). The column needs the editor to
 * keep `EDITOR_MIN_GROUP`; a narrow dock (one strip) always uses the page. The real view and its skeleton both call this,
 * so the skeleton has the shape the view will have. An unmeasured view (width 0) is a column.
 *
 * A stored width of 0 is the default: 40% of the view (220–360, and never so wide that the editor loses its 360), so a
 * wide Files tab is not a thin strip beside an empty editor and a narrow one still has its column. It follows the view's
 * width (the layout), never what the view shows (decision 79): opening a file does not move it.
 */
export function treeLayout(width: number, stored: number, min: number, narrowDock = false): { page: boolean; column: number; maxWidth: number } {
  const maxWidth = Math.max(min, width - EDITOR_MIN_GROUP);
  const column = stored > 0 ? Math.max(min, stored) : autoColumn(width, min);
  const page = narrowDock || (width > 0 && width - column < EDITOR_MIN_GROUP);
  return { page, column, maxWidth };
}

function autoColumn(width: number, min: number): number {
  if (width <= 0) return AUTO_FLOOR;
  const share = Math.round(Math.min(AUTO_CEIL, Math.max(AUTO_FLOOR, width * AUTO_SHARE)));
  return Math.max(min, Math.min(share, width - EDITOR_MIN_GROUP));
}
