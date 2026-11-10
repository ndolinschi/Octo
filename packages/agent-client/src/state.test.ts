import assert from "node:assert/strict";
import test from "node:test";
import {
  agentBySpawnToolUse,
  ancestorsOf,
  applyEvent,
  childrenOf,
  descendantCount,
  emptyProjectState,
  toolResultFor,
  totalTokens,
  withAgents,
  withMessages,
  withNotes,
} from "./state";
import type { Agent, Message, Note } from "./types";

function agent(id: string, parent: string | null, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    project_id: "p",
    parent_id: parent,
    depth: 0,
    role: "r",
    title: id,
    task: "",
    model: "m",
    tier: null,
    status: "idle",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 1,
    output_tokens: 2,
    created_at: "t",
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

function msg(id: number, agentId: string, role: Message["role"] = "assistant"): Message {
  return { id, agent_id: agentId, role, content: [{ type: "text", text: `m${id}` }], created_at: "t" };
}

function note(id: string, title = id): Note {
  return { id, title, content: "", author: "user", created_at: "t", updated_at: "t" };
}

test("agent.created/updated upsert and keep order", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "agent.created", seq: 1, agent: agent("o", null) });
  s = applyEvent(s, { type: "agent.created", seq: 2, agent: agent("a", "o") });
  s = applyEvent(s, { type: "agent.updated", seq: 3, agent: agent("o", null, { status: "running" }) });
  assert.deepEqual(s.agentOrder, ["o", "a"]);
  assert.equal(s.agents.o?.status, "running");
  assert.equal(s.lastSeq, 3);
});

test("applyEvent is immutable", () => {
  const s = emptyProjectState();
  const next = applyEvent(s, { type: "message.delta", seq: 1, agent_id: "a", text: "x" });
  assert.deepEqual(s.streaming, {});
  assert.equal(next.streaming.a, "x");
});

test("message.created appends once, dedups, clears streaming for assistant only", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "message.delta", seq: 1, agent_id: "a", text: "hel" });
  s = applyEvent(s, { type: "message.delta", seq: 2, agent_id: "a", text: "lo" });
  assert.equal(s.streaming.a, "hello");
  s = applyEvent(s, { type: "message.created", seq: 3, message: msg(1, "a", "user") });
  assert.equal(s.streaming.a, "hello");
  s = applyEvent(s, { type: "message.created", seq: 4, message: msg(2, "a") });
  s = applyEvent(s, { type: "message.created", seq: 5, message: msg(2, "a") });
  assert.equal("a" in s.streaming, false);
  assert.deepEqual(
    s.messages.a?.map((m) => m.id),
    [1, 2],
  );
});

test("tool.started/finished maintain activeTools", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "tool.started", seq: 1, agent_id: "a", tool_use_id: "t1", name: "bash" });
  s = applyEvent(s, { type: "tool.started", seq: 2, agent_id: "a", tool_use_id: "t2", name: "read_file" });
  assert.deepEqual(s.activeTools.a, { t1: { name: "bash" }, t2: { name: "read_file" } });
  s = applyEvent(s, { type: "tool.finished", seq: 3, agent_id: "a", tool_use_id: "t1", is_error: false });
  assert.deepEqual(s.activeTools.a, { t2: { name: "read_file" } });
  s = applyEvent(s, { type: "tool.finished", seq: 4, agent_id: "z", tool_use_id: "x", is_error: true });
  assert.deepEqual(s.activeTools.z, {});
});

test("note.changed upserts and deletes", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "note.changed", seq: 1, note: note("n1"), note_id: "n1" });
  s = applyEvent(s, { type: "note.changed", seq: 2, note: note("n2"), note_id: "n2" });
  s = applyEvent(s, { type: "note.changed", seq: 3, note: note("n1", "new"), note_id: "n1" });
  assert.deepEqual(
    s.notes.map((n) => n.title),
    ["new", "n2"],
  );
  s = applyEvent(s, { type: "note.changed", seq: 4, note: null, note_id: "n1" });
  assert.deepEqual(
    s.notes.map((n) => n.id),
    ["n2"],
  );
});

