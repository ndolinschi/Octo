import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { readPref, writePref } from "../lib/storage";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, clamp, parseTreePref, type Stored } from "./fileViewPrefs";

export { TREE_DEFAULT, TREE_MAX, TREE_MIN };

type FileViewValue = {
  /** Whether the tree column is shown; shared by every file view of the project. */
  treeOpen: boolean;
  treeWidth: number;
  setTreeOpen(open: boolean): void;
  setTreeWidth(width: number): void;
  /** Bumped when something asks the visible file view to focus its tree (the header's Files button, Reveal in tree). */
  focusTreeTick: number;
  focusTree(): void;
  /** True once for a focus request made in the last second: a tree column mounted by it takes focus. */
  takeFocusRequest(): boolean;
};

const FileViewContext = createContext<FileViewValue | null>(null);

function load(projectId: string): Stored {
  return parseTreePref(readPref(`fileTree.${projectId}`));
}

/** Per-project file-view preferences, persisted in `localStorage["octo.fileTree.{projectId}"]` (guarded). */
export function FileViewProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [stored, setStored] = useState(() => load(projectId));
  const [focusTreeTick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => writePref(`fileTree.${projectId}`, JSON.stringify(stored)), 150);
    return () => window.clearTimeout(id);
  }, [stored, projectId]);
  const setTreeOpen = useCallback((open: boolean) => setStored((s) => (s.open === open ? s : { ...s, open })), []);
  const setTreeWidth = useCallback((width: number) => setStored((s) => ({ ...s, width: clamp(width) })), []);
  const requested = useRef(0);
  const focusTree = useCallback(() => {
    setStored((s) => (s.open ? s : { ...s, open: true }));
    requested.current = performance.now();
    setTick((n) => n + 1);
  }, []);
  const takeFocusRequest = useCallback(() => {
    const fresh = requested.current > 0 && performance.now() - requested.current < 1000;
    requested.current = 0;
    return fresh;
  }, []);
  const value = useMemo(
    () => ({ treeOpen: stored.open, treeWidth: stored.width, setTreeOpen, setTreeWidth, focusTreeTick, focusTree, takeFocusRequest }),
    [stored, setTreeOpen, setTreeWidth, focusTreeTick, focusTree, takeFocusRequest],
  );
  return <FileViewContext.Provider value={value}>{children}</FileViewContext.Provider>;
}

export function useFileView(): FileViewValue {
  const ctx = useContext(FileViewContext);
  if (!ctx) throw new Error("useFileView outside FileViewProvider");
  return ctx;
}
