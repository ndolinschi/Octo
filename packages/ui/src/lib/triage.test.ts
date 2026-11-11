import assert from "node:assert/strict";
import test from "node:test";
import { triageGroups, triageOf } from "./triage";

test("triageOf", () => {
  assert.equal(triageOf({ kind: "needs", error: null, at: null }, true), "needs");
  assert.equal(triageOf({ kind: "working", agents: [] }, true), "working");
  assert.equal(triageOf({ kind: "idle", at: null }, true), "review");
  assert.equal(triageOf({ kind: "idle", at: null }, false), "idle");
  assert.equal(triageOf({ kind: "new" }, false), "idle");
});

test("triageGroups sorts each group by recency", () => {
  const p = (id: string, t: string) => ({ id, updated_at: t });
  const g = triageGroups([
    { project: p("a", "2026-11-10T00:00:00Z"), triage: "idle" },
    { project: p("b", "2026-11-11T00:00:00Z"), triage: "idle" },
    { project: p("c", "2026-11-09T00:00:00Z"), triage: "needs" },
  ]);
  assert.deepEqual(
    g.idle.map((x) => x.id),
    ["b", "a"],
  );
  assert.deepEqual(
    g.needs.map((x) => x.id),
    ["c"],
  );
  assert.deepEqual(g.working, []);
});
