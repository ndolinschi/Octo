import assert from "node:assert/strict";
import test from "node:test";
import { emptyProjectState, type Agent } from "@octo/agent-client";
import { roleText, lastTeam, liveOrchestratorState, orchestratorState, projectRowLines, projectWhen, runningAgents, stateLine } from "./orchestrator";
import { agentActivity, agentDisplayName, agentStack, teamLine, teamRoles } from "./orchestratorMore";

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
  assert.equal(stateLine(s, NOW), "Working, 2 agents");
  assert.equal(stateLine(orchestratorState([root()], "running"), NOW), "Working");
  assert.equal(stateLine(orchestratorState([root(), a], "idle"), NOW), "Working, 1 agent");
});

test("a failed last turn needs the user", () => {
  const s = orchestratorState([root({ status: "failed", error: "model unavailable" })], "idle");
  assert.deepEqual(s, { kind: "needs", error: "model unavailable", at: "2026-11-10T10:05:00Z" });
  assert.equal(stateLine(s, NOW), "Failed");
});

test("the harness's attention decides when present: failed needs, none does not infer from agents", () => {
  const ok = root({ status: "completed" });
  assert.equal(orchestratorState([ok], "idle", "failed").kind, "needs");
  assert.equal(orchestratorState([root({ status: "failed", error: "x" })], "idle", "none").kind, "idle");
  assert.equal(orchestratorState([root({ status: "failed", error: "x" })], "running", "failed").kind, "working");
});

test("an approval or a form that waits needs the user, and wins over working (A1)", () => {
  const busy = [root({ status: "running" }), agent({ id: "a", status: "running" })];
  const approval = orchestratorState(busy, "running", "needs_you", { approvals: 1, inputs: 1 });
  assert.deepEqual(approval, { kind: "needs", error: null, at: null, waiting: "approval" });
  assert.equal(stateLine(approval, NOW), "Waiting for your approval");
  const form = orchestratorState(busy, "running", "needs_you", { approvals: 0, inputs: 2 });
  assert.equal(stateLine(form, NOW), "Waiting for your answer");
  // Counts alone (the live `project.attention` event carries no kind) and the kind alone both say so.
  assert.equal(orchestratorState([root()], "idle", undefined, { approvals: 0, inputs: 1 }).kind, "needs");
  assert.equal(orchestratorState([root()], "idle", "needs_you").kind, "needs");
  assert.equal(orchestratorState(busy, "running", "none", { approvals: 0, inputs: 0 }).kind, "working");
  assert.deepEqual(projectRowLines(form, NOW, "2026-11-10T11:58:00Z"), { meta: "2m", full: "Waiting for your answer" });
});

test("the open project's live attention counts decide what waits", () => {
  const state = emptyProjectState();
  state.agents = { root: root({ status: "running" }) };
  state.agentOrder = ["root"];
  state.attention = { needs_you: true, approvals: 1, inputs: 0 };
  assert.equal(stateLine(liveOrchestratorState(state, "running"), NOW), "Waiting for your approval");
  state.attention = { needs_you: false, approvals: 0, inputs: 0 };
  assert.equal(liveOrchestratorState(state, "running").kind, "working");
});

test("the sidebar and Home show one time per project (B6)", () => {
  assert.equal(projectWhen(orchestratorState([root()], "idle"), NOW, "2026-11-08T12:00:00Z"), "1h");
  assert.equal(projectWhen({ kind: "idle", at: null }, NOW, "2026-11-10T11:58:00Z"), "2m");
  assert.equal(projectWhen({ kind: "new" }, NOW, "2026-11-08T12:00:00Z"), "new");
  assert.equal(projectWhen({ kind: "working", agents: [] }, NOW, "2026-11-08T12:00:00Z"), null);
});

test("idle shows how long since the last turn ended", () => {
  assert.equal(stateLine(orchestratorState([root()], "idle"), NOW), "Idle, 1h ago");
  assert.equal(stateLine({ kind: "idle", at: null }, NOW, "2026-11-10T11:58:00Z"), "Idle, 2m ago");
  assert.equal(stateLine({ kind: "idle", at: null }, NOW), "Idle");
});

