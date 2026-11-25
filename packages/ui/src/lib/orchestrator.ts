import type { Agent, ProjectAttentionKind, ProjectState } from "@octo/agent-client";

/**
 * The project orchestrator's state as the sidebar, the header and Home show it (contract decision 23), derived
 * only from what the bridge reports: the project's status, its agents (the orchestrator is the agent without a
 * parent) and their statuses. "Needs you" = an approval or a form waits for the user (`waiting`: the harness's `attention:
 * "needs_you"`, sent while the turn that asked is still running), or the last turn failed (the orchestrator agent's status
 * after a turn).
 */
export type OrchestratorState =
  | { kind: "working"; agents: Agent[] }
  | { kind: "needs"; error: string | null; at: string | null; waiting?: "approval" | "input" }
  | { kind: "idle"; at: string | null }
  | { kind: "new" };

/** What waits for the user: the summary's `pending_approvals` / `pending_inputs`, or the live `project.attention` counts. */
export type Waiting = { approvals: number; inputs: number };

export const byStart = (a: Agent, b: Agent) => Date.parse(a.started_at ?? a.created_at) - Date.parse(b.started_at ?? b.created_at) || a.id.localeCompare(b.id);

/** Running sub-agents, oldest first (the order they were delegated). */
export function runningAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.parent_id !== null && a.status === "running").sort(byStart);
}

export function orchestratorState(
  agents: readonly Agent[],
  projectStatus: "idle" | "running",
  attention?: ProjectAttentionKind,
  waiting?: Waiting,
): OrchestratorState {
  // Parallel sessions: one root per main session; the one at work, else the default's (listed first), speaks for the project.
  const roots = agents.filter((a) => a.parent_id === null);
  const root = roots.find((a) => a.status === "running") ?? roots[0];
  // Pending work wins over working: a turn that waits on an approval or a form is still running at the harness.
  const pendingWork = waitingOn(attention, waiting);
  if (pendingWork) return { kind: "needs", error: null, at: null, waiting: pendingWork };
  const running = runningAgents(agents);
  if (projectStatus === "running" || root?.status === "running" || running.length) return { kind: "working", agents: running };
  // The harness says whether the last turn failed (`attention`); without it (an older harness) the agents decide.
  if (attention === "failed") return { kind: "needs", error: root?.error?.trim() || null, at: root?.finished_at ?? null };
  if (attention === "none")
    return !root || (!root.started_at && agents.length <= 1) ? { kind: "new" } : { kind: "idle", at: root.finished_at ?? root.started_at };
  // A failed turn needs the user even when nothing was stored (an ACP orchestrator that could not start: owner's live
  // test showed "Idle" and nothing else). An `error` on a non-running orchestrator counts too, unless it is a warning.
  if (root && (root.status === "failed" || (root.error && !/^warning:/i.test(root.error))))
    return { kind: "needs", error: root.error?.trim() || null, at: root.finished_at };
  if (!root || (!root.started_at && agents.length <= 1)) return { kind: "new" };
  return { kind: "idle", at: root.finished_at ?? root.started_at };
}

/** An approval when one waits (it blocks a tool call), else a form; null when nothing waits. */
function waitingOn(attention: ProjectAttentionKind | undefined, waiting: Waiting | undefined): "approval" | "input" | null {
  const approvals = waiting?.approvals ?? 0;
  const inputs = waiting?.inputs ?? 0;
  if (approvals > 0) return "approval";
  if (inputs > 0) return "input";
  return attention === "needs_you" ? "approval" : null;
}

/** The same derivation over a live project state (the open project): its live `project.attention` counts decide what waits. */
export function liveOrchestratorState(state: ProjectState, projectStatus: "idle" | "running"): OrchestratorState {
  const agents = state.agentOrder.flatMap((id) => {
    const a = state.agents[id];
    return a ? [a] : [];
  });
  const failure = state.attention.state;
  return orchestratorState(agents, projectStatus, failure === "failed" || failure === "none" ? failure : undefined, {
    approvals: state.attention.approvals,
    inputs: state.attention.inputs,
  });
}

/** A role as people read it: the project's agent is always "Octo" (the harness stores "orchestrator"; the dictionary's name). */
export function roleText(role: string | null | undefined): string {
  const r = (role ?? "").trim();
  if (!r) return "Agent";
  return r.toLowerCase() === "orchestrator" ? "Octo" : r;
}

/** An agent's name as shown: "Octo" for the project's agent, its role otherwise. */
export function roleName(agent: Pick<Agent, "parent_id" | "role">): string {
  return agent.parent_id === null ? "Octo" : roleText(agent.role);
}
