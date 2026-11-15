import { useMemo, useRef } from "react";
import { CLOCK_SIDEBAR_MS } from "../../lib/constants";
import { useNow, useScrollFade } from "../../lib/hooks";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { SkeletonList } from "../primitives/Skeleton";
import { ProjectItem } from "./ProjectItem";

/**
 * The sidebar's "Projects" view (decision 96: a project row opens its default session; decision 23 before sessions): the
 * caption and one row per project. Its own chunk, asked for when the sidebar's module runs (the default view is the tree).
 */
export function ProjectList(props: { activeProjectId: string | null; unseen: ReadonlySet<string>; onNewProject(): void; onPick(): void }) {
  const { projects, health } = useApp();
  const now = useNow(true, CLOCK_SIDEBAR_MS);
  const list = useRef<HTMLUListElement>(null);
  useScrollFade(list, "y");
  // Stable order (newest project first by creation), so rows never jump under the pointer as
  // activity changes `updated_at`; activity shows as the dot instead.
  const ordered = useMemo(
    () => (projects ? [...projects].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || a.id.localeCompare(b.id)) : null),
    [projects],
  );
  const orchestrators = useOrchestrators(projects);
  return (
    <>
      {(projects ? projects.length > 0 : health !== "offline") && (
        // The section caption, as in the tree (`SessionTree`): on the rows' glyph column, 16px under the block above, a 20px line,
        // 4px over the first row. "New project" is the row at the top of the sidebar: no second "+" here.
        <div data-side-caption className="mt-4 mb-1 flex h-5 shrink-0 items-center pl-2">
          <h2 className="text-xs text-fg-3">Projects</h2>
        </div>
      )}
      <ul ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain fade-y">
        {projects === null && health !== "offline" && <SkeletonList count={3} size="lg" twoLine />}
        {ordered?.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            active={p.id === props.activeProjectId}
            unseen={props.unseen.has(p.id)}
            state={orchestrators.get(p.id) ?? { kind: "idle", at: p.updated_at }}
            onPick={props.onPick}
            now={now}
          />
        ))}
      </ul>
    </>
  );
}
