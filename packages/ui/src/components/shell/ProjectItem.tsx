import type { ProjectSummary } from "@octo/agent-client";
import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { hrefFor, navigate } from "../../lib/route";
import { useNav, useNavState } from "../../state/nav";
import { useRequests, type Request } from "../../state/requests";
import { Spinner } from "../primitives/Status";

/** Requests shown before "Show all". */
const PREVIEW = 5;

/** Text inset shared by the project name and its request rows (chevron column + gap). */
const INSET = "pl-[30px]";

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
  const { requests, error } = useRequests(project, expanded);
  const { viewTurn } = useNavState();
  const listId = useId();
  const running = project.status === "running";
  // On the orchestrator view the request in view carries the selection; otherwise the project does.
  const viewing = active && !props.activeAgentId && expanded && viewTurn?.projectId === project.id ? viewTurn.messageId : null;
  const viewingShown = viewing !== null && requests?.some((r) => r.id === viewing);

  return (
    <li>
      <div
        className={cn(
          "flex h-8 items-center rounded-sm transition-[background-color] duration-100",
          active && !viewingShown ? "bg-active" : "hover:bg-hover",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-label={`Requests in ${project.name}`}
          title={expanded ? "Hide requests" : "Show requests"}
          onClick={() => props.onExpanded(!expanded)}
          className="ml-0.5 grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 transition-[color] duration-100 hover:text-fg focus-visible:-outline-offset-2"
        >
          <ChevronRight size={14} strokeWidth={1.5} absoluteStrokeWidth aria-hidden className={cn("transition-[rotate] duration-150", expanded && "rotate-90")} />
        </button>
        <a
          href={hrefFor(project.id)}
          aria-current={active ? "page" : undefined}
          title={project.name}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-r-sm pr-2 pl-1 text-sm text-fg focus-visible:-outline-offset-2"
        >
          <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{project.name}</span>
          <ProjectState project={project} running={running} unseen={props.unseen} active={active && !viewingShown} now={props.now} />
        </a>
      </div>
      {expanded && (
        <RequestList
          id={listId}
          project={project}
          requests={requests}
          error={error}
          running={running}
          activeId={viewingShown ? viewing : null}
          now={props.now}
        />
      )}
    </li>
  );
}

function ProjectState(props: { project: ProjectSummary; running: boolean; unseen: boolean; active: boolean; now: number }) {
  if (props.running) {
    return (
      <span className="grid size-4 shrink-0 place-items-center">
        <Spinner className="text-accent" />
        <span className="sr-only">Working</span>
      </span>
    );
  }
  if (props.unseen) {
    return (
      <span className="grid size-4 shrink-0 place-items-center" title="New activity">
        <span aria-hidden className="size-1.5 rounded-full bg-accent" />
        <span className="sr-only">New activity</span>
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
  running: boolean;
  activeId: number | null;
  now: number;
}) {
  const { project, requests } = props;
  const nav = useNav();
  const [all, setAll] = useState(false);
  const muted = cn("flex h-7 items-center pr-2 text-xs text-fg-3", INSET);

  if (!requests) {
    return (
      <ul id={props.id} aria-label={`Requests in ${project.name}`}>
        <li className={muted}>{props.error ? "Couldn't load requests" : <span aria-label="Loading requests" className="h-2 w-2/3 rounded-full bg-hover" />}</li>
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
                "flex h-7 items-center gap-2 rounded-sm pr-2 text-sm transition-[background-color] duration-100 focus-visible:-outline-offset-2",
                INSET,
                current ? "bg-active text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{firstLine(r.text)}</span>
              {live ? (
                <span className="grid size-4 shrink-0 place-items-center">
                  <Spinner size={10} className="text-accent" />
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
            className={cn("flex h-7 w-full items-center rounded-sm pr-2 text-xs text-fg-3 transition-[background-color,color] duration-100 hover:bg-hover hover:text-fg-2", INSET)}
          >
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
