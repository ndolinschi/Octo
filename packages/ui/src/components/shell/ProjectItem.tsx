import type { ProjectSummary } from "@octo/agent-client";
import type { ReactNode } from "react";
import { useReadable } from "../../lib/errors/useReadable";
import { stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { ListRow } from "../primitives/ListRow";
import { OrchestratorGlyph } from "../primitives/Status";

/**
 * A project row (decision 23: the sidebar lists projects, each one an orchestrator at work): a two-line `ListRow` — the name,
 * and the orchestrator's state in dim text ("Working · 3 agents", "Failed", "Idle · 2h"). Decision 91k: the words are never
 * toned; the state glyph in the leading slot carries the tone. Requests are not listed here: they live in the conversation's
 * turn rail and in the palette.
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
  return (
    <li className="group/p relative">
      <ListRow
        href={hrefFor(project.id)}
        selected={active}
        tip={error ? `${project.name}: ${error}` : project.name}
        onClick={props.onPick}
        leading={<OrchestratorGlyph state={state.kind} unseen={props.unseen && !active} />}
        title={project.name}
        description={<span data-meta>{stateLine(state, props.now, project.updated_at)}</span>}
      />
      {props.extra}
    </li>
  );
}
