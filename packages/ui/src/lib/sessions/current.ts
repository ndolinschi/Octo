import type { ProjectSession } from "@octo/agent-client";

/** What the open project needs at first paint (the tab title, which session the conversation loads); the rest of the sessions model loads with the Sessions tab. */

export const startedMs = (s: ProjectSession): number => {
  const t = Date.parse(s.started_at);
  return Number.isNaN(t) ? 0 : t;
};

/** The conversation tab's "Project / session" part (decision 63): the current main session's title, else the orchestrator's own. */
export function currentTitle(list: readonly ProjectSession[], currentId: string | null, fallback: string): string {
  const current = currentId === null ? undefined : list.find((s) => s.id === currentId);
  return current && current.title.trim() !== "" ? current.title : fallback;
}

/**
 * Which main session the project's conversation loads by id: only one that was resumed (a main session started later than
 * the current one exists). A conversation whose current session is the newest keeps loading whole (its `/clear` markers
 * show where each session began), as before project sessions.
 */
export function transcriptSession(list: readonly ProjectSession[], currentId: string | null): string | undefined {
  if (currentId === null) return undefined;
  const current = list.find((s) => s.id === currentId && s.kind === "main");
  if (!current) return undefined;
  const later = list.some((s) => s.kind === "main" && s.id !== currentId && startedMs(s) > startedMs(current));
  return later ? currentId : undefined;
}

export type SessionTabMode = "loading" | "conversation" | "detail";

/**
 * How a `session:<id>` tab renders: wait until initial sync completes if the session is not yet in state, show the
 * conversation for parallel main sessions (even before `synced > 0` if already upserted), and show detail for an agent
 * session or an older harness without parallel sessions.
 */
export function sessionTabMode(input: { parallel: boolean; kind: "main" | "agent" | undefined; synced: number }): SessionTabMode {
  if (input.kind === undefined && input.synced === 0) return "loading";
  if (input.parallel && (input.kind === "main" || input.kind === undefined)) return "conversation";
  return "detail";
}
