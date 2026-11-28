import type { ProjectSession, ProjectSummary } from "@octo/agent-client";
import { isDefaultSession } from "../../lib/sessions/current";

export type WorkspaceMode = "regular" | "worktree";

export const WORKSPACE_MODES: readonly { id: WorkspaceMode; label: string; title: string }[] = [
  { id: "regular", label: "Regular", title: "Work directly in the main project checkout" },
  { id: "worktree", label: "Worktree", title: "Work in an isolated git worktree" },
];

/** Whether a session is an untouched, idle, non-archived main session that can be reused or cleaned up on switch. */
export function isUnusedEmptyMain(s: ProjectSession): boolean {
  return s.kind === "main" && !s.archived && s.exchanges === 0 && s.children === 0 && s.state === "idle" && (s.queued ?? 0) === 0;
}

/** Projects sorted newest first, pre-parsing timestamps once (`O(N)` instead of per comparison) with `id` tie-breaking. */
export function sortProjectsByRecent(projects: readonly ProjectSummary[]): ProjectSummary[] {
  return projects
    .map((project) => {
      const ts = Date.parse(project.created_at);
      return { project, ts: Number.isNaN(ts) ? -Infinity : ts };
    })
    .sort((a, b) => b.ts - a.ts || a.project.id.localeCompare(b.project.id))
    .map((entry) => entry.project);
}

/** Finds an existing unused empty shared-checkout session to reuse when switching from Worktree back to Regular. */
export function findReusableSharedSession(sessions: readonly ProjectSession[]): ProjectSession | undefined {
  const isUnusedShared = (s: ProjectSession) => isUnusedEmptyMain(s) && s.workspace?.kind !== "worktree";
  return sessions.find((s) => isDefaultSession(s) && isUnusedShared(s)) ?? sessions.find(isUnusedShared);
}
