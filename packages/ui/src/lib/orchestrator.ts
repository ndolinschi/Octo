import type { Agent, ProjectState } from "@octo/agent-client";
import { timeAgo } from "./format";

/**
 * The project orchestrator's state as the sidebar, the header and Home show it (contract decision 23), derived
 * only from what the bridge reports: the project's status, its agents (the orchestrator is the agent without a
 * parent) and their statuses. "Needs you" = the last turn failed (the orchestrator agent's status after a turn);
 * approvals will join it when the harness has them.
 */
export type OrchestratorState =
  { kind: "working"; agents: Agent[] } | { kind: "needs"; error: string | null; at: string | null } | { kind: "idle"; at: string | null } | { kind: "new" };

const byStart = (a: Agent, b: Agent) => Date.parse(a.started_at ?? a.created_at) - Date.parse(b.started_at ?? b.created_at) || a.id.localeCompare(b.id);

/** Running sub-agents, oldest first (the order they were delegated). */
export function runningAgents(agents: readonly Agent[]): Agent[] {
  return agents.filter((a) => a.parent_id !== null && a.status === "running").sort(byStart);
}

export function orchestratorState(agents: readonly Agent[], projectStatus: "idle" | "running"): OrchestratorState {
  const root = agents.find((a) => a.parent_id === null);
  const running = runningAgents(agents);
  if (projectStatus === "running" || root?.status === "running" || running.length) return { kind: "working", agents: running };
  if (!root || (!root.started_at && agents.length <= 1)) return { kind: "new" };
  if (root.status === "failed") return { kind: "needs", error: root.error, at: root.finished_at };
  return { kind: "idle", at: root.finished_at ?? root.started_at };
}

/** The same derivation over a live project state (the open project). */
export function liveOrchestratorState(state: ProjectState, projectStatus: "idle" | "running"): OrchestratorState {
  const agents = state.agentOrder.flatMap((id) => {
    const a = state.agents[id];
    return a ? [a] : [];
  });
  return orchestratorState(agents, projectStatus);
}

/** One line: "Working, 3 agents", "Working", "Needs you", "Idle, 2h ago", "No requests yet" (no "·" joiners: craft rule). */
export function stateLine(s: OrchestratorState, now: number, fallbackAt?: string): string {
  switch (s.kind) {
    case "working":
      return s.agents.length === 0 ? "Working" : `Working, ${s.agents.length} ${s.agents.length === 1 ? "agent" : "agents"}`;
    case "needs":
      return "Needs you";
    case "idle": {
      const at = s.at ?? fallbackAt;
      return at ? `Idle, ${timeAgo(at, now)}` : "Idle";
    }
    case "new":
      return "No requests yet";
  }
}

/** "Dependency auditor, Test runner +1": the first `max` distinct roles, then how many more agents. */
export function agentStack(roles: readonly string[], max = 2): string {
  const shown: string[] = [];
  for (const r of roles) if (!shown.includes(r) && shown.length < max) shown.push(r);
  const rest = roles.length - roles.filter((r) => shown.includes(r)).length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

const ACTIVITY: Record<string, string> = {
  bash: "Running a command…",
  read_file: "Reading files…",
  list_dir: "Listing folders…",
  write_file: "Writing files…",
};

/** What an agent is doing now, from its live tools, children and stream (delegation rows, team strip). */
export function agentActivity(state: ProjectState, agentId: string): string {
  const working = state.agentOrder.flatMap((id) => {
    const c = state.agents[id];
    return c?.parent_id === agentId && c.status === "running" ? [c.role] : [];
  });
  if (working.length) return `Waiting on ${working.join(", ")}…`;
  const tool = Object.values(state.activeTools[agentId] ?? {})[0];
  if (tool) return ACTIVITY[tool.name] ?? `Using ${tool.name}…`;
  return state.streaming[agentId] ? "Writing…" : "Thinking…";
}
