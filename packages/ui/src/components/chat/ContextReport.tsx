import { lazy, Suspense } from "react";
import { resolveFolder } from "../../lib/files";
import { useOptionalCode } from "../../state/code";
import { useOptionalNav } from "../../state/nav";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";

const WindowReport = lazy(() => import("../shared/WindowReport").then((m) => ({ default: m.WindowReport })));

/**
 * The context window report as a sheet (decision 93 c), with what only the chat's host can do: open a project file, a memory
 * file (the Memory tool) or a request in the chat. The context ring's "Open context details" and `/context` both mount it.
 */
export function ContextReport({ onClose }: { onClose(): void }) {
  const { projectId } = useProject();
  const ws = useOptionalWorkspace();
  const code = useOptionalCode();
  const nav = useOptionalNav();
  return (
    <Suspense fallback={null}>
      <WindowReport
        onClose={onClose}
        onOpenFile={(path) => {
          const folder = code ? resolveFolder(code.folders, undefined) : null;
          if (code && folder) code.openFile(folder, path);
          onClose();
        }}
        onOpenMemoryFile={() => {
          ws?.openTool("memory");
          onClose();
        }}
        onOpenMessage={(messageId) => {
          ws?.focusChat();
          nav?.requestTurn({ projectId, messageId });
          onClose();
        }}
      />
    </Suspense>
  );
}
