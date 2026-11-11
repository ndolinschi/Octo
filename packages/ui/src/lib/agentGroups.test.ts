import assert from "node:assert/strict";
import test from "node:test";
import type { Agent } from "@octo/agent-client";
import { agentGroups, foldLine } from "./agentGroups";

let n = 0;
function agent(over: Partial<Agent>): Agent {
  n += 1;
  return {
    id: `a${n}`,
    project_id: "p",
    parent_id: null,
    depth: 0,
    role: "Role",
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
    created_at: `2026-11-11T10:0${n % 10}:00Z`,
    started_at: `2026-11-11T10:0${n % 10}:00Z`,
    finished_at: null,
    ...over,
  };
}

test("agentGroups: running (oldest first) and finished (newest first), children folded", () => {
  const root = agent({ role: "orchestrator" });
  const a = agent({ parent_id: root.id, role: "Explorer", status: "completed", started_at: "2026-11-11T09:00:00Z" });
  const b = agent({ parent_id: root.id, role: "Implementer", status: "running", started_at: "2026-11-11T09:30:00Z" });
  const c = agent({ parent_id: root.id, role: "Reviewer", status: "completed", started_at: "2026-11-11T09:40:00Z" });
  const b1 = agent({ parent_id: b.id, role: "Test writer", status: "failed", started_at: "2026-11-11T09:31:00Z" });
  const b2 = agent({ parent_id: b1.id, role: "Fixer", status: "completed", started_at: "2026-11-11T09:32:00Z" });
  const a1 = agent({ parent_id: a.id, role: "Grep", status: "running", started_at: "2026-11-11T09:01:00Z" });
  const g = agentGroups([root, a, b, c, b1, b2, a1]);
  assert.deepEqual(
    g.running.map((x) => x.agent.role),
    ["Explorer", "Implementer"],
  );
  assert.deepEqual(
    g.finished.map((x) => x.agent.role),
    ["Reviewer"],
  );
  const impl = g.running[1];
  assert.equal(impl?.total, 2);
  assert.equal(impl?.failed, 1);
  assert.deepEqual(
    impl?.children.map((x) => [x.agent.role, x.via]),
    [
      ["Test writer", null],
      ["Fixer", "Test writer"],
    ],
  );
});

test("foldLine", () => {
  assert.equal(foldLine({ total: 0, failed: 0 }), null);
  assert.deepEqual(foldLine({ total: 5, failed: 1 }), { text: "5 agents", failed: "1 failed" });
  assert.deepEqual(foldLine({ total: 1, failed: 0 }), { text: "1 agent", failed: null });
});
