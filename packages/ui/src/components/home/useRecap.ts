import type { UsageReport } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { buildRecap, runWithin, type RecapPart } from "../../lib/recap";
import { bucketTokens } from "../../lib/usage";
import { useApp } from "../../state/app";
import { useModelNames } from "../../state/models";
import { dayStart, type useOverview } from "./useOverview";

const DAY = 86_400_000;

/**
 * Decision 26's recap from Home's data: today, or this week when today is empty; requests per project from the request
 * cache, the top model's share from `getUsage` (model groups over the period), and the time sub-agents ran (start to
 * finish, clipped to the period). `undefined` while loading, null when there is nothing to say.
 */
export function useRecap(data: ReturnType<typeof useOverview>, now: number): { parts: RecapPart[] | null; period: "today" | "week" } | undefined {
  const { bridge } = useApp();
  const { name } = useModelNames();
  const today = dayStart(now);
  const ready = data.requests.complete && data.agents !== null;
  const ranToday = (data.agents ?? []).some(({ agents }) => agents.some((a) => a.parent_id !== null && Date.parse(a.started_at ?? a.created_at) >= today));
  const period: "today" | "week" = data.requests.all.some((r) => Date.parse(r.created_at) >= today) || ranToday ? "today" : "week";
  const from = period === "today" ? today : today - 6 * DAY;
  const [usage, setUsage] = useState<{ from: number; report: UsageReport | null } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    // Without usage the model clause is simply left out.
    bridge.getUsage({ group: "model", from: new Date(from).toISOString() }).then(
      (report) => alive && setUsage({ from, report }),
      () => alive && setUsage({ from, report: null }),
    );
    return () => {
      alive = false;
    };
  }, [bridge, from, ready]);

  return useMemo(() => {
    if (!ready || usage?.from !== from) return undefined;
    const counts = new Map<string, { id: string; name: string; requests: number }>();
    for (const r of data.requests.all) {
      if (Date.parse(r.created_at) < from) continue;
      const c = counts.get(r.project.id) ?? { id: r.project.id, name: r.project.name, requests: 0 };
      c.requests += 1;
      counts.set(r.project.id, c);
    }
    const buckets = usage.report?.buckets ?? [];
    const total = buckets.reduce((n, b) => n + bucketTokens(b), 0);
    const top = [...buckets].sort((a, b) => bucketTokens(b) - bucketTokens(a))[0];
    let agentMs = 0;
    for (const { agents } of data.agents ?? [])
      for (const a of agents) {
        if (a.parent_id === null || !a.started_at) continue;
        agentMs += runWithin(Date.parse(a.started_at), a.finished_at ? Date.parse(a.finished_at) : now, from);
      }
    return {
      period,
      parts: buildRecap({
        period,
        projects: [...counts.values()],
        topModel: top && total > 0 ? { key: top.key, name: name(top.key), share: bucketTokens(top) / total } : null,
        agentMs,
      }),
    };
  }, [ready, usage, from, data.requests.all, data.agents, now, period, name]);
}
