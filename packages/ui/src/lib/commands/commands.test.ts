import assert from "node:assert/strict";
import test from "node:test";
import type { CommandRun, CommandSuggestion, ProjectCommand } from "@octo/agent-client";
import { commandFromSuggestion, commandsProblem, menuOrder, openSuggestions, parseGlobs, renameOffered, uniqueName, withPinned } from "./config";
import { durationText, runStatusText, runTone, stripAnsi } from "./format";
import { OUTPUT_KEEP, emptyRuns, runsFor, runsReducer, type RunsState } from "./runs";

const at = (s: RunsState, id: string) => s.byId[id];

const run = (id: string, extra: Partial<CommandRun> = {}): CommandRun => ({
  id,
  name: "Tests",
  command: "pnpm test",
  cwd: "/p",
  status: "running",
  exit_code: null,
  started_at: "2026-01-01T10:00:00Z",
  duration_ms: 0,
  output_bytes: 0,
  truncated: false,
  ...extra,
});

test("a run streams in, finishes, and keeps its review", () => {
  let s = runsReducer(emptyRuns, { type: "event", event: { type: "command.started", seq: 1, run: run("r1", { review_id: "rv" }) } });
  s = runsReducer(s, { type: "event", event: { type: "command.output", seq: 2, run_id: "r1", stream: "stdout", text: "hello " } });
  s = runsReducer(s, { type: "event", event: { type: "command.output", seq: 3, run_id: "r1", stream: "stderr", text: "world" } });
  s = runsReducer(s, { type: "event", event: { type: "command.output", seq: 4, run_id: "nope", stream: "stdout", text: "x" } });
  assert.equal(at(s, "r1")?.output, "hello world");
  s = runsReducer(s, {
    type: "event",
    event: { type: "command.finished", seq: 5, run_id: "r1", exit_code: 1, duration_ms: 1200, status: "finished", name: "Tests" },
  });
  assert.equal(at(s, "r1")?.run.exit_code, 1);
  assert.equal(runsFor(s, "rv").length, 1);
  assert.equal(runsFor(s, undefined).length, 0);
});

test("loaded runs are newest first and a tail fills an unseen run", () => {
  let s = runsReducer(emptyRuns, {
    type: "loaded",
    runs: [run("a", { started_at: "2026-01-01T09:00:00Z" }), run("b", { started_at: "2026-01-01T11:00:00Z" })],
  });
  assert.deepEqual(s.order, ["b", "a"]);
  s = runsReducer(s, { type: "tail", run: run("a", { status: "finished", exit_code: 0, tail: "done\n" }) });
  assert.equal(at(s, "a")?.output, "done\n");
  assert.equal(at(s, "a")?.run.status, "finished");
});

test("output is kept to the end", () => {
  let s = runsReducer(emptyRuns, { type: "event", event: { type: "command.started", seq: 1, run: run("r") } });
  s = runsReducer(s, { type: "event", event: { type: "command.output", seq: 2, run_id: "r", stream: "stdout", text: "a".repeat(OUTPUT_KEEP) } });
  s = runsReducer(s, { type: "event", event: { type: "command.output", seq: 3, run_id: "r", stream: "stdout", text: "END" } });
  const v = at(s, "r");
  assert.equal(v?.output.length, OUTPUT_KEEP);
  assert.equal(v?.output.endsWith("END"), true);
  assert.equal(v?.clipped, true);
});

test("status words, durations, ansi", () => {
  assert.equal(runStatusText({ status: "finished", exit_code: 0 }), "Passed");
  assert.equal(runStatusText({ status: "finished", exit_code: 2 }), "Failed (exit 2)");
  assert.equal(runStatusText({ status: "stopped", exit_code: -1 }), "Stopped");
  assert.equal(runTone({ status: "error", exit_code: null }), "err");
  assert.equal(durationText(850), "850 ms");
  assert.equal(durationText(4200), "4.2 s");
  assert.equal(durationText(125_000), "2 min 5 s");
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\rnext"), "red\nnext");
});

const cmd = (name: string, extra: Partial<ProjectCommand> = {}): ProjectCommand => ({ name, command: "echo", ...extra });

test("the same limits as the harness", () => {
  assert.equal(commandsProblem([cmd("a"), cmd("b")]), null);
  assert.match(commandsProblem([cmd("a"), cmd("A")]) ?? "", /Two commands/);
  assert.match(commandsProblem([cmd("a/b")]) ?? "", /can only use letters/);
  assert.match(commandsProblem([cmd(" ")]) ?? "", /needs a name/);
  assert.match(commandsProblem([{ name: "x", command: " " }]) ?? "", /no command line/);
  assert.match(commandsProblem([cmd("a", { cwd: "../x" })]) ?? "", /inside the project/);
  assert.match(commandsProblem([cmd("a", { pinned: true }), cmd("b", { pinned: true }), cmd("c", { pinned: true })]) ?? "", /Only 2 commands can be buttons/);
});

test("suggestions, names and pins", () => {
  assert.equal(uniqueName("Test", [cmd("test"), cmd("Test 2")]), "Test 3");
  const s: CommandSuggestion = { name: "dev", command: "pnpm run dev", cwd: "app", source: "package.json", configured: false };
  assert.deepEqual(commandFromSuggestion(s, [cmd("dev")]), { name: "dev 2", command: "pnpm run dev", cwd: "app" });
  const list: CommandSuggestion[] = [
    s,
    { ...s, name: "x", configured: true },
    { ...s, name: "b", source: "justfile" },
    { ...s, name: "m", source: "Makefile" },
  ];
  assert.deepEqual(
    openSuggestions(list).map((x) => x.name),
    ["dev", "m", "b"],
  );
  const pinned = withPinned([cmd("a", { pinned: true }), cmd("b", { pinned: true }), cmd("c")], "c", true);
  assert.deepEqual(
    pinned.filter((c) => c.pinned).map((c) => c.name),
    ["b", "c"],
  );
  assert.equal(withPinned(pinned, "b", false).find((c) => c.name === "b")?.pinned, undefined);
  assert.deepEqual(
    menuOrder([cmd("a"), cmd("b", { pinned: true })]).map((c) => c.name),
    ["b", "a"],
  );
  assert.deepEqual(parseGlobs(" a/**\n\nb\na/** \n"), ["a/**", "b"]);
});

test("a renamed command stays in the review's offered list, once", () => {
  assert.deepEqual(renameOffered(["Tests", "Build"], "tests", "Unit tests"), ["Unit tests", "Build"]);
  assert.deepEqual(renameOffered(["Tests", "Build"], "Tests", "build"), ["build"]);
  assert.deepEqual(renameOffered([], "a", "b"), []);
});
