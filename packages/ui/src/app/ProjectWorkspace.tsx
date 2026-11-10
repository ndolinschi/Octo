import { X } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn";
import { useMediaQuery } from "../lib/hooks";
import { navigate } from "../lib/route";
import { readPref, writePref } from "../lib/storage";
import { useApp } from "../state/app";
import { useProject } from "../state/project";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { ConversationView } from "../components/chat/ConversationView";
import { NotesPanel } from "../components/notes/NotesPanel";
import { IconButton } from "../components/primitives/Button";
import { Tabs } from "../components/primitives/Tabs";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { ProjectHeader, type PanelTab } from "../components/project/ProjectHeader";

function initialPanel(): PanelTab | null {
  const saved = readPref("panel");
  return saved === "agents" || saved === "notes" ? saved : saved === "none" ? null : "agents";
}

export function ProjectWorkspace(props: { agentId: string | null; sidebarOpen: boolean; onOpenSidebar(): void }) {
  const { bridge, refreshProjects, projects } = useApp();
  const { project, state, loadError, update, projectId } = useProject();
  const [panel, setPanelState] = useState<PanelTab | null>(initialPanel);
  const [settings, setSettings] = useState(false);
  const docked = useMediaQuery("(min-width: 1100px)");

  const setPanel = (next: PanelTab | null) => {
    setPanelState(next);
    writePref("panel", next ?? "none");
  };

  if (loadError && !project) {
    return (
      <div className="grid h-full place-items-center text-sm text-fg-2" role="alert">
        Couldn't load this project: {loadError}
      </div>
    );
  }

  const agentId = props.agentId ?? project?.orchestrator_agent_id ?? null;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ProjectHeader
        sidebarOpen={props.sidebarOpen}
        onOpenSidebar={props.onOpenSidebar}
        panel={panel}
        onPanel={(tab) => setPanel(panel === tab ? null : tab)}
        onSettings={() => setSettings(true)}
      />
      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1" aria-label="Conversation">
          {agentId && <ConversationView key={agentId} agentId={agentId} />}
        </main>
        {panel && agentId && (
          <aside
            aria-label={panel === "agents" ? "Agents" : "Notes"}
            className={cn(
              "flex w-[320px] shrink-0 flex-col border-l border-line bg-bg",
              !docked && "animate-fade-in absolute inset-y-0 right-0 z-20 bg-overlay shadow-pop",
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-3">
              <Tabs<PanelTab>
                label="Project panel"
                idPrefix="panel"
                value={panel}
                onChange={setPanel}
                options={[
                  { value: "agents", label: "Agents", count: Math.max(0, state.agentOrder.length - 1) },
                  { value: "notes", label: "Notes", count: state.notes.length },
                ]}
              />
              <IconButton icon={X} label="Close panel" size="sm" className="ml-auto" onClick={() => setPanel(null)} />
            </div>
            <div role="tabpanel" id={`panel-panel-${panel}`} aria-labelledby={`panel-tab-${panel}`} className="min-h-0 flex-1">
              {panel === "agents" ? <AgentsPanel currentAgentId={agentId} /> : <NotesPanel />}
            </div>
          </aside>
        )}
      </div>
      {settings && project && (
        <ProjectDialog
          project={project}
          onClose={() => setSettings(false)}
          onSubmit={async (input) => {
            await update(input);
            setSettings(false);
          }}
          onDelete={async () => {
            await bridge.deleteProject(projectId);
            setSettings(false);
            const next = projects?.find((p) => p.id !== projectId);
            navigate(next?.id ?? null);
            await refreshProjects();
          }}
        />
      )}
    </div>
  );
}
