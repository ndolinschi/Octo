import { emptyProjectState, type Agent, type Message, type Note } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { projectReducer } from "./projectReducer";

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  project_id: "p",
  parent_id: null,
  depth: 0,
  role: "orchestrator",
  title: id,
  task: "",
  model: "m",
  tier: null,
  status: "idle",
  result: null,
  error: null,
  spawn_tool_use_id: null,
  input_tokens: 0,
  output_tokens: 0,
  created_at: "2026-11-10T10:00:00Z",
  started_at: null,
  finished_at: null,
  ...over,
});
const message = (id: number, role: "user" | "assistant" = "assistant", agent_id = "a"): Message => ({
  id,
  agent_id,
  role,
  content: [{ type: "text", text: `m${id}` }],
  created_at: "2026-11-10T10:00:00Z",
});
const note = (id: string): Note => ({
  id,
  title: id,
  description: "",
  description_auto: true,
  tags: [],
  pinned: false,
  size: 0,
  author: "user",
  created_at: "",
  updated_at: "",
  last_read_at: "",
  read_count: 0,
});

test("the state starts empty", () => {
  const s = emptyProjectState();
  assert.deepEqual([s.agentOrder, s.notes, s.lastSeq, s.lastTurn], [[], [], 0, null]);
});

test("bridge events go through the event reducer and advance lastSeq (never backwards)", () => {
  let s = projectReducer(emptyProjectState(), { type: "event", event: { type: "agent.created", seq: 5, agent: agent("a") } });
  assert.deepEqual([s.agentOrder, s.lastSeq], [["a"], 5]);
  s = projectReducer(s, { type: "event", event: { type: "message.delta", seq: 3, agent_id: "a", text: "He" } });
  s = projectReducer(s, { type: "event", event: { type: "message.delta", seq: 4, agent_id: "a", text: "llo" } });
  assert.equal(s.streaming.a, "Hello");
  assert.equal(s.lastSeq, 5, "an older seq does not move the cursor back");
});

test("a finished assistant message replaces the streamed text; a user message does not", () => {
  let s = projectReducer(emptyProjectState(), { type: "event", event: { type: "message.delta", seq: 1, agent_id: "a", text: "partial" } });
  s = projectReducer(s, { type: "event", event: { type: "message.created", seq: 2, message: message(1, "user") } });
  assert.equal(s.streaming.a, "partial");
  s = projectReducer(s, { type: "event", event: { type: "message.created", seq: 3, message: message(2, "assistant") } });
  assert.equal(s.streaming.a, undefined);
});

test("loading messages merges by id, sorted, without duplicating what the stream already added", () => {
  let s = projectReducer(emptyProjectState(), { type: "event", event: { type: "message.created", seq: 1, message: message(3) } });
  s = projectReducer(s, { type: "messages", agentId: "a", messages: [message(1), message(3), message(2)] });
  assert.deepEqual(
    s.messages.a?.map((m) => m.id),
    [1, 2, 3],
  );
  s = projectReducer(s, { type: "messages", agentId: "b", messages: [message(9, "user", "b")] });
  assert.deepEqual(Object.keys(s.messages).sort(), ["a", "b"]);
});

test("loading agents keeps ones the stream knows that the list lacks, after the listed ones", () => {
  let s = projectReducer(emptyProjectState(), { type: "event", event: { type: "agent.created", seq: 1, agent: agent("new") } });
  s = projectReducer(s, { type: "agents", agents: [agent("x"), agent("y")] });
  assert.deepEqual(s.agentOrder, ["x", "y", "new"]);
  assert.ok(s.agents.new);
});

test("notes are replaced wholesale", () => {
  let s = projectReducer(emptyProjectState(), { type: "notes", notes: [note("1"), note("2")] });
  s = projectReducer(s, { type: "notes", notes: [note("3")] });
  assert.deepEqual(
    s.notes.map((n) => n.id),
    ["3"],
  );
});

test("clearTurn forgets the last turn's outcome and nothing else", () => {
  let s = projectReducer(emptyProjectState(), { type: "event", event: { type: "turn.finished", seq: 7, status: "failed", error: "boom" } });
  assert.deepEqual(s.lastTurn, { status: "failed", error: "boom" });
  s = projectReducer(s, { type: "agents", agents: [agent("a")] });
  const cleared = projectReducer(s, { type: "clearTurn" });
  assert.equal(cleared.lastTurn, null);
  assert.deepEqual([cleared.agentOrder, cleared.lastSeq], [["a"], 7]);
});

test("a rewind cuts the request and everything after it, hides later sub-agents and leaves a marker", () => {
  let s = projectReducer(emptyProjectState(), {
    type: "agents",
    agents: [
      agent("a"),
      agent("late", { parent_id: "a", created_at: "2026-11-10T12:00:00Z" }),
      agent("early", { parent_id: "a", created_at: "2026-11-10T08:00:00Z" }),
    ],
  });
  const at = (id: number, hour: number, role: "user" | "assistant" = "assistant", agent_id = "a"): Message => ({
    ...message(id, role, agent_id),
    created_at: `2026-11-10T${String(hour).padStart(2, "0")}:00:00Z`,
  });
  s = projectReducer(s, { type: "messages", agentId: "a", messages: [at(1, 9, "user"), at(2, 9), at(3, 11, "user"), at(4, 11)] });
  s = projectReducer(s, { type: "messages", agentId: "late", messages: [at(5, 12, "assistant", "late")] });
  s = projectReducer(s, { type: "rewound", messageId: 3, label: "Rewound to here", at: "2026-11-10T13:00:00Z" });
  assert.deepEqual(
    s.messages.a?.map((m) => m.id),
    [1, 2],
  );
  assert.deepEqual(s.agentOrder, ["a", "early"]);
  assert.equal(s.messages.late, undefined);
  assert.deepEqual(
    s.compactions.a?.map((c) => [c.upto_message_id, c.label]),
    [[2, "Rewound to here"]],
  );
  // Applied again (the event, then the dialog's result): one marker, with the later label.
  s = projectReducer(s, { type: "rewound", messageId: 3, label: "Rewound to here · agent session reset", at: "2026-11-10T13:00:01Z" });
  assert.deepEqual(
    s.compactions.a?.map((c) => c.label),
    ["Rewound to here · agent session reset"],
  );
  // The event arriving after the dialog's result does not replace the richer label.
  s = projectReducer(s, { type: "rewound", messageId: 3, label: "Rewound to here", at: "2026-11-10T13:00:02Z", soft: true });
  assert.equal(s.compactions.a?.[0]?.label, "Rewound to here · agent session reset");
});

test("the reducer never mutates the state it is given", () => {
  const before = emptyProjectState();
  const frozen = JSON.stringify(before);
  projectReducer(before, { type: "notes", notes: [note("1")] });
  projectReducer(before, { type: "messages", agentId: "a", messages: [message(1)] });
  projectReducer(before, { type: "event", event: { type: "agent.created", seq: 1, agent: agent("a") } });
  projectReducer(before, { type: "clearTurn" });
  assert.equal(JSON.stringify(before), frozen);
});
