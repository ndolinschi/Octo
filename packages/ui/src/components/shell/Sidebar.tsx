import type { ProjectSummary } from "@octo/agent-client";
import { FolderPlus, Moon, PanelLeftClose, Plus, Search, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useApp } from "../../state/app";
import { IconButton } from "../primitives/Button";
import { Spinner } from "../primitives/Status";

const SEARCH_THRESHOLD = 6;

export function Sidebar(props: { activeProjectId: string | null; onNewProject(): void; onClose?(): void }) {
  const { projects, health, theme, toggleTheme } = useApp();
  const [query, setQuery] = useState("");
  const now = useNow(true, 30_000);
  const canCreate = health === "online";

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!projects) return [];
    return q ? projects.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  return (
    <nav aria-label="Projects" className="flex h-full w-sidebar shrink-0 flex-col border-r border-line bg-bg">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
        <button
          type="button"
          onClick={props.onNewProject}
          disabled={!canCreate}
          className="flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-sm px-2 text-sm text-fg transition-[background-color] duration-100 hover:bg-hover disabled:text-fg-3 disabled:hover:bg-transparent"
        >
          <FolderPlus size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className="shrink-0 text-fg-2" />
          New project
        </button>
        {props.onClose && <IconButton icon={PanelLeftClose} label="Close sidebar" onClick={props.onClose} />}
      </div>

      {projects && projects.length > SEARCH_THRESHOLD && (
        <label className="relative mx-2 mt-0.5 block">
          <span className="sr-only">Filter projects</span>
          <Search size={14} strokeWidth={1.5} absoluteStrokeWidth className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-2" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter projects"
            className="h-8 w-full rounded-sm bg-transparent pr-2 pl-[30px] text-sm placeholder:text-fg-3 hover:bg-hover focus:bg-hover focus:outline-none"
          />
        </label>
      )}

      {projects?.length !== 0 && (
        <div className="mt-4 flex h-7 shrink-0 items-center pr-2 pl-4">
          <h2 className="text-sm text-fg-3">Projects</h2>
          <IconButton icon={Plus} label="Add project" size="sm" onClick={props.onNewProject} disabled={!canCreate} className="ml-auto" />
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projects === null &&
          health !== "offline" &&
          [0, 1, 2].map((i) => (
            <li key={i} className="flex h-8 items-center gap-2.5 px-2" aria-hidden>
              <span className="size-3 shrink-0" />
              <span className="h-2 rounded-full bg-hover" style={{ width: `${62 - i * 14}%` }} />
            </li>
          ))}
        {visible.map((p) => (
          <ProjectRow key={p.id} project={p} active={p.id === props.activeProjectId} now={now} />
        ))}
        {projects && projects.length > 0 && visible.length === 0 && <li className="px-2 py-1.5 text-sm text-fg-3">No matches</li>}
      </ul>

      <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <span className="shrink-0 text-xs text-fg-3">Octo</span>
        <ConnectionStatus />
        <IconButton
          icon={theme === "dark" ? Sun : Moon}
          label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={toggleTheme}
          className="ml-auto"
        />
      </div>
    </nav>
  );
}

function ProjectRow({ project, active, now }: { project: ProjectSummary; active: boolean; now: number }) {
  const running = project.status === "running";
  return (
    <li>
      <a
        href={hrefFor(project.id)}
        aria-current={active ? "page" : undefined}
        title={project.name}
        className={cn(
          "flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-fg transition-[background-color] duration-100",
          active ? "bg-active" : "hover:bg-hover",
        )}
      >
        <span className="grid size-3 shrink-0 place-items-center">
          {running ? <Spinner /> : <span aria-hidden className="size-[5px] rounded-full bg-line-strong" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {running && <span className="sr-only">Working</span>}
        <time dateTime={project.updated_at} className={cn("shrink-0 text-xs tabular-nums", active ? "text-fg-2" : "text-fg-3")}>
          {formatRelative(project.updated_at, now)}
        </time>
      </a>
    </li>
  );
}

/** Silent while the bridge is healthy; speaks up only when it is not. */
function ConnectionStatus() {
  const { health, bridgeUrl } = useApp();
  if (health === "online") return null;
  return (
    <p role="status" className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3" title={bridgeUrl}>
      {health === "offline" ? <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-err" /> : <Spinner size={10} />}
      <span className="truncate">{health === "offline" ? "Bridge offline" : "Connecting…"}</span>
    </p>
  );
}
