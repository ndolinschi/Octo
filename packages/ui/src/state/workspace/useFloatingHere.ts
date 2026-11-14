import { usePhone } from "../../lib/phone";
import { createContext, useContext, useEffect } from "react";
import { focusedGroup, CHAT, type TabId } from "./layout";
import { useWorkspace } from "./WorkspaceProvider";

/** True for the tab that hosts the floating composer: the focused group's active tab while no Chat tab is visible. */
export function useFloatingHere(tab: TabId): boolean {
  const ws = useWorkspace();
  // Direction 7: a panel on the phone is a screen of its own, reached from the conversation and left with Back: no composer over it.
  const phone = usePhone();
  return !phone && focusedGroup(ws.layout).active === tab && !ws.isVisible(CHAT);
}

/** Provided by a tool tab's host (`dock/TabView`): counts the editing forms the tab shows now. */
export const FloatingBlockContext = createContext<((delta: 1 | -1) => void) | null>(null);

/**
 * An editing form (note editor, memory file editor, "Add" fact) has its own input: while it is mounted the tab shows no floating
 * composer over it (two inputs would compete). No-op outside a tool tab.
 */
export function useBlockFloating(): void {
  const count = useContext(FloatingBlockContext);
  useEffect(() => {
    if (!count) return;
    count(1);
    return () => count(-1);
  }, [count]);
}
