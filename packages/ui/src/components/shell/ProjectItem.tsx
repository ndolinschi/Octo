import type { ProjectSummary } from "@octo/agent-client";
import { cn } from "../../lib/cn";
import { stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { OrchestratorGlyph } from "../primitives/Status";

/**
 * A project row (decision 23: the sidebar lists projects, each one an orchestrator at work): 40px, two lines —
 * the name, and the orchestrator's state in `fg-3` ("Working · 3 agents", "Needs you", "Idle · 2h"). Anatomy:
 * 8 · 16 state slot (working, needs you, new activity or idle: one mark) · 8 · name / state · 8. Requests are not listed here: they live in
 * the conversation's turn rail and in the palette.
 */
export function ProjectItem(props: { project: ProjectSummary; active: boolean; unseen: boolean; state: OrchestratorState; now: number; onPick(): void }) {
  const { project, active, state } = props;
  const line = stateLine(state, props.now, project.updated_at);
  return (
    <li>
      <a
        href={hrefFor(project.id)}
        data-row
        aria-current={active ? "page" : undefined}
        title={project.name}
        onClick={props.onPick}
        className={cn("flex h-bar items-center gap-2 rounded-sm px-2 press-row focus-inset", active ? "bg-active hover:bg-active" : "hover:bg-hover")}
      >
        <OrchestratorGlyph state={state.kind} unseen={props.unseen && !active} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm text-fg">{project.name}</span>
          <span data-meta className={cn("truncate text-xs", state.kind === "needs" ? "text-warn" : active ? "text-fg-2" : "text-fg-3")}>
            {line}
          </span>
        </span>
      </a>
    </li>
  );
}
