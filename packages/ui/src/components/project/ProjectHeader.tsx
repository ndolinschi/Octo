import { totalTokens } from "@octo/agent-client";
import { Folder, NotebookText, PanelLeft, PanelRight, Settings2 } from "lucide-react";
import { formatTokens } from "../../lib/format";
import { useProject } from "../../state/project";
import { IconButton } from "../primitives/Button";
import { StatusDot } from "../primitives/Status";

export type PanelTab = "agents" | "notes";

export function ProjectHeader(props: {
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  panel: PanelTab | null;
  onPanel(tab: PanelTab): void;
  onSettings(): void;
}) {
  const { project, state } = useProject();
  if (!project) return <header className="h-12 shrink-0 border-b border-line" />;
  const tokens = totalTokens(state);
  const running = state.agentOrder.filter((id) => {
    const a = state.agents[id];
    return a?.status === "running" && a.parent_id !== null;
  }).length;
  const folders = project.folders;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line pr-2 pl-4">
      {!props.sidebarOpen && <IconButton icon={PanelLeft} label="Show sidebar" onClick={props.onOpenSidebar} className="-ml-1.5" />}
      <h1 className="min-w-0 shrink truncate text-[14px] font-semibold tracking-[-0.01em]" title={project.description || undefined}>
        {project.name}
      </h1>
      <ul aria-label="Attached folders" className="flex min-w-0 shrink items-center gap-1 overflow-hidden max-[1100px]:hidden">
        {folders.slice(0, 3).map((f) => (
          <li
            key={f.id}
            title={f.path}
            className="inline-flex h-[22px] max-w-[150px] min-w-0 items-center gap-1 rounded-sm border border-line px-1.5 text-2xs text-fg-3"
          >
            <Folder size={11} strokeWidth={1.75} aria-hidden className="shrink-0" />
            <span className="truncate">{f.label}</span>
          </li>
        ))}
        {folders.length > 3 && <li className="text-2xs text-fg-3">+{folders.length - 3}</li>}
      </ul>

      <div className="ml-auto flex shrink-0 items-center gap-3 text-xs text-fg-3 tabular-nums">
        {running > 0 && (
          <span className="flex items-center gap-1.5 text-fg-2" role="status">
            <StatusDot status="running" />
            {running} agent{running === 1 ? "" : "s"} working
          </span>
        )}
        {tokens.input + tokens.output > 0 && (
          <span title={`${tokens.input.toLocaleString()} input · ${tokens.output.toLocaleString()} output tokens`}>
            {formatTokens(tokens.input + tokens.output)} tokens
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <span aria-hidden className="mx-1 h-4 w-px bg-line" />
        <IconButton icon={PanelRight} label="Agents panel" pressed={props.panel === "agents"} onClick={() => props.onPanel("agents")} />
        <IconButton icon={NotebookText} label="Notes" pressed={props.panel === "notes"} onClick={() => props.onPanel("notes")} />
        <IconButton icon={Settings2} label="Project settings" onClick={props.onSettings} />
      </div>
    </header>
  );
}
