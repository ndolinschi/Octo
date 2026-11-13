import { timeAgo } from "./format";

/** Home cards and the approvals slot (lazy chunks) need these; the first paint does not. */

/** "Dependency auditor, Test runner +1": the first `max` distinct roles, then how many more agents. */
export function agentStack(roles: readonly string[], max = 2): string {
  const shown: string[] = [];
  for (const r of roles) if (!shown.includes(r) && shown.length < max) shown.push(r);
  const rest = roles.length - roles.filter((r) => shown.includes(r)).length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

/** The idle team line: "Last ran 3 agents, 1h ago", "Worked alone, 2h ago" (no "·" joiners: craft rule). */
export function teamLine(count: number, at: string | null, now: number): string {
  const what = count === 0 ? "Worked alone" : `Last ran ${count} ${count === 1 ? "agent" : "agents"}`;
  return at ? `${what}, ${timeAgo(at, now)}` : what;
}

/**
 * Decision 63: the word "orchestrator" is never a name on screen. A label a harness gives the project's own agent
 * ("orchestrator", as approvals and forms carry it) reads as the project's name; any other agent keeps its label.
 */
export function agentDisplayName(label: string, projectName: string | null | undefined): string {
  return label.trim().toLowerCase() === "orchestrator" ? projectName?.trim() || "Assistant" : label;
}
