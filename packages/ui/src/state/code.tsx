import { BridgeError, type FileEntry, type Folder } from "@octo/agent-client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EditorBuffers } from "../components/files/buffers";
import { ancestors, fileKey, fileName, normalizePath, parentPath, splitKey, type FilePosition } from "../lib/files";
import { EditorIntel, type IntelClient } from "../lsp/hub";
import type { LspManagerOptions } from "../lsp/manager";
import { useApp } from "./app";
import { useOptionalNav } from "./nav";
import { useProject } from "./project";

export type FileStatus = "loading" | "ready" | "error" | "too_large" | "binary";
export type FileNotice =
  | { kind: "conflict" }
  | { kind: "save_error"; message: string }
  | { kind: "changed" };

export type OpenFile = {
  key: string;
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

type CodeValue = {
  /** The project's folders (label + absolute path), one tree root each. */
  folders: { label: string; path: string }[];
  files: OpenFile[];
  file(key: string): OpenFile | undefined;
  buffers: EditorBuffers;
  /** Language-server status and problems per file (written by the lazily loaded client). */
  intel: EditorIntel;
  /** Starts the language-server client once Monaco is loaded (the factory comes from the editor chunk). */
  startIntel(create: (options: Omit<LspManagerOptions, "monaco">) => IntelClient): void;
  dirs: Record<string, DirState>;
  isExpanded(key: string): boolean;
  setExpanded(folder: string, path: string, expanded: boolean): void;
  ensureDir(folder: string, path: string): void;
  reloadDir(folder: string, path: string): void;
  /** Tree row that reflects the latest open/reveal/focused file; bumps `revealTick` to scroll it into view. */
  selectedKey: string | null;
  revealTick: number;
  /** Opens a file (loading it once) and asks the workspace to show its tab, optionally at a position. */
  openFile(folder: string, path: string, at?: FilePosition): void;
  /** Loads a file restored with the layout, without showing it; a file gone from disk is reported via `onGone`. */
  restore(key: string): void;
  /** Marks the file whose tab has focus in the tree. */
  select(key: string): void;
  revealDir(folder: string, path: string): void;
  close(key: string): void;
  save(key: string, options?: { overwrite?: boolean }): Promise<void>;
  reloadFromDisk(key: string): Promise<void>;
  retryOpen(key: string): void;
  dismissNotice(key: string): void;
};

const NO_FOLDERS: { label: string; path: string }[] = [];
const NO_FOLDERS_FULL: Folder[] = [];

const CodeContext = createContext<CodeValue | null>(null);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Callbacks = {
  /** Show the tab of a file the user opened. */
  onOpen(key: string): void;
  /** Show the Files tab (a folder was revealed). */
  onReveal(): void;
  /** A restored file no longer exists; drop its tab silently. */
  onGone(key: string): void;
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);

  const filesRef = useRef(files);
  const dirsRef = useRef(dirs);
  const expandedRef = useRef(expanded);
  const selectedRef = useRef(selectedKey);
  useLayoutEffect(() => {
    filesRef.current = files;
    dirsRef.current = dirs;
    expandedRef.current = expanded;
    selectedRef.current = selectedKey;
  });
  const cb = useRef(callbacks);
  useLayoutEffect(() => {
    cb.current = callbacks;
  });

  const patch = useCallback((key: string, next: Partial<OpenFile>) => {
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
  const foldersRef = useRef(folders);
  foldersRef.current = folders;

  const saving = useRef(new Set<string>());
  const find = (key: string) => filesRef.current.find((f) => f.key === key);

  /* ---------- tree ---------- */

  const loadDir = useCallback(
    async (folder: string, path: string, quiet = false) => {
      const key = fileKey(folder, path);
      if (!quiet) setDirs((d) => ({ ...d, [key]: { status: "loading", entries: d[key]?.entries ?? [], error: null } }));
      try {
        const entries = await bridge.listFiles(projectId, folder, path);
        setDirs((d) => ({ ...d, [key]: { status: "ready", entries, error: null } }));
      } catch (e) {
        if (quiet && dirsRef.current[key]?.status === "ready") return;
        setDirs((d) => ({ ...d, [key]: { status: "error", entries: [], error: errorMessage(e) } }));
      }
    },
    [bridge, projectId],
  );

  const isExpanded = useCallback((key: string) => expanded[key] ?? key.endsWith("\u0000"), [expanded]);

  const ensureDir = useCallback(
    (folder: string, path: string) => {
      if (!dirsRef.current[fileKey(folder, path)]) void loadDir(folder, path);
    },
    [loadDir],
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
    async (key: string, folder: string, path: string, restored = false) => {
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
    [bridge, projectId, patch, buffers],
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
    [load],
  );

  const openFile = useCallback(
    (folder: string, rawPath: string, at?: FilePosition) => {
      const path = normalizePath(rawPath);
      if (!path) return;
      const key = ensure(folder, path);
      if (at) buffers.reveal(key, at);
      setSelectedKey(key);
      setRevealTick((n) => n + 1);
      expandTo(folder, ancestors(path));
      cb.current.onOpen(key);
    },
    [ensure, expandTo, buffers],
  );

  const restore = useCallback(
    (key: string) => {
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
    [expandTo],
  );

  const close = useCallback(
    (key: string) => {
      const fs = filesRef.current;
      const i = fs.findIndex((f) => f.key === key);
      if (i < 0) return;
      buffers.dispose(key);
      const rest = fs.filter((f) => f.key !== key);
      filesRef.current = rest;
      setFiles(rest);
    },
    [buffers],
  );

  const save = useCallback(
    async (key: string, options: { overwrite?: boolean } = {}) => {
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
    [bridge, projectId, patch, buffers],
  );

  const reloadFromDisk = useCallback(
    async (key: string) => {
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
    [bridge, projectId, patch, buffers],
  );

  const retryOpen = useCallback(
    (key: string) => {
      const f = find(key);
      if (!f) return;
      patch(key, { status: "loading", error: null });
      void load(key, f.folder, f.path);
    },
    [load, patch],
  );

  /* ---------- live refresh ---------- */

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type !== "file.changed") return;
        const path = normalizePath(event.path);
        const parent = fileKey(event.folder, parentPath(path));
        if (dirsRef.current[parent] && (expandedRef.current[parent] ?? parentPath(path) === "")) {
          void loadDir(event.folder, parentPath(path), true);
        }
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
    [onEvent, bridge, projectId, loadDir, patch, buffers, retryOpen],
  );

  // Leaving the project unmounts this provider and its buffers: the shell asks first.
  const nav = useOptionalNav();
  useEffect(() => {
    if (!nav) return;
    nav.setLeaveGuard(() => filesRef.current.filter((f) => f.modified).length);
    return () => nav.setLeaveGuard(null);
  }, [nav]);

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
      isExpanded,
      setExpanded: (folder, path, value) => {
        const key = fileKey(folder, path);
        setExpandedState((x) => ({ ...x, [key]: value }));
        if (value) ensureDir(folder, path);
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
    [folders, files, buffers, intel, bridge, projectId, dirs, isExpanded, ensureDir, loadDir, selectedKey, revealTick, openFile, restore, revealDir, close, save, reloadFromDisk, retryOpen, patch],
  );

  return <CodeContext.Provider value={value}>{children}</CodeContext.Provider>;
}

export function useCode(): CodeValue {
  const ctx = useContext(CodeContext);
  if (!ctx) throw new Error("useCode outside CodeProvider");
  return ctx;
}

/** Null outside a project workspace (e.g. when the transcript is embedded elsewhere). */
export function useOptionalCode(): CodeValue | null {
  return useContext(CodeContext);
}
