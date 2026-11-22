import assert from "node:assert/strict";
import test from "node:test";
import type { Message, PlanEntry } from "@octo/agent-client";
import { callRow } from "../../lib/toolView";
import { escalation, outcomeLine, routeShort, runActions, runProgress, runSteps, runTitle, STEPS_SHOWN, visibleSteps, waitedCards } from "./runCard";

const at = (s: number) => new Date(Date.UTC(2026, 10, 22, 10, 0, s)).toISOString();
const use = (id: string, name: string, input: unknown, s = 0): Message => ({
  id: s * 2 + 1,
  agent_id: "a",
  role: "assistant",
  created_at: at(s),
  content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: string, opts: { error?: boolean; ms?: number; s?: number } = {}): Message => ({
  id: (opts.s ?? 0) * 2 + 2,
  agent_id: "a",
  role: "user",
  created_at: at(opts.s ?? 0),
  content: [{ type: "tool_result", tool_use_id: id, content, is_error: opts.error ?? false, ...(opts.ms !== undefined ? { duration_ms: opts.ms } : {}) }],
});
const plan = (...s: PlanEntry["status"][]): PlanEntry[] => s.map((status, i) => ({ content: `step ${i}`, status, priority: "medium" }));

test("steps are phrased by the transcript's own row grammar (callRow), not a second phrasing", () => {
  const messages = [
    use("t1", "read_file", { path: "src/billing/invoice.ts" }),
    result("t1", "…", { ms: 1900 }),
    use("t2", "bash", { command: "pnpm test --filter billing" }, 2),
  ];
  const steps = runSteps(messages, { running: true });
  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0]?.row, callRow("read_file", { path: "src/billing/invoice.ts" }, undefined, "…"));
  assert.equal(steps[0]?.row.verb, "Read");
  assert.equal(steps[0]?.durationMs, 1900);
  assert.equal(steps[1]?.row.verb, "Ran");
  assert.equal(steps[1]?.state, "running");
  assert.equal(steps[1]?.startedAt, Date.parse(at(2)));
});

test("a step's duration is the harness's figure or nothing (never derived from message times)", () => {
  const steps = runSteps([use("t1", "read_file", { path: "a.ts" }, 0), result("t1", "x", { s: 9 })], { running: false });
  assert.equal(steps[0]?.durationMs, null);
});

test("a running step's timer starts at tool.started's time when the harness sent it", () => {
  const steps = runSteps([use("t1", "bash", { command: "ls" }, 0)], { running: true, activeTools: { t1: { name: "bash", started_at: at(5) } } });
  assert.equal(steps[0]?.startedAt, Date.parse(at(5)));
});

test("a failed step carries its reason; a call cut by a stop reads stopped; a refusal is not a failure", () => {
  const messages = [
    use("t1", "bash", { command: "pnpm test" }),
    result("t1", "\n  3 tests failed: invoice.test.ts\nmore", { error: true, ms: 4000 }),
    use("t2", "read_file", { path: "b.ts" }, 1),
  ];
  const stopped = runSteps(messages, { running: false });
  assert.equal(stopped[0]?.state, "error");
  assert.equal(stopped[0]?.reason, "3 tests failed: invoice.test.ts");
  assert.equal(stopped[1]?.state, "stopped");
  const refused = runSteps([use("t1", "edit", { path: "a" }), result("t1", "rejected", { error: true })], { running: false });
  assert.equal(refused[0]?.state, "stopped");
  assert.equal(refused[0]?.reason, null);
});

test("older steps fold behind 'Show N earlier'; the newest stay", () => {
  const all = Array.from({ length: 42 }, (_, i) => i);
  const folded = visibleSteps(all, false);
  assert.equal(folded.earlier, 42 - STEPS_SHOWN);
  assert.deepEqual(folded.steps, all.slice(-STEPS_SHOWN));
  assert.deepEqual(visibleSteps(all, true), { earlier: 0, steps: all });
  assert.deepEqual(visibleSteps([1, 2], false), { earlier: 0, steps: [1, 2] });
});

test("progress with a plan: step k of n and one segment per plan step", () => {
  const p = runProgress(plan("completed", "completed", "completed", "in_progress", "pending", "pending"), [], "running");
  assert.deepEqual(p, { kind: "plan", label: "Step 4 of 6", segments: ["done", "done", "done", "current", "pending", "pending"] });
  // Between steps (nothing in progress): the next one.
  const between = runProgress(plan("completed", "pending"), [], "running");
  assert.ok(between.kind === "plan" && between.label === "Step 2 of 2");
  const finished = runProgress(plan("completed", "completed"), [], "completed");
  assert.deepEqual(finished, { kind: "plan", label: "All 2 steps done", segments: ["done", "done"] });
  const stopped = runProgress(plan("completed", "in_progress", "pending"), [], "cancelled");
  assert.deepEqual(stopped, { kind: "plan", label: "1 of 3 steps done", segments: ["done", "pending", "pending"] });
});

