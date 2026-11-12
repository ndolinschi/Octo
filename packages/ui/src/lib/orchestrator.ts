import type { Agent, ProjectAttentionKind, ProjectState } from "@octo/agent-client";
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

export function orchestratorState(agents: readonly Agent[], projectStatus: "idle" | "running", attention?: ProjectAttentionKind): OrchestratorState {
  const root = agents.find((a) => a.parent_id === null);
  const running = runningAgents(agents);
  if (projectStatus === "running" || root?.status === "running" || running.length) return { kind: "working", agents: running };
  // The harness says whether the last turn failed (`attention`); without it (an older harness) the agents decide.
  if (attention === "failed") return { kind: "needs", error: root?.error ?? null, at: root?.finished_at ?? null };
  if (attention === "none")
    return !root || (!root.started_at && agents.length <= 1) ? { kind: "new" } : { kind: "idle", at: root.finished_at ?? root.started_at };
  // A failed turn needs the user even when nothing was stored (an ACP orchestrator that could not start: owner's live
  // test showed "Idle" and nothing else). An `error` on a non-running orchestrator counts too, unless it is a warning.
  if (root && (root.status === "failed" || (root.error && !/^warning:/i.test(root.error)))) return { kind: "needs", error: root.error, at: root.finished_at };
  if (!root || (!root.started_at && agents.length <= 1)) return { kind: "new" };
  return { kind: "idle", at: root.finished_at ?? root.started_at };
}

/** The same derivation over a live project state (the open project). */
export function liveOrchestratorState(state: ProjectState, projectStatus: "idle" | "running"): OrchestratorState {
  const agents = state.agentOrder.flatMap((id) => {
    const a = state.agents[id];
    return a ? [a] : [];
  });
  const failure = state.attention.state;
  return orchestratorState(agents, projectStatus, failure === "failed" || failure === "none" ? failure : undefined);
}

/**
 * One line: "Working, 3 agents", "Working", "Failed", "Idle, 2h ago", "No requests yet" (no "·" joiners: craft rule). A
 * failed turn says "Failed" (decision 53): the project is still in the "Needs you" triage group, its ring the alert.
 */
export function stateLine(s: OrchestratorState, now: number, fallbackAt?: string): string {
  switch (s.kind) {
    case "working":
      return s.agents.length === 0 ? "Working" : `Working, ${s.agents.length} ${s.agents.length === 1 ? "agent" : "agents"}`;
    case "needs":
      return "Failed";
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

/**
 * The agents of the orchestrator's latest turn (decision 34's team line): every sub-agent that started at or after the
 * orchestrator's last turn began, in start order. Empty before the first turn.
 */
export function lastTeam(agents: readonly Agent[]): Agent[] {
  const root = agents.find((a) => a.parent_id === null);
  const since = root?.started_at ? Date.parse(root.started_at) : NaN;
  if (Number.isNaN(since)) return [];
  return agents.filter((a) => a.parent_id !== null && Date.parse(a.started_at ?? a.created_at) >= since).sort(byStart);
}

/** The idle team line: "Last ran 3 agents, 1h ago", "Worked alone, 2h ago" (no "·" joiners: craft rule). */
export function teamLine(count: number, at: string | null, now: number): string {
  const what = count === 0 ? "Worked alone" : `Last ran ${count} ${count === 1 ? "agent" : "agents"}`;
  return at ? `${what}, ${timeAgo(at, now)}` : what;
}

export type TeamRole = { role: string; count: number; status: Agent["status"]; agent: Agent };

/**
 * The team grouped by role for the header chips ("Code explorer ×4"): first-seen order; the group's status is the most
 * urgent of its agents (running, then failed, then the rest); `agent` is the one a click opens — the running one, else
 * the latest.
 */
export function teamRoles(team: readonly Agent[]): TeamRole[] {
  const rank = (s: Agent["status"]) => (s === "running" ? 2 : s === "failed" ? 1 : 0);
  const out: TeamRole[] = [];
  for (const a of team) {
    const g = out.find((x) => x.role === a.role);
    if (!g) out.push({ role: a.role, count: 1, status: a.status, agent: a });
    else {
      g.count += 1;
      if (rank(a.status) > rank(g.status)) g.status = a.status;
      if (rank(a.status) >= rank(g.agent.status)) g.agent = a;
    }
  }
  return out;
}

/** A role as people read it: the project's agent is always "Orchestrator" (the harness stores "orchestrator"). */
export function roleText(role: string | null | undefined): string {
  const r = (role ?? "").trim();
  if (!r) return "Agent";
  return r.toLowerCase() === "orchestrator" ? "Orchestrator" : r;
}

/** An agent's name as shown: "Orchestrator" for the project's agent, its role otherwise. */
export function roleName(agent: Pick<Agent, "parent_id" | "role">): string {
  return agent.parent_id === null ? "Orchestrator" : roleText(agent.role);
}

/**
 * Decision 63: the word "orchestrator" is never a name on screen. A label a harness gives the project's own agent
 * ("orchestrator", as approvals and forms carry it) reads as the project's name; any other agent keeps its label.
 */
export function agentDisplayName(label: string, projectName: string | null | undefined): string {
  return label.trim().toLowerCase() === "orchestrator" ? projectName?.trim() || "Assistant" : label;
}
