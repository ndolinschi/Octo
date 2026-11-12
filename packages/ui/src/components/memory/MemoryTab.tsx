import { useProject } from "../../state/project";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { useOptionalCode } from "../../state/code";
import { useNav } from "../../state/nav";
import { resolveFolder } from "../../lib/files";
import { toolTab } from "../../state/workspace/layout";
import { MEMORY_START, onMemoryViewRequest } from "../../state/workspace/tabMemory";
import { useEffect, useState } from "react";
import type { MemoryTab as MemoryView } from "./MemoryView";
import { MemoryPanel } from "./MemoryPanel";

/** The dock's Memory tab: the panel with what only the dock can do (open a file in the editor, jump to a request in the chat). */
export function MemoryTab() {
  const { projectId } = useProject();
  const ws = useWorkspace();
  const code = useOptionalCode();
  const nav = useNav();
  const take = (): MemoryView | undefined => {
    const asked = ws.memory.get(toolTab("memory"), MEMORY_START);
    if (asked) ws.memory.set(toolTab("memory"), MEMORY_START, "");
    return asked === "sessions" || asked === "context" || asked === "files" || asked === "search" || asked === "tasks" ? asked : undefined;
  };
  const [start, setStart] = useState<MemoryView | undefined>(take);
  // Parity B7: "Open context details" while this tab is already mounted: the panel remounts on the asked view.
  const [nonce, setNonce] = useState(0);
  useEffect(
    () =>
      onMemoryViewRequest(() => {
        const asked = take();
        if (!asked) return;
        setStart(asked);
        setNonce((n) => n + 1);
      }),
    // `take` only reads the workspace memory, which is stable for this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [ws.memory],
  );
  return (
    <MemoryPanel
      key={nonce}
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
