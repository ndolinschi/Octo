import { useCode } from "../../state/code";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { FileTree } from "./FileTree";

/** The Files tab: the project's folder tree; files open as their own tabs. */
export function FilesTool() {
  const { folders } = useCode();
  const ws = useWorkspace();
  if (!folders.length) {
    return (
      <div className="px-4 pt-3 text-sm">
        <p className="text-fg-2">No folders attached. Add one in project settings.</p>
        <Button size="sm" className="mt-3" onClick={ws.openSettings}>
          Project settings
        </Button>
      </div>
    );
  }
  return <FileTree folders={folders} />;
}
