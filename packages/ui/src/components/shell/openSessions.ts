import { useCallback } from "react";
import { useActivity } from "../../state/activity";
import { useApp } from "../../state/app";
import { useProject } from "../../state/project";
import { requestSession } from "../../state/workspace/sessionsStart";
import { useOptionalWorkspace } from "../../state/workspace/WorkspaceProvider";

/**
 * The one place the top row opens "the list of sessions" for a project (decision 91g): the Sessions tab narrowed to the agents
 * of the current session. It goes through `requestSession` like every other way into that tab (sidebar, Memory, a delegation row).
 */
export function useOpenSessions(): (projectId: string) => void {
  const ws = useOptionalWorkspace();
  const { state } = useProject();
  const current = state.sessions.currentId;
  return useCallback(
    (projectId) => {
      if (!ws) return;
      requestSession(projectId, "", { filter: "agents", ...(current ? { agentsOf: current } : {}) });
      ws.openTool("sessions");
    },
    [ws, current],
  );
}

/**
 * Opens the project's active (or default/new) session in its own `session:<id>` tab, resolving via `listSessions` or
 * `createSession` when called right after initial project setup, and updating `state.sessions` synchronously beforehand.
 */
export function useOpenSessionTab(): (projectId: string) => Promise<void> {
  const { bridge } = useApp();
  const activity = useActivity();
  const ws = useOptionalWorkspace();
  const { state, applySession } = useProject();
  const current = state.sessions.currentId;
  const list = state.sessions.list;
  return useCallback(
    async (projectId) => {
      if (!ws) return;
      let sessionId = current ?? list.find((s) => s.kind === "main" && (s.default || s.current))?.id ?? list[0]?.id ?? null;
      if (!sessionId && bridge.listSessions) {
        try {
          const sessions = await bridge.listSessions(projectId, { limit: 200, archived: "all" });
          for (const s of sessions) applySession({ kind: "upsert", session: s });
          sessionId =
            sessions.find((s) => s.kind === "main" && (s.default || s.current))?.id ?? sessions.find((s) => s.kind === "main")?.id ?? sessions[0]?.id ?? null;
        } catch {
          /* fall through to create */
        }
      }
      if (!sessionId) {
        try {
          const { session } = await bridge.createSession(projectId, {});
          applySession({ kind: "upsert", session });
          if (session.default ?? session.current) applySession({ kind: "current", id: session.id, previous: current ?? "" });
          activity.refreshSessions();
          sessionId = session.id;
        } catch {
          /* fall through to sessions tool */
        }
      }
      if (sessionId) ws.openSession(sessionId);
      else ws.openTool("sessions");
    },
    [bridge, activity, ws, current, list, applySession],
  );
}
