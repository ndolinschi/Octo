import { ListFilter, X } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/cn";
import { useCode } from "../../state/code";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, useFileView } from "../../state/fileView";
import type { TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { FileTree, type FileTreeHandle } from "./FileTree";

/**
 * The file view's tree column: hairline on its left edge, a 40px header holding the 28px Filter files
 * input (8px inset), then the tree with the same 8px side inset. Resizable from its left edge
 * (pointer, or ←/→ by 16 and Shift by 64 on the focused handle; double-click resets to 280); width and
 * open state persist per project. Filtering walks the folders breadth-first (see `indexFiles`).
 */
export function TreeColumn(props: { id: string; tab: TabId; overlay: boolean; maxWidth: number; onOpenFile(folder: string, path: string): void }) {
  const code = useCode();
  const fv = useFileView();
  const ws = useWorkspace();
  const [filter, setFilter] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tree = useRef<FileTreeHandle>(null);
  const { indexFiles, fileIndex } = code;
  const width = Math.max(TREE_MIN, Math.min(fv.treeWidth, props.maxWidth));
  const active = filter.trim().length > 0;

  useEffect(() => {
    if (active) indexFiles();
  }, [active, indexFiles]);

  // "Show files" (header) and "Reveal in tree" land in the visible view's filter input — also when the
  // request is what mounted this column (the Files tab opening, the column being shown).
  const { takeFocusRequest } = fv;
  useEffect(() => {
    if (ws.isVisible(props.tab) && takeFocusRequest()) input.current?.focus({ preventScroll: true });
  }, [fv.focusTreeTick, ws, props.tab, takeFocusRequest]);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && filter) {
      e.preventDefault();
      e.stopPropagation();
      setFilter("");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      tree.current?.focusFirst();
    }
  };

  return (
    <aside
      id={props.id}
      aria-label="File tree"
      style={{ width }}
      className={cn("flex shrink-0 flex-col border-l border-line bg-panel", props.overlay ? "absolute inset-y-0 right-0 z-20 shadow-pop" : "relative")}
    >
      <ResizeHandle width={width} max={props.maxWidth} />
      <div className="flex h-bar shrink-0 items-center px-2">
        <label className="flex h-row min-w-0 flex-1 items-center gap-2 rounded-sm border border-line px-2 text-fg-3 transition-[border-color] duration-100 focus-within:border-focus">
          <Glyph icon={ListFilter} size={14} className="shrink-0" />
          <span className="sr-only">Filter files</span>
          <input
            ref={input}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Filter files"
            spellCheck={false}
            autoComplete="off"
            aria-controls={`${props.id}-list`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none max-sm:text-input-touch"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              title="Clear filter"
              onClick={() => {
                setFilter("");
                input.current?.focus();
              }}
              className="relative -mr-1 grid size-5 shrink-0 press place-items-center rounded-2xs text-fg-3 before:absolute before:-inset-0.5 before:content-[''] hover:bg-hover hover:text-fg"
            >
              <Glyph icon={X} size={14} />
            </button>
          )}
        </label>
      </div>
      <div id={`${props.id}-list`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
        {active && fileIndex.status === "done" && fileIndex.partial && (
          <p className="flex h-row items-center px-2 text-xs text-fg-3">Showing matches in loaded folders</p>
        )}
        {active && fileIndex.status === "loading" && (
          <p className="sr-only" role="status">
            Searching folders…
          </p>
        )}
        <FileTree ref={tree} folders={code.folders} filter={filter} onOpenFile={props.onOpenFile} onExitTop={() => input.current?.focus()} />
      </div>
    </aside>
  );
}

/** 8px-wide handle centred on the column's hairline (keyboard: ←/→ 16, Shift 64; Home/End; double-click resets). */
function ResizeHandle({ width, max }: { width: number; max: number }) {
  const fv = useFileView();
  const start = useRef<{ x: number; w: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start.current = { x: e.clientX, w: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    fv.setTreeWidth(Math.min(max, start.current.w + (start.current.x - e.clientX)));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next =
      e.key === "ArrowLeft"
        ? width + step
        : e.key === "ArrowRight"
          ? width - step
          : e.key === "Home"
            ? TREE_MIN
            : e.key === "End"
              ? Math.min(max, TREE_MAX)
              : null;
    if (next === null) return;
    e.preventDefault();
    fv.setTreeWidth(Math.min(max, next));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize file tree"
      aria-valuenow={width}
      aria-valuemin={TREE_MIN}
      aria-valuemax={Math.min(max, TREE_MAX)}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onDoubleClick={() => fv.setTreeWidth(TREE_DEFAULT)}
      onKeyDown={onKeyDown}
      className="group/handle absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none focus-visible:shadow-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-[background-color] duration-100 group-hover/handle:bg-line-strong group-focus-visible/handle:bg-focus"
      />
    </div>
  );
}
