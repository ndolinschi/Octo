import { lazy, Suspense, useState } from "react";
import { useProject } from "../../state/project";
import { FloatRoomContext } from "../primitives/floatRoom";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { AgentsPanel } from "../agents/AgentsPanel";
import { ConversationView } from "../chat/ConversationView";
import { FloatingComposer, useFloatingHere } from "../chat/FloatingComposer";
import { FileView } from "../files/FileView";
import { NotesPanel } from "../notes/NotesPanel";

/** The Details tab loads when it is first opened (its own chunk). */
const DetailsPanel = lazy(() => import("../details/DetailsPanel").then((m) => ({ default: m.DetailsPanel })));

/** The view behind a tab. The Files tab is the file view with no file open yet. */
export function TabView({ tab }: { tab: TabId }) {
  const { project } = useProject();
  const ref = parseTab(tab);
  if (!ref || !project) return null;
  switch (ref.kind) {
    case "chat":
      return <ConversationView agentId={project.orchestrator_agent_id} tab={tab} />;
    case "agent":
      return <ConversationView agentId={ref.agentId} tab={tab} />;
    case "file":
      return <FileView tab={tab} fileKey={ref.key} />;
    case "tool":
      if (ref.tool === "files") return <FileView tab={tab} fileKey={null} />;
      return <ToolView tab={tab}>{ref.tool === "agents" ? <AgentsPanel /> : ref.tool === "notes" ? <NotesPanel /> : <Suspense fallback={null}><DetailsPanel /></Suspense>}</ToolView>;
  }
}

/**
 * Agents, Notes and Details: the floating composer sits over them too when no Chat tab is visible, and
 * their lists reserve its height + 16 at the end (`FloatRoom`, the editor's rule), so the last row can
 * always be scrolled above it.
 */
function ToolView({ tab, children }: { tab: TabId; children: React.ReactNode }) {
  const floating = useFloatingHere(tab);
  const [height, setHeight] = useState(0);
  const room = floating && height > 0 ? height + 16 : 0;
  return (
    <FloatRoomContext.Provider value={room}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {children}
        {floating && <FloatingComposer onHeight={setHeight} />}
      </div>
    </FloatRoomContext.Provider>
  );
}
