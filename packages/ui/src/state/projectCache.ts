import { sessionRoot, type Project, type ProjectState, type QueueState } from "@octo/agent-client";
import type { Codec } from "../lib/storage";
import type { StoredEndingLookup } from "../lib/storedEndings";

/**
 * What a conversation reads for itself besides the project state, kept with the project so a switch back paints it at once:
 * the queue its composer shows (`QueueSlot`) and how each request ended (the transcript's stored endings), by session id
 * ("" for the queue without parallel sessions; the endings' own session otherwise).
 */
export type ProjectKept = {
  queues: Map<string, QueueState>;
  endings: Map<string, StoredEndingLookup>;
  /**
   * The project's files as last walked (`state/fileWalk`), by folder: file links in prose resolve with them until this view's
   * walk is done.
   */
  files: Map<string, readonly string[]>;
};

/**
 * What a project's provider knew when it last ran (UI decision 98: switching projects). A switch to a project read before
 * paints this at once, complete, and reads everything again behind it (as after a reopened stream, A11).
 */
export type ProjectSnapshot = {
  project: Project;
  state: ProjectState;
  /** The agents whose conversations were asked for. */
  loaded: ReadonlySet<string>;
  kept: ProjectKept;
};

/** How many projects are kept: the ones a person switches between. */
export const KEEP = 8;

/** One map per bridge (another harness, or the demo, never sees these). */
const stores = new WeakMap<object, Map<string, ProjectSnapshot>>();

export function projectSnapshots(bridge: object): Map<string, ProjectSnapshot> {
  let map = stores.get(bridge);
  if (!map) stores.set(bridge, (map = new Map<string, ProjectSnapshot>()));
  return map;
}

/** Sets `key` in `map`; past KEEP projects the others go (they are read again when shown, as the first time). */
export function keepLatest<T>(map: Map<string, T>, key: string, value: T): void {
  if (!map.has(key) && map.size >= KEEP) map.clear();
  map.set(key, value);
}

/** The session a project's Chat showed last (`PREFS.lastSession`), as plain text; nothing stored is null. */
export const lastSessionCodec: Codec<string | null> = { parse: (raw) => (raw && raw.trim() !== "" ? raw : null), stringify: (v) => v ?? "" };

/**
 * Whether a switch can paint the route's conversation complete at once: the project was read before and the conversation's
 * messages are in (the route's agent, its session's root, else the orchestrator's; a route without a session opens the one
 * shown last, which was read when it was shown).
 */
export function canPaint(
  snapshot: { project: Pick<Project, "orchestrator_agent_id">; state: ProjectState } | undefined,
  route: { agentId: string | null; sessionId: string | null },
): boolean {
  if (!snapshot) return false;
  const { state, project } = snapshot;
  const agentId = route.agentId ?? ((route.sessionId && sessionRoot(state, route.sessionId)) || project.orchestrator_agent_id);
  return state.messages[agentId] !== undefined;
}
