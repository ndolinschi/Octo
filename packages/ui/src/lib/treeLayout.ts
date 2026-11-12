import { EDITOR_MIN_GROUP } from "./constants";

/**
 * Where a file view's tree goes (decisions 85, 94a), from the view's width and the stored column width alone: a column at
 * the left edge, or a page of the group (the group shows the tree or the editor, never both). The column needs the editor to
 * keep `EDITOR_MIN_GROUP`; a narrow dock (one strip) always uses the page. The real view and its skeleton both call this,
 * so the skeleton has the shape the view will have. An unmeasured view (width 0) is a column.
 */
export function treeLayout(width: number, stored: number, min: number, narrowDock = false): { page: boolean; column: number; maxWidth: number } {
  const maxWidth = Math.max(min, width - EDITOR_MIN_GROUP);
  const column = Math.max(min, stored);
  const page = narrowDock || (width > 0 && width - column < EDITOR_MIN_GROUP);
  return { page, column, maxWidth };
}
