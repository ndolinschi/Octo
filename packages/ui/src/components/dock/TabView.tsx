import { useProject } from "../../state/project";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { AgentsPanel } from "../agents/AgentsPanel";
import { ConversationView } from "../chat/ConversationView";
import { FloatingComposer, useFloatingHere } from "../chat/FloatingComposer";
import { FileView } from "../files/FileView";
import { NotesPanel } from "../notes/NotesPanel";

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
      return <ToolView tab={tab}>{ref.tool === "agents" ? <AgentsPanel /> : <NotesPanel />}</ToolView>;
  }
}

/** Agents and Notes: the floating composer sits over them too when no Chat tab is visible. */
function ToolView({ tab, children }: { tab: TabId; children: React.ReactNode }) {
  const floating = useFloatingHere(tab);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}
      {floating && <FloatingComposer />}
    </div>
  );
}
