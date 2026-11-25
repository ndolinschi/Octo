import type { CommandRun } from "@octo/agent-client";

/** "Running", "Passed", "Failed (exit 2)", "Stopped", "Could not run": the words of a run's state. */
export function runStatusText(run: Pick<CommandRun, "status" | "exit_code">): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "error":
      return "Could not run";
    case "finished":
      return run.exit_code === 0 ? "Passed" : `Failed (exit ${run.exit_code ?? "?"})`;
  }
}

export type RunTone = "run" | "ok" | "err" | "muted";

export function runTone(run: Pick<CommandRun, "status" | "exit_code">): RunTone {
  if (run.status === "running") return "run";
  if (run.status === "finished") return run.exit_code === 0 ? "ok" : "err";
  return run.status === "error" ? "err" : "muted";
}

/** "850 ms", "4.2 s", "2 min 5 s". */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** Terminal colour and cursor codes are not rendered; they would show as noise in a plain `<pre>`. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- the escape character is the thing being matched
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r(?!\n)/g, "\n");
}
