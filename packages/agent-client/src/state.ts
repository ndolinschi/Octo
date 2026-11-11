import type { Agent, BridgeEvent, CompactionMarker, ContentBlock, Message, Note, SideMessage, SideStarted, TurnStatus } from "./types";

/** The project's side conversation (decision 40): kept apart from every agent's messages. */
export type SideState = {
  messages: SideMessage[];
  /** The answer in flight: its `side_id` and the text streamed so far. */
  pending: { side_id: string; text: string } | null;
  /** The last question that failed; cleared by the next question. */
  error: { side_id: string; message: string } | null;
};

export type ProjectState = {
  agents: Record<string, Agent>;
  agentOrder: string[];
  messages: Record<string, Message[]>;
  streaming: Record<string, string>;
  activeTools: Record<string, Record<string, { name: string }>>;
  notes: Note[];
  /** Compaction markers per agent id, ordered by `upto_message_id`. */
  compactions: Record<string, CompactionMarker[]>;
  side: SideState;
  lastSeq: number;
  lastTurn: { status: TurnStatus; error: string | null } | null;
};

export function emptySide(): SideState {
  return { messages: [], pending: null, error: null };
}

export function emptyProjectState(): ProjectState {
  return {
    agents: {},
    agentOrder: [],
    messages: {},
    streaming: {},
    activeTools: {},
    notes: [],
    compactions: {},
    side: emptySide(),
    lastSeq: 0,
    lastTurn: null,
  };
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function upsertAgent(state: ProjectState, agent: Agent): ProjectState {
  const known = agent.id in state.agents;
  return {
    ...state,
    agents: { ...state.agents, [agent.id]: agent },
    agentOrder: known ? state.agentOrder : [...state.agentOrder, agent.id],
  };
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function addMessage(state: ProjectState, message: Message): ProjectState {
  const list = state.messages[message.agent_id] ?? [];
  const next = list.some((m) => m.id === message.id) ? list : mergeMessages(list, [message]);
  const streaming = message.role === "assistant" ? omitKey(state.streaming, message.agent_id) : state.streaming;
  return { ...state, messages: { ...state.messages, [message.agent_id]: next }, streaming };
}

function mergeCompactions(existing: CompactionMarker[], incoming: CompactionMarker[]): CompactionMarker[] {
  const byUpto = new Map<number, CompactionMarker>();
  for (const c of existing) byUpto.set(c.upto_message_id, c);
  for (const c of incoming) byUpto.set(c.upto_message_id, c);
  return [...byUpto.values()].sort((a, b) => a.upto_message_id - b.upto_message_id);
}

function upsertNote(notes: Note[], note: Note): Note[] {
  const i = notes.findIndex((n) => n.id === note.id);
  if (i === -1) return [...notes, note];
  return notes.map((n, idx) => (idx === i ? note : n));
}

function reduce(state: ProjectState, event: BridgeEvent): ProjectState {
  switch (event.type) {
    case "agent.created":
    case "agent.updated":
      return upsertAgent(state, event.agent);
    case "message.created":
      return addMessage(state, event.message);
    case "message.delta":
      return {
        ...state,
        streaming: {
          ...state.streaming,
          [event.agent_id]: (state.streaming[event.agent_id] ?? "") + event.text,
        },
      };
    case "tool.started":
      return {
        ...state,
        activeTools: {
          ...state.activeTools,
          [event.agent_id]: {
            ...state.activeTools[event.agent_id],
            [event.tool_use_id]: { name: event.name },
          },
        },
      };
    case "tool.finished":
      return {
        ...state,
        activeTools: {
          ...state.activeTools,
          [event.agent_id]: omitKey(state.activeTools[event.agent_id] ?? {}, event.tool_use_id),
        },
      };
    case "note.changed":
      return {
        ...state,
        notes: event.note ? upsertNote(state.notes, event.note) : state.notes.filter((n) => n.id !== event.note_id),
      };
    case "turn.finished":
      return {
        ...state,
        streaming: {},
        activeTools: {},
        lastTurn: { status: event.status, error: event.error },
      };
    case "agent.compacted": {
      const marker: CompactionMarker = { upto_message_id: event.upto_message_id, at: event.at };
      if (event.summary_tokens !== undefined) marker.summary_tokens = event.summary_tokens;
      return {
        ...state,
        compactions: { ...state.compactions, [event.agent_id]: mergeCompactions(state.compactions[event.agent_id] ?? [], [marker]) },
      };
    }
    case "side.delta": {
      const prior = state.side.pending?.side_id === event.side_id ? state.side.pending.text : "";
      return { ...state, side: { ...state.side, pending: { side_id: event.side_id, text: prior + event.text } } };
    }
    case "side.done": {
      const known = state.side.messages.some((m) => m.id === event.message.id);
      const messages = known ? state.side.messages : [...state.side.messages, event.message].sort((a, b) => a.id - b.id);
      const pending = state.side.pending?.side_id === event.side_id ? null : state.side.pending;
      return { ...state, side: { messages, pending, error: null } };
    }
    case "side.error": {
      const pending = state.side.pending?.side_id === event.side_id ? null : state.side.pending;
      return {
        ...state,
        side: {
          messages: state.side.messages.filter((m) => m.side_id !== event.side_id),
          pending,
          error: event.error === "cancelled" ? state.side.error : { side_id: event.side_id, message: event.error },
        },
      };
    }
    case "project.updated":
    case "file.changed":
      return state;
  }
}

export function applyEvent(state: ProjectState, event: BridgeEvent): ProjectState {
  const next = reduce(state, event);
  return { ...next, lastSeq: Math.max(next.lastSeq, event.seq) };
}

export function withAgents(state: ProjectState, agents: Agent[]): ProjectState {
  const loaded = new Set(agents.map((a) => a.id));
  const extra = state.agentOrder.filter((id) => !loaded.has(id));
  return {
    ...state,
    agents: {
      ...Object.fromEntries(
        extra.flatMap((id) => {
          const agent = state.agents[id];
          return agent === undefined ? [] : [[id, agent]];
        }),
      ),
      ...Object.fromEntries(agents.map((a) => [a.id, a])),
    },
    agentOrder: [...agents.map((a) => a.id), ...extra],
  };
}

export function withMessages(state: ProjectState, agentId: string, messages: Message[]): ProjectState {
  const merged = mergeMessages(state.messages[agentId] ?? [], messages);
  return { ...state, messages: { ...state.messages, [agentId]: merged } };
}

export function withCompactions(state: ProjectState, agentId: string, markers: CompactionMarker[]): ProjectState {
  return { ...state, compactions: { ...state.compactions, [agentId]: mergeCompactions(state.compactions[agentId] ?? [], markers) } };
}

/** Replaces the side conversation with a loaded list (nothing is pending after a reload unless `pending` is kept). */
export function withSideMessages(state: ProjectState, messages: SideMessage[]): ProjectState {
  return { ...state, side: { messages: [...messages].sort((a, b) => a.id - b.id), pending: state.side.pending, error: state.side.error } };
}

/** Records a question the harness accepted and marks its answer as pending. */
export function withSideAsked(state: ProjectState, started: SideStarted): ProjectState {
  const rest = state.side.messages.filter((m) => m.id !== started.message.id);
  return { ...state, side: { messages: [...rest, started.message], pending: { side_id: started.side_id, text: "" }, error: null } };
}

export function withSideCleared(state: ProjectState): ProjectState {
  return { ...state, side: emptySide() };
}

export function withNotes(state: ProjectState, notes: Note[]): ProjectState {
  return { ...state, notes };
}

export function childrenOf(state: ProjectState, agentId: string): Agent[] {
  return state.agentOrder.map((id) => state.agents[id]).filter((a): a is Agent => a !== undefined && a.parent_id === agentId);
}

export function ancestorsOf(state: ProjectState, agentId: string): Agent[] {
  const chain: Agent[] = [];
  const seen = new Set<string>([agentId]);
  let parentId = state.agents[agentId]?.parent_id ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    const parent: Agent | undefined = state.agents[parentId];
    if (!parent) break;
    chain.unshift(parent);
    seen.add(parentId);
    parentId = parent.parent_id;
  }
  return chain;
}

export function agentBySpawnToolUse(state: ProjectState, toolUseId: string): Agent | undefined {
  return Object.values(state.agents).find((a) => a.spawn_tool_use_id === toolUseId);
}

export function descendantCount(state: ProjectState, agentId: string): number {
  return childrenOf(state, agentId).reduce((sum, child) => sum + 1 + descendantCount(state, child.id), 0);
}

export function toolResultFor(messages: Message[], toolUseId: string): Extract<ContentBlock, { type: "tool_result" }> | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_result" && block.tool_use_id === toolUseId) return block;
    }
  }
  return undefined;
}

export function totalTokens(state: ProjectState): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const agent of Object.values(state.agents)) {
    input += agent.input_tokens;
    output += agent.output_tokens;
  }
  return { input, output };
}
