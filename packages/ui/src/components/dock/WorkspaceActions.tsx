import { Ellipsis, SquareArrowOutUpRight, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { GLYPH } from "../primitives/glyphs";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { shownTool, type ToolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { IconButton } from "../primitives/Button";
import { Menu, type MenuItem } from "../primitives/Menu";
import { Presence } from "../primitives/Presence";
import { useShowFiles } from "../files/useShowFiles";

const TOOLS: { tool: ToolTab; label: string; icon: LucideIcon }[] = [
  { tool: "agents", label: "Show agents", icon: GLYPH.agents },
  { tool: "notes", label: "Show notes", icon: GLYPH.notes },
  { tool: "files", label: "Show files", icon: GLYPH.files },
  { tool: "details", label: "Show project details", icon: GLYPH.details },
  { tool: "usage", label: "Show usage", icon: GLYPH.usage },
];

/**
 * The project's global actions, at the trailing end of the last group's strip (the window's top-right
 * corner, its last button on the panel's right inset): open or focus Agents / Notes / the file view / Details /
 * Usage in the side group (pressed while showing), open the folders in the editor, project settings. In a group
 * narrower than `STRIP_TOOLS_FOLD_BELOW` they fold into one `…` menu (`folded`), so the group's tabs stay visible.
 */
export function WorkspaceActions({ folded = false }: { folded?: boolean }) {
  const { project } = useProject();
  const ws = useWorkspace();
  const { openProjectInEditor } = useHost();
  const files = useShowFiles();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  if (!project) return null;
  const editorTitle = project.folders.length ? "Open project folders in the editor" : "Add a folder to the project to open it in the editor";
  // Decision 33: one pressed tool at a time — the one the user is looking at.
  const pressed = ws.narrow ? null : shownTool(ws.layout);
  const show = (tool: ToolTab) => (tool === "files" ? files.show() : ws.openTool(tool));

  if (folded) {
    const items: MenuItem[] = [
      ...TOOLS.map((t) => ({ id: t.tool, label: t.label, run: () => show(t.tool) })),
      { id: "sep", separator: true },
      ...(openProjectInEditor
        ? [{ id: "editor", label: "Open in editor", title: editorTitle, disabled: project.folders.length === 0, run: () => openProjectInEditor(project.id) }]
        : []),
      { id: "settings", label: "Project settings", run: ws.openSettings },
    ];
    return (
      <div className="ml-auto flex shrink-0 items-center pl-1">
        <IconButton
          ref={button}
          icon={Ellipsis}
          label="Project tools"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={cn(menu && "bg-active text-fg")}
          onClick={() => {
            const r = button.current?.getBoundingClientRect();
            if (r) setMenu(menu ? null : { x: r.right, y: r.bottom + 4 });
          }}
        />
        <Presence show={menu !== null} exitMs={0}>
          {menu && <Menu label="Project tools" x={menu.x} y={menu.y} alignEnd items={items} onClose={() => setMenu(null)} />}
        </Presence>
      </div>
    );
  }

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
      {/* A hairline between the tabs and the tools: crowded icon-only tabs never read as more tool buttons. */}
      <span aria-hidden className="mr-1 h-4 w-px bg-line-strong" />
      {TOOLS.map((t) =>
        t.tool === "files" ? (
          <IconButton key={t.tool} icon={t.icon} label={t.label} pressed={pressed === "files" && files.shown} onClick={files.show} />
        ) : (
          <IconButton key={t.tool} icon={t.icon} label={t.label} pressed={pressed === t.tool} onClick={() => ws.openTool(t.tool)} />
        ),
      )}
      <span aria-hidden className="mx-1 h-4 w-px bg-line-strong" />
      {openProjectInEditor && (
        <IconButton
          icon={SquareArrowOutUpRight}
          label="Open in editor"
          title={editorTitle}
          disabled={project.folders.length === 0}
          onClick={() => openProjectInEditor(project.id)}
        />
      )}
      <IconButton icon={GLYPH.settings} label="Project settings" onClick={ws.openSettings} />
    </div>
  );
}
