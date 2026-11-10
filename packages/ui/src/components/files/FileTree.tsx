import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { fileKey, parentPath } from "../../lib/files";
import { useCode, type DirState } from "../../state/code";
import { useDelayedLoading } from "../../lib/hooks";
import { Spinner } from "../primitives/Status";

type NodeRow = { id: string; kind: "dir" | "file"; folder: string; path: string; name: string; level: number; expanded: boolean; title: string };
type StateRow = { id: string; kind: "loading" | "error" | "empty"; folder: string; path: string; level: number; error: string | null };
type Row = NodeRow | StateRow;

const isNode = (row: Row): row is NodeRow => row.kind === "dir" || row.kind === "file";

function flatten(
  folders: { label: string; path: string }[],
  dirs: Record<string, DirState>,
  isExpanded: (key: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  const walk = (folder: string, path: string, level: number) => {
    const key = fileKey(folder, path);
    const dir = dirs[key];
    if (!dir || (dir.status === "loading" && !dir.entries.length)) {
      rows.push({ id: `${key}\u0001loading`, kind: "loading", folder, path, level, error: null });
      return;
    }
    if (dir.status === "error") {
      rows.push({ id: `${key}\u0001error`, kind: "error", folder, path, level, error: dir.error });
      return;
    }
    if (!dir.entries.length) rows.push({ id: `${key}\u0001empty`, kind: "empty", folder, path, level, error: null });
    for (const e of dir.entries) {
      const id = fileKey(folder, e.path);
      const expanded = e.type === "dir" && isExpanded(id);
      rows.push({ id, kind: e.type, folder, path: e.path, name: e.name, level, expanded, title: `${folder}/${e.path}` });
      if (expanded) walk(folder, e.path, level + 1);
    }
  };
  for (const f of folders) {
    const id = fileKey(f.label, "");
    const expanded = isExpanded(id);
    rows.push({ id, kind: "dir", folder: f.label, path: "", name: f.label, level: 1, expanded, title: f.path });
    if (expanded) walk(f.label, "", 2);
  }
  return rows;
}

/** ARIA tree of the project's folders; directories load when expanded. */
export function FileTree({ folders }: { folders: { label: string; path: string }[] }) {
  const code = useCode();
  const { dirs, isExpanded, ensureDir, selectedKey, revealTick } = code;
  const allRows = useMemo(() => flatten(folders, dirs, isExpanded), [folders, dirs, isExpanded]);
  // Loading rows appear only for slow folders (after 200ms) and then stay ≥300ms.
  const slow = useDelayedLoading(allRows.some((r) => r.kind === "loading"));
  const rows = useMemo(() => (slow ? allRows : allRows.filter((r) => r.kind !== "loading")), [allRows, slow]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  // Expanded directories (roots start expanded) load as soon as they are visible.
  useEffect(() => {
    for (const r of allRows) if (r.kind === "loading") ensureDir(r.folder, r.path);
  }, [allRows, ensureDir]);

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

  const activate = (row: Row) => {
    if (row.kind === "file") code.openFile(row.folder, row.path);
    else if (row.kind === "dir") code.setExpanded(row.folder, row.path, !row.expanded);
    else if (row.kind === "error") code.reloadDir(row.folder, row.path);
  };

  const onKeyDown = (e: KeyboardEvent, row: Row) => {
    const i = ids.indexOf(row.id);
    const parentId = () => {
      if (row.kind !== "dir" && row.kind !== "file") return fileKey(row.folder, row.path);
      return row.path ? fileKey(row.folder, parentPath(row.path)) : undefined;
    };
    const moves: Record<string, () => void> = {
      ArrowDown: () => focus(ids[i + 1]),
      ArrowUp: () => focus(ids[i - 1]),
      Home: () => focus(ids[0]),
      End: () => focus(ids[ids.length - 1]),
      ArrowRight: () => {
        if (row.kind !== "dir") return;
        if (!row.expanded) code.setExpanded(row.folder, row.path, true);
        else focus(ids[i + 1]);
      },
      ArrowLeft: () => {
        if (row.kind === "dir" && row.expanded) code.setExpanded(row.folder, row.path, false);
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
    <div role="tree" aria-label="Project files" className="h-full min-h-0 overflow-y-auto overscroll-contain px-2 pt-1 pb-4">
      {rows.map((row) => {
        const pad = { paddingLeft: (row.level - 1) * 14 };
        if (row.kind === "empty") {
          return (
            <div key={row.id} role="none" className="flex h-7 items-center text-xs text-fg-3" style={{ paddingLeft: pad.paddingLeft + 28 }}>
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
          style: pad,
        } as const;
        if (!isNode(row)) {
          return (
            <div
              key={row.id}
              {...common}
              aria-disabled={row.kind === "loading" || undefined}
              aria-busy={row.kind === "loading" || undefined}
              className="flex h-7 items-center gap-1 rounded-sm pr-1 text-xs text-fg-3 focus-inset"
            >
              <span className="grid size-6 shrink-0 place-items-center">{row.kind === "loading" && <Spinner size={10} />}</span>
              {row.kind === "loading" ? (
                "Loading…"
              ) : (
                <>
                  <span className="min-w-0 truncate" title={row.error ?? undefined}>
                    Couldn't load{row.error ? `: ${row.error}` : ""}
                  </span>
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => code.reloadDir(row.folder, row.path)}
                    className="press ml-auto h-6 shrink-0 rounded-sm px-1.5 text-fg-2 hover:bg-hover hover:text-fg"
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          );
        }
        const selected = row.id === selectedKey;
        const isRoot = row.kind === "dir" && row.path === "";
        const Icon = row.kind === "file" ? File : row.expanded ? FolderOpen : Folder;
        return (
          <div
            key={row.id}
            {...common}
            aria-expanded={row.kind === "dir" ? row.expanded : undefined}
            aria-selected={selected}
            title={row.title}
            onClick={() => activate(row)}
            className={cn(
              "press-row flex h-7 items-center gap-1 rounded-sm pr-2 text-sm focus-inset",
              selected ? "bg-active" : "hover:bg-hover",
            )}
          >
            <span aria-hidden className={cn("grid size-6 shrink-0 place-items-center text-fg-3", row.kind !== "dir" && "invisible")}>
              <ChevronRight
                size={12}
                strokeWidth={1.5}
                absoluteStrokeWidth
                className={cn("transition-[rotate] duration-150", row.kind === "dir" && row.expanded && "rotate-90")}
              />
            </span>
            {!isRoot && <Icon size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="mr-0.5 shrink-0 text-fg-3" />}
            <span className={cn("min-w-0 truncate", isRoot ? "font-medium text-fg" : "text-fg")}>{row.name}</span>
          </div>
        );
      })}
    </div>
  );
}
