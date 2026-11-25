import type { BridgeEvent, CommandRun } from "@octo/agent-client";

/** Output kept in memory per run; the harness caps a run at 5 MB, the panel keeps the end of it. */
export const OUTPUT_KEEP = 256 * 1024;

export type RunView = { run: CommandRun; output: string; /** Earlier output was dropped from the front. */ clipped: boolean };
export type RunsState = { byId: Readonly<Record<string, RunView>>; order: readonly string[] };

export const emptyRuns: RunsState = { byId: {}, order: [] };

export type RunsAction = { type: "event"; event: BridgeEvent } | { type: "loaded"; runs: readonly CommandRun[] } | { type: "tail"; run: CommandRun };

function appendOutput(view: RunView, text: string): RunView {
  const joined = view.output + text;
  if (joined.length <= OUTPUT_KEEP) return { ...view, output: joined };
  return { ...view, output: joined.slice(joined.length - OUTPUT_KEEP), clipped: true };
}

function put(state: RunsState, run: CommandRun, output?: string): RunsState {
  const known = state.byId[run.id];
  const view: RunView = known ? { ...known, run: { ...known.run, ...run } } : { run, output: output ?? "", clipped: false };
  const order = known ? state.order : [run.id, ...state.order];
  return { byId: { ...state.byId, [run.id]: output !== undefined && known?.output === "" ? { ...view, output } : view }, order };
}

/** Newest first by start time, stable. */
function sorted(state: RunsState): RunsState {
  const order = [...state.order].sort((a, b) => Date.parse(state.byId[b]?.run.started_at ?? "") - Date.parse(state.byId[a]?.run.started_at ?? ""));
  return { ...state, order };
}

/** Folds `command.*` events and loaded run lists into the runs the panel shows. Output of unknown runs is not kept. */
export function runsReducer(state: RunsState, action: RunsAction): RunsState {
  switch (action.type) {
    case "loaded":
      return sorted(action.runs.reduce((s, r) => put(s, r), state));
    case "tail":
      // A tail is the end of what a run printed: it fills a run whose live output this panel never saw.
      return put(state, action.run, action.run.tail ?? "");
    case "event": {
      const e = action.event;
      if (e.type === "command.started") return sorted(put(state, e.run));
      if (e.type === "command.output") {
        const view = state.byId[e.run_id];
        return view ? { ...state, byId: { ...state.byId, [e.run_id]: appendOutput(view, e.text) } } : state;
      }
      if (e.type === "command.finished") {
        const view = state.byId[e.run_id];
        if (!view) return state;
        const { pid: _pid, ...rest } = view.run;
        void _pid;
        const run: CommandRun = {
          ...rest,
          status: e.status,
          exit_code: e.exit_code,
          duration_ms: e.duration_ms,
          finished_at: view.run.finished_at ?? new Date().toISOString(),
        };
        return { ...state, byId: { ...state.byId, [e.run_id]: { ...view, run } } };
      }
      return state;
    }
  }
}

/** Runs of one review (or of no review when `reviewId` is undefined), newest first. */
export function runsFor(state: RunsState, reviewId: string | undefined): RunView[] {
  return state.order.flatMap((id) => {
    const v = state.byId[id];
    return v && v.run.review_id === reviewId ? [v] : [];
  });
}

export const isRunning = (r: Pick<CommandRun, "status">): boolean => r.status === "running";
