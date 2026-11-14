import type { GlobalSession, ProjectSummary } from "@octo/agent-client";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { focusSoon, visibleComposer } from "../../lib/focus";
import { useRowKeys } from "../../lib/hooksMore";
import { readable } from "../../lib/errors/plain";
import { projectWhen, stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { agentStack } from "../../lib/orchestratorMore";
import { navigate } from "../../lib/route";
import { TRIAGE_LABEL, TRIAGE_ORDER, triageGroups, type Triage } from "../../lib/triage";
import { useApp } from "../../state/app";
import { isPending } from "../../state/orchestrators";
import type { Reply } from "../../state/requests";
import { Card } from "../primitives/Card";
import { Button } from "../primitives/Button";
import { ListRow } from "../primitives/ListRow";
import { SectionHeader } from "../primitives/SectionHeader";
import { Skeleton, SkeletonList } from "../primitives/Skeleton";
import { OrchestratorGlyph } from "../primitives/Status";
import { StateGlyph } from "../primitives/StateGlyph";
import { sessionGlyph, sessionMeta, sessionTitle } from "../../lib/sessions/tree";
import { sessionStateWord } from "../../lib/sessions/model";
import { STILL } from "./still";
import type { useOverview } from "./useOverview";

/**
 * Rows in the grouped list before "N more projects" (Home fits 1440×900 with the triage row). B55: "Needs you" and "Working" are
 * never cut (their tiles' counts must match the rows); the limit applies to the groups after them.
 */
const PROJECT_ROWS = 4;
const NEVER_CUT: readonly Triage[] = ["needs", "working"];

function secondLine(state: OrchestratorState, reply: Reply | null | undefined, loaded: boolean): string {
  if (state.kind === "working") return state.agents.length ? agentStack(state.agents.map((a) => a.role)) : "Thinking";
  if (state.kind === "needs" && !state.waiting) return state.error ? readable(state.error) : "The last turn failed";
  if (reply) return reply.text;
  return loaded || state.kind === "new" ? "No requests yet" : "";
}

type Item = { project: ProjectSummary; state: OrchestratorState; triage: Triage };
/** Decision 96: a session in Home's needs-you, working or ready-to-review group. */
export type SessionItem = { session: GlobalSession; triage: Triage };

/** The grouped project list (decision 26): needs you, working, ready to review, idle; rows are `ListRow`s on the shared scale. */
export function Projects({
  items,
  sessions = null,
  data,
  now,
  filter,
  onNewProject,
}: {
  items: Item[];
  /** With parallel sessions: the session rows of the groups before Idle (Idle lists `items`). */
  sessions?: readonly SessionItem[] | null;
  data: ReturnType<typeof useOverview>;
  now: number;
  filter: Triage | null;
  onNewProject(): void;
}) {
  const { health } = useApp();
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  // B55: "N more projects" shows the whole list here (it opened the palette, which lists six), and "Show fewer" folds it again.
  const [all, setAll] = useState(false);
  // Grouped by state in triage order, most recent first within a group (decision 26); a tile shows its group whole.
  const groups = useMemo(() => {
    const by = triageGroups(items.map((x) => ({ project: x.project, triage: x.triage })));
    const stateOf = new Map(items.map((x) => [x.project.id, x.state]));
    const limit = filter || all ? Infinity : PROJECT_ROWS;
    const out: { triage: Triage; rows: { p: ProjectSummary; s: OrchestratorState }[]; sessions: GlobalSession[] }[] = [];
    let used = 0;
    for (const t of TRIAGE_ORDER) {
      if (filter && t !== filter) continue;
      const own = (sessions ?? []).filter((x) => x.triage === t).map((x) => x.session);
      const rows = NEVER_CUT.includes(t) ? by[t] : by[t].slice(0, Math.max(0, limit - used));
      const cutSessions = NEVER_CUT.includes(t) ? own : own.slice(0, Math.max(0, limit - used));
      used += rows.length + cutSessions.length;
      if (rows.length || cutSessions.length)
        out.push({ triage: t, sessions: cutSessions, rows: rows.map((p) => ({ p, s: stateOf.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const) })) });
    }
    return out;
  }, [items, sessions, filter, all]);
  const shown = groups.reduce((n, g) => n + g.rows.length + g.sessions.length, 0);
  const total = items.length + (sessions?.length ?? 0);
  const rest = (filter ? items.filter((x) => x.triage === filter).length + (sessions ?? []).filter((x) => x.triage === filter).length : total) - shown;
  return (
    <div className="flex flex-col gap-1">
      <Card padding="sm">
        <div ref={list} role="group" aria-label="Projects" className="flex flex-col gap-2">
          {data.projects === null && <SkeletonList count={3} size="lg" twoLine />}
          {filter && shown === 0 && (
            <p className="flex h-ctl-lg items-center px-2 text-sm text-fg-3">No projects {filter === "idle" ? "are idle" : `in ${TRIAGE_LABEL[filter]}`}.</p>
          )}
          {groups.map((g) => (
            <div key={g.triage} role="group" aria-label={TRIAGE_LABEL[g.triage]} className="flex flex-col">
              <SectionHeader inset as="h2">
                {TRIAGE_LABEL[g.triage]}
              </SectionHeader>
              {g.sessions.map((s) => (
                <SessionRow key={s.id} session={s} now={now} />
              ))}
              {g.rows.map(({ p, s }) => (
                <ProjectRow key={p.id} project={p} state={s} reply={data.replies.get(p.id)} loaded={data.replies.has(p.id)} now={now} />
              ))}
            </div>
          ))}
        </div>
      </Card>
      {/* Polish step 2 (F5): the actions are not rows of the card: a quiet line under it, the "+" on the cards' glyph column. */}
      <div className="flex items-center gap-1 px-2">
        <Button variant="quiet" size="sm" icon={Plus} disabled={health !== "online"} onClick={onNewProject}>
          New project
        </Button>
        {(rest > 0 || (all && !filter)) && (
          <Button variant="quiet" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)} className="ml-auto">
            {all ? "Show fewer" : `${rest} more ${rest === 1 ? "project" : "projects"}`}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Decision 96 (criterion 36): a session row of Home — its glyph, title, the project as meta and its state in words. */
function SessionRow({ session, now }: { session: GlobalSession; now: number }) {
  const title = sessionTitle(session);
  const state = sessionStateWord(session);
  const when = sessionMeta(session, now);
  return (
    <ListRow
      size="lg"
      title={title}
      description={`${session.project_name} · ${state}`}
      meta={when ?? undefined}
      leading={
        <span className={cn("flex -translate-y-2", session.state !== "working" && STILL)}>
          <StateGlyph state={sessionGlyph(session)} size={14} box={16} label />
        </span>
      }
      tip={`${title} — ${session.project_name}: ${state}`}
      onClick={() => {
        navigate(session.project_id, null, session.id);
        focusSoon(visibleComposer, { timeout: 3000 });
      }}
    />
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
  // B54: a project never started says "No requests yet" once (its state line and its second line were the same words).
  const status = state.kind === "idle" || state.kind === "new" ? "" : `${line}${second ? " · " : ""}`;
  return (
    <ListRow
      size="lg"
      title={project.name}
      description={`${status}${second}`}
      // B6: the sidebar's time, from the same function (since the last turn, else since the project changed).
      meta={projectWhen(state, now, project.updated_at) ?? undefined}
      // Decision 76: only a project that is working right now turns its arc; a needs-you row does not pulse. C2: the glyph sits
      // on the name's line (the 20px title line's centre is 8px above the 36px two-line block's centre).
      leading={
        <span className={cn("flex -translate-y-2", state.kind !== "working" && STILL)}>
          {isPending(state) ? <Skeleton shape="circle" className="size-3.5" /> : <OrchestratorGlyph state={state.kind} />}
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
