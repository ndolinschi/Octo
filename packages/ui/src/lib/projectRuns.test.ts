import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRun } from "@octo/agent-client";
import { emptyRuns, runsReducer, type RunsState } from "./commands/runs";
import { projectRuns, runTabStatus, runningRuns, runningText } from "./projectRuns";

const run = (id: string, extra: Partial<CommandRun> = {}): CommandRun => ({
  id,
  name: "Tests",
  command: "pnpm test",
  cwd: "/p",
  status: "running",
  exit_code: null,
  started_at: `2026-11-12T10:00:0${id}Z`,
  duration_ms: 0,
  output_bytes: 0,
  truncated: false,
  ...extra,
});
const state = (...runs: CommandRun[]): RunsState => runsReducer(emptyRuns, { type: "loaded", runs });

test("only the project's own runs count, newest first", () => {
  const s = state(run("1"), run("2", { review_id: "r" }), run("3", { name: "Build" }));
  assert.deepEqual(
    projectRuns(s).map((r) => r.id),
    ["3", "1"],
  );
  assert.deepEqual(
    runningRuns(s).map((r) => r.id),
    ["3", "1"],
  );
});

test("a tab spins while its latest run runs, marks a failure, and is quiet otherwise", () => {
  assert.equal(runTabStatus(state(), "Tests"), null);
  assert.equal(runTabStatus(state(run("1")), "tests"), "running");
  assert.equal(runTabStatus(state(run("1", { status: "finished", exit_code: 2 })), "Tests"), "failed");
  assert.equal(runTabStatus(state(run("1", { status: "error" })), "Tests"), "failed");
  assert.equal(runTabStatus(state(run("1", { status: "finished", exit_code: 0 })), "Tests"), null);
  assert.equal(runTabStatus(state(run("1", { status: "stopped", exit_code: -1 })), "Tests"), null);
  assert.equal(runTabStatus(state(run("1", { status: "finished", exit_code: 1 }), run("2")), "Tests"), "running", "the latest run decides");
});

test("the status bar text", () => {
  assert.equal(runningText(0), null);
  assert.equal(runningText(1), "1 running");
});
