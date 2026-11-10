import { useFileView } from "../../state/fileView";
import { parseTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The header's Files button: with a file view visible, it opens that view's tree column and focuses
 * its filter; otherwise it opens (or focuses) the Files tab. `shown` = a visible file view with its tree open.
 */
export function useShowFiles(): { shown: boolean; show(): void } {
  const ws = useWorkspace();
  const fv = useFileView();
  const visible = ws.layout.groups.map((g) => g.active).find((t) => {
    const ref = parseTab(t);
    return (ref?.kind === "file" || (ref?.kind === "tool" && ref.tool === "files")) && ws.isVisible(t);
  });
  return {
    shown: visible !== undefined && fv.treeOpen,
    show: () => {
      if (visible) {
        ws.activate(visible);
        fv.focusTree();
      } else {
        ws.openTool("files");
        fv.focusTree();
      }
    },
  };
}
