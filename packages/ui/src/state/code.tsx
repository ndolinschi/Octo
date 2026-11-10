import { BridgeError, type FileEntry } from "@octo/agent-client";
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
import { ancestors, fileKey, fileName, normalizePath, parentPath } from "../lib/files";
import { useApp } from "./app";
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

/** Which half of the Files tab is shown when the pane is too narrow for both. */
export type FilesView = "tree" | "editor";

type CodeValue = {
  /** The project's folders (label + absolute path), one tree root each. */
  folders: { label: string; path: string }[];
  files: OpenFile[];
  activeKey: string | null;
  active: OpenFile | null;
  buffers: EditorBuffers;
  dirs: Record<string, DirState>;
  isExpanded(key: string): boolean;
  setExpanded(folder: string, path: string, expanded: boolean): void;
  ensureDir(folder: string, path: string): void;
  reloadDir(folder: string, path: string): void;
  /** Tree row that reflects the latest open/reveal; bumps `revealTick` to scroll it into view. */
  selectedKey: string | null;
  revealTick: number;
  view: FilesView;
  setView(view: FilesView): void;
  openFile(folder: string, path: string): void;
  revealDir(folder: string, path: string): void;
  activate(key: string): void;
  close(key: string): void;
  save(key: string, options?: { overwrite?: boolean }): Promise<void>;
  reloadFromDisk(key: string): Promise<void>;
  retryOpen(key: string): void;
  dismissNotice(key: string): void;
};

const NO_FOLDERS: { label: string; path: string }[] = [];

const CodeContext = createContext<CodeValue | null>(null);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Open files and the file tree for one project. Sits above the side pane so tabs, unsaved
 * edits and expanded folders survive closing the pane or switching side-pane tabs.
 * `onReveal` asks the workspace to show the Files tab (opening the pane if needed).
 */
export function CodeProvider({ children, onReveal }: { children: ReactNode; onReveal(): void }) {
  const { bridge } = useApp();
  const { projectId, project, onEvent } = useProject();
  const folders = project?.folders;
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpandedState] = useState<Record<string, boolean>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  const [view, setView] = useState<FilesView>("tree");

  const filesRef = useRef(files);
  const dirsRef = useRef(dirs);
  const expandedRef = useRef(expanded);
  useLayoutEffect(() => {
    filesRef.current = files;
    dirsRef.current = dirs;
    expandedRef.current = expanded;
  });
  const revealRef = useRef(onReveal);
  useLayoutEffect(() => {
    revealRef.current = onReveal;
  });

  const patch = useCallback((key: string, next: Partial<OpenFile>) => {
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...next } : f)));
  }, []);

  const [buffers] = useState(() => new EditorBuffers(projectId, (key, modified) => patch(key, { modified })));
  useEffect(() => () => buffers.disposeAll(), [buffers]);

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
    async (key: string, folder: string, path: string) => {
      try {
        const fc = await bridge.readFile(projectId, folder, path);
        patch(key, { status: "ready", content: fc.content, mtime: fc.mtime, error: null, notice: null });
        buffers.replace(key, fc.content);
      } catch (e) {
        const code = e instanceof BridgeError ? e.code : "";
        const status: FileStatus = code === "file_too_large" ? "too_large" : code === "binary_file" ? "binary" : "error";
        patch(key, { status, error: errorMessage(e) });
      }
    },
    [bridge, projectId, patch, buffers],
  );

  const openFile = useCallback(
    (folder: string, rawPath: string) => {
      const path = normalizePath(rawPath);
      if (!path) return;
      const key = fileKey(folder, path);
      if (!filesRef.current.some((f) => f.key === key)) {
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
        setFiles((fs) => (fs.some((f) => f.key === key) ? fs : [...fs, file]));
        void load(key, folder, path);
      }
      setActiveKey(key);
      setSelectedKey(key);
      setRevealTick((n) => n + 1);
      setView("editor");
      expandTo(folder, ancestors(path));
      revealRef.current();
    },
    [load, expandTo],
  );

  const revealDir = useCallback(
    (folder: string, rawPath: string) => {
      const path = normalizePath(rawPath);
      expandTo(folder, [...ancestors(path), path]);
      setSelectedKey(fileKey(folder, path));
      setRevealTick((n) => n + 1);
      setView("tree");
      revealRef.current();
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
      setActiveKey((current) => (current === key ? (rest[Math.min(i, rest.length - 1)]?.key ?? null) : current));
      if (!rest.length) setView("tree");
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

  // Unsaved edits would be lost on reload or window close.
  const anyModified = files.some((f) => f.modified);
  useEffect(() => {
    if (!anyModified) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyModified]);

  const value = useMemo<CodeValue>(
    () => ({
      folders: folders ?? NO_FOLDERS,
      files,
      activeKey,
      active: files.find((f) => f.key === activeKey) ?? null,
      buffers,
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
      view,
      setView,
      openFile,
      revealDir,
      activate: (key) => {
        setActiveKey(key);
        setSelectedKey(key);
        setView("editor");
      },
      close,
      save,
      reloadFromDisk,
      retryOpen,
      dismissNotice: (key) => patch(key, { notice: null }),
    }),
    [folders, files, activeKey, buffers, dirs, isExpanded, ensureDir, loadDir, selectedKey, revealTick, view, openFile, revealDir, close, save, reloadFromDisk, retryOpen, patch],
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
