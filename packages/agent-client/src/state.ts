import type {
  Agent,
  AgentActivity,
  Approval,
  BridgeEvent,
  CompactionMarker,
  ContentBlock,
  FileChange,
  FormValue,
  InputRequest,
  Message,
  Note,
  PlanEntry,
  ProjectSession,
  QueuedMessage,
  SideMessage,
  SideStarted,
  Task,
  TurnStatus,
  ErrorFields,
  ErrorInfo,
} from "./types";

/** The project's side conversation (decision 40): kept apart from every agent's messages. */
export type SideState = {
  messages: SideMessage[];
  /** The answer in flight: its `side_id` and the text streamed so far. */
  /** `thinking` and `activity` (parity B13) are the live state of an ACP side answer; both are dropped when it ends. */
  pending: { side_id: string; text: string; thinking?: string; activity?: { kind: string; label: string; tool_use_id?: string } } | null;
  /** The last question that failed; cleared by the next question. */
  error: ({ side_id: string; message: string; code?: string } & ErrorFields) | null;
};

/** What waits for the user (v7): pending approvals and open forms, from events or a reload. */
export type AttentionState = ErrorFields & {
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
  values: Record<string, FormValue>;
};

/** A tool call in flight; the optional fields come from tool.updated (ACP). */
/** `started_at`: when the call started (from `tool.started`), for a live step timer; absent from older harnesses. */
export type ActiveTool = { name: string; status?: string; title?: string; locations?: string[]; summary?: string; started_at?: string };

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
  /** Project sessions: the sessions seen (`withSessions` loads them, `session.*` events keep them), newest first, and the current main one. */
  sessions: SessionsState;
  /** M1: task records by id (from task.updated events and withTasks). */
  tasks: Record<string, Task>;
  /** M1: bumped when a memory file was written, deleted or renamed (refetch listMemory). */
  memoryRevision: number;
  /** v7: bumped when secrets were stored or deleted (refetch listSecrets). */
  secretsRevision: number;
  /** Bumped when what can run a model changed (`providers.updated`): refetch `listProviders`. */
  providersRevision: number;
  lastSeq: number;
  lastTurn: TurnOutcome | null;
  /**
   * How each finished orchestrator turn ended, by the id of the request that started it, so failed and stopped turns
   * keep their own line when several end in a row. Only turns seen live are here.
   */
  turnOutcomes: Record<number, TurnOutcome>;
};

/**
 * Parallel sessions (spec section 9): what belongs to one main session and not to the project. The agent-keyed maps of
 * `ProjectState` stay as they are (each session's root is an agent); `scopeState` reads a session's view from them.
 */
export type SessionSlice = {
  /** Its root agent ("" until the harness gave it one). */
  rootAgentId: string;
  queue: { paused: boolean; messages: QueuedMessage[] };
  lastTurn: TurnOutcome | null;
  /** How each of its turns seen live ended, by the id of the request that started it. */
  turnOutcomes: Record<number, TurnOutcome>;
  /** Its failed state (`project.attention` with this `session_id`); the counts are its own approvals and forms. */
  attention: AttentionState;
};

/**
 * The sessions seen (`withSessions` loads them, `session.*` events keep them), newest first; the default main session
 * (`defaultId`; `currentId` is its old name, kept equal) and one slice per main session (`byId`).
 */
export type SessionsState = { list: ProjectSession[]; defaultId: string | null; currentId: string | null; byId: Record<string, SessionSlice> };

export type TurnOutcome = { status: TurnStatus; error: string | null; notice?: ErrorInfo } & ErrorFields;

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
    sessions: { list: [], defaultId: null, currentId: null, byId: {} },
    tasks: {},
    memoryRevision: 0,
    secretsRevision: 0,
    providersRevision: 0,
    lastSeq: 0,
    lastTurn: null,
    turnOutcomes: {},
  };
}

