import type { Agent, ProjectAttentionKind, ProjectState } from "@octo/agent-client";
import { formatRelative, timeAgo } from "./format";

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

const byStart = (a: Agent, b: Agent) => Date.parse(a.started_at ?? a.created_at) - Date.parse(b.started_at ?? b.created_at) || a.id.localeCompare(b.id);

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
