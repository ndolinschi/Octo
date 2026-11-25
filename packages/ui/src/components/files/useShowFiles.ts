import { useFileView } from "../../state/fileView";
import { parseTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The header's Files button: with a file view visible, it opens that view's tree (its column, or its tree page) and focuses
 * its filter; otherwise it opens (or focuses) the Files tab. `shown` = a visible file view with its tree open.
 */
export function useShowFiles(): { shown: boolean; show(): void } {
  const ws = useWorkspace();
  const fv = useFileView();
  const group = ws.layout.groups.find((g) => {
    const ref = parseTab(g.active);
    return (ref?.kind === "file" || (ref?.kind === "tool" && ref.tool === "files")) && ws.isVisible(g.active);
  });
  const visible = group?.active;
  return {
    shown: group !== undefined && fv.column(group.id).open,
    show: () => {
      if (group && visible) {
        ws.activate(visible);
        fv.focusTree(group.id);
      } else {
        ws.openTool("files");
        fv.focusTree();
      }
    },
  };
}
