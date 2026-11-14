import type { DemoNote } from "./notes";
import type { Agent, BridgeEvent, Message, Project, SubscribeHandlers } from "@octo/agent-client";

type EventBody = BridgeEvent extends infer E ? (E extends BridgeEvent ? Omit<E, "seq"> : never) : never;

/** In-memory file: `size` overrides the content length (to simulate files too large to load). */
export type DemoFile = { content: string; mtime: string; binary?: boolean; size?: number };

export type ProjectRecord = {
  project: Project;
  agents: Agent[];
  messages: Message[];
  notes: DemoNote[];
  streaming: Map<string, string>;
  activeTools: Map<string, { agentId: string; name: string }>;
  listeners: Set<SubscribeHandlers>;
  seq: number;
  nextMessageId: number;
  /** The default session's running turn (what the project routes stop). */
  turn: { cancelled: boolean } | null;
  /** Parallel sessions: the running turn of each main session, by its root agent id. */
  turns?: Map<string, { cancelled: boolean }>;
  /** How each root agent's latest turn ended (a session's resting state). */
  lastStatus?: Map<string, "completed" | "failed" | "cancelled">;
  /** Called when a turn of root `rootId` ended (the sessions layer starts what waited for a slot). */
  afterTurn?: (rootId: string) => void;
  /** folder label → folder-relative path → file. Directories are implied by paths. */
  files: Map<string, Map<string, DemoFile>>;
  /** Folder labels whose sample content has been loaded (see `ensureSeeded`). */
  seeded: Set<string>;
  /**
   * How each orchestrator request ended, as the harness stores it in the current session's exchanges (no error text: the
   * harness keeps none there, so a failed earlier turn after a reload has only what the transcript holds — NEW-1).
   */
  endings?: { turn_id: number; status: "completed" | "failed" | "stopped"; started_at: string; duration_ms: number }[];
};

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  // Deterministic, so a reload of the demo gets the same ids (saved layouts keep working).
  return `${prefix}_${idCounter.toString(36).padStart(4, "0")}`;
}

export function emit(rec: ProjectRecord, body: EventBody): void {
  rec.seq += 1;
  const event = { ...body, seq: rec.seq };
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
export function writeDemoFile(rec: ProjectRecord, folder: string, path: string, content: string, source: "user" | "agent", at = Date.now()): DemoFile {
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
