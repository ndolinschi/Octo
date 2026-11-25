import { ChevronRight } from "lucide-react";
import { Button } from "../primitives/Button";
import { Glyph } from "../primitives/Glyph";
import { forwardRef, lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { ancestors, fileKey, fileName, parentPath } from "../../lib/files";
import { useCompactFolders } from "../../lib/compactFoldersPref";
import { TreeScrollController } from "../../lib/treeScroll";
import { useApp } from "../../state/app";
import { useCode } from "../../state/code";
import { isNode, treeRows, TYPE_AHEAD_MS, typeAhead, type NodeRow, type Row } from "./treeRows";
import { useOptionalComments } from "../../state/comments";
import { CommentCount, commentsDescription } from "./CommentCount";
import { fileIcon } from "../primitives/fileIcons";
import { Highlight } from "../primitives/Highlight";
import { MiddleText } from "../primitives/MiddleText";
import { distinctSplit } from "../../lib/distinctSplit";
import { useDelayedLoading } from "../../lib/hooksMore";
import { Spinner } from "../primitives/Status";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { chatMention } from "../../lib/chatMention";
import { addToChat, canAddToChat } from "../../state/chatInsert";
import type { FileTreeAction } from "./FileTreeActionsDialog";

const FileTreeActionsDialog = lazy(() => import("./FileTreeActionsDialog"));

/**
 * Indent per level (polish step 4, E2: was 16). A root folder is the tree's section head and its entries start on its own
 * edge, so the 24px glyph box of level n ≥ 2 starts at (n − 2) × 12: five levels deep a name still starts 76px in.
 */
const INDENT = 12;
const indentOf = (level: number) => Math.max(0, level - 2) * INDENT;

/** Updates a row's path tooltip lazily on hover/focus so tree expansion avoids full-DOM layout reads. */
function updateRowTip(row: HTMLDivElement) {
  const path = row.dataset.path;
  if (!path) return;
  const label = row.querySelector<HTMLElement>("[data-label]");
  const cut = row.dataset.root !== undefined || row.dataset.compact !== undefined || (label !== null && label.scrollWidth > label.clientWidth + 1);
  if (cut) {
    if (row.title !== path) row.title = path;
    if (row.dataset.tip !== undefined && row.dataset.tip !== path) row.dataset.tip = path;
  } else {
    if (row.hasAttribute("title")) row.removeAttribute("title");
    if (row.dataset.tip !== undefined) delete row.dataset.tip;
  }
}

/**
 * Nesting depth as a spacer (a width, not padding: indents are structure, not spacing). G2 (2026-11-18): it carries the
 * indent guides, a 1px `line` under each ancestor's glyph, drawn only while the tree is hovered or focused (styles.css,
 * `.octo-tree-indent`; a background, so nothing moves).
 */
function Indent({ px }: { px: number }) {
  return px > 0 ? <span aria-hidden className="octo-tree-indent shrink-0 self-stretch" style={{ width: px }} /> : null;
}

const TreeNodeRow = memo(function TreeNodeRow({
  row,
  selected,
  tabbable,
  isFirstRoot,
  roots,
  comments,
  query,
  setRowRef,
  onFocusRow,
  onKeyDownRow,
  onActivateRow,
  onMenuRow,
}: {
  row: NodeRow;
  selected: boolean;
  tabbable: boolean;
  isFirstRoot: boolean;
  /** Every root's label: a root keeps the part that tells it from the others ("product-con…facade-service"). */
  roots: readonly string[];
  comments: number;
  query: string;
  setRowRef: (id: string, el: HTMLDivElement | null) => void;
  onFocusRow: (id: string) => void;
  onKeyDownRow: (e: KeyboardEvent, row: Row) => void;
  onActivateRow: (row: Row) => void;
  onMenuRow: (row: NodeRow, at: { x: number; y: number }) => void;
}) {
  const indent = indentOf(row.level);
  const isRoot = row.kind === "dir" && row.path === "";
  const Icon = row.kind === "file" ? fileIcon(row.name) : null;
  const chain = row.paths.length > 1;
  return (
    <div
      // A compact row answers for each of its directories, so revealing one scrolls to it (decision 98).
      ref={(el) => {
        setRowRef(row.id, el);
        if (chain) for (const p of row.paths) setRowRef(fileKey(row.folder, p), el);
      }}
      role="treeitem"
      aria-level={row.level}
      tabIndex={tabbable ? 0 : -1}
      aria-expanded={row.kind === "dir" ? row.expanded : undefined}
      aria-selected={selected}
      aria-description={row.kind === "file" ? commentsDescription(comments) : undefined}
      data-path={row.title}
      data-root={isRoot || undefined}
      data-compact={chain || undefined}
      onPointerEnter={(e) => updateRowTip(e.currentTarget)}
      onFocus={(e) => {
        updateRowTip(e.currentTarget);
        onFocusRow(row.id);
      }}
      onKeyDown={(e) => onKeyDownRow(e, row)}
      onClick={() => onActivateRow(row)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenuRow(row, { x: e.clientX, y: e.clientY });
      }}
      className={cn(
        "flex h-ctl-xs shrink-0 items-center rounded-sm px-1 text-sm press-row focus-inset touch:h-ctl-lg",
        selected ? "bg-active" : "hover:bg-hover",
        isRoot && !isFirstRoot && "mt-2",
      )}
    >
      <Indent px={indent} />
      {/* One glyph column (decided once, v6.2): a folder's chevron or a file's type glyph, so every label of a
          level starts on one edge. */}
      <span aria-hidden className="grid size-6 shrink-0 place-items-center text-fg-3">
        {Icon ? (
          <Glyph icon={Icon} size={14} />
        ) : (
          <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-base", row.kind === "dir" && row.expanded && "rotate-90")} />
        )}
      </span>
      <span data-label className={cn("ml-1 min-w-0 truncate", isRoot ? "text-xs font-medium text-fg-3" : "text-fg")} title={chain ? row.title : row.name}>
        {/* A root keeps what tells it from the other roots; a compact chain ("com/wsgc/…/config") keeps its last folder. */}
        {isRoot ? (
          <MiddleText text={row.name} split={distinctSplit(row.name, roots)} />
        ) : chain ? (
          <MiddleText text={row.name} split={distinctSplit(row.name)} />
        ) : query && row.kind === "file" ? (
          <Highlight text={row.name} query={query} />
        ) : (
          row.name
        )}
      </span>
      {comments > 0 && (
        <span className="ml-auto pr-1 pl-2">
          <CommentCount count={comments} />
        </span>
      )}
    </div>
  );
});

