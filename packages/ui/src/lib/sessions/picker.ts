import type { ProjectSession } from "@octo/agent-client";
import { mainSessions, sessionMeta } from "./tree";

export type SessionChoiceMeta = {
  detail?: string;
  hint?: string;
};

/**
 * Non-archived main sessions for quick switchers and menus, newest activity first, optionally capped to `limit`.
 */
export function sessionChoices(list: readonly ProjectSession[], limit?: number): ProjectSession[] {
  const mains = mainSessions(list);
  return limit === undefined ? mains : mains.slice(0, limit);
}

/**
 * Secondary metadata for a session row in the header picker or "+" tab picker: whether it is open in its own tab,
 * whether it is the project's default session, and either "in Chat" or its last activity time.
 */
export function sessionChoiceMeta(
  session: ProjectSession,
  opts: { activeId: string | null; openTab: boolean; now: number; markActiveHint?: boolean },
): SessionChoiceMeta {
  const isDefault = session.default ?? session.current;
  const detail = opts.openTab ? "open" : isDefault ? "default" : undefined;
  const hint = opts.markActiveHint && session.id === opts.activeId ? "in Chat" : (sessionMeta(session, opts.now) ?? undefined);
  return {
    ...(detail !== undefined ? { detail } : {}),
    ...(hint !== undefined ? { hint } : {}),
  };
}
