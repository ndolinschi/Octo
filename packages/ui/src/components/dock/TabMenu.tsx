import { closable, type TabId } from "../../state/workspace/layout";
import { MOD, useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Menu, type MenuItem } from "../primitives/Menu";

/** The context menu of a tab (decision 25; "Maximise" is decision 78). `tabs` are the tabs of the strip it opened in. */
export default function TabMenu(props: { tab: TabId; x: number; y: number; tabs: readonly TabId[]; maximised: boolean; onClose(): void }) {
  const ws = useWorkspace();
  const { tab } = props;
  const at = props.tabs.indexOf(tab);
  const items: MenuItem[] = [];
  if (!ws.narrow) {
    items.push(
      { id: "move", label: "Move to the other side", shortcut: `${MOD}\\`, disabled: !ws.canMoveToOtherSide(tab), run: () => ws.moveToOtherSide(tab) },
      { id: "split", label: "Split right", disabled: !ws.canSplitRight(tab), run: () => ws.splitRight(tab) },
      { id: "maximise", label: props.maximised ? "Restore the panel" : "Maximise", shortcut: `${MOD}Shift+Enter`, run: () => ws.toggleMaximise(tab) },
      { id: "sep", separator: true },
    );
  }
  items.push(
    { id: "close", label: "Close", shortcut: `${MOD}W`, disabled: !closable(tab), run: () => ws.requestClose([tab]) },
    { id: "others", label: "Close others", disabled: props.tabs.filter((t) => t !== tab && closable(t)).length === 0, run: () => ws.closeOthers(tab) },
    { id: "right", label: "Close tabs to the right", disabled: !props.tabs.slice(at + 1).some(closable), run: () => ws.closeRight(tab) },
    { id: "sep2", separator: true },
    { id: "reopen", label: "Reopen closed tab", shortcut: `${MOD}Shift+T`, disabled: !ws.canReopen, run: () => ws.reopenClosed() },
  );
  return <Menu label="Tab actions" x={props.x} y={props.y} items={items} onClose={props.onClose} />;
}
