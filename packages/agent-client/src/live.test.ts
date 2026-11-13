import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES } from "./client";
import { applyEvent, emptyProjectState } from "./state";
import type { Agent, BridgeEvent } from "./types";

const apply = (events: BridgeEvent[]) => events.reduce(applyEvent, emptyProjectState());

test("the live-activity event types are subscribed to", () => {
  for (const t of ["message.thinking_delta", "agent.plan", "agent.activity", "tool.updated"]) {
    assert.ok((BRIDGE_EVENT_TYPES as readonly string[]).includes(t), t);
  }
});

test("activity, thinking and plan are kept per agent; thinking and activity end with the turn", () => {
  const plan = [
    { content: "Read", status: "in_progress", priority: "high" },
    { content: "Write", status: "pending", priority: "medium" },
  ];
  let s = apply([
    { type: "agent.activity", seq: 1, agent_id: "a", kind: "thinking", label: "Thinking" },
    { type: "message.thinking_delta", seq: 2, agent_id: "a", text: "Let me " },
    { type: "message.thinking_delta", seq: 3, agent_id: "a", text: "look." },
    { type: "agent.plan", seq: 4, agent_id: "a", entries: plan },
    { type: "agent.activity", seq: 5, agent_id: "a", kind: "tool", label: "Reading x.go", tool_use_id: "t1" },
    { type: "agent.activity", seq: 6, agent_id: "b", kind: "text", label: "Writing" },
  ]);
  assert.equal(s.thinking.a, "Let me look.");
  assert.deepEqual(s.plan.a, plan);
  assert.deepEqual(s.activity.a, { kind: "tool", label: "Reading x.go", tool_use_id: "t1" });
  assert.deepEqual(s.activity.b, { kind: "text", label: "Writing" });
  s = applyEvent(s, { type: "turn.finished", seq: 7, status: "completed", error: null });
  assert.deepEqual(s.thinking, {});
  assert.deepEqual(s.activity, {});
  assert.deepEqual(s.plan.a, plan); // the plan stays until the next turn clears it
});

test("tool.updated merges into the tool in flight and ignores an unknown one", () => {
  let s = apply([{ type: "tool.started", seq: 1, agent_id: "a", tool_use_id: "t1", name: "read" }]);
  s = applyEvent(s, { type: "tool.updated", seq: 2, agent_id: "a", tool_use_id: "t1", status: "in_progress", title: "Read x.go", locations: ["/p/x.go"] });
  s = applyEvent(s, { type: "tool.updated", seq: 3, agent_id: "a", tool_use_id: "t1", summary: "12 bytes" });
  assert.deepEqual(s.activeTools.a?.t1, { name: "read", status: "in_progress", title: "Read x.go", locations: ["/p/x.go"], summary: "12 bytes" });
  const same = applyEvent(s, { type: "tool.updated", seq: 4, agent_id: "a", tool_use_id: "nope", status: "x" });
  assert.equal(same.activeTools, s.activeTools);
});

test("the agent row's plan seeds the state and a cleared plan removes it", () => {
  const base = { id: "a", project_id: "p" } as unknown as Agent;
  const plan = [{ content: "Read", status: "pending", priority: "low" }];
  let s = apply([{ type: "agent.updated", seq: 1, agent: { ...base, plan } }]);
  assert.deepEqual(s.plan.a, plan);
  s = applyEvent(s, { type: "agent.updated", seq: 2, agent: { ...base } }); // no plan field: unchanged
  assert.deepEqual(s.plan.a, plan);
  s = applyEvent(s, { type: "agent.updated", seq: 3, agent: { ...base, plan: null } });
  assert.deepEqual(s.plan, {});
});

test("message.updated replaces a stored message and turn.finished keeps the hint apart", () => {
  const msg = (text: string, stopped?: boolean) => ({
    id: 5,
    agent_id: "a",
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    created_at: "t",
    ...(stopped ? { stopped } : {}),
  });
  let s = apply([{ type: "message.created", seq: 1, message: msg("partial") }]);
  s = applyEvent(s, { type: "message.updated", seq: 2, message: msg("partial, now stopped", true) });
  assert.equal(s.messages.a?.length, 1);
  assert.equal(s.messages.a?.[0]?.stopped, true);
  s = applyEvent(s, { type: "turn.finished", seq: 3, status: "failed", error: "Codex is not logged in", hint: "Run `codex login`." });
  assert.deepEqual(s.lastTurn, { status: "failed", error: "Codex is not logged in", hint: "Run `codex login`." });
  s = applyEvent(s, { type: "turn.finished", seq: 4, status: "completed", error: null });
  assert.deepEqual(s.lastTurn, { status: "completed", error: null });
});
