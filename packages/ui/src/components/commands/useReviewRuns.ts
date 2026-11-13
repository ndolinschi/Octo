import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { ProjectCommand } from "@octo/agent-client";
import { menuOrder } from "../../lib/commands/config";
import type { CommandsApi } from "../../lib/commands/api";
import { emptyRuns, isRunning, runsFor, runsReducer, type RunView } from "../../lib/commands/runs";
import { errorMessage } from "../../lib/format";
import { useProject } from "../../state/project";

/** The project commands a review offers: its configured names (decision 78), or all of them when none are configured. */
export function offeredCommands(all: readonly ProjectCommand[], names: readonly string[] | undefined): ProjectCommand[] {
  const want = new Set((names ?? []).map((n) => n.toLowerCase()));
  return menuOrder(want.size === 0 ? all : all.filter((c) => want.has(c.name.toLowerCase())));
}

/**
 * The runs of one review: loaded once, then folded from `command.*` events (no polling). Starting a run opens the panel on
 * it; a run's output that this panel never saw (opened later, or from history) is read from the run's tail.
 */
export function useReviewRuns(api: CommandsApi | null, reviewId: string) {
  const { project, onEvent } = useProject();
  const [state, dispatch] = useReducer(runsReducer, emptyRuns);
  const [selected, setSelected] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    api.list(reviewId).then(
      (runs) => alive && dispatch({ type: "loaded", runs }),
      (e: unknown) => alive && setError(`Earlier runs did not load: ${errorMessage(e).replace(/\.$/, "")}.`),
    );
    return () => {
      alive = false;
    };
  }, [api, reviewId]);

  useEffect(() => onEvent((event) => dispatch({ type: "event", event })), [onEvent]);

  const runs: RunView[] = useMemo(() => runsFor(state, reviewId), [state, reviewId]);
  const current = runs.find((r) => r.run.id === selected) ?? runs[0] ?? null;
  const currentId = current?.run.id ?? null;
  const needsTail = current !== null && current.output === "" && current.run.output_bytes > 0;

  useEffect(() => {
    if (!api || !currentId || !needsTail) return;
    let alive = true;
    api.get(currentId).then(
      (run) => alive && dispatch({ type: "tail", run }),
      () => undefined, // the panel then shows the status without the output; Re-run is one click away
    );
    return () => {
      alive = false;
    };
  }, [api, currentId, needsTail]);

  const start = useCallback(
    async (name: string) => {
      if (!api) return;
      setError(null);
      try {
        const r = await api.run(name, reviewId);
        dispatch({ type: "event", event: { type: "command.started", seq: 0, run: r.run } });
        setSelected(r.run.id);
        setPanelOpen(true);
      } catch (e) {
        setError(`${name} did not start: ${errorMessage(e).replace(/\.$/, "")}.`);
        setPanelOpen(true);
      }
    },
    [api, reviewId],
  );

  const stop = useCallback(
    async (id: string) => {
      if (!api) return;
      try {
        dispatch({ type: "tail", run: await api.stop(id) });
      } catch (e) {
        setError(`Could not stop it: ${errorMessage(e).replace(/\.$/, "")}. Try Stop again.`);
      }
    },
    [api],
  );

  const offered = useMemo(() => offeredCommands(project?.commands ?? [], project?.review?.commands), [project?.commands, project?.review?.commands]);
  const running = useMemo(() => new Set(runs.filter((r) => isRunning(r.run)).map((r) => r.run.name.toLowerCase())), [runs]);

  return {
    offered,
    runs,
    current,
    running,
    panelOpen,
    error,
    start,
    stop,
    select: setSelected,
    openPanel: () => setPanelOpen(true),
    closePanel: () => setPanelOpen(false),
    clearError: () => setError(null),
  };
}
