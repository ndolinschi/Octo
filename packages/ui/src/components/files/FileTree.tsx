import { ChevronRight } from "lucide-react";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { ancestors, fileKey, parentPath, type FileKey } from "../../lib/files";
import { useCode, type DirState } from "../../state/code";
import { useOptionalComments } from "../../state/comments";
import { CommentCount, commentsDescription } from "./CommentCount";
import { fileIcon } from "../primitives/fileIcons";
import { Highlight } from "../primitives/Highlight";
import { useDelayedLoading } from "../../lib/hooks";
import { Spinner } from "../primitives/Status";

type NodeRow = { id: string; kind: "dir" | "file"; folder: string; path: string; name: string; level: number; expanded: boolean; title: string };
type StateRow = { id: string; kind: "loading" | "error" | "empty"; folder: string; path: string; level: number; error: string | null };
type Row = NodeRow | StateRow;

const isNode = (row: Row): row is NodeRow => row.kind === "dir" || row.kind === "file";

/** Indent per level; the 24px chevron box of level n starts at (n − 1) × 16. */
const INDENT = 16;

function flatten(
  folders: { label: string; path: string }[],
  dirs: Record<string, DirState>,
  isExpanded: (key: FileKey) => boolean,
  /** While filtering: only these keys are shown (matches and their ancestors), every shown directory open. */
  only: Set<string> | null,
): Row[] {
  const rows: Row[] = [];
  const walk = (folder: string, path: string, level: number) => {
    const key = fileKey(folder, path);
    const dir = dirs[key];
    if (!dir || (dir.status === "loading" && !dir.entries.length)) {
      if (!only) rows.push({ id: `${key}\u0001loading`, kind: "loading", folder, path, level, error: null });
      return;
    }
    if (dir.status === "error") {
      if (!only) rows.push({ id: `${key}\u0001error`, kind: "error", folder, path, level, error: dir.error });
      return;
    }
    if (!dir.entries.length && !only) rows.push({ id: `${key}\u0001empty`, kind: "empty", folder, path, level, error: null });
    for (const e of dir.entries) {
      const id = fileKey(folder, e.path);
      if (only && !only.has(id)) continue;
      const expanded = e.type === "dir" && (only ? true : isExpanded(id));
      rows.push({ id, kind: e.type, folder, path: e.path, name: e.name, level, expanded, title: `${folder}/${e.path}` });
      if (expanded) walk(folder, e.path, level + 1);
    }
  };
  for (const f of folders) {
    const id = fileKey(f.label, "");
    if (only && !only.has(id)) continue;
    const expanded = only ? true : isExpanded(id);
    rows.push({ id, kind: "dir", folder: f.label, path: "", name: f.label, level: 1, expanded, title: f.path });
    if (expanded) walk(f.label, "", 2);
  }
  return rows;
}

/** Nesting depth as a spacer (a width, not padding: indents are structure, not spacing). */
function Indent({ px }: { px: number }) {
  return px > 0 ? <span aria-hidden className="shrink-0" style={{ width: px }} /> : null;
}

export type FileTreeHandle = { focusFirst(): void };

/**
 * ARIA tree of the project's folders; directories load when expanded. With `filter`, only files whose
 * folder-relative path contains it (case-insensitive) are shown, with their ancestors expanded; the
 * caller loads the folders first (`indexFiles`). Rows: 28px, radius 6, 16px per level,
 * [24px glyph box: chevron for folders, type glyph for files] 4 [name] … — one anatomy for roots (medium weight),
 * folders and files, so siblings share one label edge.
 */
export const FileTree = forwardRef<
  FileTreeHandle,
  {
    folders: { label: string; path: string }[];
    filter?: string;
    /** Opens a file (default: `code.openFile`, which shows it in the side group). */
    onOpenFile?(folder: string, path: string): void;
    /** ↑ from the first row (back to the filter input). */
    onExitTop?(): void;
    label?: string;
  }
