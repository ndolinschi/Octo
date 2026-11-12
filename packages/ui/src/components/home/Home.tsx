import type { ProjectSummary } from "@octo/agent-client";
import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { TRIAGE_LABEL, TRIAGE_ORDER, triageGroups, triageOf, type Triage } from "../../lib/triage";
import type { GlyphState } from "../../lib/stateGlyph";
import { StateGlyph } from "../primitives/StateGlyph";
import { useRecap } from "./useRecap";
import { cn } from "../../lib/cn";
import { focusSoon, visibleComposer } from "../../lib/focus";
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
import { ActivityCard, TeamCard, TokensCard } from "./HomeCards";
import { useOverview } from "./useOverview";

/** Rows in the grouped list before "N more projects" (Home fits 1440×900 with the triage row and the recap). */
const PROJECT_ROWS = 4;

/**
 * Home (`#/`, decisions 22 and 23): projects and their orchestrators, not requests — the streak, a title, every
 * project's orchestrator (state, and what it is doing or last said), then Orchestrators at work (agents running
 * across projects), Activity and Tokens ("This month" folded into the recap's "Full recap", decision 26). Cards are top-aligned and the block is anchored at the top, so
 * nothing moves when a card's content changes.
 */
export function Home({
  onNewProject,
  onSearch,
  onUsage,
  unseen,
}: {
  onNewProject(): void;
  onSearch(): void;
  onUsage(projectId: string): void;
  unseen: Set<string>;
}) {
  const { theme, backdrop } = useApp();
  const data = useOverview();
  const now = useNow(true, CLOCK_MINUTE_MS);
  const latest = useMemo(() => [...(data.projects ?? [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0], [data.projects]);
  const [filter, setFilter] = useState<Triage | null>(null);
  const triaged = useMemo(
    () =>
      (data.projects ?? []).map((p) => {
        const s = data.orchestrators.get(p.id) ?? ({ kind: "idle", at: p.updated_at } as const);
        return { project: p, state: s, triage: triageOf(s, unseen.has(p.id)) };
      }),
    [data.projects, data.orchestrators, unseen],
  );
  const recap = useRecap(data, now);
  const count = data.projects?.length ?? 0;
  return (
    // Decision 50: the streak is fixed to the panel (outside the scroller); only the content scrolls, never rubber-bands.
    <section aria-labelledby="home-title" data-home className="@container/home relative h-full overflow-hidden">
      {backdrop !== "off" && <StreakLayer preset={STREAK_HOME} theme={theme} mono={backdrop === "mono"} />}
      <div data-home-scroll data-start-scroll className="relative h-full overflow-x-hidden overflow-y-auto overscroll-none">
        <div className="relative mx-auto flex w-full max-w-home flex-col gap-4 px-6 pt-8 pb-8 max-sm:px-4">
          <div className="relative flex flex-col gap-3">
            {/* Decision 28: one sentence in two tones — the lead-in muted, the statement in fg. */}
            <h1 id="home-title" className="relative text-center text-display text-fg">
              {count > 0 && <span className="octo-lead">{count === 1 ? "One project. " : `${count} projects. `}</span>}
              What should we work on?
            </h1>
            <TriageRow items={triaged} loading={data.projects === null} value={filter} onChange={setFilter} />
            <Recap recap={recap} onUsage={latest ? () => onUsage(latest.id) : null} />
          </div>
          <Projects items={triaged} data={data} now={now} filter={filter} onNewProject={onNewProject} onSearch={onSearch} />
          {/* Two columns that stack independently (a masonry of two), paired so their heights come out close: who is
            working and this month on the left, tokens and activity on the right; no card stretches, none leaves a
            hole. One column under 900px, in reading order. */}
          <div className="grid grid-cols-1 items-start gap-3 @min-[900px]/home:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-3">
              <TeamCard projects={data.projects} agents={data.agents} />
              <ActivityCard agents={data.agents} requests={data.requests.complete ? data.requests.all : null} now={now} />
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <TokensCard usage={data.usage} daily={data.daily} now={now} onOpen={latest ? () => onUsage(latest.id) : null} />
            </div>
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

/**
 * Decision 26's triage row: four 64px tiles (two rows of two under 640px) — Needs you, Working, Ready to review, Idle —
 * each a toggle that filters the project list (one at a time; again to clear). A zero tile stays, quiet.
 */
function TriageRow(props: { items: { triage: Triage }[]; loading: boolean; value: Triage | null; onChange(t: Triage | null): void }) {
  return (
    <div role="group" aria-label="Filter projects by state" className="grid grid-cols-4 gap-2 @max-[640px]/home:grid-cols-2">
      {TRIAGE_ORDER.map((t) => {
        const n = props.items.filter((x) => x.triage === t).length;
        const on = props.value === t;
        return (
          <button
            key={t}
            type="button"
            data-triage={t}
            aria-pressed={on}
            onClick={() => props.onChange(on ? null : t)}
            className={cn(
              "octo-card flex h-16 min-w-0 press flex-col justify-center gap-1 rounded-lg px-3 text-left focus-inset",
              on ? "bg-active!" : "hover:bg-hover",
            )}
          >
            <span className="flex items-center gap-2">
              <StateGlyph state={TRIAGE_GLYPH[t]} size={14} box={16} />
              <span
                className={cn(
                  "text-figure leading-6 tabular-nums",
                  props.loading ? "text-fg-3" : n === 0 ? "text-fg-3" : t === "needs" ? "text-warn" : "text-fg",
                )}
              >
                {props.loading ? "–" : n}
              </span>
            </span>
            <span className={cn("truncate text-xs", n === 0 ? "text-fg-3" : "text-fg-2")}>{TRIAGE_LABEL[t]}</span>
          </button>
        );
      })}
    </div>
  );
}

const TRIAGE_GLYPH: Record<Triage, GlyphState> = { needs: "needs", working: "working", review: "unseen", idle: "idle" };

/** 8 + 2 × 22 + 8: two lines of recap (Home keeps its layout whether the recap has one line, two, or is loading). */
const RECAP_BOX = "octo-card block min-h-[60px] rounded-lg px-4 py-2";

/** The recap sentence (decision 26): figures in `fg`, projects and models link to their source; "Full recap" opens Usage. */
function Recap({ recap, onUsage }: { recap: ReturnType<typeof useRecap>; onUsage: (() => void) | null }) {
  // The card holds two lines from the first paint (loading, one line or two), so nothing below moves when it fills in.
  if (recap === undefined) return <div aria-hidden className={RECAP_BOX} />;
  if (!recap.parts) return null;
  return (
    <p data-recap className={cn(RECAP_BOX, "text-center text-base leading-[22px] text-pretty text-fg-2")}>
      {recap.parts.map((p, i) => {
        if (!("figure" in p)) return <span key={i}>{p.text}</span>;
        const link = p.link;
        if (!link)
          return (
            <span key={i} className="text-fg">
              {p.text}
            </span>
          );
        const go = "project" in link ? () => navigate(link.project) : onUsage;
        return go ? (
          <button key={i} type="button" onClick={go} className="rounded-2xs text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
            {p.text}
          </button>
        ) : (
          <span key={i} className="text-fg">
            {p.text}
          </span>
        );
      })}
      {onUsage && (
        <>
          {" "}
          <button type="button" onClick={onUsage} className="rounded-2xs whitespace-nowrap text-fg-3 hover:text-fg">
            Full recap ›
          </button>
        </>
      )}
    </p>
  );
}

function Projects({
  items,
  data,
  now,
  filter,
  onNewProject,
  onSearch,
}: {
  items: { project: ProjectSummary; state: OrchestratorState; triage: Triage }[];
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
    <div ref={list} role="group" aria-label="Projects" className="octo-card octo-card-dense flex flex-col rounded-lg p-1">
      {data.projects === null && <SkeletonRows count={3} />}
      {filter && shown === 0 && (
        <p className="flex h-bar items-center px-2 text-sm text-fg-3">
          No projects {TRIAGE_LABEL[filter] === "Idle" ? "are idle" : `in ${TRIAGE_LABEL[filter]}`}.
        </p>
      )}
      {groups.map((g) => (
        <div key={g.triage} role="group" aria-label={TRIAGE_LABEL[g.triage]} className="flex flex-col">
          <div className="flex h-row items-center px-2 text-xs text-fg-3">{TRIAGE_LABEL[g.triage]}</div>
          {g.rows.map(({ p, s }) => (
            <ProjectRow key={p.id} project={p} state={s} reply={data.requests.replies.get(p.id)} loaded={data.requests.replies.has(p.id)} now={now} />
          ))}
        </div>
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
      onClick={() => {
        navigate(project.id);
        // Decision 35: the opened project's composer takes focus (the row that had it is gone with Home).
        focusSoon(visibleComposer, { timeout: 3000 });
      }}
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
