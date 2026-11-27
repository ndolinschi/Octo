import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { FileKey } from "../../lib/files";
import { treeLayout } from "../../lib/treeLayout";
import { TREE_MIN, useFileView } from "../../state/fileView";
import type { TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

export type TreeShell = {
  /** The file view's measured width (0 until measured). */
  width: number;
  /** The tree is a page of the group (narrow dock, or the group cannot give the column and 360px to the editor). */
  page: boolean;
  /** Width of the column, and the most a drag may give it. */
  column: number;
  maxWidth: number;
  /** The column's own shown/hidden preference (this group). */
  open: boolean;
  /** Page mode: the tree is the page being shown (otherwise the editor is). */
  treePage: boolean;
  toggleColumn(): void;
  showTree(): void;
  showEditor(): void;
};

/**
 * Decision 94a: where a file group's tree goes. A column at the group's left edge while the group can give it its width and
 * leave the editor 360px; otherwise a page of the group (the group shows the tree or the editor, nothing overlays anything).
 * `root` is the view's own element (the caller attaches it). Measured before the first paint, so the view never paints one shape and then the other (decision 85).
 */
export function useTreeShell(root: RefObject<HTMLDivElement | null>, tab: TabId, fileKey: FileKey | null, groupId: string): TreeShell {
  const ws = useWorkspace();
  const fv = useFileView();
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([e]) => {
      // A hidden view (its tab is not the active one) reports 0: keep the last real width.
      if (e && e.contentRect.width > 0) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [root]);

  const col = fv.column(groupId);
  const { page, column, maxWidth } = treeLayout(width, col.width, TREE_MIN, ws.narrow);

  // Page mode: the empty view starts on the tree; a file coming into the view (picked, linked, a tab chosen) shows the editor;
  // the view turning empty again (the Files tool opened) shows the tree.
  const [treePage, setTreePage] = useState(fileKey === null);
  const [seen, setSeen] = useState(fileKey);
  if (seen !== fileKey) {
    setSeen(fileKey);
    setTreePage(fileKey === null);
  }
  // "Show files" and "Reveal in tree" show the tree page of the visible view.
  const [seenTick, setSeenTick] = useState(fv.focusTreeTick);
  if (seenTick !== fv.focusTreeTick) {
    setSeenTick(fv.focusTreeTick);
    if (ws.isVisible(tab)) setTreePage(true);
  }

  const { setColumnOpen } = fv;
  // Decision 94a: opening the Files tool (the empty view coming into sight, from any entry point) shows its group's tree column,
  // also when the column was hidden; the toggle in the bar hides it again.
  const emptyShown = fileKey === null && ws.isVisible(tab);
  useEffect(() => {
    if (emptyShown && groupId) setColumnOpen(groupId, true, false);
  }, [emptyShown, groupId, fv.focusTreeTick, setColumnOpen]);

  return {
    width,
    page,
    column,
    maxWidth,
    open: col.open,
    treePage,
    toggleColumn: () => setColumnOpen(groupId, !col.open),
    showTree: () => setTreePage(true),
    showEditor: () => setTreePage(false),
  };
}
