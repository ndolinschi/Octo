import { focusedGroup, CHAT, type TabId } from "./layout";
import { useWorkspace } from "./WorkspaceProvider";

/** True for the tab that hosts the floating composer: the focused group's active tab while no Chat tab is visible. */
export function useFloatingHere(tab: TabId): boolean {
  const ws = useWorkspace();
  return focusedGroup(ws.layout).active === tab && !ws.isVisible(CHAT);
}
