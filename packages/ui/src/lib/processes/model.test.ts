import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRun, WorkerProcess } from "@octo/agent-client";
import { emptyRuns, runsReducer } from "../commands/runs";
import { must } from "../must";
import { buildProcessList, filterProcesses, isProcessActive, processCounts, processPid, processStarter, processStatusText } from "./model";

const makeRun = (overrides: Partial<CommandRun> & Pick<CommandRun, "id" | "name">): CommandRun => ({
  command: "pnpm dev",
  cwd: "/repo",
  status: "running",
  exit_code: null,
  started_at: "2026-11-16T10:00:00.000Z",
  duration_ms: 0,
  output_bytes: 0,
  truncated: false,
  ...overrides,
});

const makeWorker = (overrides: Partial<WorkerProcess> & Pick<WorkerProcess, "id" | "name">): WorkerProcess => ({
  kind: "lsp",
  command: "typescript-language-server --stdio",
  pid: 4100,
  status: "running",
  started_at: "2026-11-16T09:55:00.000Z",
  ...overrides,
});

test("buildProcessList orders active commands and workers ahead of stopped processes", () => {
  let state = emptyRuns;
  state = runsReducer(state, {
    type: "loaded",
    runs: [
      makeRun({ id: "r_old_done", name: "Tests", status: "finished", exit_code: 0, started_at: "2026-11-16T09:50:00.000Z" }),
      makeRun({ id: "r_dev", name: "Dev server", status: "running", pid: 48210, started_at: "2026-11-16T10:00:00.000Z" }),
    ],
  });
  const workers: WorkerProcess[] = [makeWorker({ id: "lsp:ts", name: "typescript-language-server", pid: 47902, status: "idle" })];
  const items = buildProcessList(state, workers);
  assert.deepEqual(
    items.map((i) => i.key),
    ["cmd:r_dev", "wrk:lsp:ts", "cmd:r_old_done"],
  );
  assert.deepEqual(processCounts(items), { all: 3, running: 2, stopped: 1 });
  assert.equal(processPid(must(items[0])), 48210);
  assert.equal(processPid(must(items[2])), undefined);
  assert.equal(processStatusText(must(items[1])), "Idle");
  assert.equal(isProcessActive(must(items[1])), true);
});

test("filterProcesses filters by state and searches name, command, and PID", () => {
  let state = emptyRuns;
  state = runsReducer(state, {
    type: "loaded",
    runs: [
      makeRun({ id: "r_dev", name: "Dev server", command: "vite --port 5173", status: "running", pid: 48210 }),
      makeRun({ id: "r_lint", name: "Typecheck", command: "tsc --noEmit", status: "finished", exit_code: 2 }),
    ],
  });
  const items = buildProcessList(state, [makeWorker({ id: "lsp:go", name: "gopls", command: "gopls serve", pid: 9912 })]);
  assert.equal(filterProcesses(items, "running", "").length, 2);
  assert.equal(filterProcesses(items, "stopped", "").length, 1);
  assert.deepEqual(
    filterProcesses(items, "all", "48210").map((i) => i.key),
    ["cmd:r_dev"],
  );
  assert.deepEqual(
    filterProcesses(items, "all", "gopls").map((i) => i.key),
    ["wrk:lsp:go"],
  );
});

test("processStarter names who started a process (G3)", () => {
  const titles = (id: string) => (id === "ses_1" ? "Run the API tests" : undefined);
  const cmd = (run: CommandRun) => ({ kind: "command" as const, key: "c", run, output: "", clipped: false });
  const wrk = (worker: WorkerProcess) => ({ kind: "worker" as const, key: "w", worker });
  assert.equal(processStarter(cmd(makeRun({ id: "r1", name: "Dev" })), titles), "by you");
  assert.equal(processStarter(cmd(makeRun({ id: "r2", name: "Tests", review_id: "rv1" })), titles), "by you, from a review");
  assert.equal(processStarter(wrk(makeWorker({ id: "term:1", name: "zsh", kind: "terminal" })), titles), "by you");
  assert.equal(processStarter(wrk(makeWorker({ id: "lsp:ts", name: "ts" })), titles), "by the editor");
  assert.equal(processStarter(wrk(makeWorker({ id: "acp:ses_1", name: "claude-code", kind: "agent", session_id: "ses_1" })), titles), "by Run the API tests");
  // The session is not known (or the harness is older and sends none): nothing is said.
  assert.equal(processStarter(wrk(makeWorker({ id: "acp:x", name: "claude-code", kind: "agent", session_id: "gone" })), titles), null);
  assert.equal(processStarter(wrk(makeWorker({ id: "acp:y", name: "claude-code", kind: "agent" })), titles), null);
});
