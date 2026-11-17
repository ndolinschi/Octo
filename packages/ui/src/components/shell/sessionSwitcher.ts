import type { ProjectSession } from "@octo/agent-client";
import { Plus } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { sessionTitle } from "../../lib/sessions/tree";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";
import type { MenuItem } from "../primitives/Menu";

export const MENU_SESSIONS_SHOWN = 5;

/**
 * Loads the project's sessions if the live list is still empty (e.g. a newly created project or a picker opened
 * immediately after switching projects) and applies them to `state.sessions` before any session action runs.
 */
export function useSyncProjectSessions(enabled: boolean): void {
  const { bridge } = useApp();
  const { projectId, state, applySession } = useProject();
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || state.sessions.list.length > 0 || !bridge.listSessions) return;
    if (asked.current === projectId) return;
    asked.current = projectId;
    let live = true;
    void bridge
      .listSessions(projectId, { limit: 200, archived: "all" })
      .then((sessions) => {
        if (!live) return;
        for (const session of sessions) applySession({ kind: "upsert", session });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, projectId, state.sessions.list.length, bridge, applySession]);
}

/**
 * Creates a new main session, writes it to `state.sessions` and the sidebar session index immediately so the route or
 * tab never shows a missing-session screen, and opens it either in `Chat` (`show`) or its own tab (`tab`).
 */
export function useCreateProjectSession(): (target: "show" | "tab") => Promise<ProjectSession | null> {
  const { bridge } = useApp();
  const { projectId, state, applySession } = useProject();
  const activity = useActivity();
  const ws = useOptionalWorkspace();
  const currentId = state.sessions.currentId;
  return useCallback(
    async (target) => {
      if (!ws) return null;
      const { session } = await bridge.createSession(projectId, {});
      applySession({ kind: "upsert", session });
      if (session.default ?? session.current) applySession({ kind: "current", id: session.id, previous: currentId ?? "" });
      activity.refreshSessions();
      if (target === "tab") ws.openSession(session.id);
      else ws.showSession(session.id);
      return session;
    },
    [bridge, projectId, currentId, applySession, activity, ws],
  );
}

/** Shared session creation and switching rows for the project "⋯" menu and the Chat tab context menu. */
export function sessionMenuItems(opts: {
  sessions: readonly ProjectSession[];
  activeId: string | null;
  disabled?: boolean;
  onSelect(sessionId: string): void;
  onCreate(target: "show" | "tab"): void;
  onShowAll?: () => void;
}): MenuItem[] {
  const shown = opts.sessions.slice(0, MENU_SESSIONS_SHOWN);
  const items: MenuItem[] = [
    { id: "new-session", label: "New session", icon: Plus, ...(opts.disabled ? { disabled: true } : {}), run: () => opts.onCreate("show") },
    { id: "new-session-tab", label: "New session in new tab", ...(opts.disabled ? { disabled: true } : {}), run: () => opts.onCreate("tab") },
  ];
  if (shown.length > 0) {
    items.push({ id: "cap-sessions", caption: "Switch session" });
    for (const s of shown) {
      const isDefault = s.default ?? s.current;
      items.push({
        id: `session:${s.id}`,
        label: sessionTitle(s),
        checked: s.id === opts.activeId,
        ...(isDefault ? { detail: "default" } : {}),
        ...(opts.disabled ? { disabled: true } : {}),
        run: () => opts.onSelect(s.id),
      });
    }
  }
  if (opts.onShowAll) {
    items.push({
      id: "sessions",
      label: opts.sessions.length > MENU_SESSIONS_SHOWN ? `All sessions (${opts.sessions.length})…` : "Show sessions",
      ...(opts.disabled ? { disabled: true } : {}),
      run: opts.onShowAll,
    });
  }
  return items;
}
