import type { ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo } from "react";
import { orchestratorState, type OrchestratorState } from "../lib/orchestrator";
import { useActivity, useActivityVersion } from "./activity";

/**
 * Each project's orchestrator state (decision 23) for the sidebar and Home: from the open project's live agents,
 * else the cached agent list (`listAgents`, re-read when the project's `updated_at` moves, 4 in flight). Until a
 * list is in, the project summary's own status stands in (running → working, otherwise idle since `updated_at`).
 */
export function useOrchestrators(projects: readonly ProjectSummary[] | null): Map<string, OrchestratorState> {
  const store = useActivity();
  const version = useActivityVersion(store);
  const stamp = (projects ?? []).map((p) => `${p.id}:${p.updated_at}`).join(",");
  useEffect(() => {
    for (const p of projects ?? []) {
      // A list that cannot be read keeps the summary's state (the next refresh tries again).
      if (!store.liveAgents(p.id)) store.agentsOf(p).catch(() => undefined);
    }
    // `stamp` stands for `projects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, store]);
  return useMemo(() => {
    void version;
    const out = new Map<string, OrchestratorState>();
    for (const p of projects ?? []) {
      const agents = store.liveAgents(p.id) ?? store.peekAgents(p);
      out.set(
        p.id,
        agents ? orchestratorState(agents, p.status) : p.status === "running" ? { kind: "working", agents: [] } : { kind: "idle", at: p.updated_at },
      );
    }
    return out;
  }, [projects, store, version]);
}
