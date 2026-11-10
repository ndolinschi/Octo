import { useProject } from "../../state/project";
import { parseTab, type TabId } from "../../state/workspace/layout";
import { AgentsPanel } from "../agents/AgentsPanel";
import { ConversationView } from "../chat/ConversationView";
import { FileTab } from "../files/FileTab";
import { FilesTool } from "../files/FilesTool";
import { NotesPanel } from "../notes/NotesPanel";

/** The view behind a tab. */
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
      return <FileTab fileKey={ref.key} />;
    case "tool":
      return ref.tool === "agents" ? <AgentsPanel /> : ref.tool === "notes" ? <NotesPanel /> : <FilesTool />;
  }
}