>(function FileTree({ folders, filter = "", onOpenFile, onExitTop, label = "Project files" }, handle) {
  const code = useCode();
  const counts = useOptionalComments()?.counts;
  const { dirs, isExpanded, ensureDir, selectedKey, revealTick, loadedFiles } = code;
  const query = filter.trim().toLowerCase();

  const only = useMemo(() => {
    if (!query) return null;
    const keys = new Set<string>();
    for (const f of loadedFiles) {
      if (!f.path.toLowerCase().includes(query)) continue;
      keys.add(fileKey(f.folder, f.path));
      for (const a of ancestors(f.path)) keys.add(fileKey(f.folder, a));
    }
    return keys;
  }, [query, loadedFiles]);

  const allRows = useMemo(() => flatten(folders, dirs, isExpanded, only), [folders, dirs, isExpanded, only]);
  // Loading rows appear only for slow folders (after 200ms) and then stay ≥300ms.
  const slow = useDelayedLoading(allRows.some((r) => r.kind === "loading"));
  const rows = useMemo(() => (slow ? allRows : allRows.filter((r) => r.kind !== "loading")), [allRows, slow]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  // Expanded directories (roots start expanded) load as soon as they are visible.
  useEffect(() => {
    for (const r of allRows) if (r.kind === "loading") ensureDir(r.folder, r.path);
  }, [allRows, ensureDir]);

  // The path tooltip only where it adds something: a cut-off name (roots: their absolute path, always).
  // Measured after layout and on resize, so the tooltip layer reads the right `title` on hover.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const apply = () => {
      for (const row of el.querySelectorAll<HTMLElement>("[data-path]")) {
        const label = row.querySelector<HTMLElement>("[data-label]");
        const cut = row.dataset.root !== undefined || (label !== null && label.scrollWidth > label.clientWidth + 1);
        if (cut) row.title = row.dataset.path!;
        else row.removeAttribute("title");
        if (!cut) delete row.dataset.tip;
        else if (row.dataset.tip !== undefined) row.dataset.tip = row.dataset.path;
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);

  // Scroll the row a link revealed into view.
  useEffect(() => {
    if (selectedKey) refs.current.get(selectedKey)?.scrollIntoView({ block: "nearest" });
  }, [revealTick, selectedKey, rows]);

  const ids = rows.filter((r) => r.kind !== "empty").map((r) => r.id);
  const tabId = focusId && ids.includes(focusId) ? focusId : selectedKey && ids.includes(selectedKey) ? selectedKey : ids[0];

  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  };

  useImperativeHandle(handle, () => ({
    // While filtering, the first match (not its folder) is where ↓ from the input lands.
    focusFirst: () => focus((query ? rows.find((r) => r.kind === "file")?.id : undefined) ?? ids[0]),
  }));

  const activate = (row: Row) => {
    if (row.kind === "file") (onOpenFile ?? code.openFile)(row.folder, row.path);
    else if (row.kind === "dir") {
      if (!query) code.setExpanded(row.folder, row.path, !row.expanded);
    } else if (row.kind === "error") code.reloadDir(row.folder, row.path);
  };

  const onKeyDown = (e: KeyboardEvent, row: Row) => {
    const i = ids.indexOf(row.id);
    const parentId = () => {
      if (row.kind !== "dir" && row.kind !== "file") return fileKey(row.folder, row.path);
      return row.path ? fileKey(row.folder, parentPath(row.path)) : undefined;
    };
    const moves: Record<string, () => void> = {
      ArrowDown: () => focus(ids[i + 1]),
      ArrowUp: () => (i === 0 && onExitTop ? onExitTop() : focus(ids[i - 1])),
      Home: () => focus(ids[0]),
      End: () => focus(ids[ids.length - 1]),
      ArrowRight: () => {
        if (row.kind !== "dir") return;
        if (!row.expanded) code.setExpanded(row.folder, row.path, true);
        else focus(ids[i + 1]);
      },
      ArrowLeft: () => {
        if (row.kind === "dir" && row.expanded && !query) code.setExpanded(row.folder, row.path, false);
        else focus(parentId());
      },
      Enter: () => activate(row),
      " ": () => activate(row),
    };
    const fn = moves[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  };

  return (
    <div ref={root} role="tree" aria-label={label} className="flex flex-col">
      {rows.map((row) => {
        const indent = (row.level - 1) * INDENT;
        if (row.kind === "empty") {
          return (
            <div key={row.id} role="none" className="flex h-row shrink-0 items-center text-xs text-fg-3">
              <Indent px={indent + 24 + 4} />
              Empty folder
            </div>
          );
        }
        const common = {
          ref: (el: HTMLDivElement | null) => {
            if (el) refs.current.set(row.id, el);
            else refs.current.delete(row.id);
          },
          role: "treeitem",
          "aria-level": row.level,
          tabIndex: row.id === tabId ? 0 : -1,
          onFocus: () => setFocusId(row.id),
          onKeyDown: (e: KeyboardEvent) => onKeyDown(e, row),
        } as const;
        if (!isNode(row)) {
          return (
            <div
              key={row.id}
              {...common}
              aria-disabled={row.kind === "loading" || undefined}
              aria-busy={row.kind === "loading" || undefined}
              className="flex h-row shrink-0 items-center gap-1 rounded-sm pr-1 text-xs text-fg-3 focus-inset"
            >
              <Indent px={indent} />
              <span className="grid size-6 shrink-0 place-items-center">{row.kind === "loading" && <Spinner size={10} />}</span>
              {row.kind === "loading" ? (
                "Loading…"
              ) : (
                <>
                  <span className="min-w-0 truncate" title={row.error ?? undefined}>
                    Couldn't load{row.error ? `: ${row.error}` : ""}
                  </span>
                  <Button variant="quiet" size="xs" tabIndex={-1} onClick={() => code.reloadDir(row.folder, row.path)} className="ml-auto">
                    Retry
                  </Button>
                </>
              )}
            </div>
          );
        }
        const selected = row.id === selectedKey;
        const isRoot = row.kind === "dir" && row.path === "";
        const Icon = row.kind === "file" ? fileIcon(row.name) : null;
        const comments = row.kind === "file" ? (counts?.get(row.id) ?? 0) : 0;
        return (
          <div
            key={row.id}
            {...common}
            aria-expanded={row.kind === "dir" ? row.expanded : undefined}
            aria-selected={selected}
            aria-description={row.kind === "file" ? commentsDescription(comments) : undefined}
            data-path={row.title}
            data-root={isRoot || undefined}
            onClick={() => activate(row)}
            className={cn("flex h-row shrink-0 items-center rounded-sm px-1 text-sm press-row focus-inset", selected ? "bg-active" : "hover:bg-hover")}
          >
            <Indent px={indent} />
            {/* One glyph column (decided once, v6.2): a folder's chevron or a file's type glyph, so every label of a
                level starts on one edge. */}
            <span aria-hidden className="grid size-6 shrink-0 place-items-center text-fg-3">
              {Icon ? (
                <Glyph icon={Icon} size={14} />
              ) : (
                <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-150", row.kind === "dir" && row.expanded && "rotate-90")} />
              )}
            </span>
            <span data-label className={cn("ml-1 min-w-0 truncate text-fg", isRoot && "font-medium")} title={row.name}>
              {query && row.kind === "file" ? <Highlight text={row.name} query={query} /> : row.name}
            </span>
            {comments > 0 && (
              <span className="ml-auto pr-1 pl-2">
                <CommentCount count={comments} />
              </span>
            )}
          </div>
        );
      })}
      {query && rows.length === 0 && <p className="flex h-row items-center px-2 text-xs text-fg-3">No files match</p>}
    </div>
  );
});
