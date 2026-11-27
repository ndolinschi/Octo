import { BridgeError, type FileEntry, type Folder } from "@octo/agent-client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorBuffers } from "../lib/buffers";
import { ancestors, fileKey, fileName, normalizePath, parentPath, splitKey, type FilePosition, type FileKey, keyInFolder, isRootKey } from "../lib/files";
import { EditorIntel, type IntelClient } from "../lsp/hub";
import type { TabId } from "./workspace/layout";
import type { LspManagerOptions } from "../lsp/manager";
import { useApp } from "./app";
import { useOptionalNav } from "./nav";
import { useProject } from "./project";
import { errorMessage } from "../lib/format";
import { createRequiredContext } from "../lib/context";
import { useLatest } from "../lib/hooks";

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

/** Limits of the walk (contract v6 decision 6). */
const INDEX_MAX_DIRS = 200;
const INDEX_MAX_ENTRIES = 5000;

type CodeValue = {
  /** The project's folders (label + absolute path), one tree root each. */
  folders: { label: string; path: string }[];
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
  reloadDir(folder: string, path: string): void;
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

export const { Provider: CodeContextProvider, useRequired: useCode, useOptional: useOptionalCode } = createRequiredContext<CodeValue>("useCode");

/** A group to open a file tab in, optionally replacing one of its tabs (the empty file view). */
export type OpenWhere = { group: string; replace?: TabId };

type Callbacks = {
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
export function CodeProvider({ children, ...callbacks }: Callbacks & { children: ReactNode }) {
  const { bridge } = useApp();
  const { projectId, project, onEvent } = useProject();
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
  const cb = useLatest(callbacks);

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

  const loadDir = useCallback(
    async (folder: string, path: string, quiet = false): Promise<FileEntry[] | null> => {
      const key = fileKey(folder, path);
      if (!quiet) setDirs((d) => ({ ...d, [key]: { status: "loading", entries: d[key]?.entries ?? [], error: null } }));
      try {
        const entries = await bridge.listFiles(projectId, folder, path);
        dirsRef.current = { ...dirsRef.current, [key]: { status: "ready", entries, error: null } };
        setDirs((d) => ({ ...d, [key]: { status: "ready", entries, error: null } }));
        return entries;
      } catch (e) {
        if (quiet && dirsRef.current[key]?.status === "ready") return dirsRef.current[key].entries;
        setDirs((d) => ({ ...d, [key]: { status: "error", entries: [], error: errorMessage(e) } }));
        return null;
      }
    },
    [bridge, projectId, dirsRef],
  );

  const [fileIndex, setFileIndex] = useState<FileIndex>({ status: "idle", partial: false });
  const indexing = useRef(false);
  const indexedKey = useRef<string | null>(null);
  const foldersKey = useMemo(() => `${projectId}\0${(folders ?? []).map((f) => `${f.label}:${f.path}`).join("\0")}`, [projectId, folders]);
  const foldersKeyRef = useLatest(foldersKey);
  const indexFiles = useCallback(
    (force = false) => {
      if (indexing.current) return;
      if (!force && indexedKey.current === foldersKeyRef.current) return;
      const runKey = foldersKeyRef.current;
      indexing.current = true;
      setFileIndex({ status: "loading", partial: false });
      void (async () => {
        const CONCURRENCY = 6;
        let wave: [string, string][] = (foldersRef.current ?? []).map((f) => [f.label, ""]);
        let seenDirs = 0;
        let seenEntries = 0;
        let partial = false;
        while (wave.length > 0 && !partial) {
          const nextWave: [string, string][] = [];
          const batchPatch: Record<string, DirState> = {};
          for (let i = 0; i < wave.length && !partial; i += CONCURRENCY) {
            const slice: [string, string][] = [];
            while (slice.length < CONCURRENCY && i + slice.length < wave.length) {
              if (seenDirs >= INDEX_MAX_DIRS || seenEntries >= INDEX_MAX_ENTRIES) {
                partial = true;
                break;
              }
              slice.push(wave[i + slice.length]!);
              seenDirs += 1;
            }
            const results = await Promise.all(
              slice.map(async ([folder, path]) => {
                const key = fileKey(folder, path);
                const known = dirsRef.current[key];
                if (known?.status === "ready") return { folder, key, entries: known.entries, fetched: false };
                try {
                  const entries = await bridge.listFiles(projectId, folder, path);
                  return { folder, key, entries, fetched: true };
                } catch {
                  return { folder, key, entries: null as FileEntry[] | null, fetched: false };
                }
              }),
            );
            for (const r of results) {
              if (!r.entries) continue;
              if (r.fetched) {
                const ready: DirState = { status: "ready", entries: r.entries, error: null };
                batchPatch[r.key] = ready;
              }
              seenEntries += r.entries.length;
              if (seenEntries >= INDEX_MAX_ENTRIES) partial = true;
              for (const e of r.entries) if (e.type === "dir") nextWave.push([r.folder, e.path]);
            }
          }
          if (Object.keys(batchPatch).length > 0) {
            dirsRef.current = { ...dirsRef.current, ...batchPatch };
            setDirs((d) => ({ ...d, ...batchPatch }));
          }
          wave = nextWave;
        }
        indexedKey.current = runKey;
        setFileIndex({ status: "done", partial });
        // A later forced call (or folder change) walks again, reusing what is loaded.
        indexing.current = false;
      })();
    },
    [bridge, projectId, dirsRef, foldersRef, foldersKeyRef],
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
  const { kept } = useProject();
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
      try {
        const fc = await bridge.readFile(projectId, folder, path);
        patch(key, { status: "ready", content: fc.content, mtime: fc.mtime, error: null, notice: null });
        buffers.replace(key, fc.content);
      } catch (e) {
        const code = e instanceof BridgeError ? e.code : "";
        if (restored && code === "not_found") return cb.current.onGone(key);
        const status: FileStatus = code === "file_too_large" ? "too_large" : code === "binary_file" ? "binary" : "error";
        patch(key, { status, error: errorMessage(e) });
      }
    },
    [bridge, projectId, patch, buffers, cb],
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
      saving.current.add(key);
      const content = buffers.value(key) ?? f.content;
      const version = buffers.version(key);
      patch(key, { saving: true, notice: null });
      try {
        const stat = await bridge.writeFile(projectId, {
          folder: f.folder,
          path: f.path,
          content,
          ...(options.overwrite ? {} : { expected_mtime: f.mtime }),
        });
        patch(key, { saving: false, content, mtime: stat.mtime });
        if (version !== null) buffers.markSaved(key, version);
      } catch (e) {
        const conflict = e instanceof BridgeError && e.code === "file_changed";
        patch(key, { saving: false, notice: conflict ? { kind: "conflict" } : { kind: "save_error", message: errorMessage(e) } });
      } finally {
        saving.current.delete(key);
      }
    },
    [bridge, projectId, patch, buffers, find],
  );

  const reloadFromDisk = useCallback(
    async (key: FileKey) => {
      const f = find(key);
      if (!f) return;
      try {
        const fc = await bridge.readFile(projectId, f.folder, f.path);
        patch(key, { status: "ready", content: fc.content, mtime: fc.mtime, notice: null, error: null });
        buffers.replace(key, fc.content);
      } catch (e) {
        patch(key, { notice: { kind: "save_error", message: `Couldn't reload: ${errorMessage(e)}` } });
      }
    },
    [bridge, projectId, patch, buffers, find],
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

  /* ---------- live refresh ---------- */

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "file.changed") return;
        const path = normalizePath(event.path);
        const dirPath = parentPath(path);
        const listed = dirsRef.current[fileKey(event.folder, dirPath)];
        const shown = listed && (expandedRef.current[fileKey(event.folder, dirPath)] ?? dirPath === "");
        void (async () => {
          const before = listed?.entries.length ?? 0;
          const after = shown ? ((await loadDir(event.folder, dirPath, true))?.length ?? before) : before;
          // Decision 98: a directory that is not listed, or holds (held) one entry, may sit in a compact row, whose
          // `chain` hint comes from the nearest listed ancestor: list that again so the row re-forms or splits.
          if (!dirPath || (listed && before > 1 && after > 1)) return;
          for (let a = parentPath(dirPath); ; a = parentPath(a)) {
            const k = fileKey(event.folder, a);
            if (dirsRef.current[k]) {
              if (expandedRef.current[k] ?? a === "") void loadDir(event.folder, a, true);
              return;
            }
            if (!a) return;
          }
        })();
        const key = fileKey(event.folder, path);
        const f = filesRef.current.find((x) => x.key === key);
        // While saving, our own write is in flight; its response carries the new mtime.
        if (!f || saving.current.has(key) || f.status === "loading") return;
        if (f.status !== "ready") return retryOpen(key);
        void bridge.readFile(projectId, f.folder, f.path).then(
          (fc) => {
            const now = filesRef.current.find((x) => x.key === key);
            if (!now || saving.current.has(key) || fc.mtime === now.mtime) return;
            if (now.modified) {
              if (buffers.value(key) === fc.content) {
                patch(key, { content: fc.content, mtime: fc.mtime });
                buffers.replace(key, fc.content);
              } else patch(key, { notice: { kind: "changed" } });
              return;
            }
            patch(key, { content: fc.content, mtime: fc.mtime });
            buffers.replace(key, fc.content);
          },
          () => undefined,
        );
      }),
    [onEvent, bridge, projectId, loadDir, patch, buffers, retryOpen, dirsRef, expandedRef, filesRef],
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
      reloadDir: (folder, path) => void loadDir(folder, path),
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
      loadDir,
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
