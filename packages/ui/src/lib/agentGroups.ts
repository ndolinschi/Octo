import type { Agent } from "@octo/agent-client";

/** One row of the Agents tab (decision 39) and what folds under it. */
export type AgentNode = {
  agent: Agent;
  /** Its sub-agents at one indent step: children, and deeper descendants flattened with their parent's role. */
  children: { agent: Agent; via: string | null }[];
  /** Descendants in all, and how many failed. */
  total: number;
  failed: number;
};

const startOf = (a: Agent) => Date.parse(a.started_at ?? a.created_at);

/**
 * Decision 39: the orchestrator's direct sub-agents in two groups — Running (oldest first, the order they were
 * delegated) and Finished (newest first). Everything an agent started folds under it at one indent step; depth beyond 2
 * flattens there with a "↳ parent" prefix (`via`). An agent counts as running while it or anything under it runs.
 */
export function agentGroups(agents: readonly Agent[]): { running: AgentNode[]; finished: AgentNode[] } {
  const kids = new Map<string, Agent[]>();
  for (const a of agents) if (a.parent_id) kids.set(a.parent_id, [...(kids.get(a.parent_id) ?? []), a]);
  // Parallel sessions: every main session has its own root; the agents of all of them are the project's.
  const roots = agents.filter((a) => a.parent_id === null);
  const top = roots.length
    ? roots.flatMap((r) => kids.get(r.id) ?? [])
    : agents.filter((a) => a.parent_id !== null && !agents.some((p) => p.id === a.parent_id));
  const node = (a: Agent): AgentNode & { live: boolean } => {
    const children: { agent: Agent; via: string | null }[] = [];
    let failed = 0;
    let live = a.status === "running";
    const walk = (p: Agent, depth: number) => {
      for (const c of (kids.get(p.id) ?? []).sort((x, y) => startOf(x) - startOf(y))) {
        children.push({ agent: c, via: depth > 1 ? p.role || "Agent" : null });
        if (c.status === "failed") failed += 1;
        if (c.status === "running") live = true;
        walk(c, depth + 1);
      }
    };
    walk(a, 1);
    return { agent: a, children, total: children.length, failed, live };
  };
  const nodes = top.map(node);
  const strip = ({ live: _live, ...n }: AgentNode & { live: boolean }): AgentNode => n;
  return {
    running: nodes
      .filter((n) => n.live)
      .sort((x, y) => startOf(x.agent) - startOf(y.agent))
      .map(strip),
    finished: nodes
      .filter((n) => !n.live)
      .sort((x, y) => startOf(y.agent) - startOf(x.agent))
      .map(strip),
  };
}

/** The fold line under an agent: "5 agents, 1 failed" (null when it started none). */
export function foldLine(n: Pick<AgentNode, "total" | "failed">): { text: string; failed: string | null } | null {
  if (n.total === 0) return null;
  return { text: `${n.total} ${n.total === 1 ? "agent" : "agents"}`, failed: n.failed ? `${n.failed} failed` : null };
}
