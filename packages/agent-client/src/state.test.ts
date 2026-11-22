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
  withCompactions,
  withSideAsked,
  withSideCleared,
  withSideMessages,
  withMessages,
  withNotes,
} from "./state";
import type { Agent, Message, Note, SideMessage } from "./types";

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
  return {
    id,
    title,
    description: "",
    description_auto: true,
    tags: [],
    pinned: false,
    size: 0,
    author: "user",
    created_at: "t",
    updated_at: "t",
    last_read_at: "",
    read_count: 0,
  };
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

test("agent.updated stores served_model and routed_tier and replaces them when they change", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "agent.created", seq: 1, agent: agent("o", null, { served_model: null, routed_tier: null }) });
  assert.equal(s.agents.o?.served_model, null);
  s = applyEvent(s, {
    type: "agent.updated",
    seq: 2,
    agent: agent("o", null, { served_model: "deepseek-v4", routed_tier: "low" }),
  });
  assert.equal(s.agents.o?.served_model, "deepseek-v4");
  assert.equal(s.agents.o?.routed_tier, "low");
  s = applyEvent(s, {
    type: "agent.updated",
    seq: 3,
    agent: agent("o", null, { served_model: "claude-opus-5-5", routed_tier: "high" }),
  });
  assert.equal(s.agents.o?.served_model, "claude-opus-5-5");
  assert.equal(s.agents.o?.routed_tier, "high");
  assert.equal(s.agents.o?.model, "m");
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

test("tool.started keeps when the call started (the run card's live step timer); an older harness sends none", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "tool.started", seq: 1, agent_id: "a", tool_use_id: "t1", name: "bash", started_at: "2026-11-22T10:00:00.5Z" });
  s = applyEvent(s, { type: "tool.started", seq: 2, agent_id: "a", tool_use_id: "t2", name: "read_file" });
  assert.deepEqual(s.activeTools.a, { t1: { name: "bash", started_at: "2026-11-22T10:00:00.5Z" }, t2: { name: "read_file" } });
  // The duration a finished call reports is carried by its stored result (`duration_ms` on the tool_result block).
  s = applyEvent(s, { type: "tool.finished", seq: 3, agent_id: "a", tool_use_id: "t1", is_error: false, duration_ms: 1200 });
  assert.deepEqual(s.activeTools.a, { t2: { name: "read_file" } });
  s = applyEvent(s, {
    type: "message.created",
    seq: 4,
    message: { id: 9, agent_id: "a", role: "user", created_at: "t", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false, duration_ms: 1200 }] },
  });
  const block = s.messages.a?.[0]?.content[0];
  assert.equal(block?.type === "tool_result" ? block.duration_ms : null, 1200);
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

test("agent.compacted stores a marker per agent, deduplicated and ordered", () => {
  let s = emptyProjectState();
  assert.deepEqual(s.compactions, {});
  s = applyEvent(s, { type: "agent.compacted", seq: 1, agent_id: "o", upto_message_id: 9, summary_tokens: 40, at: "t2" });
  s = applyEvent(s, { type: "agent.compacted", seq: 2, agent_id: "o", upto_message_id: 3, at: "t1" });
  s = applyEvent(s, { type: "agent.compacted", seq: 3, agent_id: "o", upto_message_id: 9, summary_tokens: 41, at: "t2" });
  s = applyEvent(s, { type: "agent.compacted", seq: 4, agent_id: "a", upto_message_id: 5, at: "t3" });
  assert.deepEqual(s.compactions.o, [
    { upto_message_id: 3, at: "t1" },
    { upto_message_id: 9, at: "t2", summary_tokens: 41 },
  ]);
  assert.deepEqual(s.compactions.a, [{ upto_message_id: 5, at: "t3" }]);
  assert.equal(s.lastSeq, 4);
});

test("withCompactions merges loaded markers with live ones", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "agent.compacted", seq: 1, agent_id: "o", upto_message_id: 9, at: "t2" });
  const next = withCompactions(s, "o", [
    { upto_message_id: 3, at: "t1", summary_tokens: 7 },
    { upto_message_id: 9, at: "t2" },
  ]);
  assert.deepEqual(
    next.compactions.o?.map((c) => c.upto_message_id),
    [3, 9],
  );
  assert.deepEqual(s.compactions.o?.length, 1);
});

function side(id: number, sideId: string, role: SideMessage["role"], text: string = role): SideMessage {
  return { id, side_id: sideId, role, text, created_at: "t" };
}

