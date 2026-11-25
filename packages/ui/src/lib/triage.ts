import type { OrchestratorState } from "./orchestrator";

/** Home's triage (decision 26), in its order: what needs the user, what works, what finished unseen, the rest. */
export type Triage = "needs" | "working" | "review" | "idle";
export const TRIAGE_ORDER: readonly Triage[] = ["needs", "working", "review", "idle"];
export const TRIAGE_LABEL: Record<Triage, string> = { needs: "Needs you", working: "Working", review: "Ready to review", idle: "Idle" };

/**
 * A project's triage group: an approval or a form waiting, or a failed turn, needs you (pending work wins over working: the
 * turn that waits still runs); a running turn works; finished work not yet seen is ready to review.
 */
export function triageOf(state: OrchestratorState, unseen: boolean): Triage {
  if (state.kind === "needs") return "needs";
  if (state.kind === "working") return "working";
  return unseen ? "review" : "idle";
}

/** Projects per group, each group most recent first (by `updated_at`). */
export function triageGroups<T extends { id: string; updated_at: string }>(items: readonly { project: T; triage: Triage }[]): Record<Triage, T[]> {
  const out: Record<Triage, T[]> = { needs: [], working: [], review: [], idle: [] };
  for (const { project, triage } of items) out[triage].push(project);
  for (const k of TRIAGE_ORDER) out[k].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return out;
}

/**
 * Decision 96: a main session's triage group on Home. Waiting for the person or failed needs you; working or waiting for a
 * slot works; the newest finished session of a project with unseen activity is ready to review; the rest is idle (its project
 * shows in Idle, collapsed).
 */
export function sessionTriageOf(
  s: { state: "working" | "waiting" | "queued" | "idle" | "failed" | "stopped"; needs_you?: boolean },
  unseen: boolean,
  newest: boolean,
): Triage {
  if (s.state === "waiting" || s.needs_you === true || s.state === "failed") return "needs";
  if (s.state === "working" || s.state === "queued") return "working";
  return unseen && newest ? "review" : "idle";
}