test("turn.finished sets lastTurn and clears transient state", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "message.delta", seq: 1, agent_id: "a", text: "x" });
  s = applyEvent(s, { type: "tool.started", seq: 2, agent_id: "a", tool_use_id: "t", name: "n" });
  s = applyEvent(s, { type: "turn.finished", seq: 3, status: "failed", error: "boom" });
  assert.deepEqual(s.streaming, {});
  assert.deepEqual(s.activeTools, {});
  assert.deepEqual(s.lastTurn, { status: "failed", error: "boom" });
});

test("file.changed only advances lastSeq", () => {
  const s0 = emptyProjectState();
  const s1 = applyEvent(s0, { type: "file.changed", seq: 7, folder: "f", path: "a", source: "user" });
  assert.deepEqual(s1, { ...s0, lastSeq: 7 });
});

test("project.updated only advances lastSeq; lastSeq never decreases", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "turn.finished", seq: 10, status: "completed", error: null });
  const before = s;
  s = applyEvent(s, { type: "message.delta", seq: 2, agent_id: "a", text: "x" });
  assert.equal(s.lastSeq, 10);
  assert.notEqual(s, before);
});

test("withMessages merges out of order, keeps newer live messages", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "message.created", seq: 1, message: msg(5, "a") });
  s = withMessages(s, "a", [msg(3, "a"), msg(1, "a"), msg(5, "a")]);
  assert.deepEqual(
    s.messages.a?.map((m) => m.id),
    [1, 3, 5],
  );
  s = withMessages(s, "a", [msg(2, "a")]);
  assert.deepEqual(
    s.messages.a?.map((m) => m.id),
    [1, 2, 3, 5],
  );
});

test("withAgents loads in order and keeps live-only agents; withNotes replaces", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "agent.created", seq: 1, agent: agent("live", "o") });
  s = withAgents(s, [agent("o", null), agent("a", "o")]);
  assert.deepEqual(s.agentOrder, ["o", "a", "live"]);
  s = withNotes(s, [note("n")]);
  assert.deepEqual(
    s.notes.map((n) => n.id),
    ["n"],
  );
});

function tree() {
  return withAgents(emptyProjectState(), [
    agent("o", null),
    agent("a", "o", { spawn_tool_use_id: "tu_a", input_tokens: 10, output_tokens: 20 }),
    agent("b", "o"),
    agent("a1", "a", { spawn_tool_use_id: "tu_a1" }),
    agent("a1x", "a1"),
  ]);
}

test("selectors on a 3-level tree", () => {
  const s = tree();
  assert.deepEqual(
    childrenOf(s, "o").map((a) => a.id),
    ["a", "b"],
  );
  assert.deepEqual(childrenOf(s, "b"), []);
  assert.deepEqual(
    ancestorsOf(s, "a1x").map((a) => a.id),
    ["o", "a", "a1"],
  );
  assert.deepEqual(ancestorsOf(s, "o"), []);
  assert.deepEqual(ancestorsOf(s, "missing"), []);
  assert.equal(agentBySpawnToolUse(s, "tu_a1")?.id, "a1");
  assert.equal(agentBySpawnToolUse(s, "nope"), undefined);
  assert.equal(descendantCount(s, "o"), 4);
  assert.equal(descendantCount(s, "a"), 2);
  assert.equal(descendantCount(s, "b"), 0);
  assert.deepEqual(totalTokens(s), { input: 14, output: 28 });
});

test("toolResultFor finds the answering block", () => {
  const messages: Message[] = [
    { id: 1, agent_id: "o", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }], created_at: "t" },
    { id: 2, agent_id: "o", role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done", is_error: false }], created_at: "t" },
  ];
  assert.equal(toolResultFor(messages, "t1")?.content, "done");
  assert.equal(toolResultFor(messages, "t2"), undefined);
});
