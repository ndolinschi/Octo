import type { OrchestratorState } from "./orchestrator";

/** Home's triage (decision 26), in its order: what needs the user, what works, what finished unseen, the rest. */
export type Triage = "needs" | "working" | "review" | "idle";
export const TRIAGE_ORDER: readonly Triage[] = ["needs", "working", "review", "idle"];
export const TRIAGE_LABEL: Record<Triage, string> = { needs: "Needs you", working: "Working", review: "Ready to review", idle: "Idle" };

/** A project's triage group: a failed turn needs you; a running turn works; finished work not yet seen is ready to review. */
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
