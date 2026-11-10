import { PanelRight, Settings2 } from "lucide-react";
import { forwardRef } from "react";
import { useProject } from "../../state/project";
import { IconButton } from "../primitives/Button";
import { TopBar } from "../shell/TopBar";

export type PanelTab = "agents" | "notes";

/** Project title bar. The forwarded ref is the side-panel toggle, so focus can return to it. */
export const ProjectHeader = forwardRef<
  HTMLButtonElement,
  {
    sidebarOpen: boolean;
    onToggleSidebar(): void;
    paneOpen: boolean;
    onTogglePane(): void;
    onSettings(): void;
  }
>(function ProjectHeader(props, paneToggle) {
  const { project } = useProject();
  return (
    <TopBar
      sidebarOpen={props.sidebarOpen}
      onToggleSidebar={props.onToggleSidebar}
      actions={
        project && (
          <>
            <IconButton icon={Settings2} label="Project settings" onClick={props.onSettings} />
            <IconButton
              ref={paneToggle}
              icon={PanelRight}
              label="Agents and notes panel"
              pressed={props.paneOpen}
              onClick={props.onTogglePane}
            />
          </>
        )
      }
    >
      {project && (
        <h1 className="min-w-0 truncate pl-1 text-sm font-medium" title={project.name}>
          {project.name}
        </h1>
      )}
    </TopBar>
  );
});
