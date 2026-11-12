import { EDITOR_MIN_WIDTH, FILE_VIEW_OVERLAY_BELOW } from "./constants";

/**
 * Where a file view's tree goes, from the view's width and the stored column width alone (decision 85): a column, or an
 * overlay when the view is narrow or the column would leave the editor under `EDITOR_MIN_WIDTH`. The real view and its
 * skeleton both call this, so the skeleton has the shape the view will have.
 */
export function treeLayout(width: number, stored: number, min: number): { overlay: boolean; maxWidth: number } {
  const column = Math.max(min, Math.min(stored, Math.round(width * 0.4)));
  const overlay = width > 0 && (width < FILE_VIEW_OVERLAY_BELOW || width - column < EDITOR_MIN_WIDTH);
  return { overlay, maxWidth: overlay ? width - 48 : Math.max(min, Math.min(width - 320, Math.round(width * 0.4))) };
}
