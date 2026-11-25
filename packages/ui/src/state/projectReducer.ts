import {
  applyEvent,
  withAgents,
  withApprovals,
  withCompactions,
  withInputs,
  withMessages,
  withNotes,
  withSessions,
  settleStreams,
  ancestorsOf,
  withSideAsked,
  withSideCleared,
  withSideMessages,
  withTurnCleared,
  type Agent,
  type Approval,
  type BridgeEvent,
  type CompactionMarker,
  type InputRequest,
  type Message,
  type Note,
  type ProjectSession,
  type ProjectState,
  type SideMessage,
  type SideStarted,
} from "@octo/agent-client";

export type Action =
  | { type: "event"; event: BridgeEvent }
  | { type: "events"; events: readonly BridgeEvent[] }
  | { type: "agents"; agents: Agent[] }
  | { type: "messages"; agentId: string; messages: Message[] }
  | { type: "notes"; notes: Note[] }
  /** NEW-3: the pending approvals and open forms as read (a reload, a reopened stream); events keep them current. */
  | { type: "waits"; approvals: Approval[] | null; inputs: InputRequest[] | null }
  | { type: "sessions"; sessions: ProjectSession[] }
  | { type: "compactions"; agentId: string; markers: CompactionMarker[] }
  /** The agent's conversation replaced by another one (a resumed session): messages, markers and any streamed text. */
  | { type: "transcript"; agentId: string; messages: Message[]; markers: CompactionMarker[] }
  | { type: "side"; messages: SideMessage[] }
  | { type: "sideAsked"; started: SideStarted }
  | { type: "sideCleared" }
  /** A turn is about to start in session `sessionId` (default: the default session): its last outcome goes. */
  | { type: "clearTurn"; sessionId?: string }
  /** After a re-read: drop the live parts of agents that are not running any more (A11). */
  | { type: "settle" }
  /** `root`: the root agent of the session that was rewound (parallel sessions); absent: the project's first root. */
  | { type: "rewound"; messageId: number; label: string; at: string; soft?: boolean; root?: string };

export function projectReducer(state: ProjectState, action: Action): ProjectState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "events": {
      let next = state;
      for (const e of action.events) next = applyEvent(next, e);
      return next;
    }
    case "agents":
      return withAgents(state, action.agents);
    case "messages":
      return withMessages(state, action.agentId, action.messages);
    case "notes":
      return withNotes(state, action.notes);
    case "waits": {
      // Merged with what events brought while the lists were read (one asked meanwhile is not dropped).
      const merge = <T extends { id: string }>(read: T[], live: readonly T[]) => {
        if (!live.length) return read;
        const ids = new Set(read.map((r) => r.id));
        return [...read, ...live.filter((x) => !ids.has(x.id))];
      };
      const a = action.approvals ? withApprovals(state, merge(action.approvals, state.approvals)) : state;
      return action.inputs ? withInputs(a, merge(action.inputs, a.inputs)) : a;
    }
    case "sessions":
      return withSessions(state, action.sessions);
    case "transcript":
      return {
        ...state,
        messages: { ...state.messages, [action.agentId]: [...action.messages] },
        compactions: { ...state.compactions, [action.agentId]: [...action.markers] },
        streaming: { ...state.streaming, [action.agentId]: "" },
      };
    case "compactions":
      return withCompactions(state, action.agentId, action.markers);
    case "side":
      return withSideMessages(state, action.messages);
    case "sideAsked":
      return withSideAsked(state, action.started);
    case "sideCleared":
      return withSideCleared(state);
    case "settle":
      return settleStreams(state);
    case "clearTurn":
      return withTurnCleared(state, action.sessionId ?? null);
    case "rewound":
      return rewound(state, action.messageId, action.label, action.at, action.soft === true, action.root);
  }
}

/**
 * Parity B5: the conversation after a rewind to request `messageId`: that message and every later one (of every agent) are
 * gone, sub-agents created since are hidden, and a quiet marker stays where the cut is. Idempotent (the event and the
 * dialog's own result both apply it; the marker at the same position is replaced, unless `soft` (the event) finds one.
 */
export function rewound(state: ProjectState, messageId: number, label: string, at: string, soft = false, root?: string): ProjectState {
  // Parallel sessions: only the rewound session's agents are cut (message ids are project-wide; another session's later
  // messages stay). Without a root (an older harness) every agent is.
  const inScope = (id: string) => root === undefined || ancestorsOf(state, id).some((a) => a.id === root) || id === root;
  const present = Object.entries(state.compactions).some(
    ([agentId, list]) => inScope(agentId) && list.some((c) => c.upto_message_id === messageId - 1 && c.label?.startsWith("Restored")),
  );
  if (soft && present) return state;
  const cutAt = Object.values(state.messages)
    .flat()
    .find((m) => m.id === messageId)?.created_at;
  const gone = new Set(
    cutAt === undefined
      ? []
      : state.agentOrder.filter((id) => state.agents[id]?.parent_id !== null && inScope(id) && (state.agents[id]?.created_at ?? "") >= cutAt),
  );
  const messages = Object.fromEntries(
    Object.entries(state.messages)
      .filter(([agentId]) => !gone.has(agentId))
      .map(([agentId, list]) => [agentId, inScope(agentId) ? list.filter((m) => m.id < messageId) : list]),
  );
  const agents = Object.fromEntries(Object.entries(state.agents).filter(([id]) => !gone.has(id)));
  const compactions = Object.fromEntries(
    Object.entries(state.compactions).map(([agentId, list]) => [agentId, inScope(agentId) ? list.filter((c) => c.upto_message_id < messageId - 1) : list]),
  );
  const orchestrator = root ?? state.agentOrder.find((id) => state.agents[id]?.parent_id === null);
  if (orchestrator !== undefined) {
    const marker: CompactionMarker = { upto_message_id: messageId - 1, at, label };
    compactions[orchestrator] = [...(compactions[orchestrator] ?? []), marker];
  }
  const streaming = root === undefined ? {} : Object.fromEntries(Object.entries(state.streaming).filter(([id]) => !inScope(id)));
  const next = { ...state, messages, agents, agentOrder: state.agentOrder.filter((id) => !gone.has(id)), compactions, streaming };
  const sid = root === undefined ? null : (Object.entries(state.sessions.byId).find(([, x]) => x.rootAgentId === root)?.[0] ?? null);
  return withTurnCleared(next, sid);
}
