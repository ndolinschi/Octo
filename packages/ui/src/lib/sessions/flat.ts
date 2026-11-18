import type { GlobalSession, ProjectSession } from "@octo/agent-client";
import { byActivity, hasSessionMessages, visibleSessions } from "./tree";

/**
 * Sessions shown in the flat "Sessions" sidebar view: every non-archived main session with activity, the currently
 * active session even while still empty, plus one fallback session (default else newest) for any project that has
 * no non-empty sessions yet so an open or newly created empty project never vanishes from the sidebar. Newest start first,
 * then id: a stable order, so rows never swap places under the pointer as activity moves.
 */
export function flatSessions(list: readonly GlobalSession[], activeSessionId: string | null): GlobalSession[] {
  const mains = list.filter((s) => s.kind === "main" && !s.archived);
  const picked = new Set<string>();
  const represented = new Set<string>();

  for (const s of mains) {
    if (hasSessionMessages(s) || s.id === activeSessionId) {
      picked.add(s.id);
      represented.add(s.project_id);
    }
  }

  const fallbackByProject = new Map<string, GlobalSession>();
  for (const s of mains) {
    if (represented.has(s.project_id)) continue;
    const prev = fallbackByProject.get(s.project_id);
    const isDefault = s.default ?? s.current;
    const prevDefault = prev ? (prev.default ?? prev.current) : false;
    if (!prev || (isDefault && !prevDefault) || (isDefault === prevDefault && byActivity(s, prev) < 0)) {
      fallbackByProject.set(s.project_id, s);
    }
  }
  for (const s of fallbackByProject.values()) picked.add(s.id);

  return mains.filter((s) => picked.has(s.id)).sort(byStarted);
}

/** Newest start first (ties: id). */
const byStarted = (a: GlobalSession, b: GlobalSession): number => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id);

/**
 * Sessions shown under an open project in "Projects and sessions" (`tree`) mode: keeps `visibleSessions` behavior
 * while surfacing a newly opened empty `activeSessionId` when the project already lists other sessions.
 */
export function treeSessions<T extends ProjectSession>(list: readonly T[], all: boolean, activeSessionId: string | null): { shown: T[]; hidden: number } {
  const res = visibleSessions(list, all);
  if (activeSessionId === null || res.shown.length === 0 || res.shown.some((s) => s.id === activeSessionId)) return res;
  const active = list.find((s) => s.id === activeSessionId && s.kind === "main" && !s.archived);
  if (!active) return res;
  return { shown: [active, ...res.shown], hidden: res.hidden };
}
