import type { ProjectSession } from "@octo/agent-client";

/**
 * A session's title as a row shows it. (The title the harness gives a new session from its first request, which only the demo
 * needs, is `requestTitle`: apart, so the entry, which shows titles, does not carry it.)
 */
export const sessionTitle = (s: Pick<ProjectSession, "title">): string => (s.title.trim() === "" ? "New session" : s.title.trim());
