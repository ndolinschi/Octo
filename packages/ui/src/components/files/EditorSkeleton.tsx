import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { treeLayout } from "../../lib/treeLayout";
import { TREE_MIN, useFileView } from "../../state/fileView";

/** Line widths (% of the editor), a code-like ragged edge. */
const LINES = [38, 62, 0, 74, 51, 46, 68, 33, 0, 57, 71, 44, 29, 64, 52, 40];

/**
 * What stands where the editor will be until Monaco and the file are in (decision 60): the same box, a few grey lines.
 * It fills its positioned parent, so nothing around it moves when the editor replaces it, and there is no empty frame.
 */
export function EditorSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden data-editor-skeleton className={cn("absolute inset-0 z-10 flex flex-col gap-3 overflow-hidden bg-panel px-3 pt-3", className)}>
      {LINES.map((w, i) => (
        <span key={i} className={cn("h-2 shrink-0 rounded-full bg-hover", w === 0 && "bg-transparent")} style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

/**
 * The file view before its chunk has loaded (the `Suspense` fallback in `dock/TabView`): the 40px bar with its hairline, the
 * editor's place and the tree column at the width the project last used, so the group has its final shape from the first
 * frame and the real view replaces it without a size change.
 */
export function FileViewSkeleton() {
  const { treeOpen, treeWidth } = useFileView();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Measured before the first paint; the column is drawn only where the real view will draw one (`treeLayout`), so the real
  // view replaces this one without a size change (decision 85).
  useLayoutEffect(() => {
    if (root.current) setWidth(Math.round(root.current.getBoundingClientRect().width));
  }, []);
  const { overlay, maxWidth } = treeLayout(width, treeWidth, TREE_MIN);
  const column = Math.max(TREE_MIN, Math.min(treeWidth, maxWidth));
  return (
    <div ref={root} aria-hidden className="flex min-h-0 flex-1 flex-col">
      <div data-file-bar className="h-bar shrink-0 shadow-[inset_0_-1px_0_var(--octo-line)]" />
      <div className="relative flex min-h-0 flex-1">
        <div data-editor-area className="relative min-w-0 flex-1">
          <EditorSkeleton />
        </div>
        {treeOpen && !overlay && width > 0 && <aside data-tree-skeleton style={{ width: column }} className="shrink-0 border-l border-line bg-panel" />}
      </div>
    </div>
  );
}