const MAX_CHANGES_TURNS = 200;
const MAX_ANSWERED_INPUTS = 200;
const MAX_TURN_OUTCOMES = 200;

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function omitKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>): Record<string, T> {
  if (keys.size === 0) return record;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!keys.has(k)) out[k] = v;
  }
  return out;
}

function capRecord<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  return Object.fromEntries(entries.slice(entries.length - max));
}

function capNumRecord<T>(record: Record<number, T>, max: number): Record<number, T> {
  const entries = Object.entries(record);
  if (entries.length <= max) return record;
  return Object.fromEntries(entries.slice(entries.length - max));
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

/** The id of the latest request of `root` (default: the first root agent): a user message with text, not a tool result. */
function lastRequestId(state: ProjectState, root = state.agentOrder.find((id) => state.agents[id]?.parent_id === null)): number | null {
  const list = root ? (state.messages[root] ?? []) : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.role === "user" && m.content.some((b) => b.type === "text")) return m.id;
  }
  return null;
}

/** An event without `state` (approval counts) keeps the last state of the turn. */
function nextAttention(prev: AttentionState, event: Extract<BridgeEvent, { type: "project.attention" }>): AttentionState {
  const attention: AttentionState = { needs_you: event.needs_you, approvals: event.approvals, inputs: event.inputs };
  const from = event.state === undefined ? prev : event;
  if (from.state !== undefined) attention.state = from.state;
  if (from.error !== undefined) attention.error = from.error;
  Object.assign(attention, errorFieldsOf(from));
  return attention;
}

function emptySlice(rootAgentId = ""): SessionSlice {
  return { rootAgentId, queue: { paused: false, messages: [] }, lastTurn: null, turnOutcomes: {}, attention: { needs_you: false, approvals: 0, inputs: 0 } };
}

/** Whether `sid` is the default session (or nothing says which session: an older harness, or no sessions known). */
function isDefault(state: ProjectState, sid: string | null | undefined): boolean {
  return sid === null || sid === undefined || state.sessions.defaultId === null || state.sessions.defaultId === sid;
}

/** Applies `fn` to the slice of `sid` (made when missing); nothing when no session is named. */
function withSlice(sessions: SessionsState, sid: string | null | undefined, fn: (slice: SessionSlice) => SessionSlice): SessionsState {
  if (sid === null || sid === undefined) return sessions;
  return { ...sessions, byId: { ...sessions.byId, [sid]: fn(sessions.byId[sid] ?? emptySlice()) } };
}

function withDefault(sessions: SessionsState, sid: string): SessionsState {
  const list = sessions.list.map((s) => {
    if (s.kind !== "main") return s;
    const on = s.id === sid;
    return s.current !== on || (s.default !== undefined && s.default !== on) ? { ...s, current: on, ...(s.default === undefined ? {} : { default: on }) } : s;
  });
  return { ...sessions, list, defaultId: sid, currentId: sid };
}

/** The main session an agent works in: its own `session_id`, else its root's. */
export function agentSession(state: ProjectState, agentId: string): string | null {
  const seen = new Set<string>();
  let id: string | null = agentId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const a: Agent | undefined = state.agents[id];
    if (!a) break;
    if (a.session_id) return a.session_id;
    id = a.parent_id;
  }
  const owner = Object.entries(state.sessions.byId).find(([, x]) => x.rootAgentId === agentId);
  return owner?.[0] ?? null;
}

/**
 * A turn ended. With `session_id` (schema 15) only that session's live parts (streamed text, reasoning, tools, activity of
 * its agents) go, and its outcome is filed under its own latest request; another session's stream keeps running. Without it
 * (an older harness) everything live goes, as before.
 */
