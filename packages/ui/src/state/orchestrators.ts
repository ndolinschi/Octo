import type { ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { orchestratorState, type OrchestratorState } from "../lib/orchestrator";
import { useActivity, useActivityVersion } from "./activity";

/** "Not known yet": an idle state that carries `pending` until the project's agents are in (the glyph slot shows a placeholder). */
export type PendingState = Extract<OrchestratorState, { kind: "idle" }> & { pending: true };

export function isPending(s: OrchestratorState): s is PendingState {
  return s.kind === "idle" && "pending" in s;
}

/**
 * Each project's orchestrator state (decision 23) for the sidebar and Home: from the open project's live agents,
 * else the cached agent list (`listAgents`, re-read when the project's `updated_at` moves, 4 in flight). The summary's
 * waiting approvals and forms make it "needs you" whatever the agents say (A1). Until a list is in, a running summary reads
 * as working and anything else is `pending` (not a guessed "idle", which flashed a wrong glyph); a list that cannot be read
 * falls back to idle since `updated_at`.
 */
export function useOrchestrators(projects: readonly ProjectSummary[] | null): Map<string, OrchestratorState> {
  const store = useActivity();
  const version = useActivityVersion(store);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const last = lastResolved(store);
  const stamp = (projects ?? []).map((p) => `${p.id}:${p.updated_at}`).join(",");
  useEffect(() => {
    for (const p of projects ?? []) {
      // A list that cannot be read keeps the summary's state (the next refresh tries again).
      if (!store.liveAgents(p.id)) store.agentsOf(p).catch(() => setFailed((f) => (f.has(p.id) ? f : new Set(f).add(p.id))));
    }
    // `stamp` stands for `projects`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp, store]);
  return useMemo(() => {
    void version;
    const out = new Map<string, OrchestratorState>();
    for (const p of projects ?? []) {
      // The open project's live agents are newer than the polled summary: their root's status decides alone.
      const live = store.liveAgents(p.id);
      const agents = live ?? store.peekAgents(p);
      const waiting = { approvals: p.pending_approvals ?? 0, inputs: p.pending_inputs ?? 0 };
      // An approval or a form that waits decides alone (A1), before the agents are in too.
      const state: OrchestratorState = agents
        ? orchestratorState(agents, live ? "idle" : p.status, p.attention, waiting)
        : p.attention === "needs_you" || waiting.approvals + waiting.inputs > 0
          ? orchestratorState([], p.status, p.attention, waiting)
          : p.status === "running"
            ? { kind: "working", agents: [] }
            : (last.get(p.id) ?? (failed.has(p.id) ? { kind: "idle", at: p.updated_at } : pending(p.updated_at)));
      if (agents) last.set(p.id, state);
      out.set(p.id, state);
    }
    return out;
  }, [projects, store, version, failed, last]);
}

/**
 * The last resolved state of each project, per activity store (shared by the sidebar, Home and the palette): while a project's
 * agents are re-read because its `updated_at` moved, the row keeps it instead of going back to the placeholder.
 */
const resolved = new WeakMap<object, Map<string, OrchestratorState>>();
function lastResolved(store: object): Map<string, OrchestratorState> {
  let m = resolved.get(store);
  if (!m) resolved.set(store, (m = new Map<string, OrchestratorState>()));
  return m;
}

function pending(at: string): PendingState {
  return { kind: "idle", at, pending: true };
}
