import type { ProjectMode } from "@octo/agent-client";

export const MODE_LABEL: Record<ProjectMode, string> = { agent: "Agent", ask: "Ask", plan: "Plan" };

/** What a mode does, for its menu row's tooltip. */
export const MODE_DETAIL: Record<ProjectMode, string> = {
  agent: "Reads, edits files and runs commands",
  ask: "Answers questions, changes nothing",
  plan: "Writes a plan you approve first, changes nothing",
};

/** Why approving a plan did not work, as one sentence with a next step; `refresh` says the plan should be read again. */
export function planError(code: string | null): { text: string; refresh: boolean } | null {
  if (code === "plan_not_pending") return { text: "This plan was already approved.", refresh: true };
  if (code === "turn_in_progress") return { text: "A turn is still running. Approve the plan when it has finished, or stop it first.", refresh: false };
  return null;
}
