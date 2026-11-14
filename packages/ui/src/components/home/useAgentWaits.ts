import type { ProjectSummary } from "@octo/agent-client";
import { useEffect, useMemo, useState } from "react";
import { agentWaiting, type AgentWait } from "../../lib/agentWaiting";
import { useLatest } from "../../lib/hooks";
import { useApp } from "../../state/app";

/**
 * NEW-3 on Home: which running agents wait for the person. The project list only counts what waits (`pending_approvals`,
 * `pending_inputs`); the approvals and forms of those projects name their agents, so they are read for those projects only,
 * again whenever a count changes.
 */
export function useAgentWaits(projects: readonly ProjectSummary[] | null): ReadonlyMap<string, AgentWait> {
  const { bridge } = useApp();
  const waiting = useMemo(() => (projects ?? []).filter((p) => (p.pending_approvals ?? 0) + (p.pending_inputs ?? 0) > 0), [projects]);
  const key = waiting.map((p) => `${p.id}:${p.pending_approvals ?? 0}:${p.pending_inputs ?? 0}`).join(",");
  // The list changes identity with every poll; `key` is what it says.
  const latest = useLatest(waiting);
  const [waits, setWaits] = useState<ReadonlyMap<string, AgentWait>>(() => new Map());
  useEffect(() => {
    if (!key || !bridge.listApprovals) return;
    let alive = true;
    const reads = latest.current.map(async (p) => {
      const [approvals, inputs] = await Promise.all([bridge.listApprovals?.(p.id) ?? [], bridge.listInputs?.(p.id) ?? []]);
      return { approvals, inputs };
    });
    Promise.all(reads).then(
      (all) => {
        if (!alive) return;
        const state = { approvals: all.flatMap((x) => x.approvals), inputs: all.flatMap((x) => x.inputs) };
        const out = new Map<string, AgentWait>();
        for (const id of new Set([...state.approvals, ...state.inputs].map((x) => x.agent_id))) {
          const w = agentWaiting(state, id);
          if (w) out.set(id, w);
        }
        setWaits(out);
      },
      // Unreadable: the rows keep saying they are at work (the project's own row says it needs you).
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [bridge, key, latest]);
  return key ? waits : EMPTY;
}

const EMPTY: ReadonlyMap<string, AgentWait> = new Map();