function turnFinished(state: ProjectState, event: Extract<BridgeEvent, { type: "turn.finished" }>): ProjectState {
  const outcome: TurnOutcome = { status: event.status, error: event.error, ...errorFieldsOf(event), ...(event.notice ? { notice: event.notice } : {}) };
  const sid = event.session_id ?? null;
  const root = event.agent_id ?? (sid !== null ? state.sessions.byId[sid]?.rootAgentId : undefined) ?? undefined;
  const request = sid !== null && !root ? null : lastRequestId(state, root || undefined);
  const outcomes = (prev: Record<number, TurnOutcome>) => (request === null ? prev : capNumRecord({ ...prev, [request]: outcome }, MAX_TURN_OUTCOMES));
  if (sid === null) {
    return { ...state, streaming: {}, activeTools: {}, thinking: {}, activity: {}, lastTurn: outcome, turnOutcomes: outcomes(state.turnOutcomes) };
  }
  const mine = (id: string) => agentSession(state, id) === sid || id === root;
  const keep = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => !mine(id)));
  const sessions = withSlice(state.sessions, sid, (x) => ({
    ...x,
    ...(root ? { rootAgentId: root } : {}),
    lastTurn: outcome,
    turnOutcomes: outcomes(x.turnOutcomes),
  }));
  const top = isDefault(state, sid) ? { lastTurn: outcome, turnOutcomes: outcomes(state.turnOutcomes) } : {};
  return {
    ...state,
    ...top,
    streaming: keep(state.streaming),
    activeTools: keep(state.activeTools),
    thinking: keep(state.thinking),
    activity: keep(state.activity),
    sessions,
  };
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
      const next = list.some((m) => m.id === event.message.id)
        ? list.map((m) => (m.id === event.message.id ? event.message : m))
        : mergeMessages(list, [event.message]);
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
            [event.tool_use_id]: event.started_at ? { name: event.name, started_at: event.started_at } : { name: event.name },
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
      return turnFinished(state, event);
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
      const keep = state.side.pending?.side_id === event.side_id ? state.side.pending : null;
      return { ...state, side: { ...state.side, pending: { ...keep, side_id: event.side_id, text: prior + event.text } } };
    }
    case "side.thinking": {
      const cur = state.side.pending?.side_id === event.side_id ? state.side.pending : { side_id: event.side_id, text: "" };
      return { ...state, side: { ...state.side, pending: { ...cur, thinking: (cur.thinking ?? "") + event.text } } };
    }
    case "side.activity": {
      const cur = state.side.pending?.side_id === event.side_id ? state.side.pending : { side_id: event.side_id, text: "" };
      const activity: { kind: string; label: string; tool_use_id?: string } = { kind: event.kind, label: event.label };
      if (event.tool_use_id !== undefined) activity.tool_use_id = event.tool_use_id;
      return { ...state, side: { ...state.side, pending: { ...cur, activity } } };
    }
    case "side.tool":
      return state;
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
          error: event.error === "cancelled" ? state.side.error : sideError(event),
        },
      };
    }
    case "change.recorded": {
      const list = state.changes[event.turn_id] ?? [];
      if (list.some((c) => c.id === event.change.id)) return state;
      return { ...state, changes: capNumRecord({ ...state.changes, [event.turn_id]: [...list, event.change] }, MAX_CHANGES_TURNS) };
    }
    case "approval.requested":
      if (state.approvals.some((a) => a.id === event.approval.id)) return state;
      return { ...state, approvals: [...state.approvals, event.approval] };
    case "plan.created":
    case "plan.approved":
    case "conversation.rewound":
    case "message.steered":
    case "context.updated":
    case "slash_commands.updated":
    case "conversation.cleared":
      return state; // views refetch (the transcript); the new session arrives as session.created and session.current
    case "session.created":
      return { ...state, sessions: upsertSession(state.sessions, event.session) };
    case "session.updated":
      if (event.deleted && event.session_id !== undefined) {
        const gone = event.session_id;
        const rootId = state.sessions.byId[gone]?.rootAgentId;
        const evicted = new Set(state.agentOrder.filter((id) => agentSession(state, id) === gone || (rootId !== undefined && rootId !== "" && id === rootId)));
        const list = state.sessions.list.filter((s) => s.id !== gone);
        const defaultId = state.sessions.defaultId === gone ? null : state.sessions.defaultId;
        return {
          ...state,
          agents: omitKeys(state.agents, evicted),
          agentOrder: evicted.size === 0 ? state.agentOrder : state.agentOrder.filter((id) => !evicted.has(id)),
          messages: omitKeys(state.messages, evicted),
          streaming: omitKeys(state.streaming, evicted),
          activeTools: omitKeys(state.activeTools, evicted),
          activity: omitKeys(state.activity, evicted),
          thinking: omitKeys(state.thinking, evicted),
          plan: omitKeys(state.plan, evicted),
          compactions: omitKeys(state.compactions, evicted),
          sessions: { list, defaultId, currentId: defaultId, byId: omitKey(state.sessions.byId, gone) },
        };
      }
      return event.session ? { ...state, sessions: upsertSession(state.sessions, event.session) } : state;
    case "session.default":
    case "session.current":
      return { ...state, sessions: withDefault(state.sessions, event.session_id) };
    case "fact.remembered":
    case "fact.forgotten":
      return state; // views refetch (getLatestPlan, the transcript, getContext) or read the event themselves
    case "approval_rule.created":
    case "approval_rule.deleted":
      return state; // the rules are listed with listApprovalRules; a view refetches on these events
    case "approval.resolved":
      return { ...state, approvals: state.approvals.filter((a) => a.id !== event.id) };
    case "input.requested":
      if (state.inputs.some((i) => i.id === event.input.id)) return state;
      return { ...state, inputs: [...state.inputs, event.input] };
    case "input.resolved":
      return {
        ...state,
        inputs: state.inputs.filter((i) => i.id !== event.id),
        answeredInputs: capRecord(
          { ...state.answeredInputs, [event.id]: { status: event.status, provided: event.provided, values: event.values } },
          MAX_ANSWERED_INPUTS,
        ),
      };
    case "queue.updated": {
      const queue = { paused: event.paused, messages: event.messages };
      // Without `session_id` (an older harness) the queue is the default session's.
      const sid = event.session_id ?? state.sessions.defaultId;
      const top = isDefault(state, sid) ? { queue } : {};
      return { ...state, ...top, sessions: withSlice(state.sessions, sid, (x) => ({ ...x, queue })) };
    }
    case "project.attention": {
      const sid = event.session_id ?? null;
      const attention = nextAttention(state.attention, event);
      // A session's failed state goes to its slice; the project-wide counts (no `session_id`) stay the project's.
      if (sid === null) return { ...state, attention };
      const sessions = withSlice(state.sessions, sid, (x) => ({ ...x, attention: nextAttention(x.attention, event) }));
      return { ...state, ...(isDefault(state, sid) ? { attention } : {}), sessions };
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
    case "workspace.updated":
    case "file.changed":
    case "review.updated": // reviews are loaded through their own API
    case "review.list_updated":
    case "review.workspace":
    case "command.started": // runs are loaded through their own API
    case "command.output":
    case "command.finished":
    case "settings.changed": // not about this project
      return state;
  }
}

