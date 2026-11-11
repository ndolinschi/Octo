import {
  applyEvent,
  withAgents,
  withCompactions,
  withMessages,
  withNotes,
  withSideAsked,
  withSideCleared,
  withSideMessages,
  type Agent,
  type BridgeEvent,
  type CompactionMarker,
  type Message,
  type Note,
  type ProjectState,
  type SideMessage,
  type SideStarted,
} from "@octo/agent-client";

export type Action =
  | { type: "event"; event: BridgeEvent }
  | { type: "agents"; agents: Agent[] }
  | { type: "messages"; agentId: string; messages: Message[] }
  | { type: "notes"; notes: Note[] }
  | { type: "compactions"; agentId: string; markers: CompactionMarker[] }
  | { type: "side"; messages: SideMessage[] }
  | { type: "sideAsked"; started: SideStarted }
  | { type: "sideCleared" }
  | { type: "clearTurn" };

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
  }
}
