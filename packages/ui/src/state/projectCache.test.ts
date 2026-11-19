import { emptyProjectState, withMessages, withSessions, type Message, type ProjectSession, type ProjectState } from "@octo/agent-client";
import assert from "node:assert/strict";
import test from "node:test";
import { canPaint, KEEP, keepLatest, lastSessionCodec, projectSnapshots } from "./projectCache";
import { openingConversation } from "./projectOpening";

/** Decision 98: what a project switch can paint at once. */

const session = (id: string, over: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  kind: "main",
  title: id,
  state: "idle",
  model: "",
  started_at: "2026-11-16T09:00:00Z",
  last_activity_at: "2026-11-16T09:30:00Z",
  exchanges: 1,
  children: 0,
  current: false,
  archived: false,
  can_message: true,
  ...over,
});

const message = (id: number, agentId: string): Message => ({ id, agent_id: agentId, role: "user", content: [], created_at: "2026-11-16T09:00:00Z" });

const project = { orchestrator_agent_id: "orc" };
const route = (sessionId: string | null = null, agentId: string | null = null) => ({ agentId, sessionId });

/** Parallel sessions: "main" (the default, root "orc") and "side" (root "orc2"). */
function parallel(): ProjectState {
  return withSessions(emptyProjectState(), [
    session("main", { default: true, root_agent_id: "orc" }),
    session("side", { default: false, root_agent_id: "orc2", started_at: "2026-11-16T10:00:00Z" }),
    session("helper", { kind: "agent", agent_id: "h1" }),
  ]);
}

test("without parallel sessions the conversation is the orchestrator's; an agent route is that agent's", () => {
  assert.deepEqual(openingConversation(emptyProjectState(), project, route(), null), { agentId: "orc", sessionId: "" });
  assert.deepEqual(openingConversation(emptyProjectState(), project, route(null, "a1"), "side"), { agentId: "a1", sessionId: "" });
});

test("parallel sessions: the route's session, else the one shown last, else the default", () => {
  const state = parallel();
  assert.deepEqual(openingConversation(state, project, route("side"), null), { agentId: "orc2", sessionId: "side" });
  assert.deepEqual(openingConversation(state, project, route(), "side"), { agentId: "orc2", sessionId: "side" });
  assert.deepEqual(openingConversation(state, project, route(), "gone"), { agentId: "orc", sessionId: "main" });
  // An agent session is not a conversation of its own here: the default's.
  assert.deepEqual(openingConversation(state, project, route("helper"), null), { agentId: "orc", sessionId: "main" });
});

test("a project can be painted once the opening conversation's messages are in", () => {
  assert.equal(canPaint(undefined, route()), false);
  const state = parallel();
  assert.equal(canPaint({ project, state }, route("side")), false);
  assert.equal(canPaint({ project, state: withMessages(state, "orc", [message(1, "orc")]) }, route("side")), false);
  assert.equal(canPaint({ project, state: withMessages(state, "orc2", []) }, route("side")), true, "an empty conversation is known too");
});

test("snapshots are kept up to KEEP projects, then start over; another bridge sees none", () => {
  const map = new Map<string, number>();
  for (let i = 0; i < KEEP; i++) keepLatest(map, `p${i}`, i);
  keepLatest(map, "p0", 10);
  assert.equal(map.size, KEEP);
  assert.equal(map.get("p0"), 10);
  keepLatest(map, "new", 11);
  assert.deepEqual([...map], [["new", 11]]);
  assert.equal(projectSnapshots({}).get("p1"), undefined);
});

test("the last session is plain text; nothing stored is null", () => {
  assert.equal(lastSessionCodec.parse(null), null);
  assert.equal(lastSessionCodec.parse("  "), null);
  assert.equal(lastSessionCodec.parse("ses_1"), "ses_1");
  assert.equal(lastSessionCodec.stringify(null), "");
});
