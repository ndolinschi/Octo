import { FolderTree, NotebookText, Settings2, SquareArrowOutUpRight, Workflow } from "lucide-react";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import type { ToolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { TopBar } from "../shell/TopBar";

const TOOLS: { tool: ToolTab; label: string; icon: typeof Workflow }[] = [
  { tool: "agents", label: "Show agents", icon: Workflow },
  { tool: "notes", label: "Show notes", icon: NotebookText },
  { tool: "files", label: "Show files", icon: FolderTree },
];

/**
 * Header row of a project: its name, the tools (open or focus Agents / Notes / Files in the side
 * group; pressed while showing) and project settings. It never repeats the tabs themselves.
 */
export function ProjectHeader(props: { sidebarOpen: boolean; onToggleSidebar(): void; onSettings(): void }) {
  const { project } = useProject();
  const ws = useWorkspace();
  const { openProjectInEditor } = useHost();
  return (
    <TopBar
      sidebarOpen={props.sidebarOpen}
      onToggleSidebar={props.onToggleSidebar}
      actions={
        project && (
          <>
            {TOOLS.map((t) => (
              <IconButton key={t.tool} icon={t.icon} label={t.label} pressed={ws.isVisible(t.tool)} onClick={() => ws.openTool(t.tool)} />
            ))}
            <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
            {openProjectInEditor && (
              <IconButton
                icon={SquareArrowOutUpRight}
                label="Open in editor"
                title={project.folders.length ? "Open project folders in the editor" : "Add a folder to the project to open it in the editor"}
                disabled={project.folders.length === 0}
                onClick={() => openProjectInEditor(project.id)}
              />
            )}
            <IconButton icon={Settings2} label="Project settings" onClick={props.onSettings} />
          </>
        )
      }
    >
      {project && (
        <h1 className="min-w-0 truncate pl-1 text-sm font-medium text-fg" title={project.name}>
          {project.name}
        </h1>
      )}
    </TopBar>
  );
}