export type FileTreeHandle = { focusFirst(): void };

/**
 * ARIA tree of the project's folders; directories load when expanded. With `filter`, only files whose
 * folder-relative path contains it (case-insensitive) are shown, with their ancestors expanded; the
 * caller loads the folders first (`indexFiles`). Rows: 24px (G2; 40 under touch, 44 on a phone), radius 6, 12px per level,
 * [24px glyph box: chevron for folders, type glyph for files] 4 [name] … — one anatomy for folders and files, so siblings
 * share one label edge. A root folder is a section head on the same edges: a meta caption (12px, `fg-3`, medium) with its chevron, 8px above every root but the first.
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
  const { bridge } = useApp();
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

  const compact = useCompactFolders();
  const allRows = useMemo(() => treeRows(folders, dirs, isExpanded, only, compact), [folders, dirs, isExpanded, only, compact]);
  // Loading rows appear only for slow folders (after 200ms) and then stay ≥300ms.
  const slow = useDelayedLoading(allRows.some((r) => r.kind === "loading"));
  const rows = useMemo(() => (slow ? allRows : allRows.filter((r) => r.kind !== "loading")), [allRows, slow]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ row: NodeRow; x: number; y: number } | null>(null);
  const [action, setAction] = useState<FileTreeAction | null>(null);
  const openMenu = useCallback((row: NodeRow, at: { x: number; y: number }) => setMenu({ row, ...at }), []);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const scrollCtrl = useRef(new TreeScrollController());
  const typed = useRef({ text: "", at: 0 });

  const setRowRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);

  // Expanded directories (roots start expanded) load as soon as they are visible.
  useEffect(() => {
    for (const r of allRows) if (r.kind === "loading") ensureDir(r.folder, r.path);
  }, [allRows, ensureDir]);

  // Arm a scroll only when a link/reveal/selection changes — never when opening or closing subfolders.
  useEffect(() => {
    scrollCtrl.current.sync(revealTick, selectedKey);
  }, [revealTick, selectedKey]);

  useEffect(() => {
    const key = scrollCtrl.current.consume(revealTick, selectedKey, (k) => refs.current.has(k));
    if (key) refs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [revealTick, selectedKey, rows]);

  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  // A directory revealed in the middle of a compact row selects that row (decision 98).
  const selectedId = useMemo(
    () => (selectedKey && rows.find((r) => isNode(r) && r.paths.length > 1 && r.paths.some((p) => fileKey(r.folder, p) === selectedKey))?.id) ?? selectedKey,
    [rows, selectedKey],
  );
  const tabId = focusId && ids.includes(focusId) ? focusId : selectedId && ids.includes(selectedId) ? selectedId : ids[0];

  const focus = useCallback((id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    refs.current.get(id)?.focus();
  }, []);

  useImperativeHandle(handle, () => ({
    // While filtering, the first match (not its folder) is where ↓ from the input lands.
    focusFirst: () => focus((query ? rows.find((r) => r.kind === "file")?.id : undefined) ?? ids[0]),
  }));

  const activate = useCallback(
    (row: Row) => {
      if (row.kind === "file") (onOpenFile ?? code.openFile)(row.folder, row.path);
      else if (row.kind === "dir") {
        if (!query) {
          scrollCtrl.current.cancel();
          code.setExpanded(row.folder, row.paths, !row.expanded);
        }
      } else if (row.kind === "error") code.reloadDir(row.folder, row.path);
    },
    [onOpenFile, code, query],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent, row: Row) => {
      const i = ids.indexOf(row.id);
      const parentId = () => {
        if (row.kind !== "dir" && row.kind !== "file") return fileKey(row.folder, row.path);
        return row.head ? fileKey(row.folder, parentPath(row.head)) : undefined;
      };
      const moves: Record<string, () => void> = {
        ArrowDown: () => focus(ids[i + 1]),
        ArrowUp: () => (i === 0 && onExitTop ? onExitTop() : focus(ids[i - 1])),
        Home: () => focus(ids[0]),
        End: () => focus(ids[ids.length - 1]),
        ArrowRight: () => {
          if (row.kind !== "dir") return;
          if (!row.expanded) {
            scrollCtrl.current.cancel();
            code.setExpanded(row.folder, row.paths, true);
          } else focus(ids[i + 1]);
        },
        ArrowLeft: () => {
          if (row.kind === "dir" && row.expanded && !query) {
            scrollCtrl.current.cancel();
            code.setExpanded(row.folder, row.paths, false);
          } else focus(parentId());
        },
        Enter: () => activate(row),
        " ": () => activate(row),
      };
      const fn = moves[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = typed.current;
        t.text = (e.timeStamp - t.at > TYPE_AHEAD_MS ? "" : t.text) + e.key;
        t.at = e.timeStamp;
        // A word being typed may still match the focused row; a first letter moves on from it.
        const id = typeAhead(rows, t.text.length > 1 ? i - 1 : i, t.text);
        if (id) {
          e.preventDefault();
          focus(id);
        }
      }
    },
    [ids, rows, focus, onExitTop, code, query, activate],
  );

  const firstRoot = rows.find((r) => r.kind === "dir" && r.path === "");
  const roots = useMemo(() => folders.map((f) => f.label), [folders]);
  return (
    <div role="tree" aria-label={label} className="flex flex-col">
      {rows.map((row) => {
        const indent = indentOf(row.level);
        if (!isNode(row)) {
          return (
            <div
              key={row.id}
              ref={(el) => setRowRef(row.id, el)}
              role="treeitem"
              aria-selected={false}
              aria-level={row.level}
              tabIndex={row.id === tabId ? 0 : -1}
              onFocus={() => setFocusId(row.id)}
              onKeyDown={(e) => onKeyDown(e, row)}
              aria-disabled={row.kind === "loading" || undefined}
              aria-busy={row.kind === "loading" || undefined}
              className="flex h-ctl-xs shrink-0 items-center gap-1 rounded-sm px-1 text-xs text-fg-3 focus-inset touch:h-ctl-lg"
            >
              <Indent px={indent} />
              <span className="grid size-6 shrink-0 place-items-center">{row.kind === "loading" && <Spinner size="xs" />}</span>
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
        return (
          <TreeNodeRow
            key={row.id}
            row={row}
            selected={row.id === selectedId}
            tabbable={row.id === tabId}
            isFirstRoot={row === firstRoot}
            roots={roots}
            comments={row.kind === "file" ? (counts?.get(row.id) ?? 0) : 0}
            query={query}
            setRowRef={setRowRef}
            onFocusRow={setFocusId}
            onKeyDownRow={onKeyDown}
            onActivateRow={activate}
            onMenuRow={openMenu}
          />
        );
      })}
      {query && rows.length === 0 && <p className="flex h-ctl-sm items-center px-2 text-xs text-fg-3">No files match</p>}
      <Presence show={menu !== null}>
        {menu && (
          <Menu
            label={menu.row.name}
            x={menu.x}
            y={menu.y}
            items={rowMenu(
              menu.row,
              {
                canMkdir: Boolean(bridge.createDirectory),
                canRename: Boolean(bridge.renameFile),
                canDelete: Boolean(bridge.deleteFile),
              },
              setAction,
            )}
            onClose={() => setMenu(null)}
          />
        )}
      </Presence>
      <Presence show={action !== null}>
        {action && (
          <Suspense fallback={null}>
            <FileTreeActionsDialog action={action} {...(onOpenFile ? { onOpenFile } : {})} onClose={() => setAction(null)} />
          </Suspense>
        )}
      </Presence>
    </div>
  );
});

type RowMenuCaps = { canMkdir: boolean; canRename: boolean; canDelete: boolean };

/**
 * G4: a row's right-click menu: New file / New folder (on folders and roots), Rename / Delete (on non-root items),
 * Add to chat (the file or folder as a mention in the composer), Copy path, and Copy filename.
 * A compact row's menu acts on its last directory, as in VS Code (decision 98).
 */
