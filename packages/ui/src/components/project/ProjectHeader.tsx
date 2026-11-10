import { NotebookText, PanelLeft, PanelRight, Settings2 } from "lucide-react";
import { useProject } from "../../state/project";
import { IconButton } from "../primitives/Button";

export type PanelTab = "agents" | "notes";

export function ProjectHeader(props: {
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  panel: PanelTab | null;
  onPanel(tab: PanelTab): void;
  onSettings(): void;
}) {
  const { project } = useProject();
  if (!project) return <header className="h-11 shrink-0 border-b border-line" />;

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
      {!props.sidebarOpen && <IconButton icon={PanelLeft} label="Show sidebar" onClick={props.onOpenSidebar} className="-ml-1.5" />}
      <h1 className="min-w-0 truncate text-sm font-medium" title={project.description || undefined}>
        {project.name}
      </h1>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <IconButton icon={PanelRight} label="Agents panel" pressed={props.panel === "agents"} onClick={() => props.onPanel("agents")} />
        <IconButton icon={NotebookText} label="Notes" pressed={props.panel === "notes"} onClick={() => props.onPanel("notes")} />
        <IconButton icon={Settings2} label="Project settings" onClick={props.onSettings} />
      </div>
    </header>
  );
}
