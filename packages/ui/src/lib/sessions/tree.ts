import type { ProjectSession, ProjectSessionState } from "@octo/agent-client";
import type { GlyphState } from "../stateGlyph";
import { formatRelative } from "../format";
import { sessionTitle } from "./title";

/**
 * The sidebar's "Projects and sessions" tree (UI decision 96): which sessions a tree lists, a session's glyph, title and meta
 * (the palette, Home and the tab picker show them too). What only the tree itself needs (which sessions an open project shows,
 * the project's summed-up glyph, which projects are open, the keyboard) is `treeRows`, in the tree's own chunk. Pure.
 */

/** What `GET /v1/sessions` adds to a session. */
export type Located = { project_id: string; project_name: string };

const activityMs = (s: Pick<ProjectSession, "last_activity_at" | "started_at">): number => {
  const t = Date.parse(s.last_activity_at || s.started_at);
  return Number.isNaN(t) ? 0 : t;
};
/** Newest activity first (ties: newest start, then id, so rows never swap places at random). */
export const byActivity = (a: ProjectSession, b: ProjectSession): number =>
  activityMs(b) - activityMs(a) || b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id);

/** A session that asks to be seen whatever its age: it works, waits for the person, or waits for a free slot. */
export const isLive = (s: Pick<ProjectSession, "state" | "needs_you">): boolean =>
  s.state === "working" || s.state === "waiting" || s.state === "queued" || s.needs_you === true;

/** A session stays hidden from the sidebar until a message is sent or queued in it (or it is running/ended). */
export const hasSessionMessages = (s: Pick<ProjectSession, "exchanges" | "state" | "needs_you" | "queued">): boolean =>
  s.exchanges > 0 || isLive(s) || s.state === "failed" || s.state === "stopped" || (s.queued ?? 0) > 0;

/** The main sessions a tree lists (not archived and non-empty), newest activity first. */
export function mainSessions<T extends ProjectSession>(list: readonly T[]): T[] {
  return list.filter((s) => s.kind === "main" && !s.archived && hasSessionMessages(s)).sort(byActivity);
}

/** A session's state glyph (decision 29's family): waiting is "needs you", a queued one the dashed ring. */
export function sessionGlyph(s: Pick<ProjectSession, "state" | "needs_you">): GlyphState {
  if (s.state === "waiting" || s.needs_you === true) return "needs";
  const by: Record<ProjectSessionState, GlyphState> = {
    working: "working",
    waiting: "needs",
    queued: "queued",
    failed: "failed",
    idle: "idle",
    stopped: "stopped",
  };
  return by[s.state];
}

/**
 * A session row's meta: nothing while it works (the glyph turns), "queued" for a slot, else the time since its activity
 * (also while it waits for the person: how long it has waited, as a failed row says how long ago it failed).
 */
export function sessionMeta(s: Pick<ProjectSession, "state" | "last_activity_at" | "started_at">, now: number): string | null {
  if (s.state === "working") return null;
  if (s.state === "queued") return "queued";
  return formatRelative(s.last_activity_at || s.started_at, now);
}

// The title lives in `title` (the tab strip, in the entry, reads it; this module stays in the lazy chunks that list sessions).
export { sessionTitle };

/**
 * The sessions the palette lists as rows of their own: those an open tab does not already show. A tab counts only when its
 * label carries the session's title (a tab still called "New session" while the sidebar says "Alpha session" must not hide
 * the session: typing its name has to find it).
 */
export function sessionsBesideTabs<T extends Pick<ProjectSession, "id" | "title"> & { project_name: string }>(
  sessions: readonly T[],
  tabs: readonly { id: string; label: string }[],
  tabIdOf: (sessionId: string) => string,
): T[] {
  const labels = new Map(tabs.map((t) => [t.id, t.label]));
  return sessions.filter((s) => {
    const title = sessionTitle(s);
    const own = labels.get(tabIdOf(s.id));
    if (own !== undefined && own.includes(title)) return false;
    // The conversation tab (Chat) is named "Project / Session title".
    return !tabs.some((t) => t.label === `${s.project_name} / ${title}`);
  });
}
