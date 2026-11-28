import type { FileEntry, Folder } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorBuffers } from "../lib/buffers";
import { ancestors, fileKey, fileName, normalizePath, splitKey, type FilePosition, type FileKey, keyInFolder, isRootKey } from "../lib/files";
import { EditorIntel, type IntelClient } from "../lsp/hub";
import type { TabId } from "./workspace/layout";
import type { LspManagerOptions } from "../lsp/manager";
import { useApp } from "./app";
import { useOptionalNav } from "./nav";
import { useProject } from "./project";
import { createRequiredContext } from "../lib/context";
import { useLatest } from "../lib/hooks";
import type { DirState, FileIndex, FileNotice, FileStatus, OpenFile } from "./dirCache";

export type { DirState, FileIndex, FileNotice, FileStatus, OpenFile };

type CodeValue = {
  /** The project's folders (label + absolute path), one tree root each. */
  folders: { label: string; path: string }[];
  /** Non-shared worktree workspace id of the focused session, or `undefined` for the shared checkout. */
  workspaceId: string | undefined;
  files: OpenFile[];
  file(key: FileKey): OpenFile | undefined;
  buffers: EditorBuffers;
  /** Language-server status and problems per file (written by the lazily loaded client). */
  intel: EditorIntel;
  /** Starts the language-server client once Monaco is loaded (the factory comes from the editor chunk). */
  startIntel(create: (options: Omit<LspManagerOptions, "monaco">) => IntelClient): void;
  dirs: Record<string, DirState>;
  /** Loads directories breadth-first (up to the limits) so every loaded file can be searched. */
  indexFiles(force?: boolean): void;
  fileIndex: FileIndex;
  /** Every file in the loaded directories, folder by folder, paths sorted. */
  loadedFiles: { folder: string; path: string }[];
  isExpanded(key: FileKey): boolean;
  /** A list is a compact row's directories (decision 98): all open or close together, and only the last one is listed. */
  setExpanded(folder: string, path: string | readonly string[], expanded: boolean): void;
  ensureDir(folder: string, path: string): void;
  reloadDir(folder: string, path: string, quiet?: boolean): void;
  /** Evicts cached collapsed directory listings and invalidates the file index so expanding reloads from disk. */
  evictDirs(keys: readonly FileKey[]): void;
  /** Tree row that reflects the latest open/reveal/focused file; bumps `revealTick` to scroll it into view. */
  selectedKey: FileKey | null;
  revealTick: number;
  /**
   * Opens a file (loading it once) and asks the workspace to show its tab, optionally at a position;
   * `where` puts the tab in a given group (the file view's own tree), optionally in place of a tab.
   */
  openFile(folder: string, path: string, at?: FilePosition, where?: OpenWhere): void;
  /** Loads a file restored with the layout, without showing it; a file gone from disk is reported via `onGone`. */
  restore(key: FileKey): void;
  /** Marks the file whose tab has focus in the tree. */
  select(key: FileKey): void;
  revealDir(folder: string, path: string): void;
  close(key: FileKey): void;
  save(key: FileKey, options?: { overwrite?: boolean }): Promise<void>;
  reloadFromDisk(key: FileKey): Promise<void>;
  retryOpen(key: FileKey): void;
  dismissNotice(key: FileKey): void;
};

const NO_FOLDERS: { label: string; path: string }[] = [];
const NO_FOLDERS_FULL: Folder[] = [];
const normWs = (id?: string | null) => (id && id !== "shared" ? id : undefined);

export const { Provider: CodeContextProvider, useRequired: useCode, useOptional: useOptionalCode } = createRequiredContext<CodeValue>("useCode");

/** A group to open a file tab in, optionally replacing one of its tabs (the empty file view). */
export type OpenWhere = { group: string; replace?: TabId };

