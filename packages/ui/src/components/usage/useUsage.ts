import type { Limit, PluginAgent, UsageReport } from "@octo/agent-client";
import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/format";
import { periodRange } from "../../lib/usage/model";
import { SESSION_STARTED_AT, type UsageView } from "../../lib/usageView";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";

/** Limits are re-read this often while the tab is mounted (the harness keeps only the latest headers). */
const LIMITS_POLL_MS = 15_000;

export type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ok"; value: T };

export type UsageData = { days: UsageReport; models: UsageReport; breakdown: UsageReport };

/**
 * The Usage tab's reports (`getUsage` by day, by model, and by agent for one project or by project for all) over the
 * chosen period, re-read when the period or scope changes and after each finished turn of the open project.
 */
export function useUsageReports(view: Pick<UsageView, "period" | "scope">): Load<UsageData> {
  const { bridge } = useApp();
  const { projectId, onEvent } = useProject();
  const [load, setLoad] = useState<Load<UsageData>>({ status: "loading" });
  const [tick, setTick] = useState(0);
  useEffect(() => onEvent((e) => e.type === "turn.finished" && setTick((t) => t + 1)), [onEvent]);
  useEffect(() => {
    let cancelled = false;
    const range = periodRange(view.period, Date.now(), SESSION_STARTED_AT);
    const scope = view.scope === "project" ? { project: projectId } : {};
    Promise.all([
      bridge.getUsage({ ...range, ...scope, group: "day" }),
      bridge.getUsage({ ...range, ...scope, group: "model" }),
      bridge.getUsage({ ...range, ...scope, group: view.scope === "project" ? "agent" : "project" }),
    ]).then(
      ([days, models, breakdown]) => !cancelled && setLoad({ status: "ok", value: { days, models, breakdown } }),
      (e: unknown) => !cancelled && setLoad({ status: "error", message: errorMessage(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId, view.period, view.scope, tick]);
  return load;
}

/**
 * Rate limits from `getLimits()` (re-read every 15 s while `shown`: the tab visible and the page not hidden — decision
 * 36) and the available ACP agents (for the plan-limits note).
 */
export function useLimits(shown: boolean): { limits: Load<Limit[]>; agents: PluginAgent[]; agentsRead: boolean } {
  const { bridge } = useApp();
  const [limits, setLimits] = useState<Load<Limit[]>>({ status: "loading" });
  const [agents, setAgents] = useState<PluginAgent[]>([]);
  const [agentsRead, setAgentsRead] = useState(false);
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    const read = () =>
      bridge.getLimits().then(
        (value) => !cancelled && setLimits({ status: "ok", value }),
        (e: unknown) => !cancelled && setLimits({ status: "error", message: errorMessage(e) }),
      );
    void read();
    const id = window.setInterval(() => void read(), LIMITS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bridge, shown]);
  useEffect(() => {
    let cancelled = false;
    // Without the plugin list the note simply names no agents.
    bridge.listPlugins().then(
      (plugins) => {
        if (cancelled) return;
        setAgents(plugins.flatMap((p) => p.agents).filter((a) => a.available));
        setAgentsRead(true);
      },
      () => !cancelled && setAgentsRead(true),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  return { limits, agents, agentsRead };
}
