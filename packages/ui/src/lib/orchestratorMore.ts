import type { Agent, ProjectState } from "@octo/agent-client";
import { formatRelative, timeAgo } from "./format";
import { byStart, type OrchestratorState } from "./orchestrator";

/** Home cards, the sidebar tree, the palette and the approvals slot (lazy chunks) need these; the first paint does not. */

/** "Waiting for your approval", "Waiting for your answer" (a form), "Failed". */
function needsLine(s: Extract<OrchestratorState, { kind: "needs" }>): string {
  if (s.waiting === "approval") return "Waiting for your approval";
  if (s.waiting === "input") return "Waiting for your answer";
  return "Failed";
}

/**
 * The time a project row shows (B6: the sidebar and Home show the same one): since the orchestrator's last turn, else since the
 * project changed (`fallbackAt`, its `updated_at`); "new" for a project never started; null while it works.
 */
export function projectWhen(s: OrchestratorState, now: number, fallbackAt?: string): string | null {
  if (s.kind === "working") return null;
  if (s.kind === "new") return "new";
  const at = s.at ?? fallbackAt;
  return at ? formatRelative(at, now) : null;
}

/**
 * One line: "Working, 3 agents", "Working", "Waiting for your approval", "Waiting for your answer", "Failed", "Idle, 2h ago",
 * "No requests yet" (no "·" joiners: craft rule). A failed turn says "Failed" (decision 53): the project is still in the
 * "Needs you" triage group, its ring the alert.
 */
export function stateLine(s: OrchestratorState, now: number, fallbackAt?: string): string {
  switch (s.kind) {
    case "working":
      return s.agents.length === 0 ? "Working" : `Working, ${s.agents.length} ${s.agents.length === 1 ? "agent" : "agents"}`;
    case "needs":
      return needsLine(s);
    case "idle": {
      const at = s.at ?? fallbackAt;
      return at ? `Idle, ${timeAgo(at, now)}` : "Idle";
    }
    case "new":
      return "No requests yet";
  }
}

/**
 * The sidebar's project row (polish step 2, F1): every row is ONE line — state glyph, name, right-aligned meta — and the
 * meta says the one thing worth saying: idle → the time since its last turn ("1h"); working → "2 agents" when it has agents,
 * else nothing (the turning glyph says working); needs you (a failed turn, an approval or a form waiting) → the time; never
 * started → "new" (`projectWhen`, Home's time too). `full` is the whole sentence ("Working, 2 agents", "Waiting for your
 * approval", "Failed", "Idle, 1h ago", "No requests yet") for the tooltip and the accessible name;
 * the tone is carried once, by the glyph (decision 91k).
 */
export function projectRowLines(s: OrchestratorState, now: number, fallbackAt?: string): { meta: string | null; full: string } {
  const full = stateLine(s, now, fallbackAt);
  if (s.kind === "working") return { meta: s.agents.length ? `${s.agents.length} ${s.agents.length === 1 ? "agent" : "agents"}` : null, full };
  return { meta: projectWhen(s, now, fallbackAt), full };
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
