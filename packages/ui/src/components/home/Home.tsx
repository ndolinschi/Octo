import type { ProjectSummary } from "@octo/agent-client";
import { Plus } from "lucide-react";
import { useMemo, useRef } from "react";
import { cn } from "../../lib/cn";
import { CLOCK_MINUTE_MS } from "../../lib/constants";
import { formatRelative } from "../../lib/format";
import { useNow, useRowKeys } from "../../lib/hooks";
import { agentStack, stateLine, type OrchestratorState } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import type { Reply } from "../../state/requests";
import { Glyph } from "../primitives/Glyph";
import { SkeletonRows } from "../primitives/InfoList";
import { OrchestratorGlyph } from "../primitives/Status";
import { StreakLayer } from "../primitives/StreakLayer";
import { STREAK_HOME } from "../../lib/streakPresets";
import { ActivityCard, MonthCard, TeamCard, TokensCard } from "./HomeCards";
import { useOverview } from "./useOverview";

const PROJECT_ROWS = 5;
const ORDER: Record<OrchestratorState["kind"], number> = { working: 0, needs: 1, idle: 2, new: 3 };

/**
 * Home (`#/`, decisions 22 and 23): projects and their orchestrators, not requests — the streak, a title, every
 * project's orchestrator (state, and what it is doing or last said), then Orchestrators at work (agents running
 * across projects), Activity, Tokens and This month. Cards are top-aligned and the block is anchored at the top, so
 * nothing moves when a card's content changes.
 */
export function Home({ onNewProject, onSearch, onUsage }: { onNewProject(): void; onSearch(): void; onUsage(projectId: string): void }) {
  const { theme } = useApp();
  const data = useOverview();
  const now = useNow(true, CLOCK_MINUTE_MS);
  const latest = useMemo(() => [...(data.projects ?? [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0], [data.projects]);
  return (
    <section aria-labelledby="home-title" data-home className="@container/home relative h-full overflow-x-hidden overflow-y-auto">
      <StreakLayer preset={STREAK_HOME} theme={theme} />
      <div className="relative mx-auto flex w-full max-w-home flex-col gap-6 px-6 pt-10 pb-8 max-sm:px-4">
        <div className="relative">
          {/* The title sits on the band: a soft local scrim keeps it ≥ 4.5:1 (the band is not dimmed). */}
          <div aria-hidden className="octo-streak-scrim" />
          <h1 id="home-title" className="relative text-center text-display text-fg">
            What should we work on?
          </h1>
        </div>
        <Projects data={data} now={now} onNewProject={onNewProject} onSearch={onSearch} />
        {/* Two columns that stack independently (a masonry of two), paired so their heights come out close: who is
            working and this month on the left, tokens and activity on the right; no card stretches, none leaves a
            hole. One column under 900px, in reading order. */}
        <div className="grid grid-cols-1 items-start gap-3 @min-[900px]/home:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-3">
            <TeamCard projects={data.projects} agents={data.agents} />
            <MonthCard month={data.month} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <TokensCard usage={data.usage} daily={data.daily} now={now} onOpen={latest ? () => onUsage(latest.id) : null} />
            <ActivityCard agents={data.agents} requests={data.requests.complete ? data.requests.all : null} now={now} />
          </div>
        </div>
      </div>
    </section>
  );
}

function secondLine(state: OrchestratorState, reply: Reply | null | undefined, loaded: boolean): string {
  if (state.kind === "working") return state.agents.length ? agentStack(state.agents.map((a) => a.role)) : "Thinking";
  if (state.kind === "needs") return state.error ?? "The last turn failed";
  if (reply) return reply.text;
  return loaded ? "No requests yet" : "";
}

function Projects({ data, now, onNewProject, onSearch }: { data: ReturnType<typeof useOverview>; now: number; onNewProject(): void; onSearch(): void }) {
  const { health } = useApp();
  const list = useRef<HTMLDivElement>(null);
  useRowKeys(list);
  const rows = useMemo(() => {
    const list = (data.projects ?? []).map((p) => ({ p, s: data.orchestrators.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const) }));
    // Orchestrators that are working or need the user come first, then the most recently active.
    return list.sort((a, b) => ORDER[a.s.kind] - ORDER[b.s.kind] || Date.parse(b.p.updated_at) - Date.parse(a.p.updated_at));
  }, [data.projects, data.orchestrators]);
  const shown = rows.slice(0, PROJECT_ROWS);
  const rest = rows.length - shown.length;
  return (
    <div ref={list} role="group" aria-label="Projects and their orchestrators" className="octo-card flex flex-col rounded-lg p-1">
      {data.projects === null && <SkeletonRows count={3} />}
      {shown.map(({ p, s }) => (
        <ProjectRow key={p.id} project={p} state={s} reply={data.requests.replies.get(p.id)} loaded={data.requests.replies.has(p.id)} now={now} />
      ))}
      <div className="flex">
        <button
          type="button"
          data-row
          onClick={onNewProject}
          disabled={health !== "online"}
          className="flex h-row-nav min-w-0 flex-1 items-center gap-2 rounded-sm px-2 text-left text-sm text-fg-2 press-row focus-inset hover:bg-hover disabled:text-fg-3"
        >
          <Glyph icon={Plus} size={16} className="shrink-0 text-fg-3" />
          New project
        </button>
        {rest > 0 && (
          <button
            type="button"
            data-row
            onClick={onSearch}
            className="flex h-row-nav shrink-0 items-center rounded-sm px-2 text-xs text-fg-3 press-row focus-inset hover:bg-hover hover:text-fg-2"
          >
            {rest} more {rest === 1 ? "project" : "projects"}
          </button>
        )}
      </div>
    </div>
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
  return (
    <button
      type="button"
      data-row
      onClick={() => navigate(project.id)}
      title={`${project.name} — ${line}${second ? `\n${second}` : ""}`}
      className="flex h-bar w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left press-row focus-inset hover:bg-hover"
    >
      <OrchestratorGlyph state={state.kind} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 truncate text-sm text-fg">{project.name}</span>
          <span className={cn("shrink-0 text-xs", state.kind === "needs" ? "text-warn" : "text-fg-3")}>{state.kind === "idle" ? "Idle" : line}</span>
        </span>
        <span className="truncate text-xs text-fg-3">{second}</span>
      </span>
      <time dateTime={project.updated_at} className="shrink-0 text-xs text-fg-3 tabular-nums">
        {formatRelative(project.updated_at, now)}
      </time>
    </button>
  );
}
