import {
  applyEvent,
  withAgents,
  withCompactions,
  withMessages,
  withNotes,
  withSessions,
  withSideAsked,
  withSideCleared,
  withSideMessages,
  type Agent,
  type BridgeEvent,
  type CompactionMarker,
  type Message,
  type Note,
  type ProjectSession,
  type ProjectState,
  type SideMessage,
  type SideStarted,
} from "@octo/agent-client";

export type Action =
  | { type: "event"; event: BridgeEvent }
  | { type: "agents"; agents: Agent[] }
  | { type: "messages"; agentId: string; messages: Message[] }
  | { type: "notes"; notes: Note[] }
  | { type: "sessions"; sessions: ProjectSession[] }
  | { type: "compactions"; agentId: string; markers: CompactionMarker[] }
  | { type: "side"; messages: SideMessage[] }
  | { type: "sideAsked"; started: SideStarted }
  | { type: "sideCleared" }
  | { type: "clearTurn" }
  | { type: "rewound"; messageId: number; label: string; at: string; soft?: boolean };

export function projectReducer(state: ProjectState, action: Action): ProjectState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "agents":
      return withAgents(state, action.agents);
    case "messages":
      return withMessages(state, action.agentId, action.messages);
    case "notes":
      return withNotes(state, action.notes);
    case "sessions":
      return withSessions(state, action.sessions);
    case "compactions":
      return withCompactions(state, action.agentId, action.markers);
    case "side":
      return withSideMessages(state, action.messages);
    case "sideAsked":
      return withSideAsked(state, action.started);
    case "sideCleared":
      return withSideCleared(state);
    case "clearTurn":
      return { ...state, lastTurn: null };
    case "rewound":
      return rewound(state, action.messageId, action.label, action.at, action.soft === true);
  }
}

/**
 * Parity B5: the conversation after a rewind to request `messageId`: that message and every later one (of every agent) are
 * gone, sub-agents created since are hidden, and a quiet marker stays where the cut is. Idempotent (the event and the
 * dialog's own result both apply it; the marker at the same position is replaced, unless `soft` (the event) finds one.
 */
export function rewound(state: ProjectState, messageId: number, label: string, at: string, soft = false): ProjectState {
  const present = Object.values(state.compactions).some((list) => list.some((c) => c.upto_message_id === messageId - 1 && c.label?.startsWith("Rewound")));
  if (soft && present) return state;
  const cutAt = Object.values(state.messages)
    .flat()
    .find((m) => m.id === messageId)?.created_at;
  const gone = new Set(
    cutAt === undefined ? [] : state.agentOrder.filter((id) => state.agents[id]?.parent_id !== null && (state.agents[id]?.created_at ?? "") >= cutAt),
  );
  const messages = Object.fromEntries(
    Object.entries(state.messages)
      .filter(([agentId]) => !gone.has(agentId))
      .map(([agentId, list]) => [agentId, list.filter((m) => m.id < messageId)]),
  );
  const agents = Object.fromEntries(Object.entries(state.agents).filter(([id]) => !gone.has(id)));
  const compactions = Object.fromEntries(
    Object.entries(state.compactions).map(([agentId, list]) => [agentId, list.filter((c) => c.upto_message_id < messageId - 1)]),
  );
  const orchestrator = state.agentOrder.find((id) => state.agents[id]?.parent_id === null);
  if (orchestrator !== undefined) {
    const marker: CompactionMarker = { upto_message_id: messageId - 1, at, label };
    compactions[orchestrator] = [...(compactions[orchestrator] ?? []), marker];
  }
  return { ...state, messages, agents, agentOrder: state.agentOrder.filter((id) => !gone.has(id)), compactions, lastTurn: null, streaming: {} };
}
