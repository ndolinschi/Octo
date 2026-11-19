import { hasParallelSessions, sessionRoot, type Project, type ProjectState } from "@octo/agent-client";

/**
 * Decision 98: the conversation a route to this project opens first, which `projectPreload` reads before the project is shown:
 * its agent (whose messages must be in) and the main session it belongs to ("" without parallel sessions). The same choice
 * as `WorkspaceProvider`: the route's agent or session, else the session Chat showed last, else the default session.
 */
export function openingConversation(
  state: ProjectState,
  project: Pick<Project, "orchestrator_agent_id">,
  route: { agentId: string | null; sessionId: string | null },
  lastSession: string | null,
): { agentId: string; sessionId: string } {
  if (route.agentId !== null) return { agentId: route.agentId, sessionId: "" };
  if (!hasParallelSessions(state)) return { agentId: project.orchestrator_agent_id, sessionId: "" };
  const main = (id: string | null) => (id !== null && state.sessions.list.some((s) => s.id === id && s.kind === "main") ? id : null);
  const sessionId = main(route.sessionId) ?? main(lastSession) ?? state.sessions.defaultId ?? "";
  return { agentId: sessionRoot(state, sessionId) || project.orchestrator_agent_id, sessionId };
}
