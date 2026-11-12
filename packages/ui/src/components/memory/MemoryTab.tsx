import { useProject } from "../../state/project";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useOptionalCode } from "../../state/code";
import { useNav } from "../../state/nav";
import { resolveFolder } from "../../lib/files";
import { toolTab } from "../../state/workspace/layout";
import { MEMORY_START } from "../../state/workspace/tabMemory";
import { useState } from "react";
import type { MemoryTab as MemoryView } from "./MemoryView";
import { MemoryPanel } from "./MemoryPanel";

/** The dock's Memory tab: the panel with what only the dock can do (open a file in the editor, jump to a request in the chat). */
export function MemoryTab() {
  const { projectId } = useProject();
  const ws = useWorkspace();
  const code = useOptionalCode();
  const nav = useNav();
  const [start] = useState<MemoryView | undefined>(() => {
    const asked = ws.memory.get(toolTab("memory"), MEMORY_START);
    if (asked) ws.memory.set(toolTab("memory"), MEMORY_START, "");
    return asked === "context" || asked === "files" || asked === "search" || asked === "tasks" ? asked : undefined;
  });
  return (
    <MemoryPanel
      {...(start ? { initialTab: start } : {})}
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