type Callbacks = {
  /** Non-shared worktree workspace id for the active session, or `undefined` for the shared checkout. */
  workspaceId?: string | undefined;
  /** Show the tab of a file the user opened. */
  onOpen(key: FileKey, where?: OpenWhere): void;
  /** Show the Files tab (a folder was revealed). */
  onReveal(): void;
  /** A restored file no longer exists; drop its tab silently. */
  onGone(key: FileKey): void;
};

/**
 * Open files and the file tree for one project. Sits above the dock, so unsaved edits and
 * expanded folders survive moving and closing tabs. Which file tab is shown where is the
 * workspace's business; it is told through the callbacks.
 */
export function CodeProvider({ children, workspaceId: rawWorkspaceId, ...callbacks }: Callbacks & { children: ReactNode }) {
  const { bridge } = useApp();
  const { projectId, project, onEvent, kept } = useProject();
  const workspaceId = normWs(rawWorkspaceId);
  const folders = project?.folders;
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<FileKey | null>(null);
  const [revealTick, setRevealTick] = useState(0);

  const filesRef = useLatest(files);
  const dirsRef = useLatest(dirs);
  const expandedRef = useLatest(expanded);
  const selectedRef = useLatest(selectedKey);
  const workspaceIdRef = useLatest(workspaceId);
  const cb = useLatest(callbacks);
  const dirGen = useRef(new Map<string, number>());
  const workspaceGen = useRef(0);
  const indexGen = useRef(0);
  const reindexWanted = useRef(false);

  const wsOpt = useCallback(() => (workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : undefined), [workspaceIdRef]);

  const patch = useCallback((key: FileKey, next: Partial<OpenFile>) => {
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...next } : f)));
  }, []);

  const [buffers] = useState(() => new EditorBuffers(projectId, (key, modified) => patch(key, { modified })));
  const [intel] = useState(() => new EditorIntel());
  useEffect(
    () => () => {
      // Language servers stop before their models go away (project switch, unmount).
      intel.dispose();
      buffers.disposeAll();
    },
    [buffers, intel],
  );
  const foldersRef = useLatest(folders);

  const saving = useRef(new Set<string>());
  const find = useCallback((key: FileKey) => filesRef.current.find((f) => f.key === key), [filesRef]);

  /* ---------- tree ---------- */

  const [fileIndex, setFileIndex] = useState<FileIndex>({ status: "idle", partial: false });
  const indexing = useRef(false);
  const indexedKey = useRef<string | null>(null);

  const evictDirs = useCallback(
    (keys: readonly FileKey[]) => {
      indexedKey.current = null;
      indexGen.current++;
      if (!keys.length) return;
      const drop = new Set<string>(keys);
      let changed = false;
      for (const k of keys) {
        dirGen.current.set(k, (dirGen.current.get(k) ?? 0) + 1);
        if (k in dirsRef.current) changed = true;
      }
      if (!changed) return;
      const next = Object.fromEntries(Object.entries(dirsRef.current).filter(([k]) => !drop.has(k)));
      dirsRef.current = next;
      setDirs(next);
    },
    [dirsRef],
  );

  const loadDir = useCallback(
    async (folder: string, path: string, quiet = false): Promise<FileEntry[] | null> => {
      const key = fileKey(folder, path);
      const gen = (dirGen.current.get(key) ?? 0) + 1;
      dirGen.current.set(key, gen);
      const write = (state: DirState) => {
        dirsRef.current = { ...dirsRef.current, [key]: state };
        setDirs((d) => ({ ...d, [key]: state }));
      };
      if (!quiet) write({ status: "loading", entries: dirsRef.current[key]?.entries ?? [], error: null });
      const { loadDirectory } = await import("./codeOps");
      return loadDirectory({
        bridge,
        projectId,
        folder,
        path,
        opts: wsOpt(),
        quiet,
        isCurrent: () => dirGen.current.get(key) === gen,
        prev: () => dirsRef.current[key],
        write,
      });
    },
    [bridge, projectId, dirsRef, wsOpt],
  );

  const reloadDir = useCallback(
    (folder: string, path: string, quiet?: boolean) => {
      indexedKey.current = null;
      indexGen.current++;
      void loadDir(folder, path, quiet);
    },
    [loadDir],
  );

  const foldersKey = useMemo(
    () => `${projectId}\0${workspaceId ?? ""}\0${(folders ?? []).map((f) => `${f.label}:${f.path}`).join("\0")}`,
    [projectId, workspaceId, folders],
  );
  const foldersKeyRef = useLatest(foldersKey);
  const indexFiles = useCallback(
    (force = false) => {
      if (indexing.current) {
        if (force) reindexWanted.current = true;
        return;
      }
      if (!force && indexedKey.current === foldersKeyRef.current) return;
      const runKey = foldersKeyRef.current;
      const runIndexGen = indexGen.current;
      indexing.current = true;
      setFileIndex({ status: "loading", partial: false });
      void import("./codeOps")
        .then(({ runFileIndex }) =>
          runFileIndex({
            bridge,
            projectId,
            folders: (foldersRef.current ?? []).map((f) => f.label),
            opts: wsOpt(),
            force,
            isCurrent: () => foldersKeyRef.current === runKey,
            getKnown: (key) => dirsRef.current[key],
            getDirGen: (key) => dirGen.current.get(key) ?? 0,
            commitBatch: (batchPatch) => {
              const applied: Record<string, DirState> = {};
              for (const [k, v] of Object.entries(batchPatch)) {
                if ((dirGen.current.get(k) ?? 0) === v.gen) applied[k] = v.state;
              }
              if (!Object.keys(applied).length) return;
              dirsRef.current = { ...dirsRef.current, ...applied };
              setDirs((d) => ({ ...d, ...applied }));
            },
          }),
        )
        .then((partial) => {
          if (foldersKeyRef.current === runKey) {
            if (indexGen.current === runIndexGen) indexedKey.current = runKey;
            setFileIndex({ status: "done", partial });
          }
        })
        .finally(() => {
          indexing.current = false;
          if (reindexWanted.current) {
            reindexWanted.current = false;
            indexFiles(true);
          }
        });
    },
    [bridge, projectId, dirsRef, foldersRef, foldersKeyRef, wsOpt],
  );

  const loadedFiles = useMemo(() => {
    const out: { folder: string; path: string }[] = [];
    for (const f of folders ?? []) {
      for (const [key, dir] of Object.entries(dirs)) {
        if (!keyInFolder(key, f.label) || dir.status !== "ready") continue;
        for (const e of dir.entries) if (e.type === "file") out.push({ folder: f.label, path: e.path });
      }
    }
    return out.sort((a, b) => (a.folder !== b.folder ? 0 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }, [dirs, folders]);

  // Persist the walked file list onto `project.kept.files` once per completed walk (O(F)) instead of inside every InlineCode mount.
  useEffect(() => {
    if (fileIndex.status !== "done") return;
    kept.files.clear();
    const byFolder = new Map<string, string[]>();
    for (const f of loadedFiles) {
      let arr = byFolder.get(f.folder);
      if (!arr) byFolder.set(f.folder, (arr = []));
      arr.push(f.path);
    }
    for (const [folder, paths] of byFolder) kept.files.set(folder, paths);
  }, [fileIndex.status, kept, loadedFiles]);

  const isExpanded = useCallback((key: FileKey) => expanded[key] ?? isRootKey(key), [expanded]);

  const ensureDir = useCallback(
    (folder: string, path: string) => {
      if (!dirsRef.current[fileKey(folder, path)]) void loadDir(folder, path);
    },
    [loadDir, dirsRef],
  );

  const expandTo = useCallback(
    (folder: string, dirs: string[]) => {
      setExpandedState((x) => {
        const next = { ...x };
        for (const d of dirs) next[fileKey(folder, d)] = true;
        return next;
      });
      for (const d of dirs) ensureDir(folder, d);
    },
    [ensureDir],
  );

  /* ---------- files ---------- */

  const load = useCallback(
    async (key: FileKey, folder: string, path: string, restored = false) => {
      const wsGen = workspaceGen.current;
      const { loadOpenFile } = await import("./codeOps");
      await loadOpenFile({
        bridge,
        projectId,
        key,
        folder,
        path,
        opts: wsOpt(),
        restored,
        isCurrent: () => workspaceGen.current === wsGen,
        buffers,
        patch,
        onGone: (k) => cb.current.onGone(k),
      });
    },
    [bridge, projectId, patch, buffers, cb, wsOpt],
  );

  /** Adds the file to the open set (loading it) unless it is already there. */
  const ensure = useCallback(
    (folder: string, path: string, restored = false) => {
      const key = fileKey(folder, path);
      if (filesRef.current.some((f) => f.key === key)) return key;
      const file: OpenFile = {
        key,
        folder,
        path,
        name: fileName(path),
        status: "loading",
        error: null,
        content: "",
        mtime: "",
        modified: false,
        saving: false,
        notice: null,
      };
      filesRef.current = [...filesRef.current, file];
      setFiles((fs) => (fs.some((f) => f.key === key) ? fs : [...fs, file]));
      void load(key, folder, path, restored);
      return key;
    },
    [load, filesRef],
  );

  const openFile = useCallback(
    (folder: string, rawPath: string, at?: FilePosition, where?: OpenWhere) => {
      const path = normalizePath(rawPath);
      if (!path) return;
      const key = ensure(folder, path);
      if (at) buffers.reveal(key, at);
      setSelectedKey(key);
      setRevealTick((n) => n + 1);
      expandTo(folder, ancestors(path));
      cb.current.onOpen(key, where);
    },
    [ensure, expandTo, buffers, cb],
  );

  const restore = useCallback(
    (key: FileKey) => {
      const { folder, path } = splitKey(key);
      if (path) ensure(folder, path, true);
    },
    [ensure],
  );

  const revealDir = useCallback(
    (folder: string, rawPath: string) => {
      const path = normalizePath(rawPath);
      expandTo(folder, [...ancestors(path), path]);
      setSelectedKey(fileKey(folder, path));
      setRevealTick((n) => n + 1);
      cb.current.onReveal();
    },
    [expandTo, cb],
  );

  const close = useCallback(
    (key: FileKey) => {
      const fs = filesRef.current;
      const i = fs.findIndex((f) => f.key === key);
      if (i < 0) return;
      buffers.dispose(key);
      const rest = fs.filter((f) => f.key !== key);
      filesRef.current = rest;
      setFiles(rest);
    },
    [buffers, filesRef],
  );

  const save = useCallback(
    async (key: FileKey, options: { overwrite?: boolean } = {}) => {
      const f = find(key);
      if (!f || f.status !== "ready" || saving.current.has(key)) return;
      const { saveOpenFile } = await import("./codeOps");
      await saveOpenFile({
        bridge,
        projectId,
        file: f,
        buffers,
        saving: saving.current,
        workspaceId: workspaceIdRef.current,
        overwrite: Boolean(options.overwrite),
        patch,
      });
    },
    [bridge, projectId, patch, buffers, find, workspaceIdRef],
  );

  const reloadFromDisk = useCallback(
    async (key: FileKey) => {
      const f = find(key);
      if (!f) return;
      const wsGen = workspaceGen.current;
      const { reloadOpenFile } = await import("./codeOps");
      await reloadOpenFile({
        bridge,
        projectId,
        file: f,
        opts: wsOpt(),
        isCurrent: () => workspaceGen.current === wsGen,
        buffers,
        patch,
      });
    },
    [bridge, projectId, patch, buffers, find, wsOpt],
  );

  const retryOpen = useCallback(
    (key: FileKey) => {
      const f = find(key);
      if (!f) return;
      patch(key, { status: "loading", error: null });
      void load(key, f.folder, f.path);
    },
    [load, patch, find],
  );

  /* ---------- workspace switch ---------- */

  const prevWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (prevWorkspace.current === workspaceId) return;
    prevWorkspace.current = workspaceId;
    workspaceGen.current++;
    indexGen.current++;
    reindexWanted.current = false;
    for (const k of dirGen.current.keys()) dirGen.current.set(k, (dirGen.current.get(k) ?? 0) + 1);
    dirsRef.current = {};
    setDirs({});
    indexedKey.current = null;
    setFileIndex({ status: "idle", partial: false });
    for (const f of filesRef.current) if (!f.modified) void load(f.key, f.folder, f.path);
  }, [workspaceId, dirsRef, filesRef, load]);

  /* ---------- live refresh ---------- */

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "file.changed") return;
        const wsGen = workspaceGen.current;
        void import("./codeOps").then(({ handleFileChanged }) =>
          handleFileChanged({
            event,
            workspaceId: workspaceIdRef.current,
            isCurrent: () => workspaceGen.current === wsGen,
            bridge,
            projectId,
            dirs: () => dirsRef.current,
            expanded: () => expandedRef.current,
            files: () => filesRef.current,
            saving: saving.current,
            buffers,
            invalidateIndex: () => {
              indexedKey.current = null;
              indexGen.current++;
            },
            evictDirs,
            loadDir,
            patch,
            retryOpen,
          }),
        );
      }),
    [onEvent, bridge, projectId, loadDir, evictDirs, patch, buffers, retryOpen, dirsRef, expandedRef, filesRef, workspaceIdRef],
  );

  // Leaving the project unmounts this provider and its buffers: the shell asks first.
  const nav = useOptionalNav();
  useEffect(() => {
    if (!nav) return;
    nav.setLeaveGuard(() => filesRef.current.filter((f) => f.modified).length);
    return () => nav.setLeaveGuard(null);
  }, [nav, filesRef]);

  // Unsaved edits would be lost on reload or window close.
  const anyModified = files.some((f) => f.modified);
  useEffect(() => {
    if (!anyModified) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // still required by Chromium-based webviews
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyModified]);

  const value = useMemo<CodeValue>(
    () => ({
      folders: folders ?? NO_FOLDERS,
      workspaceId,
      files,
      file: (key) => files.find((f) => f.key === key),
      buffers,
      intel,
      startIntel: (create) =>
        intel.start(() =>
          create({
            bridge,
            projectId,
            folders: () => foldersRef.current ?? NO_FOLDERS_FULL,
            buffers,
            intel,
            open: (folder, path, at) => openFile(folder, path, at),
          }),
        ),
      dirs,
      indexFiles,
      fileIndex,
      loadedFiles,
      isExpanded,
      setExpanded: (folder, path, value) => {
        const paths = typeof path === "string" ? [path] : path;
        setExpandedState((x) => ({ ...x, ...Object.fromEntries(paths.map((p) => [fileKey(folder, p), value])) }));
        const last = paths.at(-1);
        if (value && last !== undefined) ensureDir(folder, last);
      },
      ensureDir,
      reloadDir,
      evictDirs,
      selectedKey,
      revealTick,
      openFile,
      restore,
      select: (key) => {
        if (selectedRef.current === key) return;
        selectedRef.current = key;
        setSelectedKey(key);
        setRevealTick((n) => n + 1);
      },
      revealDir,
      close,
      save,
      reloadFromDisk,
      retryOpen,
      dismissNotice: (key) => patch(key, { notice: null }),
    }),
    [
      folders,
      workspaceId,
      files,
      buffers,
      intel,
      bridge,
      projectId,
      dirs,
      indexFiles,
      fileIndex,
      loadedFiles,
      isExpanded,
      ensureDir,
      reloadDir,
      evictDirs,
      selectedKey,
      revealTick,
      openFile,
      restore,
      revealDir,
      close,
      save,
      reloadFromDisk,
      retryOpen,
      patch,
      foldersRef,
      selectedRef,
    ],
  );

  return <CodeContextProvider value={value}>{children}</CodeContextProvider>;
}
