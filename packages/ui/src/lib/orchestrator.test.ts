import assert from "node:assert/strict";
import test from "node:test";
import { emptyProjectState, type Agent } from "@octo/agent-client";
import { agentActivity, agentStack, orchestratorState, runningAgents, stateLine } from "./orchestrator";

const NOW = Date.parse("2026-11-10T12:00:00Z");
function agent(p: Partial<Agent> & { id: string }): Agent {
  return {
    project_id: "p",
    parent_id: "root",
    depth: 1,
    role: "Worker",
    title: "",
    task: "",
    model: "m",
    tier: null,
    status: "completed",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: "2026-11-10T10:00:00Z",
    started_at: "2026-11-10T10:00:00Z",
    finished_at: "2026-11-10T10:05:00Z",
    ...p,
  };
}
const root = (p: Partial<Agent> = {}) => agent({ id: "root", parent_id: null, depth: 0, role: "orchestrator", ...p });

test("a fresh project has no requests yet", () => {
  const s = orchestratorState([root({ started_at: null, finished_at: null, status: "idle" })], "idle");
  assert.deepEqual(s, { kind: "new" });
  assert.equal(stateLine(s, NOW), "No requests yet");
  assert.equal(orchestratorState([], "idle").kind, "new");
});

test("working: project running, root running or any sub-agent running; agents oldest first", () => {
  const a = agent({ id: "a", status: "running", role: "Test runner", started_at: "2026-11-10T11:59:00Z" });
  const b = agent({ id: "b", status: "running", role: "Dependency auditor", started_at: "2026-11-10T11:58:00Z" });
  const s = orchestratorState([root({ status: "running" }), a, b, agent({ id: "c" })], "idle");
  assert.equal(s.kind, "working");
  assert.deepEqual(
    runningAgents([a, b]).map((x) => x.id),
    ["b", "a"],
  );
  assert.equal(stateLine(s, NOW), "Working · 2 agents");
  assert.equal(stateLine(orchestratorState([root()], "running"), NOW), "Working");
  assert.equal(stateLine(orchestratorState([root(), a], "idle"), NOW), "Working · 1 agent");
});

test("a failed last turn needs the user", () => {
  const s = orchestratorState([root({ status: "failed", error: "model unavailable" })], "idle");
  assert.deepEqual(s, { kind: "needs", error: "model unavailable", at: "2026-11-10T10:05:00Z" });
  assert.equal(stateLine(s, NOW), "Needs you");
});

test("idle shows how long since the last turn ended", () => {
  assert.equal(stateLine(orchestratorState([root()], "idle"), NOW), "Idle · 1h");
  assert.equal(stateLine({ kind: "idle", at: null }, NOW, "2026-11-10T11:58:00Z"), "Idle · 2m");
  assert.equal(stateLine({ kind: "idle", at: null }, NOW), "Idle");
});

test("agent stack names two distinct roles, then counts the rest", () => {
  assert.equal(agentStack([]), "");
  assert.equal(agentStack(["A"]), "A");
  assert.equal(agentStack(["A", "B"]), "A, B");
  assert.equal(agentStack(["A", "B", "C"]), "A, B +1");
  assert.equal(agentStack(["A", "A", "B", "C", "D"]), "A, B +2");
});

test("activity: children, then the live tool, then streaming, else thinking", () => {
  const s = emptyProjectState();
  assert.equal(agentActivity(s, "x"), "Thinking…");
  const withTool = { ...s, activeTools: { x: { t1: { name: "read_file" } } } };
  assert.equal(agentActivity(withTool, "x"), "Reading files…");
  assert.equal(agentActivity({ ...s, activeTools: { x: { t1: { name: "grep" } } } }, "x"), "Using grep…");
  assert.equal(agentActivity({ ...s, streaming: { x: "hi" } }, "x"), "Writing…");
  const child = agent({ id: "c", parent_id: "x", status: "running", role: "Scout" });
  assert.equal(agentActivity({ ...s, agents: { c: child }, agentOrder: ["c"] }, "x"), "Waiting on Scout…");
});
