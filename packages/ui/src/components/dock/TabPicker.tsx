import type { Agent } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
import { FileSearch, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useMemo, type RefObject } from "react";
import { MOD_LABEL } from "../../lib/keys";
import { filterSections, type PickerRow, type PickerSection } from "../../lib/picker";
import { agentGlyph } from "../../lib/stateGlyph";
import { useCode } from "../../state/code";
import { useHost } from "../../state/host";
import { useProject } from "../../state/project";
import { allTabs, toolTab, type ToolTab } from "../../state/workspace/layout";
import { useWorkspace } from "../../state/workspace/WorkspaceProvider";
import { fileIcon } from "../primitives/fileIcons";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { Picker } from "../primitives/Picker";
import { StateGlyph } from "../primitives/StateGlyph";
import { useShowFiles } from "../files/useShowFiles";
import { TOOL_TABS } from "./tabInfo";

const AGENTS_SHOWN = 6;
const FILES_SHOWN = 6;

/**
 * The "+" at the end of a strip (and `Ctrl/Cmd+T`, decision 25): one searchable list — the tools (Agents, Notes, Files,
 * Details, Usage, Side question), "Open file…" and, once something is typed, matching project files; running and recent
 * agents; the project's settings and "Open in editor". This replaces the tool buttons the strip used to carry
 * (decision 24: the strip carries tabs only).
 */
export function TabPicker({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const ws = useWorkspace();
  const code = useCode();
  const files = useShowFiles();
  const { state, project } = useProject();
  const { openProjectInEditor } = useHost();
  const { indexFiles } = code;
  useEffect(() => indexFiles(), [indexFiles]);
  const open = new Set(allTabs(ws.layout));

  const agents = useMemo(() => {
    const list = state.agentOrder.flatMap((id) => {
      const a = state.agents[id];
      return a && a.parent_id !== null ? [a] : [];
    });
    const rank = (a: Agent) => (a.status === "running" ? 1 : 0);
    return list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at)).slice(0, AGENTS_SHOWN);
  }, [state.agentOrder, state.agents]);

  const sections = (query: string): PickerSection[] => {
    const tools: PickerRow[] = (Object.entries(TOOL_TABS) as [ToolTab, (typeof TOOL_TABS)[string]][]).map(([tool, t]) => ({
      id: `tool:${tool}`,
      label: t.label,
      lead: <Glyph icon={t.icon} size={14} />,
      ...(open.has(toolTab(tool)) ? { detail: "open" } : {}),
      ...(tool === "side" ? { hint: `${MOD_LABEL};` } : {}),
      title: t.title,
      run: () => (tool === "files" ? files.show() : ws.openTool(tool)),
    }));
    tools.push({ id: "open-file", label: "Open file…", lead: <Glyph icon={FileSearch} size={14} />, title: "Filter the project's files", run: files.show });
    const q = query.trim().toLowerCase();
    const fileRows: PickerRow[] = q
      ? code.loadedFiles
          .filter((f) => `${f.folder}/${f.path}`.toLowerCase().includes(q))
          .sort((a, b) => a.path.length - b.path.length)
          .slice(0, FILES_SHOWN)
          .map((f) => ({
            id: `file:${f.folder}/${f.path}`,
            label: f.path.slice(f.path.lastIndexOf("/") + 1),
            detail: `${f.folder}/${f.path.slice(0, Math.max(0, f.path.lastIndexOf("/")))}`.replace(/\/$/, ""),
            lead: <Glyph icon={fileIcon(f.path)} size={14} />,
            title: `${f.folder}/${f.path}`,
            run: () => code.openFile(f.folder, f.path),
          }))
      : [];
    const agentRows: PickerRow[] = agents.map((a) => ({
      id: `agent:${a.id}`,
      label: roleText(a.role),
      detail: a.title,
      lead: <StateGlyph state={agentGlyph(a.status)} />,
      title: a.title ? `${a.role}: ${a.title}` : a.role,
      run: () => ws.openAgent(a.id),
    }));
    const projectRows: PickerRow[] = [
      { id: "settings", label: "Project settings", lead: <Glyph icon={GLYPH.settings} size={14} />, run: ws.openSettings },
      ...(openProjectInEditor && project && project.folders.length > 0
        ? [{ id: "editor", label: "Open in editor", lead: <Glyph icon={SquareArrowOutUpRight} size={14} />, run: () => openProjectInEditor(project.id) }]
        : []),
    ];
    // Files are matched by the query already; the other sections are filtered by it.
    const rest = filterSections(
      [
        { title: "Open", rows: tools },
        { title: "Agents", rows: agentRows },
        { title: "Project", rows: projectRows },
      ],
      query,
    );
    return fileRows.length ? [...rest.slice(0, 1), { title: "Files", rows: fileRows }, ...rest.slice(1)] : rest;
  };

  return <Picker anchor={anchor} label="Open a tab" placeholder="Open a tool, file or agent" sections={sections} onClose={onClose} align="end" />;
}