test("progress without a plan never invents a denominator: a count and an indeterminate current step", () => {
  const steps = [{ state: "done" as const }, { state: "error" as const }, { state: "running" as const }];
  const live = runProgress(null, steps, "running");
  assert.deepEqual(live, { kind: "count", label: "2 steps done", live: true });
  assert.doesNotMatch(live.kind === "count" ? live.label : "", / of |%/);
  assert.deepEqual(runProgress([], [{ state: "done" }], "completed"), { kind: "count", label: "1 step", live: false });
  assert.deepEqual(runProgress(undefined, [], "completed"), { kind: "none" });
  assert.deepEqual(runProgress(undefined, [], "running"), { kind: "count", label: "0 steps done", live: true });
});

test("the action set per state: no pause ever; stop only while running; needs-you links, it does not answer", () => {
  const can = { canStop: true, canOpen: true };
  assert.deepEqual(runActions({ status: "running", waiting: false, ...can }), ["stop", "open"]);
  assert.deepEqual(runActions({ status: "running", waiting: true, ...can }), ["needs", "stop", "open"]);
  for (const status of ["completed", "failed", "cancelled"] as const) assert.deepEqual(runActions({ status, waiting: false, ...can }), ["open"]);
  assert.deepEqual(runActions({ status: "running", waiting: false, canStop: false, canOpen: false }), []);
  for (const status of ["running", "completed", "failed", "cancelled", "idle"] as const)
    for (const waiting of [true, false]) assert.ok(!(runActions({ status, waiting, ...can }) as string[]).includes("pause"));
});

test("the outcome is the result's first line without Markdown marks", () => {
  assert.equal(outcomeLine("**Breaking changes that affect Orbit (0.76 → 0.80):**\n\n- New architecture"), "Breaking changes that affect Orbit (0.76 → 0.80)");
  assert.equal(outcomeLine("## Done\nrest"), "Done");
  assert.equal(outcomeLine("- see [the doc](http://x) now"), "see the doc now");
  assert.equal(outcomeLine(null), "");
});

test("an escalation and the router's reason come out as one short sentence", () => {
  const retried = "Retried on the deep tier after the tests failed. Hard refactor across modules.";
  assert.equal(escalation(retried), "Retried on the deep tier after the tests failed.");
  assert.equal(escalation("medium task"), null);
  assert.equal(routeShort({ route_choice: "deep", route_reason: retried }), "Retried on the deep tier after the tests failed.");
  assert.equal(routeShort({ route_choice: "fast", route_reason: "Small, well-scoped read. Cheap tier is enough." }), "Small, well-scoped read.");
  assert.equal(routeShort({ route_choice: null, route_reason: "x" }), null);
});

test("the title says what happens now while it runs, and the outcome once it ended", () => {
  const base = { waitText: null, activity: "Reading src/x.ts", result: null, failure: null, interrupted: false };
  assert.equal(runTitle({ ...base, status: "running" }), "Reading src/x.ts");
  assert.equal(runTitle({ ...base, status: "running", waitText: "Waiting for your approval" }), "Waiting for your approval");
  assert.equal(runTitle({ ...base, status: "completed", result: "**Updated 5 test files.**\nmore" }), "Updated 5 test files.");
  assert.equal(runTitle({ ...base, status: "completed" }), "Finished");
  assert.equal(runTitle({ ...base, status: "failed", failure: "The model is overloaded." }), "The model is overloaded.");
  assert.equal(runTitle({ ...base, status: "cancelled" }), "Stopped");
  assert.equal(runTitle({ ...base, status: "cancelled", interrupted: true }), "Interrupted");
});

test("waiting on agents opens each card when there are at most two, else only the first running one", () => {
  const two = [
    { id: "a", running: true },
    { id: "b", running: true },
  ];
  assert.deepEqual([...waitedCards(two, true)], ["a", "b"]);
  assert.deepEqual([...waitedCards(two, false)], []);
  const many = [
    { id: "a", running: false },
    { id: "b", running: true },
    { id: "c", running: true },
    { id: "d", running: true },
  ];
  assert.deepEqual([...waitedCards(many, true)], ["b"]);
});
