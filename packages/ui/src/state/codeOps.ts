import { BridgeError, type Bridge, type FileChangedEvent, type FileEntry } from "@octo/agent-client";
import type { EditorBuffers } from "../lib/buffers";
import { fileKey, normalizePath, type FileKey } from "../lib/files";
import { errorMessage } from "../lib/format";
import { isDirExpanded, nearestListedAncestor, normalizeWorkspaceId, planFileChanged, type DirState, type FileStatus, type OpenFile } from "./dirCache";
import { walkFolders } from "./fileWalk";

/** Loads a file's contents into the open-file state and editor buffer. */
export async function loadOpenFile(params: {
  bridge: Bridge;
  projectId: string;
  key: FileKey;
  folder: string;
  path: string;
  opts: { workspaceId: string } | undefined;
  restored: boolean;
  isCurrent(): boolean;
  buffers: EditorBuffers;
  patch(key: FileKey, next: Partial<OpenFile>): void;
  onGone(key: FileKey): void;
}): Promise<void> {
  try {
    const fc = await params.bridge.readFile(params.projectId, params.folder, params.path, params.opts);
    if (!params.isCurrent()) return;
    params.patch(params.key, { status: "ready", content: fc.content, mtime: fc.mtime, error: null, notice: null });
    params.buffers.replace(params.key, fc.content);
  } catch (e) {
    if (!params.isCurrent()) return;
    const code = e instanceof BridgeError ? e.code : "";
    if (params.restored && code === "not_found") return params.onGone(params.key);
    const status: FileStatus = code === "file_too_large" ? "too_large" : code === "binary_file" ? "binary" : "error";
    params.patch(params.key, { status, error: errorMessage(e) });
  }
}

/** Reloads an open file from disk, replacing its buffer and clearing any conflict notice. */
export async function reloadOpenFile(params: {
  bridge: Bridge;
  projectId: string;
  file: OpenFile;
  opts: { workspaceId: string } | undefined;
  isCurrent(): boolean;
  buffers: EditorBuffers;
  patch(key: FileKey, next: Partial<OpenFile>): void;
}): Promise<void> {
  const { file: f } = params;
  try {
    const fc = await params.bridge.readFile(params.projectId, f.folder, f.path, params.opts);
    if (!params.isCurrent()) return;
    params.patch(f.key, { status: "ready", content: fc.content, mtime: fc.mtime, notice: null, error: null });
    params.buffers.replace(f.key, fc.content);
  } catch (e) {
    if (!params.isCurrent()) return;
    params.patch(f.key, { notice: { kind: "save_error", message: `Couldn't reload: ${errorMessage(e)}` } });
  }
}

/** Lists a directory from disk and commits the result unless a newer load/eviction superseded it. */
export async function loadDirectory(params: {
  bridge: Bridge;
  projectId: string;
  folder: string;
  path: string;
  opts: { workspaceId: string } | undefined;
  quiet: boolean;
  isCurrent(): boolean;
  prev(): DirState | undefined;
  write(state: DirState): void;
}): Promise<FileEntry[] | null> {
  try {
    const entries = await params.bridge.listFiles(params.projectId, params.folder, params.path, params.opts);
    if (!params.isCurrent()) return null;
    params.write({ status: "ready", entries, error: null });
    return entries;
  } catch (e) {
    if (!params.isCurrent()) return null;
    const prev = params.prev();
    if (params.quiet && prev?.status === "ready") return prev.entries;
    params.write({ status: "error", entries: [], error: errorMessage(e) });
    return null;
  }
}

/**
 * Breadth-first walk of a project's folders for Filter files, `@` mentions, TabPicker, and FileLink.
 * Loaded lazily on the first `indexFiles()` call so the initial bundle stays slim.
 */
export async function runFileIndex(params: {
  bridge: Bridge;
  projectId: string;
  folders: readonly string[];
  opts: { workspaceId: string } | undefined;
  force: boolean;
  isCurrent(): boolean;
  getKnown(key: string): DirState | undefined;
  getDirGen(key: string): number;
  commitBatch(patch: Record<string, { state: DirState; gen: number }>): void;
}): Promise<boolean> {
  let batchPatch: Record<string, { state: DirState; gen: number }> = {};
  const flush = () => {
    if (!params.isCurrent() || !Object.keys(batchPatch).length) return;
    const patch = batchPatch;
    batchPatch = {};
    params.commitBatch(patch);
  };
  const partial = await walkFolders(
    params.folders,
    async (folder, path) => {
      const key = fileKey(folder, path);
      if (!params.force) {
        const known = params.getKnown(key);
        if (known?.status === "ready") return known.entries;
      }
      const gen = params.getDirGen(key);
      try {
        const entries: FileEntry[] = await params.bridge.listFiles(params.projectId, folder, path, params.opts);
        if (!params.isCurrent() || params.getDirGen(key) !== gen) return null;
        batchPatch[key] = { state: { status: "ready", entries, error: null }, gen };
        return entries;
      } catch {
        return null;
      }
    },
    flush,
  );
  flush();
  return partial;
}

