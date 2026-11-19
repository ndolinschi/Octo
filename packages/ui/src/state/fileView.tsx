import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { PERSIST_TREE_MS, FOCUS_REQUEST_TTL_MS } from "../lib/constants";
import { PREFS, usePersistentState } from "../lib/storage";
import { TREE_DEFAULT, TREE_MAX, TREE_MIN, columnWidth, treePrefCodec } from "./fileViewPrefs";
import { createRequiredContext } from "../lib/context";

export { TREE_DEFAULT, TREE_MAX, TREE_MIN };

export type TreeColumnState = { open: boolean; width: number };

type FileViewValue = {
  /** A file group's tree column (decision 94a): shown or hidden, and its width. Per group; a group nobody has changed uses the project's stored default. */
  column(groupId: string): TreeColumnState;
  setColumnOpen(groupId: string, open: boolean): void;
  setColumnWidth(groupId: string, width: number): void;
  /** Bumped when something asks the visible file view to show and focus its tree (the header's Files button, Reveal in tree). */
  focusTreeTick: number;
  /** Opens the group's tree column (when it has one to open) and asks for focus in its filter. */
  focusTree(groupId?: string): void;
  /** True once for a focus request made in the last second: a tree column mounted by it takes focus. */
  takeFocusRequest(): boolean;
  /** The Filter files text, shared by the project's file views (kept when the Files tab turns into a file's tab). */
  filter: string;
  setFilter(text: string): void;
};

export const { Provider: FileViewContextProvider, useRequired: useFileView } = createRequiredContext<FileViewValue>("useFileView");

/**
 * File-view preferences. Group ids are new on every load, so the per-group column state lives in memory for the session and
 * every change also becomes the project's stored default (`localStorage["octo.fileTree.{projectId}"]`, guarded), which a
 * group without its own state starts from.
 */
export function FileViewProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const [stored, setStored] = usePersistentState(PREFS.fileTree(projectId), treePrefCodec, { debounceMs: PERSIST_TREE_MS });
  // What a group nobody has touched shows: the default as loaded, so another group's change never moves it.
  const [initial] = useState(stored);
  const [groups, setGroups] = useState<Readonly<Record<string, TreeColumnState>>>({});
  const [focusTreeTick, setTick] = useState(0);
  const [filter, setFilter] = useState("");
  const patch = useCallback(
    (groupId: string, change: Partial<TreeColumnState>) => {
      setGroups((g) => {
        const cur = g[groupId] ?? initial;
        const next = { ...cur, ...change };
        return next.open === cur.open && next.width === cur.width && g[groupId] ? g : { ...g, [groupId]: next };
      });
      setStored((s) => ({ ...s, ...change }));
    },
    [setStored, initial],
  );
  const column = useCallback((groupId: string) => groups[groupId] ?? initial, [groups, initial]);
  const setColumnOpen = useCallback((groupId: string, open: boolean) => patch(groupId, { open }), [patch]);
  const setColumnWidth = useCallback((groupId: string, width: number) => patch(groupId, { width: columnWidth(width) }), [patch]);
  const requested = useRef(0);
  const focusTree = useCallback(
    (groupId?: string) => {
      if (groupId !== undefined) patch(groupId, { open: true });
      requested.current = performance.now();
      setTick((n) => n + 1);
    },
    [patch],
  );
  const takeFocusRequest = useCallback(() => {
    const fresh = requested.current > 0 && performance.now() - requested.current < FOCUS_REQUEST_TTL_MS;
    requested.current = 0;
    return fresh;
  }, []);
  const value = useMemo(
    () => ({ column, setColumnOpen, setColumnWidth, focusTreeTick, focusTree, takeFocusRequest, filter, setFilter }),
    [column, setColumnOpen, setColumnWidth, focusTreeTick, focusTree, takeFocusRequest, filter],
  );
  return <FileViewContextProvider value={value}>{children}</FileViewContextProvider>;
}
