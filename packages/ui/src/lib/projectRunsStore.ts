import type { RunsState } from "./commands/runs";

/**
 * The project's own command runs (decision 68) in a tiny external store, one per project, so the top row's buttons, the
 * "Run: name" tabs and the status bar read one state without importing each other. The value is the commands feature's
 * `RunsState`; only that feature knows how to fold events into it and start a run. Used by lazy chunks only: the initial
 * bundle learns the state of the run tabs through `WorkspaceValue.runStatuses`.
 */
export type RunsStore = {
  get(): RunsState;
  subscribe(cb: () => void): () => void;
  update(fn: (s: RunsState) => RunsState): void;
};

const EMPTY: RunsState = { byId: {}, order: [] };

function createRunsStore(): RunsStore {
  let state = EMPTY;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    update: (fn) => {
      const next = fn(state);
      if (next === state) return;
      state = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

const stores = new Map<string, RunsStore>();

/** The store of a project (made on first use; a few bytes per project opened in this window). */
export function runsStoreFor(projectId: string): RunsStore {
  let store = stores.get(projectId);
  if (!store) {
    store = createRunsStore();
    stores.set(projectId, store);
  }
  return store;
}
