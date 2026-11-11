import type { Agent, ProjectSummary, UsageReport } from "@octo/agent-client";
import { roleText } from "../../lib/orchestrator";
import { CalendarDays, ChevronRight, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { agentDuration, formatDuration, formatTokens } from "../../lib/format";
import { useNow, useRowKeys } from "../../lib/hooks";
import { runningAgents } from "../../lib/orchestrator";
import { navigate } from "../../lib/route";
import { bucketTokens, daysWithData, fillDays } from "../../lib/usage";
import { DayBars } from "../primitives/DayBars";
import { Glyph } from "../primitives/Glyph";
import { GLYPH } from "../primitives/glyphs";
import { INFO_ROW_BUTTON, SkeletonRows } from "../primitives/InfoList";
import { modelLabel, RunningDot } from "../primitives/Status";
import { dayStart, heatCounts, WEEKS, type ProjectAgents, type RecentRequest } from "./useOverview";

const TEAM_ROWS = 5;
/** Height of the Tokens card's day chart (px). */
const CHART = 32;
const GAP = 2;

export function Card(props: { icon: LucideIcon; title: string; aside?: ReactNode; children: ReactNode; label: string }) {
  return (
    <section aria-label={props.label} className="octo-card flex min-w-0 flex-col rounded-lg p-4">
      <div className="mb-3 flex h-5 items-center gap-2 text-sm text-fg-2">
        <Glyph icon={props.icon} size={14} className="shrink-0 text-fg-3" />
        <h2 className="min-w-0 flex-1 truncate">{props.title}</h2>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

function Empty({ children = "No activity yet" }: { children?: ReactNode }) {
  return <p className="flex h-row items-center text-sm text-fg-3">{children}</p>;
}

/* ---------- orchestrators at work ---------- */

/** Running sub-agents across projects (decision 23): role, what it is on, the project, how long; a click opens its tab. */
export function TeamCard({ projects, agents }: { projects: ProjectSummary[] | null; agents: ProjectAgents[] | null }) {
  const running = useMemo(() => (agents ?? []).flatMap(({ project, agents: list }) => runningAgents(list).map((a) => ({ project, agent: a }))), [agents]);
  const now = useNow(running.length > 0);
  const list = useRef<HTMLUListElement>(null);
  useRowKeys(list);
  const shown = running.slice(0, TEAM_ROWS);
  const busy = (projects ?? []).filter((p) => p.status === "running").length;
  return (
    <Card
      icon={GLYPH.agents}
      title="Orchestrators at work"
      label="Orchestrators at work"
      aside={busy > 0 && <span className="shrink-0 text-xs text-fg-3">{busy === 1 ? "1 project" : `${busy} projects`}</span>}
    >
      {!agents ? (
        <SkeletonRows count={3} />
      ) : running.length === 0 ? (
        <Empty>Nothing is running</Empty>
      ) : (
        <ul ref={list} className="-mx-2 flex flex-col">
          {shown.map(({ project, agent }) => (
            <li key={agent.id}>
              <TeamRow project={project} agent={agent} now={now} />
            </li>
          ))}
          {running.length > TEAM_ROWS && <li className="flex h-row items-center px-2 text-xs text-fg-3">+{running.length - TEAM_ROWS} more running</li>}
        </ul>
      )}
    </Card>
  );
}

function TeamRow({ project, agent, now }: { project: ProjectSummary; agent: Agent; now: number }) {
  const ms = agentDuration(agent, now);
  return (
    <button
      type="button"
      data-row
      title={`${agent.role}${agent.title ? `: ${agent.title}` : ""} — ${project.name}`}
      onClick={() => navigate(project.id, agent.id)}
      className={INFO_ROW_BUTTON}
    >
      <RunningDot box={16} />
      <span className="max-w-[35%] shrink-0 truncate text-fg">{roleText(agent.role)}</span>
      <span className="min-w-0 flex-1 truncate text-fg-3">{agent.title}</span>
      <span className="max-w-[30%] shrink-0 truncate text-xs text-fg-3">{project.name}</span>
      {ms !== null && <span className="w-12 shrink-0 text-right text-xs text-fg-2 tabular-nums">{formatDuration(ms)}</span>}
    </button>
  );
}

/* ---------- activity ---------- */

const TONES = ["octo-heat-0", "octo-heat-1", "octo-heat-2", "octo-heat-3", "octo-heat-4"] as const;

/** Integer cell sizes (measured) so the 26 × 7 grid is crisp at DPR 1. */
function useCell(columns: number): [React.RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setCell(Math.max(4, Math.floor((el.clientWidth - GAP * (columns - 1)) / columns)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [columns]);
  return [box, cell];
}

export function ActivityCard({ agents, requests, now }: { agents: ProjectAgents[] | null; requests: RecentRequest[] | null; now: number }) {
  const heat = useMemo(
    () =>
      agents && requests
        ? heatCounts(
            agents,
            requests.map((r) => Date.parse(r.created_at)),
            now,
          )
        : null,
    [agents, requests, now],
  );
  const [box, cell] = useCell(WEEKS);
  const max = heat ? Math.max(1, ...heat.days.map((d) => d.count)) : 1;
  const tone = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor(((n - 1) / max) * 4)));
  const first = heat?.days[0]?.at;
  const range = first
    ? `${new Date(first).toLocaleDateString(undefined, { month: "short" })} – ${new Date(now).toLocaleDateString(undefined, { month: "short" })}`
    : "";
  return (
    <Card icon={CalendarDays} title="Activity" label="Activity" aside={heat && <span className="shrink-0 text-xs text-fg-3">{range}</span>}>
      <div ref={box}>
        {!heat ? (
          <div aria-hidden className="aspect-[26/7] rounded-sm bg-hover" />
        ) : heat.runs === 0 && heat.requests === 0 ? (
          <Empty />
        ) : (
          <div
            role="img"
            aria-label={`${heat.runs} agent runs and ${heat.requests} requests in the last ${WEEKS} weeks`}
            className="grid grid-flow-col"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, ${cell}px)`, gridTemplateRows: `repeat(7, ${cell}px)`, gap: GAP }}
          >
            {heat.days.map((d) => {
              const future = d.at > dayStart(now);
              const date = new Date(d.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
              return (
                <span
                  key={d.at}
                  aria-hidden
                  title={
                    future
                      ? undefined
                      : `${date}: ${d.runs} ${d.runs === 1 ? "agent run" : "agent runs"}, ${d.requests} ${d.requests === 1 ? "request" : "requests"}`
                  }
                  className={cn("rounded-2xs", future ? "bg-transparent" : TONES[tone(d.count)])}
                />
              );
            })}
          </div>
        )}
      </div>
      {heat && (heat.runs > 0 || heat.requests > 0) && (
        <p className="flex h-4 items-center gap-3 pt-3 text-xs text-fg-3 tabular-nums">
          <span>
            <span className="text-fg-2">{heat.runs.toLocaleString()}</span>&nbsp;agent runs
          </span>
          <span>
            <span className="text-fg-2">{heat.requests.toLocaleString()}</span>&nbsp;requests
          </span>
        </p>
      )}
    </Card>
  );
}

/* ---------- tokens ---------- */

/** A model's family as the card groups it: "Sonnet" for Claude ids, the provider of a routed id ("deepseek/…" → "deepseek"). */
function family(model: string): string {
  if (model.startsWith("acp:")) return "External agents";
  const label = modelLabel(model);
  if (label !== model) return label.split(" ")[0] ?? model;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : (model.split(/[-.:]/)[0] ?? model);
}

/** Families under 1% of the total are folded into "Other". */
const MIN_SHARE = 0.01;

/** 30 days from `getUsage` (group model and day): the total, model families, and the day chart (≥ 2 days with data). */
export function TokensCard({
  usage,
  daily,
  now,
  onOpen,
}: {
  usage: UsageReport | "unavailable" | null;
  daily: UsageReport | null;
  now: number;
  onOpen: (() => void) | null;
}) {
  const split = useMemo(() => {
    if (!usage || usage === "unavailable") return null;
    const by = new Map<string, number>();
    for (const b of usage.buckets) by.set(family(b.key), (by.get(family(b.key)) ?? 0) + bucketTokens(b));
    const total = bucketTokens(usage.total);
    const parts: [string, number][] = [];
    let other = 0;
    for (const [name, n] of [...by].sort((x, y) => y[1] - x[1])) {
      if (total > 0 && n / total < MIN_SHARE) other += n;
      else parts.push([name, n]);
    }
    // A remainder under 1% is noise next to the families (the total still counts it).
    if (total > 0 && other / total >= MIN_SHARE) parts.push(["Other", other]);
    return { total, parts };
  }, [usage]);
  const days = useMemo(() => (daily ? fillDays(daily, 30, now) : null), [daily, now]);
  const open = onOpen && (
    <button
      type="button"
      onClick={onOpen}
      className="-mr-1 flex h-6 shrink-0 items-center gap-1 rounded-sm pr-1 pl-2 text-xs text-fg-3 press-row hover:bg-hover hover:text-fg-2"
    >
      Usage
      <Glyph icon={ChevronRight} size={14} />
    </button>
  );
  return (
    <Card icon={GLYPH.usage} title="Tokens" label="Tokens" aside={open}>
      {usage === "unavailable" ? (
        <Empty>This harness does not report usage yet.</Empty>
      ) : !split ? (
        <SkeletonRows count={3} />
      ) : split.total === 0 ? (
        <Empty />
      ) : (
        <>
          <p className="text-figure text-fg tabular-nums">
            {formatTokens(split.total)}
            <span className="ml-2 text-sm font-normal text-fg-3">tokens in 30 days</span>
          </p>
          <ul aria-label="By model family" className="mt-2 flex flex-col">
            {split.parts.map(([name, n]) => (
              <li key={name} className="flex h-row items-center gap-3 text-xs tabular-nums">
                <span className="w-24 shrink-0 truncate text-fg-2">{name}</span>
                <span aria-hidden className="h-0.5 min-w-0 flex-1 rounded-full bg-line">
                  <span className="block h-full rounded-full bg-fg-3" style={{ width: `${Math.max(1, (n / split.total) * 100)}%` }} />
                </span>
                <span className="w-10 shrink-0 text-right text-fg-3">{Math.round((n / split.total) * 100) || "<1"}%</span>
              </li>
            ))}
          </ul>
          {days && daysWithData(days) >= 2 && (
            <div className="mt-3">
              <DayBars
                label="Tokens per day, last 30 days"
                height={CHART}
                days={days.map((d) => ({
                  key: d.key,
                  value: d.total,
                  text: `${new Date(`${d.key}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}: ${d.total ? `${formatTokens(d.total)} tokens` : "no usage"}`,
                }))}
                summary={`${daysWithData(days)} of 30 days with usage`}
              />
            </div>
          )}
        </>
      )}
    </Card>
  );
}
