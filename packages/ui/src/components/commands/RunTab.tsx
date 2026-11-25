import { useCallback, useEffect, useMemo, useState } from "react";
import { isRunning, runsFor, runsReducer } from "../../lib/commands/runs";
import { errorMessage } from "../../lib/format";
import { useProjectRunsState, useRunsStore } from "../../state/projectRuns";
import { RunPanel } from "./RunPanel";
import { RunsContextProvider } from "./RunsContext";
import { startProjectRun } from "./startRun";
import { useCommandsApi } from "./useCommandsApi";

/**
 * The "Run: name" tab (decision 68): the runs of one project command with the output of the selected one, Stop while it runs
 * and Re-run after it. It is the review's run panel (`RunPanel`) filling a tab, fed from the project's run store instead of
 * a review's runs. Commands run in the project's own folder and only when the user asks.
 */
export default function RunTab({ name }: { name: string }) {
  const api = useCommandsApi();
  const store = useRunsStore();
  const state = useProjectRunsState();
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runs = useMemo(() => runsFor(state, undefined).filter((v) => v.run.name.toLowerCase() === name.toLowerCase()), [state, name]);
  const current = runs.find((v) => v.run.id === selected) ?? runs[0] ?? null;
  const currentId = current?.run.id ?? null;
  const needsTail = current !== null && current.output === "" && current.run.output_bytes > 0;

  useEffect(() => {
    if (!api || !store || !currentId || !needsTail) return;
    let alive = true;
    api.get(currentId).then(
      (run) => alive && store.update((s) => runsReducer(s, { type: "tail", run })),
      () => undefined, // the tab shows the status without the output; Re-run is one click away
    );
    return () => {
      alive = false;
    };
  }, [api, store, currentId, needsTail]);

  const start = useCallback(
    async (n: string) => {
      if (!api || !store) return;
      setError(null);
      const r = await startProjectRun(api, store, n);
      if ("runId" in r) setSelected(r.runId);
      else setError(r.problem);
    },
    [api, store],
  );
  const stop = useCallback(
    async (id: string) => {
      if (!api || !store) return;
      try {
        const run = await api.stop(id);
        store.update((s) => runsReducer(s, { type: "tail", run }));
      } catch (e) {
        setError(`Could not stop it: ${errorMessage(e).replace(/\.$/, "")}. Try Stop again.`);
      }
    },
    [api, store],
  );

  const value = useMemo(
    () => ({
      offered: [],
      runs,
      current,
      running: new Set(runs.filter((v) => isRunning(v.run)).map((v) => v.run.name.toLowerCase())),
      panelOpen: true,
      error,
      start,
      stop,
      select: setSelected,
      openPanel: () => undefined,
      closePanel: () => undefined,
      clearError: () => setError(null),
      api,
      worktreePresent: true,
      reviewId: "",
    }),
    [runs, current, error, start, stop, api],
  );
  return (
    <RunsContextProvider value={value}>
      <RunPanel tab={name} />
    </RunsContextProvider>
  );
}
