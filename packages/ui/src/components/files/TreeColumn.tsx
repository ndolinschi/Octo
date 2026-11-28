import { RefreshCw } from "lucide-react";
import { useLatest } from "../../lib/hooks";
import { usePhone } from "../../lib/phone";
import { quietFocus } from "../../lib/quietFocus";
import { memo, useCallback, useDeferredValue, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { cn } from "../../lib/cn";
import { useCode } from "../../state/code";
import { planRefreshDirs } from "../../state/dirCache";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, useFileFilter, useFileView } from "../../state/fileView";
import { useProject } from "../../state/project";
import type { TabId } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/IconButton";
import { PanelFilters } from "../primitives/Panel";
import { ResizeHandle } from "../primitives/ResizeHandle";
import { SearchField } from "../primitives/SearchField";
import { FileTree, type FileTreeHandle } from "./FileTree";

/** Minimum gap between automatic background refreshes (visibility, focus, turn/command end) so rapid switches stay quiet. */
const AUTO_REFRESH_MS = 1500;

/**
 * The file view's tree (decision 94a): a column at the group's left edge with a hairline on its right edge, or the whole
 * group as a page (`page`; `shown` false = the editor's turn: kept mounted and laid out, only invisible, so its scroll and
 * selection stay). The filter is the panels' filter row (`PanelFilters`: 36px, 40 under touch, the 8px pane inset), then the
 * tree with the same 8px side inset, so the field and the rows share both edges.
 * The column resizes from its right edge (pointer, or ←/→ by 16 and Shift by 64 on the focused handle; double-click resets
 * to the default, 40% of the view: `lib/treeLayout`); width and shown/hidden are kept per group (`state/fileView`). Filtering walks the folders breadth-first (`indexFiles`).
 */
export const TreeColumn = memo(function TreeColumn(props: {
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
  const { onEvent, live } = useProject();
  const { filter, setFilter } = useFileFilter();
  const deferredFilter = useDeferredValue(filter);
  const ws = useWorkspace();
  const aside = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const tree = useRef<FileTreeHandle>(null);
  const { indexFiles, fileIndex, evictDirs, reloadDir } = code;
  const codeRef = useLatest(code);
  const { width, page, shown } = props;
  const active = filter.trim().length > 0;
  const visible = shown && ws.isVisible(props.tab);

  const lastRefresh = useRef(0);
  const triggerRefresh = useCallback(
    (force = false) => {
      const now = Date.now();
      if (!force && now - lastRefresh.current < AUTO_REFRESH_MS) return;
      lastRefresh.current = now;
      const { reload, evict } = planRefreshDirs(codeRef.current.dirs, codeRef.current.isExpanded);
      evictDirs(evict);
      for (const d of reload) reloadDir(d.folder, d.path, true);
      if (active) indexFiles(true);
    },
    [codeRef, evictDirs, reloadDir, indexFiles, active],
  );

  useEffect(() => {
    if (active) indexFiles();
  }, [active, indexFiles]);

  // Refresh expanded directories when returning to the Files tab (skips initial mount while roots load via ensureDir).
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (visible && !wasVisible.current) triggerRefresh();
    wasVisible.current = visible;
  }, [visible, triggerRefresh]);

  // Refresh when the window regains focus or returns from background so external/terminal additions appear without clicking.
  useEffect(() => {
    if (!visible) return;
    const onFocus = () => triggerRefresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") triggerRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, triggerRefresh]);

  // Refresh after an SSE reconnect, or after an agent turn / run command finishes; re-index live when filtering.
  const prevLive = useRef(live);
  useEffect(() => {
    if (prevLive.current !== "live" && live === "live" && visible) triggerRefresh(true);
    prevLive.current = live;
  }, [live, visible, triggerRefresh]);

  useEffect(() => {
    let timer = 0;
    const unsub = onEvent((event) => {
      if (event.type === "turn.finished" || event.type === "command.finished") {
        if (visible) triggerRefresh();
        return;
      }
      if (event.type === "file.changed" && active && visible) {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          indexFiles(true);
        }, 250);
      }
    });
    return () => {
      if (timer) window.clearTimeout(timer);
      unsub();
    };
  }, [onEvent, visible, active, triggerRefresh, indexFiles]);

  // "Show files" (header) and "Reveal in tree" land in the visible view's filter input — also when the
  // request is what mounted this column (the Files tab opening, the column being shown).
  // Direction 7: not on the phone, where a focused field raises the on-screen keyboard over the tree.
  const { takeFocusRequest } = fv;
  const phone = usePhone();
  useEffect(() => {
    if (visible && takeFocusRequest() && !phone) quietFocus(input.current);
  }, [fv.focusTreeTick, takeFocusRequest, visible, phone]);

  const onInputKey = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      tree.current?.focusFirst();
    }
  }, []);
  const onExitTop = useCallback(() => input.current?.focus(), []);

  return (
    <aside
      ref={aside}
      id={props.id}
      aria-label="File tree"
      style={page ? undefined : { width }}
      inert={!shown}
      className={cn("flex flex-col bg-panel", page ? cn("absolute inset-0", !shown && "invisible") : "relative shrink-0 border-r border-line")}
    >
      {!page && <ColumnHandle groupId={props.groupId} width={width} max={props.maxWidth} aside={aside} />}
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
        <IconButton icon={RefreshCw} label="Refresh files" size="sm" onClick={() => triggerRefresh(true)} className="shrink-0" />
      </PanelFilters>
      <div id={`${props.id}-list`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4 [overflow-anchor:none]">
        {active && fileIndex.status === "done" && fileIndex.partial && (
          <p className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">Showing matches in loaded folders</p>
        )}
        {active && fileIndex.status === "loading" && (
          <p className="sr-only" role="status">
            Searching folders…
          </p>
        )}
        <FileTree ref={tree} folders={code.folders} filter={deferredFilter} onOpenFile={props.onOpenFile} onExitTop={onExitTop} />
      </div>
    </aside>
  );
});

