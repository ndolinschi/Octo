import type { GlobalSession, ProjectSession } from "@octo/agent-client";
import { sessionTriageOf } from "../triage";
import { hasSessionMessages } from "./tree";
import { visibleSessions } from "./treeRows";

/**
 * Sessions shown in the flat "Sessions" sidebar view: every non-archived main session with activity.
 * Projects without session activity are shown as clean project rows by `SessionTree` instead of phantom
 * "New session" entries, so deleting the last session of a project removes it cleanly. Newest start first,
 * then id: a stable order, so rows never swap places under the pointer as activity moves.
 */
export function flatSessions(list: readonly GlobalSession[], _activeSessionId: string | null = null): GlobalSession[] {
  return list.filter((s) => s.kind === "main" && !s.archived && hasSessionMessages(s)).sort(byStarted);
}

/** Newest start first (ties: id). */
const byStarted = (a: GlobalSession, b: GlobalSession): number => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id);

/**
 * Owner decision F3 (2026-11-18): the flat list pins what needs the person on top — Home's "Needs you" (waiting for them,
 * or failed: `sessionTriageOf`) — and the rest follows; both keep the list's order (by start), so a row moves only when its
 * state does.
 */
export function pinNeedsYou(list: readonly GlobalSession[]): { needs: GlobalSession[]; rest: GlobalSession[] } {
  const needs: GlobalSession[] = [];
  const rest: GlobalSession[] = [];
  for (const s of list) (sessionTriageOf(s, false, false) === "needs" ? needs : rest).push(s);
  return { needs, rest };
}

/**
 * Sessions shown under an open project in "Projects and sessions" (`tree`) mode: delegates to `visibleSessions`
 * so untouched empty default sessions do not appear as undeletable "New session" rows.
 */
export function treeSessions<T extends ProjectSession>(
  list: readonly T[],
  all: boolean,
  _activeSessionId: string | null = null,
): { shown: T[]; hidden: number } {
  return visibleSessions(list, all);
}
