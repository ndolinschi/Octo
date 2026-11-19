import type { ProjectSummary } from "@octo/agent-client";
import type { MouseEvent, ReactNode } from "react";
import { useReadable } from "../../lib/errors/useReadable";
import { projectRowLines, type OrchestratorState } from "../../lib/orchestrator";
import { hrefFor } from "../../lib/route";
import { isPending } from "../../state/orchestrators";
import { ListRow } from "../primitives/ListRow";
import { Skeleton } from "../primitives/Skeleton";
import { OrchestratorGlyph } from "../primitives/statusMore";

/**
 * A project row (decision 23: the sidebar lists projects, each one an orchestrator at work). Polish step 2 (F1): every row is
 * ONE 32px line (40 under touch) — the state glyph, the name, a right-aligned meta that says the one thing worth saying
 * (`projectRowLines`: "1h", "2 agents", "new"). The whole sentence ("Failed: GitHub Copilot is not logged in", "Working, 2
 * agents") is in the tooltip and the accessible name. Decision 91k: the words are never toned; the glyph carries the tone
 * (idle is a quiet dot, F2). An empty meta gives its room to the name; the 24px column comes back while the sessions chevron
 * shows there (`SidebarSessions`: hover, focus, open, touch), so the chevron never covers the name's ellipsis, and a row without
 * the chevron lets a short meta take only its own width (`styles.css`, cross-part leftovers b). Requests are not listed here:
 * they live in the conversation's turn rail and in the palette.
 */
export function ProjectItem(props: {
  project: ProjectSummary;
  active: boolean;
  unseen: boolean;
  state: OrchestratorState;
  now: number;
  onPick(): void;
  onMenu?(e: MouseEvent<HTMLElement>): void;
  /** Mounted under the row (the app passes the expandable sessions of the project). */ extra?: ReactNode;
}) {
  const { project, active, state } = props;
  const error = useReadable(state.kind === "needs" ? state.error : null);
  const { meta, full } = projectRowLines(state, props.now, project.updated_at);
  const unseen = props.unseen && !active;
  const sentence = `${unseen && state.kind === "idle" ? "New activity" : full}${error ? `: ${error}` : ""}`;
  return (
    <li data-project-row className="group/p relative" onContextMenu={props.onMenu}>
      <ListRow
        href={hrefFor(project.id)}
        selected={active}
        // The tooltip is the name, and for a failed turn the name and why (as before): the spacing audit finds a project row by
        // this title, so the other states' sentence is in the accessible name only (see the hand-back of polish step 2).
        tip={error ? `${project.name}: ${error}` : project.name}
        onClick={props.onPick}
        size="md"
        leading={isPending(state) ? <Skeleton shape="circle" className="size-3.5" /> : <OrchestratorGlyph state={state.kind} unseen={unseen} />}
        title={
          <>
            {project.name}
            <span className="sr-only">, {sentence}</span>
          </>
        }
        meta={
          <span aria-hidden data-meta data-project-meta className="inline-block min-w-6 text-right tabular-nums">
            {meta}
          </span>
        }
      />
      {props.extra}
    </li>
  );
}
