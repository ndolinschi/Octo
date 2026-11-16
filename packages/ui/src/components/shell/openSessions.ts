import { useCallback } from "react";
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
 * `createSession` when called right after initial project setup.
 */
export function useOpenSessionTab(): (projectId: string) => Promise<void> {
  const { bridge } = useApp();
  const ws = useOptionalWorkspace();
  const { state } = useProject();
  const current = state.sessions.currentId;
  const list = state.sessions.list;
  return useCallback(
    async (projectId) => {
      if (!ws) return;
      let sessionId = current ?? list.find((s) => s.kind === "main" && (s.default || s.current))?.id ?? list[0]?.id ?? null;
      if (!sessionId && bridge.listSessions) {
        try {
          const sessions = await bridge.listSessions(projectId);
          sessionId =
            sessions.find((s) => s.kind === "main" && (s.default || s.current))?.id ?? sessions.find((s) => s.kind === "main")?.id ?? sessions[0]?.id ?? null;
        } catch {
          /* fall through to create */
        }
      }
      if (!sessionId && bridge.createSession) {
        try {
          const { session } = await bridge.createSession(projectId, {});
          sessionId = session.id;
        } catch {
          /* fall through to sessions tool */
        }
      }
      if (sessionId) ws.openSession(sessionId);
      else ws.openTool("sessions");
    },
    [bridge, ws, current, list],
  );
}
