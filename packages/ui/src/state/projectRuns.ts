import { useSyncExternalStore } from "react";
import type { RunsState } from "../lib/commands/runs";
import { runsStoreFor, type RunsStore } from "../lib/projectRunsStore";
import { useProject } from "./project";

export type { RunsStore };

/** The open project's run store (decision 68). */
export function useRunsStore(): RunsStore {
  return runsStoreFor(useProject().projectId);
}

/** A derived value of the runs. `select` must return a primitive (a count, a name): the component re-renders only when it changes. */
export function useRunsSelector<T extends string | number | boolean | null>(select: (s: RunsState) => T): T {
  const store = useRunsStore();
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** The project's runs as they are now; re-renders on every change (output chunks included), so read it where that is cheap. */
export function useProjectRunsState(): RunsState {
  const store = useRunsStore();
  return useSyncExternalStore(store.subscribe, store.get);
}
