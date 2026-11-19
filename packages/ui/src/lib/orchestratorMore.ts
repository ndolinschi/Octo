import type { Agent, ProjectState } from "@octo/agent-client";
import { timeAgo } from "./format";

/** Home cards and the approvals slot (lazy chunks) need these; the first paint does not. */

/** "Dependency auditor, Test runner +1": the first `max` distinct roles, then how many more agents. */
export function agentStack(roles: readonly string[], max = 2): string {
  const shown: string[] = [];
  for (const r of roles) if (!shown.includes(r) && shown.length < max) shown.push(r);
  const rest = roles.length - roles.filter((r) => shown.includes(r)).length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

/** The idle team line: "Last ran 3 agents, 1h ago", "No agents used, 2h ago" (no "·" joiners: craft rule). */
export function teamLine(count: number, at: string | null, now: number): string {
  const what = count === 0 ? "No agents used" : `Last ran ${count} ${count === 1 ? "agent" : "agents"}`;
  return at ? `${what}, ${timeAgo(at, now)}` : what;
}

/**
 * Decision 63: the word "orchestrator" is never a name on screen. A label a harness gives the project's own agent
 * ("orchestrator", as approvals and forms carry it) reads as the project's name; any other agent keeps its label.
 */
export function agentDisplayName(label: string, projectName: string | null | undefined): string {
  return label.trim().toLowerCase() === "orchestrator" ? projectName?.trim() || "Assistant" : label;
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
