import type { Agent, ProjectSummary, UsageReport } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useOrchestrators } from "../../state/orchestrators";
import { useAllRequests, type Reply, type Request } from "../../state/requests";

const DAY = 86_400_000;
/** The heat map's span (decision 22): 26 weeks, one cell per day. */
export const WEEKS = 26;

export type ProjectAgents = { project: ProjectSummary; agents: Agent[] };
export type RecentRequest = Request & { project: ProjectSummary };

/** Start of the local day / month that contains `t`. */
export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function monthStart(t: number, offset = 0): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
}

const started = (a: Agent) => Date.parse(a.started_at ?? a.created_at);
const isRun = (a: Agent) => a.parent_id !== null;

export type HeatDay = { at: number; /** runs + requests */ count: number; runs: number; requests: number };

/** Agent runs and requests per local day over the last `WEEKS` weeks (oldest first), plus the totals the caption shows. */
export function heatCounts(all: ProjectAgents[], requests: number[], now: number): { days: HeatDay[]; runs: number; requests: number } {
  const today = dayStart(now);
  // Columns are weeks ending with this one; the grid starts on the Monday WEEKS-1 weeks back.
  const weekday = (new Date(today).getDay() + 6) % 7;
  const first = today - (weekday + 7 * (WEEKS - 1)) * DAY;
  const days: HeatDay[] = Array.from({ length: WEEKS * 7 }, (_, i) => ({ at: first + i * DAY, count: 0, runs: 0, requests: 0 }));
  const cellOf = (t: number) => days[Math.floor((dayStart(t) - first) / DAY + 0.5)];
  let runs = 0;
  for (const { agents } of all)
    for (const a of agents) {
      if (!isRun(a)) continue;
      const t = started(a);
      if (t < first || t > now) continue;
      const cell = cellOf(t);
      if (cell) {
        cell.count += 1;
        cell.runs += 1;
        runs += 1;
      }
    }
  let asked = 0;
  for (const t of requests) {
    if (t < first || t > now) continue;
    const cell = cellOf(t);
    if (cell) {
      cell.count += 1;
      cell.requests += 1;
      asked += 1;
    }
  }
  return { days, runs, requests: asked };
}

/**
 * Home's data (decisions 22, 23), all from what the bridge reports: every project's agents (`listAgents`, cached
 * per `updated_at`, at most 4 in flight) and its orchestrator's state, its requests and the orchestrator's latest
 * reply (the request cache), the 30-day usage report, and the files agents wrote in this month and the last (their
 * transcripts, cached per agent). Each part is null until it is in, so each card can show its own skeleton.
 */
export function useOverview() {
  const { projects, bridge } = useApp();
  const activity = useActivity();
  const [agents, setAgents] = useState<ProjectAgents[] | null>(null);
  const [usage, setUsage] = useState<UsageReport | "unavailable" | null>(null);
  const [daily, setDaily] = useState<UsageReport | null>(null);
  const requestsByProject = useAllRequests(projects);
  const orchestrators = useOrchestrators(projects);
  const stamp = (projects ?? []).map((p) => `${p.id}:${p.updated_at}`).join(",");

  useEffect(() => {
    if (!projects) return;
    let cancelled = false;
    // A project whose agents cannot be read is left out of the cards (the next refresh tries again).
    void Promise.all(
      projects.map((p) =>
        activity.agentsOf(p).then(
          (list) => ({ project: p, agents: list }),
          () => ({ project: p, agents: [] as Agent[] }),
        ),
      ),
    ).then((all) => !cancelled && setAgents(all));
    return () => {
      cancelled = true;
    };
    // `stamp` stands for `projects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, activity]);

  useEffect(() => {
    let cancelled = false;
    // An older harness has no usage endpoint: the Tokens card falls back to the agents' own totals.
    bridge.getUsage({ group: "model" }).then(
      (r) => !cancelled && setUsage(r),
      () => !cancelled && setUsage("unavailable"),
    );
    // The per-day row of the Tokens card; without it the card simply has no chart.
    bridge.getUsage({ group: "day" }).then(
      (r) => !cancelled && setDaily(r),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, stamp]);

  const requests = useMemo(() => {
    const all: RecentRequest[] = [];
    const replies = new Map<string, Reply | null>();
    let complete = true;
    for (const p of projects ?? []) {
      const entry = requestsByProject.get(p.id);
      if (!entry) complete = false;
      else replies.set(p.id, entry.reply);
      for (const r of entry?.requests ?? []) all.push({ ...r, project: p });
    }
    return { all: all.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)), complete, replies };
  }, [projects, requestsByProject]);

  return { projects, agents, usage, daily, requests, orchestrators };
}
