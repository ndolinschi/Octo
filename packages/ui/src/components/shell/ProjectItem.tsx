import type { ProjectSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { OrchestratorGlyph } from "../primitives/Status";

/**
 * A project row (decision 23: the sidebar lists projects, each one an orchestrator at work): 40px, two lines —
 * the name, and the orchestrator's state in `fg-3` ("Working · 3 agents", "Needs you", "Idle · 2h"). Anatomy:
 * 8 · 16 state slot · 8 · name / state · … · unseen dot (16 slot) · 8. Requests are not listed here: they live in
 * the conversation's turn rail and in the palette.
 */
export function ProjectItem(props: { project: ProjectSummary; active: boolean; unseen: boolean; state: OrchestratorState; now: number }) {
  const { project, active, state } = props;
  const line = stateLine(state, props.now, project.updated_at);
  return (
    <li>
      <a
        href={hrefFor(project.id)}
        data-row
        aria-current={active ? "page" : undefined}
        title={project.name}
        className={cn("flex h-bar items-center gap-2 rounded-sm px-2 press-row focus-inset", active ? "bg-active hover:bg-active" : "hover:bg-hover")}
      >
        <OrchestratorGlyph state={state.kind} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg">{project.name}</span>
          <span data-meta className={cn("truncate text-xs", state.kind === "needs" ? "text-err" : active ? "text-fg-2" : "text-fg-3")}>
            {line}
          </span>
        </span>
        {props.unseen && !active && (
          <span className="grid size-4 shrink-0 place-items-center" title="New activity">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            <span className="sr-only">New activity</span>
          </span>
        )}
      </a>
    </li>
  );
}
