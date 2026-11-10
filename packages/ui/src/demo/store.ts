import type { Agent, BridgeEvent, Message, Note, Project, SubscribeHandlers } from "@octo/agent-client";

type EventBody = BridgeEvent extends infer E ? (E extends BridgeEvent ? Omit<E, "seq"> : never) : never;

export type ProjectRecord = {
  project: Project;
  agents: Agent[];
  messages: Message[];
  notes: Note[];
  streaming: Map<string, string>;
  activeTools: Map<string, { agentId: string; name: string }>;
  listeners: Set<SubscribeHandlers>;
  seq: number;
  nextMessageId: number;
  turn: { cancelled: boolean } | null;
};

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export function emit(rec: ProjectRecord, body: EventBody): void {
  rec.seq += 1;
  const event = { ...body, seq: rec.seq } as BridgeEvent;
  for (const l of rec.listeners) l.onEvent(event);
}

export function agentById(rec: ProjectRecord, id: string): Agent {
  const agent = rec.agents.find((a) => a.id === id);
  if (!agent) throw new Error(`unknown agent ${id}`);
  return agent;
}

export function orchestratorOf(rec: ProjectRecord): Agent {
  return agentById(rec, rec.project.orchestrator_agent_id);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
