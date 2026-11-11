import { useProject } from "../../state/project";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useOptionalCode } from "../../state/code";
import { useNav } from "../../state/nav";
import { resolveFolder } from "../../lib/files";
import { MemoryPanel } from "./MemoryPanel";

/** The dock's Memory tab: the panel with what only the dock can do (open a file in the editor, jump to a request in the chat). */
export function MemoryTab() {
  const { projectId } = useProject();
  const ws = useWorkspace();
  const code = useOptionalCode();
  const nav = useNav();
  return (
    <MemoryPanel
      onOpenFile={(path) => {
        const folder = code ? resolveFolder(code.folders, undefined) : null;
        if (code && folder) code.openFile(folder, path);
      }}
      onOpenMessage={(messageId) => {
        ws.focusChat();
        nav.requestTurn({ projectId, messageId });
      }}
    />
  );
}
