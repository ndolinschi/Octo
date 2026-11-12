import { useCallback } from "react";
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
