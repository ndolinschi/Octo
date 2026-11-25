import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useCode } from "../code";
import { parseTab, type Group, type TabId } from "./layout";
import { useWorkspace } from "./WorkspaceProvider";
import { createRequiredContext } from "../../lib/context";

export type GroupValue = {
  groupId: string;
  /** Back / forward over the files viewed in this group (the file view's arrows). */
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
};

/** Null outside a dock group. */
export const { Provider: GroupContextProvider, useOptional: useGroup } = createRequiredContext<GroupValue>("useGroup");

type History = { stack: TabId[]; index: number };

/**
 * One tab group's context: its id and its file history. Every file tab that becomes the group's active
 * tab is pushed (forward entries are dropped, like a browser); back/forward show the previous/next one,
 * reopening it in this group when it was closed. A file gone from disk is dropped by the restore.
 */
export function GroupProvider({ group, children }: { group: Group; children: ReactNode }) {
  const ws = useWorkspace();
  const code = useCode();
  const [history, setHistory] = useState<History>({ stack: [], index: -1 });
  const target = useRef<TabId | null>(null);

  useEffect(() => {
    const tab = group.active;
    if (parseTab(tab)?.kind !== "file") return;
    setHistory((h) => {
      // Arrived by back/forward: the index already moved.
      if (target.current === tab) {
        target.current = null;
        return h;
      }
      if (h.stack[h.index] === tab) return h;
      const stack = [...h.stack.slice(0, h.index + 1), tab];
      return { stack, index: stack.length - 1 };
    });
  }, [group.active]);

  const go = useCallback(
    (delta: -1 | 1) => {
      const next = history.stack[history.index + delta];
      if (!next) return;
      const ref = parseTab(next);
      if (ref?.kind !== "file") return;
      target.current = next;
      // `stack[index]` moves before the tab shows, so a quick second press keeps walking.
      setHistory((h) => ({ ...h, index: h.index + delta }));
      if (!group.tabs.includes(next)) code.restore(ref.key);
      ws.openIn(next, group.id);
    },
    [history, group.tabs, group.id, code, ws],
  );

  const value = useMemo<GroupValue>(
    () => ({
      groupId: group.id,
      canBack: history.index > 0,
      canForward: history.index >= 0 && history.index < history.stack.length - 1,
      back: () => go(-1),
      forward: () => go(1),
    }),
    [group.id, history, go],
  );
  return <GroupContextProvider value={value}>{children}</GroupContextProvider>;
}
