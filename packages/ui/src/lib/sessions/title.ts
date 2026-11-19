import type { ProjectSession } from "@octo/agent-client";

/** A session's title as a row shows it. */
export const sessionTitle = (s: Pick<ProjectSession, "title">): string => (s.title.trim() === "" ? "New session" : s.title.trim());
