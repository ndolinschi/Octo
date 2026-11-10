import { ArrowLeft, ArrowRight, FolderPlus, PanelLeftClose, Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { useHistoryAvailability } from "../../lib/history";
import { useNow } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { IconButton } from "../primitives/Button";
import { Spinner } from "../primitives/Status";
import { ProjectItem } from "./ProjectItem";

const ROW = "flex h-8 w-full items-center gap-2.5 rounded-sm px-2 text-sm text-fg transition-[background-color] duration-100 hover:bg-hover";

export function Sidebar(props: {
  activeProjectId: string | null;
  activeAgentId: string | null;
  /** Projects with activity the user has not seen (see `useUnseen`). */
  unseen: Set<string>;
  onNewProject(): void;
  onSearch(): void;
  onSettings(): void;
  onClose?(): void;
}) {
  const { projects, health } = useApp();
  const now = useNow(true, 30_000);
  const history = useHistoryAvailability();
  // The open project starts expanded; any row can be toggled.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const canCreate = health === "online";

  return (
    <nav aria-label="Projects" className="flex h-full w-sidebar shrink-0 flex-col bg-window">
      <div className="box-content flex h-10 shrink-0 items-center gap-0.5 pt-1.5 pr-2 pl-2.5">
        <IconButton icon={Search} label="Search" title="Search (Ctrl+K)" aria-keyshortcuts="Control+K Meta+K" onClick={props.onSearch} />
        <span className="flex-1" />
        <IconButton icon={ArrowLeft} label="Back" onClick={() => window.history.back()} disabled={!history.back} />
        <IconButton icon={ArrowRight} label="Forward" onClick={() => window.history.forward()} disabled={!history.forward} />
        {props.onClose && <IconButton icon={PanelLeftClose} label="Close sidebar" onClick={props.onClose} />}
      </div>

      <div className="shrink-0 px-2 pt-1">
        <button type="button" onClick={props.onNewProject} disabled={!canCreate} className={`${ROW} disabled:text-fg-3 disabled:hover:bg-transparent`}>
          <FolderPlus size={16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="shrink-0 text-fg-2" />
          New project
        </button>
      </div>

      {(projects ? projects.length > 0 : health !== "offline") && (
        <div className="mt-3 flex h-7 shrink-0 items-center pr-2 pl-4">
          <h2 className="text-sm text-fg-3">Projects</h2>
          <IconButton icon={Plus} label="Add project" size="sm" onClick={props.onNewProject} disabled={!canCreate} className="ml-auto" />
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {projects === null &&
          health !== "offline" &&
          [0, 1, 2].map((i) => (
            <li key={i} className="flex h-8 items-center gap-2.5 px-2" aria-hidden>
              <span className="size-4 shrink-0" />
              <span className="h-2 rounded-full bg-hover" style={{ width: `${62 - i * 14}%` }} />
            </li>
          ))}
        {projects?.map((p) => {
          const active = p.id === props.activeProjectId;
          return (
            <ProjectItem
              key={p.id}
              project={p}
              active={active}
              activeAgentId={active ? props.activeAgentId : null}
              unseen={props.unseen.has(p.id)}
              expanded={expanded[p.id] ?? active}
              onExpanded={(value) => setExpanded((x) => ({ ...x, [p.id]: value }))}
              now={now}
            />
          );
        })}
      </ul>

      <div className="flex shrink-0 items-center gap-1 px-2 pt-1 pb-2">
        <button type="button" onClick={props.onSettings} className={`${ROW} min-w-0 flex-1`}>
          <Settings size={16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="shrink-0 text-fg-2" />
          Settings
        </button>
        <ConnectionStatus />
      </div>
    </nav>
  );
}

/** Silent while the bridge is healthy; speaks up only when it is not. */
function ConnectionStatus() {
  const { health } = useApp();
  return (
    <span role="status" className="flex max-w-[50%] min-w-0 shrink-0 items-center gap-1.5 pr-2 text-xs text-fg-3">
      {health === "offline" && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-err" />}
      {health === "checking" && <Spinner size={10} />}
      {health !== "online" && <span className="truncate">{health === "offline" ? "Bridge offline" : "Connecting…"}</span>}
    </span>
  );
}
