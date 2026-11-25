/**
 * "Show this in the Sessions tab": Memory's "Open in Sessions", the sidebar's session rows, a delegation row's "Open session",
 * the agent chips of the top row. The request is held here (not in a tab's memory) because the sidebar asks for projects whose
 * workspace is not mounted yet: the workspace opens the Sessions tab when it mounts with a request waiting, and the tab takes
 * it once. An empty id just opens the tab.
 */
export type SessionRequest = {
  sessionId: string;
  /** Show this filter (the agent chips ask for "agents"). */
  filter?: "agents";
  /** With `filter: "agents"`: only the agent sessions of this main session. */
  agentsOf?: string;
};

let queued: ({ projectId: string } & SessionRequest) | null = null;
const listeners = new Set<() => void>();

export function requestSession(projectId: string, sessionId: string, more: Omit<SessionRequest, "sessionId"> = {}): void {
  queued = { projectId, sessionId, ...more };
  for (const listener of listeners) listener();
}

export function hasQueuedSession(projectId: string): boolean {
  return queued?.projectId === projectId;
}

/** The waiting request without taking it (a state initializer runs twice in development: it must not consume). */
export function peekQueuedSession(projectId: string): SessionRequest | null {
  if (queued?.projectId !== projectId) return null;
  const { projectId: _project, ...request } = queued;
  return request;
}

/** The waiting request, once; null when nothing waits for this project. */
export function takeQueuedSession(projectId: string): SessionRequest | null {
  if (queued?.projectId !== projectId) return null;
  const { projectId: _project, ...request } = queued;
  queued = null;
  return request;
}

/** A mounted Sessions tab listens for requests made while it is open. */
export function onSessionRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
