import { usePhone } from "../../lib/phone";
import { quietFocus } from "../../lib/quietFocus";
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { cn } from "../../lib/cn";
import { useCode } from "../../state/code";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, useFileView } from "../../state/fileView";
import type { TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { PanelFilters } from "../primitives/Panel";
import { SearchField } from "../primitives/SearchField";
import { FileTree, type FileTreeHandle } from "./FileTree";

/**
 * The file view's tree (decision 94a): a column at the group's left edge with a hairline on its right edge, or the whole
 * group as a page (`page`; `shown` false = the editor's turn: kept mounted and laid out, only invisible, so its scroll and
 * selection stay). The filter is the panels' filter row (`PanelFilters`: 36px, 40 under touch, the 8px pane inset), then the
 * tree with the same 8px side inset, so the field and the rows share both edges.
 * The column resizes from its right edge (pointer, or ←/→ by 16 and Shift by 64 on the focused handle; double-click resets
 * to 220); width and shown/hidden are kept per group (`state/fileView`). Filtering walks the folders breadth-first (`indexFiles`).
 */
export function TreeColumn(props: {
  id: string;
  tab: TabId;
  groupId: string;
  page: boolean;
  shown: boolean;
  width: number;
  maxWidth: number;
  onOpenFile(folder: string, path: string): void;
}) {
  const code = useCode();
  const fv = useFileView();
  const ws = useWorkspace();
  const { filter, setFilter } = fv;
  const input = useRef<HTMLInputElement>(null);
  const tree = useRef<FileTreeHandle>(null);
  const { indexFiles, fileIndex } = code;
  const { width, page, shown } = props;
  const active = filter.trim().length > 0;

  useEffect(() => {
    if (active) indexFiles();
  }, [active, indexFiles]);

  // "Show files" (header) and "Reveal in tree" land in the visible view's filter input — also when the
  // request is what mounted this column (the Files tab opening, the column being shown).
  // Direction 7: not on the phone, where a focused field raises the on-screen keyboard over the tree.
  const { takeFocusRequest } = fv;
  const phone = usePhone();
  useEffect(() => {
    if (shown && ws.isVisible(props.tab) && takeFocusRequest() && !phone) quietFocus(input.current);
  }, [fv.focusTreeTick, ws, props.tab, takeFocusRequest, shown, phone]);

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      tree.current?.focusFirst();
    }
  };

  return (
    <aside
      id={props.id}
      aria-label="File tree"
      style={page ? undefined : { width }}
      inert={!shown}
      className={cn("flex flex-col bg-panel", page ? cn("absolute inset-0", !shown && "invisible") : "relative shrink-0 border-r border-line")}
    >
      {!page && <ResizeHandle groupId={props.groupId} width={width} max={props.maxWidth} />}
      <PanelFilters>
        <SearchField
          ref={input}
          label="Filter files"
          size="sm"
          value={filter}
          onChange={setFilter}
          onKeyDown={onInputKey}
          inputProps={{ spellCheck: false, autoComplete: "off", "aria-controls": `${props.id}-list` }}
          className="min-w-0 flex-1"
        />
      </PanelFilters>
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

/** 8px-wide handle centred on the column's right hairline (keyboard: ←/→ 16, Shift 64; Home/End; double-click resets). */
function ResizeHandle({ groupId, width, max }: { groupId: string; width: number; max: number }) {
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
    fv.setColumnWidth(groupId, Math.min(max, start.current.w + (e.clientX - start.current.x)));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const next =
      e.key === "ArrowRight"
        ? width + step
        : e.key === "ArrowLeft"
          ? width - step
          : e.key === "Home"
            ? TREE_MIN
            : e.key === "End"
              ? Math.min(max, TREE_MAX)
              : null;
    if (next === null) return;
    e.preventDefault();
    fv.setColumnWidth(groupId, Math.min(max, next));
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
      onDoubleClick={() => fv.setColumnWidth(groupId, Math.min(max, TREE_DEFAULT))}
      onKeyDown={onKeyDown}
      className="group/handle absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none focus-visible:shadow-none"
    >
      <span
        aria-hidden
        // Polish step 4, E3: the column's own hairline stays; over it the handle draws a 2px line, `line-strong` on hover and
        // `fg-3` while dragged or focused: visible, never louder than the text.
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-[background-color] duration-100 group-hover/handle:bg-line-strong group-focus-visible/handle:bg-fg-3 group-active/handle:bg-fg-3"
      />
    </div>
  );
}
