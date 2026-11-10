import { NotebookText, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { useEscape, useMediaQuery } from "../lib/hooks";
import { navigate } from "../lib/route";
import { readPref, writePref } from "../lib/storage";
import { useApp } from "../state/app";
import { useProject } from "../state/project";
import { AgentsPanel } from "../components/agents/AgentsPanel";
import { ConversationView } from "../components/chat/ConversationView";
import { NotesPanel } from "../components/notes/NotesPanel";
import { Button } from "../components/primitives/Button";
import { Tabs } from "../components/primitives/Tabs";
import { ProjectDialog } from "../components/project/ProjectDialog";
import { ProjectHeader, type PanelTab } from "../components/project/ProjectHeader";

/** At this width the side panel sits beside the conversation; below it, it overlays it. */
const DOCK_QUERY = "(min-width: 1100px)";

function savedTab(): PanelTab {
  return readPref("panel") === "notes" ? "notes" : "agents";
}

/** Opens by default only where it has room (docked) and the user hasn't closed it there. */
function initiallyOpen(): boolean {
  return window.matchMedia(DOCK_QUERY).matches && readPref("panel") !== "none";
}

export function ProjectWorkspace(props: {
  agentId: string | null;
  sidebarOpen: boolean;
  sidebarIsDrawer: boolean;
  onToggleSidebar(): void;
}) {
  const { bridge, refreshProjects, projects } = useApp();
  const { project, loadError, update, projectId, reload } = useProject();
  const docked = useMediaQuery(DOCK_QUERY);
  const [paneOpen, setPaneOpen] = useState(initiallyOpen);
  const [tab, setTabState] = useState<PanelTab>(savedTab);
  const [settings, setSettings] = useState(false);
  const pane = useRef<HTMLElement>(null);
  const paneToggle = useRef<HTMLButtonElement>(null);
  const overlay = paneOpen && !docked;

  const remember = (open: boolean, next: PanelTab) => {
    if (docked) writePref("panel", open ? next : "none");
  };
  const setTab = (next: PanelTab) => {
    setTabState(next);
    remember(true, next);
  };
  const closePane = () => {
    setPaneOpen(false);
    remember(false, tab);
    if (!docked) paneToggle.current?.focus();
  };
  const togglePane = () => {
    if (paneOpen) return closePane();
    setPaneOpen(true);
    remember(true, tab);
  };

  // An overlay pane takes focus when it opens; Esc or navigation closes it.
  useEffect(() => {
    if (overlay) pane.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [overlay]);
  useEscape(overlay, closePane);
  useEffect(() => {
    if (!docked) setPaneOpen(false);
  }, [docked, props.agentId]);

  const toggleSidebar = () => {
    // Never show the sidebar drawer and the pane overlay together.
    if (props.sidebarIsDrawer && !props.sidebarOpen) setPaneOpen(false);
    props.onToggleSidebar();
  };

  const header = (
    <ProjectHeader
      ref={paneToggle}
      sidebarOpen={props.sidebarOpen}
      onToggleSidebar={toggleSidebar}
      paneOpen={paneOpen}
      onTogglePane={togglePane}
      onSettings={() => setSettings(true)}
    />
  );

  if (loadError && !project) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <LoadError message={loadError} onRetry={reload} />
      </div>
    );
  }

  const agentId = props.agentId ?? project?.orchestrator_agent_id ?? null;

  const paneBody = agentId && (
    <aside
      ref={pane}
      aria-label="Agents and notes"
      className={cn(
        "flex w-pane max-w-full shrink-0 flex-col border-l border-line",
        overlay ? "absolute inset-y-0 right-0 z-20 bg-overlay shadow-pop" : "bg-bg",
      )}
    >
      <div className="flex h-10 shrink-0 items-center px-2">
        <Tabs<PanelTab>
          label="Side panel"
          idPrefix="panel"
          value={tab}
          onChange={setTab}
          options={[
            { value: "agents", label: "Agents", icon: Workflow },
            { value: "notes", label: "Notes", icon: NotebookText },
          ]}
        />
      </div>
      <div role="tabpanel" id={`panel-panel-${tab}`} aria-labelledby={`panel-tab-${tab}`} className="min-h-0 flex-1">
        {tab === "agents" ? <AgentsPanel currentAgentId={agentId} /> : <NotesPanel />}
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-w-0">
      <div className="flex min-w-0 flex-1 flex-col">
        {header}
        <div className="relative flex min-h-0 flex-1">
          <main className="min-w-0 flex-1" aria-label="Conversation">
            {agentId && <ConversationView key={agentId} agentId={agentId} />}
          </main>
          {overlay && paneBody}
        </div>
      </div>
      {paneOpen && docked && paneBody}
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

function LoadError({ message, onRetry }: { message: string; onRetry(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="alert" className="mx-auto w-full max-w-measure px-6 pt-10 text-sm max-[1000px]:px-4">
      <p className="text-fg">Couldn't load this project.</p>
      <p className="mt-1 text-fg-2">
        {message.replace(/\.$/, "")}. Check that the harness bridge is running, then retry.
      </p>
      <Button
        size="sm"
        className="mt-3"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onRetry();
          setBusy(false);
        }}
      >
        {busy ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}
