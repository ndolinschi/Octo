import type { FileEntry } from "@octo/agent-client";
import { fileKey, isRootKey, normalizePath, parentPath, parseFileKey, splitKey, type FileKey } from "../lib/files";

export type FileStatus = "loading" | "ready" | "error" | "too_large" | "binary";
export type FileNotice = { kind: "conflict" } | { kind: "save_error"; message: string } | { kind: "changed" };

export type OpenFile = {
  key: FileKey;
  folder: string;
  path: string;
  name: string;
  status: FileStatus;
  error: string | null;
  /** Content as last read from or written to disk. */
  content: string;
  mtime: string;
  modified: boolean;
  saving: boolean;
  notice: FileNotice | null;
};

export type DirState = { status: "loading" | "ready" | "error"; entries: FileEntry[]; error: string | null };

/** Breadth-first walk of every folder for Filter files and the composer's file search. */
export type FileIndex = { status: "idle" | "loading" | "done"; /** Stopped at a limit: only loaded folders were searched. */ partial: boolean };

export type ListedDir = { readonly entries: readonly unknown[] };

/** Normalizes a workspace id: empty string and `"shared"` both map to the main checkout (`undefined`). */
export function normalizeWorkspaceId(id?: string | null): string | undefined {
  return id && id !== "shared" ? id : undefined;
}

/** Whether a directory key is currently expanded in the tree (roots default to expanded). */
export function isDirExpanded(expanded: Readonly<Record<string, boolean>>, key: FileKey): boolean {
  return expanded[key] ?? isRootKey(key);
}

/** Finds the nearest already-listed ancestor directory above `dirPath` (or `null` if none is listed). */
export function nearestListedAncestor(
  dirs: Readonly<Record<string, ListedDir | undefined>>,
  folder: string,
  dirPath: string,
): { path: string; key: FileKey } | null {
  if (!dirPath) return null;
  for (let a = parentPath(dirPath); ; a = parentPath(a)) {
    const key = fileKey(folder, a);
    if (dirs[key]) return { path: a, key };
    if (!a) return null;
  }
}

export type DirUpdatePlan = {
  /** Expanded, listed directories to reload quietly from disk. */
  reload: { folder: string; path: string }[];
  /** Collapsed, listed directories to evict so expanding them later reads fresh entries. */
  evict: FileKey[];
};

/**
 * Plans tree updates after `file.changed` at `folder/rawPath`:
 * - If the immediate parent directory is listed and expanded, reload it; if listed and collapsed, evict it so expanding
 *   it later never shows stale cached entries (for example, directories pre-populated by `indexFiles`).
 * - If the immediate parent is not listed, is collapsed, or holds at most one entry (decision 98 compact chains), also
 *   reload or evict the nearest listed ancestor so new subdirectories or split/merged chains appear immediately.
 */
export function planFileChanged(
  dirs: Readonly<Record<string, ListedDir | undefined>>,
  expanded: Readonly<Record<string, boolean>>,
  folder: string,
  rawPath: string,
): { dirPath: string; dirKey: FileKey; listed: ListedDir | undefined; shown: boolean; evict: FileKey[] } {
  const path = normalizePath(rawPath);
  const dirPath = parentPath(path);
  const dirKey = fileKey(folder, dirPath);
  const listed = dirs[dirKey];
  const shown = Boolean(listed) && isDirExpanded(expanded, dirKey);
  const evict: FileKey[] = listed && !shown ? [dirKey] : [];
  return { dirPath, dirKey, listed, shown, evict };
}

/** Plans a full tree refresh: reload every listed expanded directory and evict every listed collapsed directory. */
export function planRefreshDirs(
  dirs: Readonly<Record<string, ListedDir | undefined>>,
  expanded: Readonly<Record<string, boolean>> | ((key: FileKey) => boolean),
): DirUpdatePlan {
  const isOpen = typeof expanded === "function" ? expanded : (key: FileKey) => isDirExpanded(expanded, key);
  const reload: { folder: string; path: string }[] = [];
  const evict: FileKey[] = [];
  for (const rawKey of Object.keys(dirs)) {
    const key = parseFileKey(rawKey);
    if (!key || !dirs[key]) continue;
    if (isOpen(key)) reload.push(splitKey(key));
    else evict.push(key);
  }
  return { reload, evict };
}