test("side question: asked, streamed, done", () => {
  let s = emptyProjectState();
  assert.deepEqual(s.side, { messages: [], pending: null, error: null });
  s = withSideAsked(s, { side_id: "a", message: side(1, "a", "user", "q1") });
  assert.deepEqual(s.side.pending, { side_id: "a", text: "" });
  s = applyEvent(s, { type: "side.delta", seq: 1, side_id: "a", text: "He" });
  s = applyEvent(s, { type: "side.delta", seq: 2, side_id: "a", text: "llo" });
  assert.deepEqual(s.side.pending, { side_id: "a", text: "Hello" });
  s = applyEvent(s, { type: "side.done", seq: 3, side_id: "a", message: side(2, "a", "assistant", "Hello!") });
  assert.equal(s.side.pending, null);
  assert.deepEqual(
    s.side.messages.map((m) => [m.id, m.role, m.text]),
    [
      [1, "user", "q1"],
      [2, "assistant", "Hello!"],
    ],
  );
  s = applyEvent(s, { type: "side.done", seq: 4, side_id: "a", message: side(2, "a", "assistant", "Hello!") });
  assert.equal(s.side.messages.length, 2);
  assert.deepEqual(s.messages, {}, "side messages never enter an agent's transcript");
  assert.equal(s.lastSeq, 4);
});

test("a delta for a new question starts a fresh pending text", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "side.delta", seq: 1, side_id: "a", text: "old" });
  s = applyEvent(s, { type: "side.delta", seq: 2, side_id: "b", text: "new" });
  assert.deepEqual(s.side.pending, { side_id: "b", text: "new" });
});

test("side.error drops the question, keeps the others, and reports unless cancelled", () => {
  let s = emptyProjectState();
  s = withSideMessages(s, [side(2, "a", "assistant"), side(1, "a", "user")]);
  assert.deepEqual(
    s.side.messages.map((m) => m.id),
    [1, 2],
  );
  s = withSideAsked(s, { side_id: "b", message: side(3, "b", "user") });
  s = applyEvent(s, { type: "side.error", seq: 1, side_id: "b", error: "the model returned no answer" });
  assert.deepEqual(
    s.side.messages.map((m) => m.id),
    [1, 2],
  );
  assert.equal(s.side.pending, null);
  assert.deepEqual(s.side.error, { side_id: "b", message: "the model returned no answer" });

  s = withSideAsked(s, { side_id: "c", message: side(4, "c", "user") });
  assert.equal(s.side.error, null, "a new question clears the error");
  s = applyEvent(s, { type: "side.error", seq: 2, side_id: "c", error: "cancelled" });
  assert.equal(s.side.error, null, "a cancelled question is not an error");
  assert.equal(
    s.side.messages.some((m) => m.side_id === "c"),
    false,
  );
});

test("an error of an older question leaves the pending one alone", () => {
  let s = withSideAsked(emptyProjectState(), { side_id: "new", message: side(5, "new", "user") });
  s = applyEvent(s, { type: "side.error", seq: 1, side_id: "old", error: "cancelled" });
  assert.deepEqual(s.side.pending, { side_id: "new", text: "" });
  assert.equal(s.side.messages.length, 1);
});

test("withSideCleared empties the conversation", () => {
  let s = withSideAsked(emptyProjectState(), { side_id: "a", message: side(1, "a", "user") });
  s = withSideCleared(s);
  assert.deepEqual(s.side, { messages: [], pending: null, error: null });
});
test("turn.finished keeps each failed turn's outcome under its request, with the hint apart", () => {
  let s = applyEvent(emptyProjectState(), { type: "agent.created", seq: 1, agent: agent("o", null) });
  s = applyEvent(s, { type: "message.created", seq: 2, message: msg(1, "o", "user") });
  s = applyEvent(s, { type: "turn.finished", seq: 3, status: "failed", error: "budget reached", hint: "Raise the budget in project settings." });
  s = applyEvent(s, { type: "message.created", seq: 4, message: msg(2, "o", "user") });
  s = applyEvent(s, {
    type: "message.created",
    seq: 5,
    message: { id: 3, agent_id: "o", role: "user", created_at: "t", content: [{ type: "tool_result", tool_use_id: "x", content: "", is_error: false }] },
  });
  s = applyEvent(s, { type: "turn.finished", seq: 6, status: "failed", error: "budget reached again" });
  assert.deepEqual(s.turnOutcomes, {
    1: { status: "failed", error: "budget reached", hint: "Raise the budget in project settings." },
    2: { status: "failed", error: "budget reached again" },
  });
  assert.deepEqual(s.lastTurn, { status: "failed", error: "budget reached again" });
});
