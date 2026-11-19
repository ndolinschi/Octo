import type { FileEntry } from "@octo/agent-client";
import { compactChain } from "../../lib/compactFolders";
import { fileKey, fileName, type FileKey } from "../../lib/files";

/** What the tree needs of a loaded directory (`state/code`'s `DirState`). */
export type TreeDir = { status: "loading" | "ready" | "error"; entries: FileEntry[]; error: string | null };

export type NodeRow = {
  /** The key of the row's (last) directory or file. */
  id: FileKey;
  kind: "dir" | "file";
  folder: string;
  /** The last directory of a compact row; what open, the menu and reveal act on. */
  path: string;
  /** The first directory of a compact row (`path` otherwise); ← goes to its parent. */
  head: string;
  /** The label: a file or directory name, or a compact row's joined names. */
  name: string;
  /** Every directory path the row stands for (one unless compact): selecting or revealing any of them lands on this row. */
  paths: string[];
  level: number;
  expanded: boolean;
  /** `folder/path` of the last directory: the tooltip. */
  title: string;
};
export type StateRow = { id: string; kind: "loading" | "error"; folder: string; path: string; level: number; error: string | null };
export type Row = NodeRow | StateRow;

export const isNode = (row: Row): row is NodeRow => row.kind === "dir" || row.kind === "file";

/**
 * The tree's visible rows, top to bottom. With `compact` (decision 98) a run of single-child directories is one row
 * (`lib/compactFolders`) whose children are the last directory's; it is open when its last directory is.
 */
export function treeRows(
  folders: { label: string; path: string }[],
  dirs: Record<string, TreeDir>,
  isExpanded: (key: FileKey) => boolean,
  /** While filtering: only these keys are shown (matches and their ancestors), every shown directory open. */
  only: Set<string> | null,
  compact: boolean,
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
    const listing = (p: string) => {
      const d = dirs[fileKey(folder, p)];
      return d?.status === "ready" ? d.entries : undefined;
    };
    for (const e of dir.entries) {
      const chain = compact && e.type === "dir" ? compactChain(e, listing) : null;
      const last = chain?.last ?? e.path;
      const id = fileKey(folder, last);
      if (only && !only.has(id)) continue;
      const expanded = e.type === "dir" && (only ? true : isExpanded(id));
      rows.push({
        id,
        kind: e.type,
        folder,
        path: last,
        head: e.path,
        name: chain?.label ?? e.name,
        paths: chain?.paths ?? [last],
        level,
        expanded,
        title: `${folder}/${last}`,
      });
      if (expanded) walk(folder, last, level + 1);
    }
  };
  for (const f of folders) {
    const id = fileKey(f.label, "");
    if (only && !only.has(id)) continue;
    const expanded = only ? true : isExpanded(id);
    rows.push({ id, kind: "dir", folder: f.label, path: "", head: "", name: f.label, paths: [""], level: 1, expanded, title: f.path });
    if (expanded) walk(f.label, "", 2);
  }
  return rows;
}

/** Keys typed within this gap build one type-ahead word (the same as `primitives/Select`). */
export const TYPE_AHEAD_MS = 700;

/**
 * Type-ahead: the id of the first row after `from` (wrapping) whose name starts with `typed`, ignoring case. A compact
 * row matches on any of its directory names, so typing `java` or `subsystem` finds the row that holds it.
 */
export function typeAhead(rows: readonly Row[], from: number, typed: string): string | undefined {
  const t = typed.toLowerCase();
  for (let k = 1; k <= rows.length; k++) {
    const row = rows[(from + k) % rows.length];
    if (!row || !isNode(row)) continue;
    const names = row.paths.length > 1 ? row.paths.map(fileName) : [row.name];
    if (names.some((n) => n.toLowerCase().startsWith(t))) return row.id;
  }
  return undefined;
}
