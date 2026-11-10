import { SquareArrowOutUpRight, type LucideIcon } from "lucide-react";
import { GLYPH } from "../primitives/glyphs";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { toolTab, type ToolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { useShowFiles } from "../files/useShowFiles";

const TOOLS: { tool: ToolTab; label: string; icon: LucideIcon }[] = [
  { tool: "agents", label: "Show agents", icon: GLYPH.agents },
  { tool: "notes", label: "Show notes", icon: GLYPH.notes },
  { tool: "files", label: "Show files", icon: GLYPH.files },
  { tool: "details", label: "Show project details", icon: GLYPH.details },
];

/**
 * The project's global actions, at the trailing end of the last group's strip (the window's top-right
 * corner, its last button on the panel's right inset): open or focus Agents / Notes / the file view in
 * the side group (pressed while showing), open the folders in the editor, project settings.
 */
export function WorkspaceActions() {
  const { project } = useProject();
  const ws = useWorkspace();
  const { openProjectInEditor } = useHost();
  const files = useShowFiles();
  if (!project) return null;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      {TOOLS.map((t) =>
        t.tool === "files" ? (
          <IconButton key={t.tool} icon={t.icon} label={t.label} pressed={files.shown} onClick={files.show} />
        ) : (
          <IconButton key={t.tool} icon={t.icon} label={t.label} pressed={ws.isVisible(toolTab(t.tool))} onClick={() => ws.openTool(t.tool)} />
        ),
      )}
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
      <IconButton icon={GLYPH.settings} label="Project settings" onClick={ws.openSettings} />
    </div>
  );
}
