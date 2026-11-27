import assert from "node:assert/strict";
import test from "node:test";
import type { Plan } from "@octo/agent-client";
import { dropPlansFromTurn, getPlanTabState, setPlanTabState } from "./planTabs";

function samplePlan(over: Partial<Plan> = {}): Plan {
  return {
    id: "pln_1",
    turn_id: 10,
    text: "# Plan: Add fallback\n\n1. Inspect repo",
    status: "pending",
    created_at: "2026-11-27T00:00:00Z",
    approved_at: null,
    ...over,
  };
}

test("setPlanTabState stores and updates plans per project", () => {
  const p = samplePlan();
  setPlanTabState("proj_a", p, "Plan: Add fallback");
  assert.deepEqual(getPlanTabState("proj_a", "pln_1"), { plan: p, title: "Plan: Add fallback" });
  assert.equal(getPlanTabState("proj_b", "pln_1"), undefined);

  const approved = samplePlan({ status: "approved", approved_at: "2026-11-27T00:05:00Z" });
  setPlanTabState("proj_a", approved, "Plan: Add fallback");
  assert.equal(getPlanTabState("proj_a", "pln_1")?.plan.status, "approved");
});

test("dropPlansFromTurn removes plans at or after the rewound turn", () => {
  setPlanTabState("proj_rw", samplePlan({ id: "pln_old", turn_id: 5 }), "Plan");
  setPlanTabState("proj_rw", samplePlan({ id: "pln_cut", turn_id: 10 }), "Plan");
  setPlanTabState("proj_rw", samplePlan({ id: "pln_later", turn_id: 14 }), "Plan");

  dropPlansFromTurn("proj_rw", 10);

  assert.ok(getPlanTabState("proj_rw", "pln_old"));
  assert.equal(getPlanTabState("proj_rw", "pln_cut"), undefined);
  assert.equal(getPlanTabState("proj_rw", "pln_later"), undefined);
});
