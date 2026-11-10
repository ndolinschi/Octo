import type { ProjectSummary } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { Glyph } from "../primitives/Glyph";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { hrefFor, navigate } from "../../lib/route";
import { useNav, useNavState } from "../../state/nav";
import { useRequests, type Request } from "../../state/requests";
import { useDelayedLoading } from "../../lib/hooks";
import { RunningDot } from "../primitives/Status";

/** Requests shown before "Show all". */
const PREVIEW = 5;

/** Request rows: an empty 16px leading slot, so their text starts on the project name's line (8 + 16 + 8). */
const INSET = "pl-8";
/** The same inset for rows with a fill: 8px padding on both sides plus a 24px leading spacer (balanced insets). */
const Lead = () => <span aria-hidden className="w-6 shrink-0" />;

export function ProjectItem(props: {
  project: ProjectSummary;
  active: boolean;
  activeAgentId: string | null;
  unseen: boolean;
  expanded: boolean;
  onExpanded(value: boolean): void;
  now: number;
}) {
  const { project, active, expanded } = props;
  const { requests, error, retry } = useRequests(project, expanded);
  const { viewTurn } = useNavState();
  const listId = useId();
  const running = project.status === "running";
  // On the orchestrator view the request in view carries the selection; otherwise the project does.
  const viewing = active && !props.activeAgentId && expanded && viewTurn?.projectId === project.id ? viewTurn.messageId : null;
  const viewingShown = viewing !== null && requests?.some((r) => r.id === viewing);

  return (
    <li>
      {/* One row shape (radius 4 on all corners); the chevron's 24px target is centred on the 16px leading slot. */}
      <div className={cn("flex h-row-nav items-center rounded-sm pr-2 pl-1 press-row", active && !viewingShown ? "bg-active" : "hover:bg-hover")}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={`Show requests in ${project.name}`}
          title={`Show requests in ${project.name}`}
          onClick={() => props.onExpanded(!expanded)}
          className="grid size-6 shrink-0 place-items-center rounded-sm text-fg-3 focus-inset transition-[color] duration-100 hover:text-fg"
        >
          <Glyph icon={ChevronRight} size={14} className={cn("transition-[rotate] duration-150", expanded && "rotate-90")} />
        </button>
        <a
          href={hrefFor(project.id)}
          aria-current={active ? "page" : undefined}
          title={project.name}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm pl-1 text-sm text-fg focus-inset"
        >
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <ProjectState project={project} running={running} unseen={props.unseen} active={active && !viewingShown} now={props.now} />
        </a>
      </div>
      {expanded && (
        <RequestList
          id={listId}
          project={project}
          requests={requests}
          error={error}
          onRetry={retry}
          running={running}
          activeId={viewingShown ? viewing : null}
          now={props.now}
        />
      )}
    </li>
  );
}

function ProjectState(props: { project: ProjectSummary; running: boolean; unseen: boolean; active: boolean; now: number }) {
  // Running and unseen share the static accent dot; the text alternative tells them apart.
  if (props.running || props.unseen) {
    const label = props.running ? "Working" : "New activity";
    return (
      <span data-meta className="grid size-4 shrink-0 place-items-center" title={label}>
        <RunningDot />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <time dateTime={props.project.updated_at} className={cn("shrink-0 text-xs tabular-nums", props.active ? "text-fg-2" : "text-fg-3")}>
      {formatRelative(props.project.updated_at, props.now)}
    </time>
  );
}

function RequestList(props: {
  id: string;
  project: ProjectSummary;
  requests: Request[] | null;
  error: string | null;
  onRetry(): void;
  running: boolean;
  activeId: number | null;
  now: number;
}) {
  const { project, requests } = props;
  const nav = useNav();
  const [all, setAll] = useState(false);
  const muted = cn("flex h-row items-center pr-2 text-xs text-fg-3", INSET);
  const slow = useDelayedLoading(!requests && !props.error);

  if (!requests) {
    return (
      <ul id={props.id} aria-label={`Requests in ${project.name}`}>
        {props.error ? (
          <li className={cn(muted, "gap-2")} title={props.error}>
            <span className="min-w-0 flex-1 truncate">Couldn't load requests</span>
            <button
              type="button"
              onClick={props.onRetry}
              aria-label={`Retry loading requests in ${project.name}`}
              className="-mr-1 h-6 shrink-0 press rounded-sm px-1 text-xs text-fg-2 hover:bg-hover hover:text-fg"
            >
              Retry
            </button>
          </li>
        ) : (
          slow && (
            <li className={muted}>
              <span aria-label="Loading requests" className="h-2 w-2/3 rounded-full bg-hover" />
            </li>
          )
        )}
      </ul>
    );
  }
  if (!requests.length) {
    return (
      <ul id={props.id} aria-label={`Requests in ${project.name}`}>
        <li className={muted}>No requests yet</li>
      </ul>
    );
  }

  const shown = all ? requests : requests.slice(0, PREVIEW);
  const open = (r: Request) => {
    nav.requestTurn({ projectId: project.id, messageId: r.id });
    navigate(project.id);
  };

  return (
    <ul id={props.id} aria-label={`Requests in ${project.name}`} className="pb-1">
      {shown.map((r, i) => {
        const current = r.id === props.activeId;
        const live = props.running && i === 0;
        return (
          <li key={r.id}>
            <a
              href={hrefFor(project.id)}
              aria-current={current ? "location" : undefined}
              title={r.text}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                open(r);
              }}
              className={cn(
                "flex h-row items-center rounded-sm px-2 text-sm press-row focus-inset",
                current ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <Lead />
              <span className="mr-2 min-w-0 flex-1 truncate">{firstLine(r.text)}</span>
              {live ? (
                <span data-meta className="grid size-4 shrink-0 place-items-center" title="Working">
                  <RunningDot />
                  <span className="sr-only">Working</span>
                </span>
              ) : (
                <time dateTime={r.created_at} className={cn("shrink-0 text-xs tabular-nums", current ? "text-fg-2" : "text-fg-3")}>
                  {formatRelative(r.created_at, props.now)}
                </time>
              )}
            </a>
          </li>
        );
      })}
      {requests.length > PREVIEW && (
        <li>
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((a) => !a)}
            className="flex h-row w-full items-center rounded-sm px-2 text-xs text-fg-3 press-row hover:bg-hover hover:text-fg-2"
          >
            <Lead />
            {all ? "Show fewer" : `Show all (${requests.length})`}
          </button>
        </li>
      )}
    </ul>
  );
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0];
}
