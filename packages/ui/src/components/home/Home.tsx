import type { Agent, UsageReport } from "@octo/agent-client";
import { CalendarDays, ChartLine, Gauge, History, Plus, type LucideIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { formatRelative, formatTokens } from "../../lib/format";
import { useNow } from "../../lib/hooks";
import { navigate } from "../../lib/route";
import { useApp } from "../../state/app";
import { useNav } from "../../state/nav";
import { Glyph } from "../primitives/Glyph";
import { INFO_ROW_BUTTON, SkeletonRows } from "../primitives/InfoList";
import { modelLabel } from "../primitives/Status";
import { StreakLayer } from "../primitives/StreakLayer";
import { dayStart, heatCounts, useOverview, WEEKS, type Month, type ProjectAgents, type RecentRequest } from "./useOverview";

/** The streak passes behind the title (upper third), down to the right edge. */
const HOME_STREAK = { x: 0.5, y: 0.12 } as const;
const RECENT_PROJECTS = 5;
const RECENT_REQUESTS = 5;
const MORE_REQUESTS = 15;

/**
 * Home (`#/`, contract v6 decision 22): the streak, a title, recent projects with New project, and four cards
 * computed from what the harness stores — Activity (agent runs per day, 26 weeks), Tokens (30 days, by model
 * family), Recent requests and This month. Every card shows a skeleton until its data is in and a quiet line
 * when there is none.
 */
export function Home({ onNewProject }: { onNewProject(): void }) {
  const { theme } = useApp();
  const data = useOverview();
  const now = useNow(true, 60_000);
  return (
    <section aria-labelledby="home-title" data-home className="@container/home relative h-full overflow-x-hidden overflow-y-auto">
      <StreakLayer anchor={HOME_STREAK} theme={theme} />
      {/* The block is centred in the height it has (never above its top padding), so a tall window has no
          dead band at the bottom. */}
      <div className="relative mx-auto flex min-h-full w-full max-w-home flex-col justify-center gap-6 px-6 py-10 max-sm:px-4">
        <div className="relative">
          <div aria-hidden className="octo-streak-scrim" />
          <h1 id="home-title" className="relative text-center text-display text-fg">
            What should we work on?
          </h1>
        </div>
        <RecentProjects data={data} now={now} onNewProject={onNewProject} />
        <div className="grid grid-cols-1 gap-3 @min-[900px]/home:grid-cols-2">
          <ActivityCard agents={data.agents} requests={data.requests.complete ? data.requests.all : null} now={now} />
          <TokensCard usage={data.usage} daily={data.daily} agents={data.agents} now={now} />
          <RecentRequestsCard requests={data.requests.complete || data.requests.all.length ? data.requests.all : null} now={now} />
          <MonthCard month={data.month} />
        </div>
      </div>
    </section>
  );
}

function Card(props: { icon: LucideIcon; title: string; aside?: ReactNode; children: ReactNode; label: string }) {
  return (
    <section aria-label={props.label} className="octo-card flex min-w-0 flex-col rounded-lg p-4">
      {/* Cards in a row share their height; each card's last block sits on its bottom edge (mt-auto). */}
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

/* ---------- recent projects ---------- */

function RecentProjects({ data, now, onNewProject }: { data: ReturnType<typeof useOverview>; now: number; onNewProject(): void }) {
  const { health } = useApp();
  const list = useRef<HTMLDivElement>(null);
  const projects = useMemo(() => [...(data.projects ?? [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, RECENT_PROJECTS), [data.projects]);
  const last = (id: string) => data.requests.all.find((r) => r.project.id === id);
  // ↑/↓ move between the rows (Enter opens: they are buttons).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <div ref={list} role="group" aria-label="Recent projects" onKeyDown={onKeyDown} className="octo-card flex flex-col rounded-lg p-1">
      {data.projects === null && <SkeletonRows count={3} />}
      {projects.map((p) => {
        const r = last(p.id);
        return (
          <button key={p.id} type="button" data-row onClick={() => navigate(p.id)} className={cn(INFO_ROW_BUTTON, "h-row-nav")}>
            <span className="max-w-[40%] shrink-0 truncate text-fg">{p.name}</span>
            <span className="min-w-0 flex-1 truncate text-fg-3">{r?.text ?? (data.requests.complete ? "No requests yet" : "")}</span>
            <time dateTime={p.updated_at} className="shrink-0 text-xs text-fg-3 tabular-nums">
              {formatRelative(p.updated_at, now)}
            </time>
          </button>
        );
      })}
      <button type="button" data-row onClick={onNewProject} disabled={health !== "online"} className={cn(INFO_ROW_BUTTON, "h-row-nav text-fg-2 disabled:text-fg-3")}>
        <Glyph icon={Plus} size={16} className="shrink-0 text-fg-3" />
        New project
      </button>
    </div>
  );
}

/* ---------- activity ---------- */

const TONES = ["bg-hover", "octo-heat-1", "octo-heat-2", "octo-heat-3", "octo-heat-4"] as const;

function ActivityCard({ agents, requests, now }: { agents: ProjectAgents[] | null; requests: RecentRequest[] | null; now: number }) {
  const heat = useMemo(() => (agents && requests ? heatCounts(agents, requests.map((r) => Date.parse(r.created_at)), now) : null), [agents, requests, now]);
  const max = heat ? Math.max(1, ...heat.days.map((d) => d.count)) : 1;
  const tone = (n: number) => (n === 0 ? 0 : Math.min(4, 1 + Math.floor(((n - 1) / max) * 4)));
  const first = heat?.days[0]?.at;
  const range = first ? `${new Date(first).toLocaleDateString(undefined, { month: "short" })} – ${new Date(now).toLocaleDateString(undefined, { month: "short" })}` : "";
  return (
    <Card icon={CalendarDays} title="Activity" label="Activity" aside={heat && <span className="shrink-0 text-xs text-fg-3">{range}</span>}>
      {!heat ? (
        <div aria-hidden className="aspect-[26/7] rounded-sm bg-hover" />
      ) : heat.runs === 0 && heat.requests === 0 ? (
        <Empty />
      ) : (
        <div
          role="img"
          aria-label={`${heat.runs} agent runs and ${heat.requests} requests in the last ${WEEKS} weeks`}
          className="grid grid-flow-col grid-rows-7 gap-0.5"
          style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
        >
          {heat.days.map((d) => {
            const future = d.at > dayStart(now);
            return (
              <span
                key={d.at}
                aria-hidden
                title={future ? undefined : `${new Date(d.at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${d.count} ${d.count === 1 ? "agent run" : "agent runs"}`}
                className={cn("aspect-square w-full rounded-2xs", future ? "bg-transparent" : TONES[tone(d.count)])}
              />
            );
          })}
        </div>
      )}
      {heat && (heat.runs > 0 || heat.requests > 0) && (
        <p className="mt-auto flex h-4 items-center gap-3 pt-3 text-xs text-fg-3 tabular-nums">
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

function family(model: string): string {
  if (model.startsWith("acp:")) return "External agents";
  return modelLabel(model).split(" ")[0] ?? model;
}

/** Families under 1% of the total are folded into "Other". */
const MIN_SHARE = 0.01;

function TokensCard({ usage, daily, agents, now }: { usage: UsageReport | "unavailable" | null; daily: UsageReport | null; agents: ProjectAgents[] | null; now: number }) {
  const split = useMemo(() => {
    const by = new Map<string, number>();
    let total = 0;
    if (usage && usage !== "unavailable") {
      for (const b of usage.buckets) by.set(family(b.key), (by.get(family(b.key)) ?? 0) + b.input_tokens + b.output_tokens);
      total = usage.total.input_tokens + usage.total.output_tokens;
    } else if (usage === "unavailable" && agents) {
      const from = now - 30 * 86_400_000;
      for (const a of agents.flatMap((p) => p.agents) as Agent[]) {
        if (Date.parse(a.started_at ?? a.created_at) < from) continue;
        const n = a.input_tokens + a.output_tokens;
        total += n;
        by.set(family(a.model), (by.get(family(a.model)) ?? 0) + n);
      }
    } else return null;
    const parts: [string, number][] = [];
    let other = 0;
    for (const [name, n] of [...by].sort((x, y) => y[1] - x[1])) {
      if (total > 0 && n / total < MIN_SHARE) other += n;
      else parts.push([name, n]);
    }
    if (other > 0) parts.push(["Other", other]);
    return { total, parts };
  }, [usage, agents, now]);
  // Thirty days, oldest first, one bar per day (a day without usage is an empty slot).
  const days = useMemo(() => {
    if (!daily) return null;
    const by = new Map(daily.buckets.map((b) => [b.key, b.input_tokens + b.output_tokens]));
    const out: { key: string; n: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const key = new Date(dayStart(now) - i * 86_400_000 + 12 * 3_600_000).toISOString().slice(0, 10);
      out.push({ key, n: by.get(key) ?? 0 });
    }
    return out;
  }, [daily, now]);
  const peak = days ? Math.max(1, ...days.map((d) => d.n)) : 1;
  return (
    <Card icon={Gauge} title="Tokens" label="Tokens" aside={split && <span className="shrink-0 text-xs text-fg-3">30 days</span>}>
      {!split ? (
        <SkeletonRows count={3} />
      ) : split.total === 0 ? (
        <Empty />
      ) : (
        <>
          <p className="text-figure text-fg tabular-nums">
            {formatTokens(split.total)}
            <span className="ml-2 text-sm font-normal text-fg-3">tokens</span>
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
          {days && (
            <div role="img" aria-label="Tokens per day, last 30 days" className="mt-auto flex h-8 items-end gap-0.5 pt-3">
              {days.map((d) => (
                <span
                  key={d.key}
                  aria-hidden
                  title={`${new Date(`${d.key}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}: ${formatTokens(d.n)} tokens`}
                  className={cn("min-w-0 flex-1 rounded-t-2xs", d.n ? "bg-fg-3" : "bg-line")}
                  style={{ height: d.n ? `${Math.max(8, (d.n / peak) * 100)}%` : "2px" }}
                />
              ))}
            </div>
          )}
          {usage === "unavailable" && <p className="mt-2 text-xs text-fg-3">From agents started in the last 30 days.</p>}
        </>
      )}
    </Card>
  );
}

/* ---------- recent requests ---------- */

function RecentRequestsCard({ requests, now }: { requests: RecentRequest[] | null; now: number }) {
  const nav = useNav();
  const [more, setMore] = useState(false);
  const shown = requests?.slice(0, more ? MORE_REQUESTS : RECENT_REQUESTS) ?? [];
  const rest = (requests?.length ?? 0) - shown.length;
  return (
    <Card icon={History} title="Recent requests" label="Recent requests">
      {!requests ? (
        <SkeletonRows count={RECENT_REQUESTS} />
      ) : requests.length === 0 ? (
        <Empty />
      ) : (
        <ul className="-mx-2 flex flex-col">
          {shown.map((r) => (
            <li key={`${r.project.id}/${r.id}`}>
              <button
                type="button"
                title={r.text}
                onClick={() => {
                  nav.requestTurn({ projectId: r.project.id, messageId: r.id });
                  navigate(r.project.id);
                }}
                className={INFO_ROW_BUTTON}
              >
                <span className="min-w-0 flex-1 truncate text-fg">{r.text}</span>
                <span className="max-w-[35%] shrink-0 truncate text-xs text-fg-3">{r.project.name}</span>
                <time dateTime={r.created_at} className="w-8 shrink-0 text-right text-xs text-fg-3 tabular-nums">
                  {formatRelative(r.created_at, now)}
                </time>
              </button>
            </li>
          ))}
          {(rest > 0 || more) && (
            <li>
              <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className={cn(INFO_ROW_BUTTON, "text-fg-3 hover:text-fg")}>
                {more ? "Show fewer" : `${rest} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

/* ---------- this month ---------- */

function MonthCard({ month }: { month: Month | null }) {
  const rows: [string, keyof Month["current"]][] = [
    ["Requests", "requests"],
    ["Agent runs", "runs"],
    ["Files written", "files"],
  ];
  const empty = month && Object.values(month.current).every((n) => n === 0) && Object.values(month.previous).every((n) => n === 0);
  const prevName = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).toLocaleDateString(undefined, { month: "long" });
  return (
    <Card icon={ChartLine} title="This month" label="This month" aside={month && <span className="shrink-0 text-xs text-fg-3">vs {prevName}</span>}>
      {!month ? (
        <SkeletonRows count={3} />
      ) : empty ? (
        <Empty />
      ) : (
        // Three rows that share the card's height: label, this month's figure and the change, then two 2px
        // bars (this month over last month) on one scale per row.
        <dl className="flex flex-1 flex-col justify-between gap-3">
          {rows.map(([label, key]) => {
            const cur = month.current[key];
            const prev = month.previous[key];
            const delta = cur - prev;
            const scale = Math.max(1, cur, prev);
            return (
              <div key={key} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 tabular-nums">
                  <dt className="min-w-0 flex-1 truncate text-xs text-fg-3">{label}</dt>
                  <dd className="text-figure text-fg">{cur.toLocaleString()}</dd>
                  <dd className={cn("w-12 shrink-0 text-right text-xs", delta > 0 ? "text-ok" : delta < 0 ? "text-err" : "text-fg-3")} aria-label={delta === 0 ? "same as last month" : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} from last month`}>
                    {delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString()}`}
                  </dd>
                </div>
                <div aria-hidden className="flex flex-col gap-0.5">
                  <span className="h-0.5 rounded-full bg-fg-3" style={{ width: `${(cur / scale) * 100}%` }} />
                  <span className="h-0.5 rounded-full bg-line-strong" style={{ width: `${(prev / scale) * 100}%` }} />
                </div>
              </div>
            );
          })}
        </dl>
      )}
    </Card>
  );
}
