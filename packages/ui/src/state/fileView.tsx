import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { PERSIST_TREE_MS, FOCUS_REQUEST_TTL_MS } from "../lib/constants";
import { PREFS, usePersistentState } from "../lib/storage";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, clamp, treePrefCodec } from "./fileViewPrefs";
import { createRequiredContext } from "../lib/context";

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

export const { Provider: FileViewContextProvider, useRequired: useFileView } = createRequiredContext<FileViewValue>("useFileView");

/** Per-project file-view preferences, persisted in `localStorage["octo.fileTree.{projectId}"]` (guarded). */
export function FileViewProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [stored, setStored] = usePersistentState(PREFS.fileTree(projectId), treePrefCodec, { debounceMs: PERSIST_TREE_MS });
  const [focusTreeTick, setTick] = useState(0);
  const setTreeOpen = useCallback((open: boolean) => setStored((s) => (s.open === open ? s : { ...s, open })), [setStored]);
  const setTreeWidth = useCallback((width: number) => setStored((s) => ({ ...s, width: clamp(width) })), [setStored]);
  const requested = useRef(0);
  const focusTree = useCallback(() => {
    setStored((s) => (s.open ? s : { ...s, open: true }));
    requested.current = performance.now();
    setTick((n) => n + 1);
  }, [setStored]);
  const takeFocusRequest = useCallback(() => {
    const fresh = requested.current > 0 && performance.now() - requested.current < FOCUS_REQUEST_TTL_MS;
    requested.current = 0;
    return fresh;
  }, []);
  const value = useMemo(
    () => ({ treeOpen: stored.open, treeWidth: stored.width, setTreeOpen, setTreeWidth, focusTreeTick, focusTree, takeFocusRequest }),
    [stored, setTreeOpen, setTreeWidth, focusTreeTick, focusTree, takeFocusRequest],
  );
  return <FileViewContextProvider value={value}>{children}</FileViewContextProvider>;
}
