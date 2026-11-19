import type { Bridge, TurnChanges } from "@octo/agent-client";

/*
 * The project's recorded changes by turn (`listChanges`), read once and shared by every turn's "N files changed" line
 * (`chat/TurnChanges`), read again when a change is recorded. Here, not in the chat chunk, so a project switched to is read
 * with them before it is shown (decision 98, `projectPreload`).
 */

/** `reader`: the project view that last asked; a new one (the project shown again) reads again, showing what it had meanwhile. */
export type TurnChangesEntry = {
  data: TurnChanges[] | null;
  loading: Promise<void> | null;
  stale: boolean;
  reader: object | null;
  listeners: Set<() => void>;
};
const entries = new WeakMap<object, Map<string, TurnChangesEntry>>();

export function turnChangesEntry(bridge: Bridge, projectId: string): TurnChangesEntry {
  // Keyed by the read itself: a session's bridge (`sessionBridge`, a new object per conversation) shares the project's.
  const key = bridge.listChanges ?? bridge;
  let byProject = entries.get(key);
  if (!byProject) {
    byProject = new Map<string, TurnChangesEntry>();
    entries.set(key, byProject);
  }
  let e = byProject.get(projectId);
  if (!e) byProject.set(projectId, (e = { data: null, loading: null, stale: true, reader: null, listeners: new Set() }));
  return e;
}

/** Reads the list when it is stale (or `reader` is new); resolves when the read in flight (if any) is done. */
export function loadTurnChanges(bridge: Bridge, projectId: string, e = turnChangesEntry(bridge, projectId), reader?: object): Promise<void> {
  if (reader !== undefined && e.reader !== reader) {
    e.reader = reader;
    e.stale = true;
  }
  if (e.loading || !e.stale || !bridge.listChanges) return e.loading ?? Promise.resolve();
  e.stale = false;
  const done = (data: TurnChanges[] | null) => {
    e.loading = null;
    if (data) e.data = data;
    for (const l of e.listeners) l();
    // A change recorded while reading: read again.
    if (e.stale) void loadTurnChanges(bridge, projectId, e);
  };
  e.loading = bridge.listChanges(projectId).then(done, () => done(null));
  return e.loading;
}
