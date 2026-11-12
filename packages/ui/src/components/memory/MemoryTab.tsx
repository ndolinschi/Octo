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

type Start = { view?: MemoryView; report?: boolean };

/**
 * What the one-shot `MEMORY_START` slot asks for. "context" is the context popover's "Open context details" (still written
 * by `chat/ContextPopover`): Memory no longer has a Context view (decision 93 c), so it opens the window report as a sheet
 * over Sessions. Old values ("tasks", "search") map to the nearest view.
 */
function startOf(asked: string | undefined): Start {
  if (asked === "context") return { report: true };
  if (asked === "tasks" || asked === "knowledge") return { view: "knowledge" };
  if (asked === "files") return { view: "files" };
  if (asked === "sessions") return { view: "sessions" };
  return {};
}

/** The dock's Memory tab: the panel with what only the dock can do (open a file in the editor, jump to a request in the chat, open Notes). */
export function MemoryTab() {
  const { projectId } = useProject();
  const ws = useWorkspace();
  const code = useOptionalCode();
  const nav = useNav();
  const take = (): Start => {
    const asked = ws.memory.get(toolTab("memory"), MEMORY_START);
    if (asked) ws.memory.set(toolTab("memory"), MEMORY_START, "");
    return startOf(asked);
  };
  const [start] = useState<Start>(take);
  const [reports, setReports] = useState(start.report ? 1 : 0);
  // "Open context details" while this tab is already mounted (parity B7): `requestMemoryView` writes the slot and calls here.
  const [view, setView] = useState<{ n: number; view?: MemoryView }>({ n: 0, ...(start.view ? { view: start.view } : {}) });
  useEffect(
    () =>
      onMemoryViewRequest(() => {
        const asked = take();
        if (asked.report) setReports((n) => n + 1);
        const next = asked.view;
        if (next) setView((v) => ({ n: v.n + 1, view: next }));
      }),
    // `take` only reads the workspace memory, which is stable for this tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
    [ws.memory],
  );
  return (
    <MemoryPanel
      key={view.n}
      {...(view.view ? { initialView: view.view } : {})}
      reportRequests={reports}
      onOpenFile={(path) => {
        const folder = code ? resolveFolder(code.folders, undefined) : null;
        if (code && folder) code.openFile(folder, path);
      }}
      onOpenMessage={(messageId) => {
        ws.focusChat();
        nav.requestTurn({ projectId, messageId });
      }}
      onOpenNote={() => ws.openTool("notes")}
    />
  );
}
