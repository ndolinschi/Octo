import type { CommandRun, WorkerProcess } from "@octo/agent-client";
import { runStatusText, runTone, type RunTone } from "../commands/format";
import { runsFor, type RunsState } from "../commands/runs";
import type { GlyphState } from "../stateGlyph";

export type ProcessFilter = "all" | "running" | "stopped";

export type ProcessItem =
  { kind: "command"; key: string; run: CommandRun; output: string; clipped: boolean } | { kind: "worker"; key: string; worker: WorkerProcess };

export const FILTERS: readonly { id: ProcessFilter; label: string; title: string }[] = [
  { id: "all", label: "All", title: "Every project command run and background worker" },
  { id: "running", label: "Running", title: "Active commands, dev servers, language servers and agent workers" },
  { id: "stopped", label: "Stopped", title: "Exited, stopped or failed processes" },
];

export function commandKey(runId: string): string {
  return `cmd:${runId}`;
}

export function workerKey(workerId: string): string {
  return `wrk:${workerId}`;
}

export function isProcessActive(item: ProcessItem): boolean {
  if (item.kind === "command") return item.run.status === "running";
  return true;
}

export function processName(item: ProcessItem): string {
  return item.kind === "command" ? item.run.name : item.worker.name;
}

export function processCommand(item: ProcessItem): string {
  return item.kind === "command" ? item.run.command : item.worker.command;
}

export function processPid(item: ProcessItem): number | undefined {
  if (item.kind === "command") return item.run.status === "running" && item.run.pid && item.run.pid > 0 ? item.run.pid : undefined;
  return item.worker.pid > 0 ? item.worker.pid : undefined;
}

export function processCwd(item: ProcessItem): string {
  return item.kind === "command" ? item.run.cwd : (item.worker.cwd ?? "");
}

export function processStartedAt(item: ProcessItem): string | undefined {
  return item.kind === "command" ? item.run.started_at : item.worker.started_at;
}

export function processKindLabel(item: ProcessItem): string {
  if (item.kind === "command") return "Command";
  return item.worker.kind === "lsp" ? "Language server" : "Agent worker";
}

export function processTone(item: ProcessItem): RunTone {
  if (item.kind === "command") return runTone(item.run);
  switch (item.worker.status) {
    case "running":
    case "busy":
      return "run";
    case "idle":
      return "ok";
  }
}

export function processGlyph(item: ProcessItem): GlyphState {
  if (item.kind === "command") {
    const t = runTone(item.run);
    return t === "run" ? "working" : t === "err" ? "failed" : "idle";
  }
  switch (item.worker.status) {
    case "running":
    case "busy":
      return "working";
    case "idle":
      return "idle";
  }
}

export function processStatusText(item: ProcessItem): string {
  if (item.kind === "command") return runStatusText(item.run);
  switch (item.worker.status) {
    case "running":
      return "Running";
    case "busy":
      return "Working";
    case "idle":
      return "Idle";
  }
}

export function canRestartProcess(_item: ProcessItem): boolean {
  return true;
}

/**
 * Combines project command runs (`runsFor(state, undefined)`) and harness worker subprocesses (`workers`)
 * with active items first (running commands newest first, then active workers), followed by stopped/exited items newest first.
 */
export function buildProcessList(state: RunsState, workers: readonly WorkerProcess[]): ProcessItem[] {
  const cmdItems: ProcessItem[] = runsFor(state, undefined).map((v) => ({
    kind: "command",
    key: commandKey(v.run.id),
    run: v.run,
    output: v.output,
    clipped: v.clipped,
  }));
  const workerItems: ProcessItem[] = workers.map((w) => ({
    kind: "worker",
    key: workerKey(w.id),
    worker: w,
  }));
  const activeCmds = cmdItems.filter(isProcessActive);
  const stoppedCmds = cmdItems
    .filter((i) => !isProcessActive(i))
    .sort((a, b) => {
      const ta = Date.parse(processStartedAt(a) ?? "") || 0;
      const tb = Date.parse(processStartedAt(b) ?? "") || 0;
      return tb - ta;
    });
  return [...activeCmds, ...workerItems, ...stoppedCmds];
}

export function processCounts(items: readonly ProcessItem[]): Record<ProcessFilter, number> {
  let running = 0;
  let stopped = 0;
  for (const item of items) {
    if (isProcessActive(item)) running += 1;
    else stopped += 1;
  }
  return { all: items.length, running, stopped };
}

export function filterProcesses(items: readonly ProcessItem[], filter: ProcessFilter, query: string): ProcessItem[] {
  const q = query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter === "running" && !isProcessActive(item)) return false;
    if (filter === "stopped" && isProcessActive(item)) return false;
    if (!q) return true;
    const pid = processPid(item);
    const hay = `${processName(item)} ${processCommand(item)} ${processCwd(item)} ${processKindLabel(item)} ${pid ? `pid ${pid} ${pid}` : ""}`.toLowerCase();
    return hay.includes(q);
  });
}