/** Saves an open editor file with optimistic mtime checking and conflict/error reporting. */
export async function saveOpenFile(params: {
  bridge: Bridge;
  projectId: string;
  file: OpenFile;
  buffers: EditorBuffers;
  saving: Set<string>;
  workspaceId: string | undefined;
  overwrite: boolean;
  patch(key: FileKey, next: Partial<OpenFile>): void;
}): Promise<void> {
  const { bridge, projectId, file: f, buffers, saving, workspaceId, overwrite, patch } = params;
  const key = f.key;
  saving.add(key);
  const content = buffers.value(key) ?? f.content;
  const version = buffers.version(key);
  patch(key, { saving: true, notice: null });
  try {
    const stat = await bridge.writeFile(projectId, {
      folder: f.folder,
      path: f.path,
      content,
      ...(overwrite ? {} : { expected_mtime: f.mtime }),
      ...(workspaceId ? { workspace_id: workspaceId } : {}),
    });
    patch(key, { saving: false, content, mtime: stat.mtime });
    if (version !== null) buffers.markSaved(key, version);
  } catch (e) {
    const conflict = e instanceof BridgeError && e.code === "file_changed";
    patch(key, { saving: false, notice: conflict ? { kind: "conflict" } : { kind: "save_error", message: errorMessage(e) } });
  } finally {
    saving.delete(key);
  }
}

/**
 * Handles a live `file.changed` SSE event: reloads expanded affected directories, evicts collapsed cached directories
 * so expanding them reads fresh entries from disk, updates compact-folder ancestors (decision 98), and refreshes any
 * matching open editor buffer.
 */
export function handleFileChanged(params: {
  event: FileChangedEvent;
  workspaceId: string | undefined;
  isCurrent(): boolean;
  bridge: Bridge;
  projectId: string;
  dirs: () => Readonly<Record<string, DirState>>;
  expanded: () => Readonly<Record<string, boolean>>;
  files: () => readonly OpenFile[];
  saving: ReadonlySet<string>;
  buffers: EditorBuffers;
  invalidateIndex(): void;
  evictDirs(keys: readonly FileKey[]): void;
  loadDir(folder: string, path: string, quiet?: boolean): Promise<FileEntry[] | null>;
  patch(key: FileKey, next: Partial<OpenFile>): void;
  retryOpen(key: FileKey): void;
}): void {
  const { event, workspaceId, isCurrent, bridge, projectId } = params;
  if (!isCurrent() || normalizeWorkspaceId(event.workspace_id) !== workspaceId) return;
  params.invalidateIndex();
  const path = normalizePath(event.path);
  const { dirPath, listed, shown, evict } = planFileChanged(params.dirs(), params.expanded(), event.folder, path);
  if (evict.length) params.evictDirs(evict);
  void (async () => {
    const before = listed?.entries.length ?? 0;
    const after = shown ? ((await params.loadDir(event.folder, dirPath, true))?.length ?? before) : before;
    if (!isCurrent()) return;
    // Decision 98: a directory that is not listed, collapsed, or holds (held) one entry may sit in a compact row,
    // whose `chain` hint comes from the nearest listed ancestor: reload (or evict if collapsed) that ancestor too.
    if (!dirPath || (listed && shown && before > 1 && after > 1)) return;
    const ancestor = nearestListedAncestor(params.dirs(), event.folder, dirPath);
    if (!ancestor) return;
    if (isDirExpanded(params.expanded(), ancestor.key)) void params.loadDir(event.folder, ancestor.path, true);
    else params.evictDirs([ancestor.key]);
  })();
  const key = fileKey(event.folder, path);
  const f = params.files().find((x) => x.key === key);
  // While saving, our own write is in flight; its response carries the new mtime.
  if (!f || params.saving.has(key) || f.status === "loading") return;
  if (f.status !== "ready") return params.retryOpen(key);
  const opts = workspaceId ? { workspaceId } : undefined;
  void bridge.readFile(projectId, f.folder, f.path, opts).then(
    (fc) => {
      if (!isCurrent()) return;
      const now = params.files().find((x) => x.key === key);
      if (!now || params.saving.has(key) || fc.mtime === now.mtime) return;
      if (now.modified) {
        if (params.buffers.value(key) === fc.content) {
          params.patch(key, { content: fc.content, mtime: fc.mtime });
          params.buffers.replace(key, fc.content);
        } else params.patch(key, { notice: { kind: "changed" } });
        return;
      }
      params.patch(key, { content: fc.content, mtime: fc.mtime });
      params.buffers.replace(key, fc.content);
    },
    () => undefined,
  );
}
