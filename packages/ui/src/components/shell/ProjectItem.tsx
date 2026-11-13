import type { ProjectSummary } from "@octo/agent-client";
import type { ReactNode } from "react";
import { useReadable } from "../../lib/errors/useReadable";
import { projectRowLines, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { ListRow } from "../primitives/ListRow";
import { OrchestratorGlyph } from "../primitives/Status";

/**
 * A project row (decision 23: the sidebar lists projects, each one an orchestrator at work). Polish trial T2: an idle project
 * is one 32px line — a small quiet dot, the name, the time since its last turn as meta; the second line ("Working, 3 agents",
 * "Failed", "No requests yet") appears only when it says something, and the row is 40px then. Decision 91k: the words are
 * never toned; the state glyph in the leading slot carries the tone (the idle dot is not a ring, so it never reads as a radio
 * button). Requests are not listed here: they live in the conversation's turn rail and in the palette.
 */
export function ProjectItem(props: {
  project: ProjectSummary;
  active: boolean;
  unseen: boolean;
  state: OrchestratorState;
  now: number;
  onPick(): void;
  /** Mounted under the row (the app passes the expandable sessions of the project). */ extra?: ReactNode;
}) {
  const { project, active, state } = props;
  const error = useReadable(state.kind === "needs" ? state.error : null);
  const lines = projectRowLines(state, props.now, project.updated_at);
  const unseen = props.unseen && !active;
  const quietIdle = state.kind === "idle" && !unseen;
  return (
    <li data-project-row className="group/p relative">
      <ListRow
        href={hrefFor(project.id)}
        selected={active}
        tip={error ? `${project.name}: ${error}` : project.name}
        onClick={props.onPick}
        size="md"
        leading={quietIdle ? <span className="size-1.5 rounded-full bg-fg-3 opacity-60" /> : <OrchestratorGlyph state={state.kind} unseen={unseen} />}
        title={project.name}
        {...(lines.description === null ? {} : { description: <span data-meta>{lines.description}</span> })}
        {...(lines.meta === null
          ? {}
          : {
              meta: (
                <span data-meta data-project-meta className="tabular-nums">
                  <span className="sr-only">Idle, </span>
                  {lines.meta}
                </span>
              ),
            })}
      />
      {props.extra}
    </li>
  );
}