test("a project row is one line: the meta says the one thing worth saying, the sentence goes to the tooltip", () => {
  assert.deepEqual(projectRowLines(orchestratorState([root()], "idle"), NOW), { meta: "1h", full: "Idle, 1h ago" });
  assert.deepEqual(projectRowLines({ kind: "idle", at: null }, NOW, "2026-11-10T11:58:00Z"), { meta: "2m", full: "Idle, 2m ago" });
  assert.deepEqual(projectRowLines({ kind: "idle", at: null }, NOW), { meta: null, full: "Idle" });
  assert.deepEqual(projectRowLines({ kind: "new" }, NOW), { meta: "new", full: "No requests yet" });
  assert.deepEqual(projectRowLines({ kind: "needs", error: "x", at: "2026-11-10T11:10:00Z" }, NOW), { meta: "50m", full: "Failed" });
  assert.deepEqual(projectRowLines({ kind: "needs", error: "x", at: null }, NOW), { meta: null, full: "Failed" });
  assert.deepEqual(projectRowLines({ kind: "working", agents: [] }, NOW), { meta: null, full: "Working" });
  const two = [agent({ id: "a", status: "running" }), agent({ id: "b", status: "running" })];
  assert.deepEqual(projectRowLines({ kind: "working", agents: two }, NOW), { meta: "2 agents", full: "Working, 2 agents" });
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

test("lastTeam: the sub-agents of the latest turn, in start order", () => {
  const mk = (id: string, parent: string | null, started: string): Agent =>
    agent({ id, parent_id: parent, started_at: started || null, created_at: started || "2026-11-11T00:00:00Z" });
  const agents = [
    mk("root", null, "2026-11-11T10:00:00Z"),
    mk("old", "root", "2026-11-11T09:00:00Z"),
    mk("b", "root", "2026-11-11T10:02:00Z"),
    mk("a", "root", "2026-11-11T10:01:00Z"),
    mk("c", "b", "2026-11-11T10:03:00Z"),
  ];
  assert.deepEqual(
    lastTeam(agents).map((a) => a.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(lastTeam([mk("root", null, "")]), []);
});

test("teamLine words", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(teamLine(3, "2026-11-11T11:00:00Z", now), "Last ran 3 agents, 1h ago");
  assert.equal(teamLine(1, null, now), "Last ran 1 agent");
  assert.equal(teamLine(0, "2026-11-11T10:00:00Z", now), "No agents used, 2h ago");
});

test("teamRoles groups by role with the most urgent status", () => {
  const team = [
    agent({ id: "1", role: "Code explorer", status: "completed" }),
    agent({ id: "2", role: "Debugger", status: "completed" }),
    agent({ id: "3", role: "Code explorer", status: "failed" }),
    agent({ id: "4", role: "Code explorer", status: "completed" }),
  ];
  const roles = teamRoles(team);
  assert.deepEqual(
    roles.map((r) => [r.role, r.count, r.status, r.agent.id]),
    [
      ["Code explorer", 3, "failed", "3"],
      ["Debugger", 1, "completed", "2"],
    ],
  );
});

test("roleText: one spelling for the orchestrator", () => {
  assert.equal(roleText("orchestrator"), "Octo");
  assert.equal(roleText("Orchestrator"), "Octo");
  assert.equal(roleText("Code explorer"), "Code explorer");
  assert.equal(roleText(""), "Agent");
  assert.equal(roleText(null), "Agent");
});

test("a failed orchestrator that never started still needs you; a warning does not", () => {
  const base = {
    id: "o",
    project_id: "p",
    parent_id: null,
    depth: 0,
    role: "orchestrator",
    title: "",
    task: "",
    model: "acp:copilot",
    tier: null,
    result: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: "2026-11-11T10:00:00Z",
    started_at: null,
    finished_at: null,
  } as const;
  assert.equal(orchestratorState([{ ...base, status: "failed", error: "not logged in" }], "idle").kind, "needs");
  assert.equal(orchestratorState([{ ...base, status: "idle", error: "ACP agent copilot could not start" }], "idle").kind, "needs");
  assert.equal(orchestratorState([{ ...base, status: "idle", error: "warning: no MCP" }], "idle").kind, "new");
});

test("agentDisplayName: the project's own agent reads as the project, others keep their label", () => {
  assert.equal(agentDisplayName("orchestrator", "Atlas API"), "Atlas API");
  assert.equal(agentDisplayName(" Orchestrator ", "Atlas API"), "Atlas API");
  assert.equal(agentDisplayName("orchestrator", ""), "Assistant");
  assert.equal(agentDisplayName("Reviewer", "Atlas API"), "Reviewer");
});
