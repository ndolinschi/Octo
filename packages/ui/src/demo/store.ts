import type { Agent, BridgeEvent, Message, Note, Project, SubscribeHandlers } from "@octo/agent-client";

type EventBody = BridgeEvent extends infer E ? (E extends BridgeEvent ? Omit<E, "seq"> : never) : never;

/** In-memory file: `size` overrides the content length (to simulate files too large to load). */
export type DemoFile = { content: string; mtime: string; binary?: boolean; size?: number };

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
  /** folder label → folder-relative path → file. Directories are implied by paths. */
  files: Map<string, Map<string, DemoFile>>;
  /** Folder labels whose sample content has been loaded (see `ensureSeeded`). */
  seeded: Set<string>;
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

/** Writes a demo file and announces it like the harness does after a save or an agent write. */
export function writeDemoFile(
  rec: ProjectRecord,
  folder: string,
  path: string,
  content: string,
  source: "user" | "agent",
  at = Date.now(),
): DemoFile {
  const tree = rec.files.get(folder) ?? new Map<string, DemoFile>();
  rec.files.set(folder, tree);
  const previous = tree.get(path);
  // Every write gets a fresh mtime, even within the same millisecond.
  let t = at;
  if (previous && Date.parse(previous.mtime) >= t) t = Date.parse(previous.mtime) + 1;
  const file: DemoFile = { content, mtime: new Date(t).toISOString() };
  tree.set(path, file);
  emit(rec, { type: "file.changed", folder, path, source });
  return file;
}
