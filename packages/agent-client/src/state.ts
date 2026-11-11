import type {
  Agent,
  AgentActivity,
  Approval,
  BridgeEvent,
  CompactionMarker,
  ContentBlock,
  FileChange,
  InputRequest,
  Message,
  Note,
  PlanEntry,
  QueuedMessage,
  SideMessage,
  SideStarted,
  Task,
  TurnStatus,
} from "./types";

/** The project's side conversation (decision 40): kept apart from every agent's messages. */
export type SideState = {
  messages: SideMessage[];
  /** The answer in flight: its `side_id` and the text streamed so far. */
  pending: { side_id: string; text: string } | null;
  /** The last question that failed; cleared by the next question. */
  error: { side_id: string; message: string } | null;
};

/** What waits for the user (v7): pending approvals and open forms, from events or a reload. */
export type AttentionState = {
  needs_you: boolean;
  approvals: number;
  inputs: number;
  /** `failed` after a failed turn (until the next one starts), with its `error`; absent before any turn. */
  state?: "none" | "failed";
  error?: string;
};

/** A form that was answered, kept so its card can collapse to "provided" lines (never holds secret values). */
export type AnsweredInput = {
  status: "submitted" | "skipped" | "cancelled";
  provided: string[];
  values: Record<string, string | boolean>;
};

/** A tool call in flight; the optional fields come from tool.updated (ACP). */
export type ActiveTool = { name: string; status?: string; title?: string; locations?: string[]; summary?: string };