function rowMenu(row: NodeRow, caps: RowMenuCaps, onAction: (action: FileTreeAction) => void): MenuItem[] {
  const isRoot = row.kind === "dir" && row.path === "";
  const dirPath = row.kind === "dir" ? row.path : parentPath(row.path);
  const items: MenuItem[] = [];
  if (row.kind === "dir") {
    items.push({ id: "new-file", label: "New file…", run: () => onAction({ kind: "new-file", folder: row.folder, dirPath }) });
    if (caps.canMkdir) {
      items.push({ id: "new-folder", label: "New folder…", run: () => onAction({ kind: "new-folder", folder: row.folder, dirPath }) });
    }
  }
  if (!isRoot && (caps.canRename || caps.canDelete)) {
    if (items.length > 0) items.push({ id: "sep-crud", separator: true });
    if (caps.canRename) {
      items.push({
        id: "rename",
        label: "Rename…",
        run: () => onAction({ kind: "rename", folder: row.folder, path: row.path, isDir: row.kind === "dir" }),
      });
    }
    if (caps.canDelete) {
      items.push({
        id: "delete",
        label: "Delete…",
        run: () => onAction({ kind: "delete", folder: row.folder, path: row.path, isDir: row.kind === "dir" }),
      });
    }
  }
  if (items.length > 0) items.push({ id: "sep-copy", separator: true });
  if (!isRoot && canAddToChat()) {
    items.push({ id: "chat", label: "Add to chat", run: () => void addToChat(chatMention(row.path)) });
  }
  if (!isRoot) {
    items.push({
      id: "path",
      label: "Copy path",
      run: () => void navigator.clipboard.writeText(row.path),
    });
    items.push({
      id: "filename",
      label: "Copy filename",
      run: () => void navigator.clipboard.writeText(fileName(row.path)),
    });
  } else {
    items.push({
      id: "path",
      label: "Copy folder name",
      run: () => void navigator.clipboard.writeText(row.folder),
    });
  }
  return items;
}
