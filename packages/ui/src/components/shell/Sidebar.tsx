import type { ProjectSummary } from "@octo/agent-client";
import { Moon, PanelLeftClose, Plus, Search, Sun } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { hrefFor } from "../../lib/route";
import { useApp } from "../../state/app";
import { IconButton } from "../primitives/Button";
import { StatusDot } from "../primitives/Status";
import { OctoMark } from "./OctoMark";

const SEARCH_THRESHOLD = 6;

export function Sidebar(props: { activeProjectId: string | null; onNewProject(): void; onCollapse(): void }) {
  const { projects, health, theme, toggleTheme } = useApp();
  const [query, setQuery] = useState("");
  const now = useNow(true, 30_000);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!projects) return [];
    return q ? projects.filter((p) => `${p.name} ${p.description}`.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  return (
    <nav aria-label="Projects" className="flex h-full w-[248px] flex-col border-r border-line bg-sidebar">
      <div className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-4">
        <OctoMark size={20} />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">Octo</span>
        <IconButton icon={PanelLeftClose} label="Collapse sidebar" onClick={props.onCollapse} className="ml-auto" />
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={props.onNewProject}
          disabled={health !== "online"}
          className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-fg-2 transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 disabled:hover:bg-transparent"
        >
          <span className="grid size-5 place-items-center rounded-sm border border-line-strong text-fg-2 group-hover:text-fg">
            <Plus size={12} strokeWidth={2} aria-hidden />
          </span>
          New project
        </button>
      </div>

      {projects && projects.length > SEARCH_THRESHOLD && (
        <div className="px-2 pb-2">
          <label className="relative block">
            <span className="sr-only">Filter projects</span>
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter projects"
              className="h-7 w-full rounded-sm border border-line bg-transparent pr-2 pl-7 text-sm placeholder:text-fg-3 focus:border-accent focus:outline-none"
            />
          </label>
        </div>
      )}

      <div className="px-4 pt-2 pb-1 text-2xs font-medium tracking-[0.04em] text-fg-3 uppercase">Projects</div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {projects === null &&
          health !== "offline" &&
          [0, 1, 2].map((i) => (
            <li key={i} className="flex h-8 items-center px-2">
              <span className="h-2.5 rounded-full bg-hover" style={{ width: `${62 - i * 14}%` }} />
            </li>
          ))}
        {visible.map((p) => (
          <ProjectRow key={p.id} project={p} active={p.id === props.activeProjectId} now={now} />
        ))}
        {projects && projects.length > 0 && visible.length === 0 && (
          <li className="px-2 py-2 text-sm text-fg-3">No matches</li>
        )}
      </ul>

      <div className="flex h-11 shrink-0 items-center gap-1 border-t border-line pr-2 pl-4">
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
        title={project.description || project.name}
        className={cn(
          "group flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors",
          active ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {running ? (
          <span className="flex items-center gap-1.5 text-2xs text-accent">
            <StatusDot status="running" />
            <span className="sr-only">Working</span>
          </span>
        ) : (
          <time dateTime={project.updated_at} className="text-2xs text-fg-3 tabular-nums">
            {formatRelative(project.updated_at, now)}
          </time>
        )}
      </a>
    </li>
  );
}

function ConnectionStatus() {
  const { health, demo, bridgeUrl, version } = useApp();
  const label =
    health === "online" ? (demo ? "Demo data" : "Bridge connected") : health === "offline" ? "Bridge offline" : "Connecting…";
  const detail = demo ? "In-memory demo bridge" : `${bridgeUrl}${version ? ` · v${version}` : ""}`;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3" title={detail} role="status">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          health === "online" && "bg-ok",
          health === "offline" && "bg-err",
          health === "checking" && "bg-fg-3",
        )}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}