export type ProjectState = {
  agents: Record<string, Agent>;
  agentOrder: string[];
  messages: Record<string, Message[]>;
  streaming: Record<string, string>;
  activeTools: Record<string, Record<string, ActiveTool>>;
  /** What each agent is doing now (agent.activity); `idle` once its turn ended. */
  activity: Record<string, AgentActivity>;
  /** The reasoning streamed during the running turn, per agent; dropped at turn.finished. */
  thinking: Record<string, string>;
  /** The latest plan per agent (agent.plan, or the agent row's). */
  plan: Record<string, PlanEntry[]>;
  notes: Note[];
  /** Compaction markers per agent id, ordered by `upto_message_id`. */
  compactions: Record<string, CompactionMarker[]>;
  side: SideState;
  /** v7: changes recorded by events, by turn id (oldest first); refetch listChanges for the net per-file view. */
  changes: Record<number, FileChange[]>;
  /** v7: pending approvals, oldest first. */
  approvals: Approval[];
  /** v7: open forms, oldest first, and the answered ones by form id. */
  inputs: InputRequest[];
  answeredInputs: Record<string, AnsweredInput>;
  /** v7: the message queue. */
  queue: { paused: boolean; messages: QueuedMessage[] };
  attention: AttentionState;
  /** M1: task records by id (from task.updated events and withTasks). */
  tasks: Record<string, Task>;
  /** M1: bumped when a memory file was written, deleted or renamed (refetch listMemory). */
  memoryRevision: number;
  /** v7: bumped when secrets were stored or deleted (refetch listSecrets). */
  secretsRevision: number;
  /** Bumped when what can run a model changed (`providers.updated`): refetch `listProviders`. */
  providersRevision: number;
  lastSeq: number;
  lastTurn: { status: TurnStatus; error: string | null; hint?: string } | null;
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
    activity: {},
    thinking: {},
    plan: {},
    notes: [],
    compactions: {},
    side: emptySide(),
    changes: {},
    approvals: [],
    inputs: [],
    answeredInputs: {},
    queue: { paused: false, messages: [] },
    attention: { needs_you: false, approvals: 0, inputs: 0 },
    tasks: {},
    memoryRevision: 0,
    secretsRevision: 0,
    providersRevision: 0,
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
  // The agent row carries the stored plan (null once a new turn cleared it): the state follows it when it is present.
  let plan = state.plan;
  if (agent.plan !== undefined) plan = agent.plan && agent.plan.length > 0 ? { ...state.plan, [agent.id]: agent.plan } : omitKey(state.plan, agent.id);
  return {
    ...state,
    plan,
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
    case "message.updated": {
      const list = state.messages[event.message.agent_id] ?? [];
      const next = list.map((m) => (m.id === event.message.id ? event.message : m));
      return { ...state, messages: { ...state.messages, [event.message.agent_id]: next } };
    }
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
    case "message.thinking_delta":
      return { ...state, thinking: { ...state.thinking, [event.agent_id]: (state.thinking[event.agent_id] ?? "") + event.text } };
    case "agent.plan":
      return { ...state, plan: { ...state.plan, [event.agent_id]: event.entries } };
    case "agent.activity": {
      const { kind, label, tool_use_id } = event;
      const next: AgentActivity = tool_use_id === undefined ? { kind, label } : { kind, label, tool_use_id };
      return { ...state, activity: { ...state.activity, [event.agent_id]: next } };
    }
    case "tool.updated": {
      const tools = state.activeTools[event.agent_id] ?? {};
      const known = tools[event.tool_use_id];
      if (!known) return state;
      const merged: ActiveTool = { ...known };
      if (event.status !== undefined) merged.status = event.status;
      if (event.title !== undefined) merged.title = event.title;
      if (event.locations !== undefined) merged.locations = event.locations;
      if (event.summary !== undefined) merged.summary = event.summary;
      return { ...state, activeTools: { ...state.activeTools, [event.agent_id]: { ...tools, [event.tool_use_id]: merged } } };
    }
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
        thinking: {},
        activity: {},
        lastTurn: { status: event.status, error: event.error, ...(event.hint ? { hint: event.hint } : {}) },
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
    case "change.recorded": {
      const list = state.changes[event.turn_id] ?? [];
      if (list.some((c) => c.id === event.change.id)) return state;
      return { ...state, changes: { ...state.changes, [event.turn_id]: [...list, event.change] } };
    }
    case "approval.requested":
      if (state.approvals.some((a) => a.id === event.approval.id)) return state;
      return { ...state, approvals: [...state.approvals, event.approval] };
    case "approval.resolved":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== event.id) };
    case "input.requested":
      if (state.inputs.some((i) => i.id === event.input.id)) return state;
      return { ...state, inputs: [...state.inputs, event.input] };
    case "input.resolved":
      return {
        ...state,
        inputs: state.inputs.filter((i) => i.id !== event.id),
        answeredInputs: { ...state.answeredInputs, [event.id]: { status: event.status, provided: event.provided, values: event.values } },
      };
    case "queue.updated":
      return { ...state, queue: { paused: event.paused, messages: event.messages } };
    case "project.attention": {
      // An event without `state` (approval counts) keeps the last state of the turn.
      const attention: AttentionState = { needs_you: event.needs_you, approvals: event.approvals, inputs: event.inputs };
      const from = event.state === undefined ? state.attention : event;
      if (from.state !== undefined) attention.state = from.state;
      if (from.error !== undefined) attention.error = from.error;
      return { ...state, attention };
    }
    case "providers.updated":
      return { ...state, providersRevision: state.providersRevision + 1 };
    case "secrets.changed":
      return { ...state, secretsRevision: state.secretsRevision + 1 };
    case "task.updated": {
      if (event.task) return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } };
      if (event.deleted && event.task_id !== undefined) return { ...state, tasks: omitKey(state.tasks, event.task_id) };
      return state;
    }
    case "memory.updated":
      return { ...state, memoryRevision: state.memoryRevision + 1 };
    case "project.updated":
    case "file.changed":
    case "review.updated": // reviews are loaded through their own API
    case "settings.changed": // not about this project
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

/** Replaces the pending approvals with a loaded list (after a reload). */
export function withApprovals(state: ProjectState, approvals: Approval[]): ProjectState {
  return { ...state, approvals: [...approvals].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
}

/** Replaces the open forms with a loaded list (after a reload); answered forms are kept. */
export function withInputs(state: ProjectState, inputs: InputRequest[]): ProjectState {
  return { ...state, inputs: [...inputs].sort((a, b) => a.created_at.localeCompare(b.created_at)) };
}

/** Replaces the queue with a loaded one (GET .../queue). */
export function withQueue(state: ProjectState, queue: { paused: boolean; messages: QueuedMessage[] }): ProjectState {
  return { ...state, queue };
}

/** Replaces the task records with a loaded list (GET .../tasks). */
export function withTasks(state: ProjectState, tasks: Task[]): ProjectState {
  return { ...state, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}
