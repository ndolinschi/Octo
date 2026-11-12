import type { ProjectSummary } from "@octo/agent-client";
import { Plus } from "lucide-react";
import { useMemo, useRef } from "react";
import { cn } from "../../lib/cn";
import { focusSoon, visibleComposer } from "../../lib/focus";
import { formatRelative } from "../../lib/format";
import { useRowKeys } from "../../lib/hooks";
import { readable } from "../../lib/errors/plain";
import { agentStack, stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { TRIAGE_LABEL, TRIAGE_ORDER, triageGroups, type Triage } from "../../lib/triage";
import { useApp } from "../../state/app";
import type { Reply } from "../../state/requests";
import { Card } from "../primitives/Card";
import { Glyph } from "../primitives/Glyph";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { SkeletonList } from "../primitives/Skeleton";
import { OrchestratorGlyph } from "../primitives/Status";
import { STILL } from "./still";
import type { useOverview } from "./useOverview";

/** Rows in the grouped list before "N more projects" (Home fits 1440×900 with the triage row). */
const PROJECT_ROWS = 4;

function secondLine(state: OrchestratorState, reply: Reply | null | undefined, loaded: boolean): string {
  if (state.kind === "working") return state.agents.length ? agentStack(state.agents.map((a) => a.role)) : "Thinking";
  if (state.kind === "needs") return state.error ? readable(state.error) : "The last turn failed";
  if (reply) return reply.text;
  return loaded ? "No requests yet" : "";
}

type Item = { project: ProjectSummary; state: OrchestratorState; triage: Triage };

/** The grouped project list (decision 26): needs you, working, ready to review, idle; rows are `ListRow`s on the shared scale. */
export function Projects({
  items,
  data,
  now,
  filter,
  onNewProject,
  onSearch,
}: {
  items: Item[];
  data: ReturnType<typeof useOverview>;
  now: number;
  filter: Triage | null;
  onNewProject(): void;
  onSearch(): void;
}) {
  const { health } = useApp();
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  // Grouped by state in triage order, most recent first within a group (decision 26); a tile shows its group whole.
  const groups = useMemo(() => {
    const by = triageGroups(items.map((x) => ({ project: x.project, triage: x.triage })));
    const stateOf = new Map(items.map((x) => [x.project.id, x.state]));
    const limit = filter ? Infinity : PROJECT_ROWS;
    const out: { triage: Triage; rows: { p: ProjectSummary; s: OrchestratorState }[] }[] = [];
    let used = 0;
    for (const t of TRIAGE_ORDER) {
      if (filter && t !== filter) continue;
      const rows = by[t].slice(0, Math.max(0, limit - used));
      used += rows.length;
      if (rows.length) out.push({ triage: t, rows: rows.map((p) => ({ p, s: stateOf.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const) })) });
    }
    return out;
  }, [items, filter]);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const rest = (filter ? items.filter((x) => x.triage === filter).length : items.length) - shown;
  return (
    <Card padding="sm">
      <div ref={list} role="group" aria-label="Projects" className="flex flex-col">
        {data.projects === null && <SkeletonList count={3} size="lg" twoLine />}
        {filter && shown === 0 && (
          <p className="flex h-ctl-lg items-center px-2 text-sm text-fg-3">No projects {filter === "idle" ? "are idle" : `in ${TRIAGE_LABEL[filter]}`}.</p>
        )}
        {groups.map((g) => (
          <div key={g.triage} role="group" aria-label={TRIAGE_LABEL[g.triage]} className="flex flex-col">
            <SectionHeader inset as="h2">
              {TRIAGE_LABEL[g.triage]}
            </SectionHeader>
            {g.rows.map(({ p, s }) => (
              <ProjectRow key={p.id} project={p} state={s} reply={data.replies.get(p.id)} loaded={data.replies.has(p.id)} now={now} />
            ))}
          </div>
        ))}
        <ListRow size="md" tone="quiet" leading={<Glyph icon={Plus} size={16} />} title="New project" disabled={health !== "online"} onClick={onNewProject} />
        {rest > 0 && <ListRow size="md" tone="quiet" leading={<span />} title={`${rest} more ${rest === 1 ? "project" : "projects"}`} onClick={onSearch} />}
      </div>
    </Card>
  );
}

function ProjectRow({
  project,
  state,
  reply,
  loaded,
  now,
}: {
  project: ProjectSummary;
  state: OrchestratorState;
  reply: Reply | null | undefined;
  loaded: boolean;
  now: number;
}) {
  const line = stateLine(state, now, project.updated_at);
  const second = secondLine(state, reply, loaded);
  // Decision 91k: the glyph carries the state's tone; the words stay neutral.
  const status = state.kind === "idle" ? "" : `${line}${second ? " · " : ""}`;
  return (
    <ListRow
      size="lg"
      title={project.name}
      description={`${status}${second}`}
      meta={formatRelative(project.updated_at, now)}
      // Decision 76: only a project that is working right now turns its arc; a needs-you row does not pulse.
      leading={
        <span className={cn("flex", state.kind !== "working" && STILL)}>
          <OrchestratorGlyph state={state.kind} />
        </span>
      }
      tip={`${project.name} — ${line}${second ? `\n${second}` : ""}`}
      onClick={() => {
        navigate(project.id);
        // Decision 35: the opened project's composer takes focus (the row that had it is gone with Home).
        focusSoon(visibleComposer, { timeout: 3000 });
      }}
    />
  );
}
