/** Pure parts of the project's own command runs (decision 68): the runs started from the top row, not those of a review. */
import type { CommandRun } from "@octo/agent-client";
import type { RunsState } from "./commands/runs";

/** Runs of the project itself (no review), newest first. */
export function projectRuns(state: RunsState): CommandRun[] {
  return state.order.flatMap((id) => {
    const v = state.byId[id];
    return v && v.run.review_id === undefined ? [v.run] : [];
  });
}

/** Runs that are running now, newest first. */
export function runningRuns(state: RunsState): CommandRun[] {
  return projectRuns(state).filter((r) => r.status === "running");
}

/** What a "Run: name" tab shows: a running spinner, a failed mark, or nothing (passed, stopped, never run). Judged by the latest run. */
export function runTabStatus(state: RunsState, name: string): "running" | "failed" | null {
  const key = name.toLowerCase();
  const latest = projectRuns(state).find((r) => r.name.toLowerCase() === key);
  if (!latest) return null;
  if (latest.status === "running") return "running";
  return latest.status === "error" || (latest.status === "finished" && latest.exit_code !== 0) ? "failed" : null;
}

/** "1 running" / "3 running"; null when none (the status bar shows nothing). */
export function runningText(n: number): string | null {
  return n > 0 ? `${n} running` : null;
}
