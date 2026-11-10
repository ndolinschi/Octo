import { applyEvent, withAgents, withMessages, withNotes, type Agent, type BridgeEvent, type Message, type Note, type ProjectState } from "@octo/agent-client";

export type Action =
  | { type: "event"; event: BridgeEvent }
  | { type: "agents"; agents: Agent[] }
  | { type: "messages"; agentId: string; messages: Message[] }
  | { type: "notes"; notes: Note[] }
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
    case "clearTurn":
      return { ...state, lastTurn: null };
  }
}