/**
 * 8px-wide handle centred on the column's right hairline: the shared `ResizeHandle` (drag, ←/→ 16, Shift 64). Double-click
 * goes back to the default, which follows the view's width (`lib/treeLayout`).
 */
function ColumnHandle({ groupId, width, max, aside }: { groupId: string; width: number; max: number; aside: RefObject<HTMLElement | null> }) {
  const fv = useFileView();
  const start = useRef(width);
  const next = useRef(width);
  const clamp = (w: number) => Math.max(TREE_MIN, Math.min(Math.min(max, TREE_MAX), Math.round(w)));
  const commit = (w: number) => fv.setColumnWidth(groupId, clamp(w));
  return (
    <ResizeHandle
      label="Resize file tree"
      title="Drag to resize; double-click to reset"
      value={width}
      min={TREE_MIN}
      max={Math.min(max, TREE_MAX)}
      onDragStart={() => {
        start.current = width;
        next.current = width;
      }}
      onDrag={(_dx, total) => {
        next.current = clamp(start.current + total);
      }}
      // Preview directly on the aside's inline width so dragging never re-renders WorkspaceProvider/Dock every frame.
      onFrame={() => {
        if (aside.current) aside.current.style.width = `${next.current}px`;
      }}
      onDragEnd={() => commit(next.current)}
      onKey={(dx) => commit(width + dx)}
      onReset={() => fv.setColumnWidth(groupId, TREE_DEFAULT)}
      className="group/handle absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none focus-visible:shadow-none"
    >
      <span
        aria-hidden
        // Polish step 4, E3: the column's own hairline stays; over it the handle draws a 2px line, `line-strong` on hover and
        // `fg-3` while dragged or focused: visible, never louder than the text.
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-[background-color] duration-fast group-hover/handle:bg-line-strong group-focus-visible/handle:bg-fg-3 group-active/handle:bg-fg-3"
      />
    </ResizeHandle>
  );
}