/** Resets `lastSeq` to 0 after a reconnect or full reload so a restarted harness stream is accepted cleanly. */
export function resetEventSeq(state: ProjectState): ProjectState {
  return state.lastSeq === 0 ? state : { ...state, lastSeq: 0 };
}

/**
 * Applies a live stream event with duplicate-`seq` protection: ignores replayed events with `seq <= state.lastSeq`
 * within the same stream epoch, and resets cleanly when a restarted harness begins again at `seq === 1`.
 */
export function applyStreamEvent(state: ProjectState, event: BridgeEvent): ProjectState {
  if (event.seq > 0) {
    if (event.seq === 1 && state.lastSeq > 1) {
      const next = reduce(state, event);
      return { ...next, lastSeq: 1 };
    }
    if (event.seq <= state.lastSeq) return state;
  }
  const next = reduce(state, event);
  return { ...next, lastSeq: Math.max(next.lastSeq, event.seq) };
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

/**
 * After a re-read (a reconnect, the stream watchdog): the live parts of every agent that is not running any more —
 * streamed text, reasoning, tools in flight, activity — are dropped, because the `turn.finished` that would have cleared
 * them was missed and the stored messages now hold what they were showing. A running agent keeps them.
 */
export function settleStreams(state: ProjectState): ProjectState {
  const live = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => state.agents[id]?.status === "running"));
  return { ...state, streaming: live(state.streaming), thinking: live(state.thinking), activeTools: live(state.activeTools), activity: live(state.activity) };
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
  return state.agentOrder.map((id) => state.agents[id]).filter((a): a is Agent => a?.parent_id === agentId);
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

function countDescendants(state: ProjectState, agentId: string, seen: Set<string>): number {
  let sum = 0;
  for (const child of childrenOf(state, agentId)) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    sum += 1 + countDescendants(state, child.id, seen);
  }
  return sum;
}

export function descendantCount(state: ProjectState, agentId: string): number {
  return countDescendants(state, agentId, new Set([agentId]));
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

/** Replaces the queue with a loaded one (GET .../queue), keeping the default session slice in sync. */
export function withQueue(state: ProjectState, queue: { paused: boolean; messages: QueuedMessage[] }): ProjectState {
  return { ...state, queue, sessions: withSlice(state.sessions, state.sessions.defaultId, (x) => ({ ...x, queue })) };
}

/** Replaces the task records with a loaded list (GET .../tasks). */
function bySessionStart(a: ProjectSession, b: ProjectSession): number {
  return a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0;
}

/** Adds or replaces one session (newest first); a main session that is the default makes every other main session not. */
function upsertSession(sessions: SessionsState, session: ProjectSession): SessionsState {
  const on = session.kind === "main" && (session.default ?? session.current);
  const rest = sessions.list.filter((s) => s.id !== session.id);
  const list = [...rest, session].sort(bySessionStart);
  const byId = session.kind === "main" ? withRoot(sessions.byId, session) : sessions.byId;
  if (on) return withDefault({ ...sessions, list, byId }, session.id);
  const stillDefault = !(sessions.defaultId === session.id && session.kind === "main");
  return { ...sessions, list, byId, ...(stillDefault ? {} : { defaultId: null, currentId: null }) };
}

/** A main session's slice with its root agent as the session says (a slice is made for every main session seen). */
function withRoot(byId: Record<string, SessionSlice>, session: ProjectSession): Record<string, SessionSlice> {
  const prev = byId[session.id];
  const root = session.root_agent_id ?? "";
  if (prev && (root === "" || prev.rootAgentId === root)) return byId;
  return { ...byId, [session.id]: prev ? { ...prev, rootAgentId: root } : emptySlice(root) };
}

/** Loads sessions from `listSessions` (the list replaces the one in the state; the default main session is read from it when it is in the list). */
export function withSessions(state: ProjectState, list: ProjectSession[]): ProjectState {
  const sorted = [...list].sort(bySessionStart);
  const current = sorted.find((s) => s.kind === "main" && (s.default ?? s.current));
  let byId = state.sessions.byId;
  for (const s of sorted) if (s.kind === "main") byId = withRoot(byId, s);
  const defaultId = current?.id ?? state.sessions.defaultId;
  return { ...state, sessions: { list: sorted, defaultId, currentId: defaultId, byId } };
}

/** Whether the harness addresses main sessions one by one (schema 15: its sessions name a root agent and a default). */
export function hasParallelSessions(state: ProjectState): boolean {
  return state.sessions.list.some((s) => s.kind === "main" && s.default !== undefined);
}

/** The root agent of main session `sid`: its slice's, else the session record's; "" when neither names one yet. */
export function sessionRoot(state: ProjectState, sid: string): string {
  const fromSlice = state.sessions.byId[sid]?.rootAgentId ?? "";
  if (fromSlice !== "") return fromSlice;
  return state.sessions.list.find((s) => s.id === sid)?.root_agent_id ?? "";
}

/** Whether an approval or a form belongs to main session `sid` (one without a session is the default session's). */
function ofSession(state: ProjectState, item: { session_id?: string }, sid: string): boolean {
  return item.session_id ? item.session_id === sid : isDefault(state, sid);
}

/** The pending approvals of one main session (the project list keeps all of them for Home and the attention count). */
export function sessionApprovals(state: ProjectState, sid: string): Approval[] {
  return state.approvals.filter((a) => ofSession(state, a, sid));
}

/** The open forms of one main session. */
export function sessionInputs(state: ProjectState, sid: string): InputRequest[] {
  return state.inputs.filter((i) => ofSession(state, i, sid));
}

/**
 * The project state as one main session sees it: its queue, its last turn and turn outcomes, its approvals and forms and
 * its attention instead of the project's (the default session's). The agent-keyed maps are shared. The same object when
 * nothing is known about `sid` (no slice: an older harness).
 */
export function scopeState(state: ProjectState, sid: string): ProjectState {
  const slice = state.sessions.byId[sid];
  if (!slice) return state;
  const approvals = sessionApprovals(state, sid);
  const inputs = sessionInputs(state, sid);
  const attention: AttentionState = { ...slice.attention, approvals: approvals.length, inputs: inputs.length, needs_you: approvals.length + inputs.length > 0 };
  return { ...state, queue: slice.queue, lastTurn: slice.lastTurn, turnOutcomes: slice.turnOutcomes, approvals, inputs, attention };
}

/** A turn is about to start in `sid` (a send): its last outcome is cleared, like `lastTurn` for the project. */
export function withTurnCleared(state: ProjectState, sid: string | null): ProjectState {
  const sessions = sid === null ? state.sessions : withSlice(state.sessions, sid, (x) => ({ ...x, lastTurn: null }));
  return { ...state, sessions, ...(isDefault(state, sid) ? { lastTurn: null } : {}) };
}

/**
 * Whether `event` concerns main session `sid` (for a view of one session): an event that names another session (its
 * `session_id`, or its approval's or form's) does not; `session.*` events (about the list) and events that name no session
 * (project-wide: files, notes, settings…) do. `conversation.cleared` belongs to the session it cleared (`previous_session_id`).
 */
export function eventInSession(event: BridgeEvent, sid: string): boolean {
  if (event.type.startsWith("session.")) return true;
  if (event.type === "conversation.cleared") return !event.previous_session_id || event.previous_session_id === sid;
  const named =
    event.session_id ??
    (event.type === "approval.requested" ? event.approval.session_id : event.type === "input.requested" ? event.input.session_id : undefined);
  return !named || named === sid;
}

export function withTasks(state: ProjectState, tasks: Task[]): ProjectState {
  return { ...state, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])) };
}

/** The structured parts of an error event (hint, command, action, details), only those that are present. */
export function errorFieldsOf(src: ErrorFields): ErrorFields {
  const out: ErrorFields = {};
  if (src.hint) out.hint = src.hint;
  if (src.command) out.command = src.command;
  if (src.action) out.action = src.action;
  if (src.details) out.details = src.details;
  return out;
}

function sideError(event: { side_id: string; error: string; code?: string } & ErrorFields): { side_id: string; message: string; code?: string } & ErrorFields {
  const e: { side_id: string; message: string; code?: string } & ErrorFields = { side_id: event.side_id, message: event.error, ...errorFieldsOf(event) };
  if (event.code !== undefined) e.code = event.code;
  return e;
}
