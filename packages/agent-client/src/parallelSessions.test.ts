import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type Bridge, type FetchLike, type TimersLike } from "./client";
import { sessionBridge } from "./sessionBridge";
import {
  applyEvent,
  emptyProjectState,
  eventInSession,
  hasParallelSessions,
  scopeState,
  sessionApprovals,
  sessionRoot,
  withAgents,
  withMessages,
  withSessions,
  withTurnCleared,
  type ProjectState,
} from "./state";
import type { Agent, Approval, BridgeEvent, Message, ProjectSession } from "./types";

function session(over: Partial<ProjectSession> & { id: string }): ProjectSession {
  return {
    kind: "main",
    title: over.id,
    state: "idle",
    model: "m",
    started_at: "2026-11-14T09:00:00.000Z",
    last_activity_at: "2026-11-14T09:00:00.000Z",
    exchanges: 0,
    children: 0,
    current: false,
    default: false,
    archived: false,
    can_message: true,
    ...over,
  };
}

function agent(id: string, sid: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    session_id: sid,
    project_id: "p",
    parent_id: null,
    depth: 0,
    role: "orchestrator",
    title: id,
    task: "",
    model: "m",
    tier: null,
    status: "running",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: "t",
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

function ask(id: number, agentId: string): Message {
  return { id, agent_id: agentId, role: "user", content: [{ type: "text", text: `q${id}` }], created_at: "t" };
}

/** Two main sessions A (default, root ra) and B (root rb), both running, each with a request and streamed text. */
function twoRunning(): ProjectState {
  let s = withSessions(emptyProjectState(), [
    session({ id: "A", default: true, current: true, root_agent_id: "ra" }),
    session({ id: "B", root_agent_id: "rb", started_at: "2026-11-14T10:00:00.000Z" }),
  ]);
  s = withAgents(s, [agent("ra", "A"), agent("rb", "B"), agent("sub_b", "B", { parent_id: "rb" })]);
  s = withMessages(s, "ra", [ask(1, "ra")]);
  s = withMessages(s, "rb", [ask(2, "rb")]);
  for (const id of ["ra", "rb", "sub_b"]) s = applyEvent(s, { type: "message.delta", seq: 1, agent_id: id, text: "…" });
  return s;
}

const ev = (e: BridgeEvent) => e;

test("withSessions: the default, its alias and one slice per main session with its root", () => {
  const s = twoRunning();
  assert.equal(s.sessions.defaultId, "A");
  assert.equal(s.sessions.currentId, "A");
  assert.deepEqual(Object.keys(s.sessions.byId).sort(), ["A", "B"]);
  assert.equal(sessionRoot(s, "B"), "rb");
  assert.equal(hasParallelSessions(s), true);
  // An older harness (no `default` field): not parallel.
  const { default: _gone, ...old } = session({ id: "X", current: true });
  assert.equal(hasParallelSessions(withSessions(emptyProjectState(), [old])), false);
});

test("turn.finished with session_id ends only that session: its stream goes, the other keeps streaming", () => {
  const s = applyEvent(twoRunning(), ev({ type: "turn.finished", seq: 2, status: "completed", error: null, session_id: "B", agent_id: "rb" }));
  assert.deepEqual(Object.keys(s.streaming), ["ra"]);
  assert.equal(s.sessions.byId.B?.lastTurn?.status, "completed");
  assert.equal(s.sessions.byId.B?.turnOutcomes[2]?.status, "completed");
  // B is not the default: the project's (default session's) last turn is untouched.
  assert.equal(s.lastTurn, null);
  assert.equal(s.sessions.byId.A?.lastTurn, null);
  const a = applyEvent(s, ev({ type: "turn.finished", seq: 3, status: "failed", error: "boom", session_id: "A", agent_id: "ra" }));
  assert.equal(a.lastTurn?.status, "failed");
  assert.equal(a.turnOutcomes[1]?.status, "failed");
  assert.deepEqual(a.streaming, {});
});

test("turn.finished without session_id (an older harness) clears everything, as before", () => {
  const s = applyEvent(twoRunning(), { type: "turn.finished", seq: 2, status: "completed", error: null });
  assert.deepEqual(s.streaming, {});
  assert.equal(s.lastTurn?.status, "completed");
});

test("queue.updated goes to its session; without session_id to the default session", () => {
  const q = { id: "q1", text: "next", created_at: "t" };
  let s = applyEvent(twoRunning(), ev({ type: "queue.updated", seq: 2, paused: false, messages: [q], session_id: "B" }));
  assert.deepEqual(s.sessions.byId.B?.queue.messages, [q]);
  assert.deepEqual(s.sessions.byId.A?.queue.messages, []);
  assert.deepEqual(s.queue.messages, []);
  s = applyEvent(s, { type: "queue.updated", seq: 3, paused: true, messages: [q] });
  assert.equal(s.sessions.byId.A?.queue.paused, true);
  assert.equal(s.queue.paused, true);
  assert.deepEqual(scopeState(s, "B").queue.messages, [q]);
  assert.equal(scopeState(s, "B").queue.paused, false);
});

test("session.default moves the default (and its alias and the flags of the list)", () => {
  const s = applyEvent(twoRunning(), { type: "session.default", seq: 2, session_id: "B", previous_session_id: "A" });
  assert.equal(s.sessions.defaultId, "B");
  assert.equal(s.sessions.currentId, "B");
  assert.deepEqual(
    s.sessions.list.map((x) => [x.id, x.default, x.current]),
    [
      ["B", true, true],
      ["A", false, false],
    ],
  );
  // A later session.updated of the old default (default: false) does not undo it.
  const t = applyEvent(s, { type: "session.updated", seq: 3, session: session({ id: "A", root_agent_id: "ra" }) });
  assert.equal(t.sessions.defaultId, "B");
});

test("session.created and deleted keep the slices", () => {
  let s = applyEvent(twoRunning(), { type: "session.created", seq: 2, session: session({ id: "C", root_agent_id: "rc" }) });
  assert.equal(sessionRoot(s, "C"), "rc");
  s = applyEvent(s, { type: "session.updated", seq: 3, session_id: "C", deleted: true });
  assert.equal(s.sessions.byId.C, undefined);
  assert.equal(
    s.sessions.list.some((x) => x.id === "C"),
    false,
  );
});

test("approvals and attention are scoped by session; the project lists keep all of them", () => {
  const ap = (id: string, sid?: string): Approval => ({ id, agent_id: "x", ...(sid ? { session_id: sid } : {}) }) as Approval;
  let s = applyEvent(twoRunning(), ev({ type: "approval.requested", seq: 2, approval: ap("1", "B"), session_id: "B" }));
  s = applyEvent(s, { type: "approval.requested", seq: 3, approval: ap("2") });
  assert.equal(s.approvals.length, 2);
  assert.deepEqual(
    sessionApprovals(s, "B").map((a) => a.id),
    ["1"],
  );
  // One without a session belongs to the default.
  assert.deepEqual(
    sessionApprovals(s, "A").map((a) => a.id),
    ["2"],
  );
  const scoped = scopeState(s, "B");
  assert.equal(scoped.attention.approvals, 1);
  assert.equal(scoped.attention.needs_you, true);
  s = applyEvent(s, ev({ type: "project.attention", seq: 4, needs_you: false, approvals: 0, inputs: 0, state: "failed", error: "no", session_id: "B" }));
  assert.equal(s.sessions.byId.B?.attention.state, "failed");
  assert.equal(s.attention.state, undefined);
});

test("withTurnCleared clears one session's last turn", () => {
  let s = applyEvent(twoRunning(), ev({ type: "turn.finished", seq: 2, status: "failed", error: "x", session_id: "B", agent_id: "rb" }));
  s = withTurnCleared(s, "B");
  assert.equal(s.sessions.byId.B?.lastTurn, null);
});

test("eventInSession: an event naming another session is not this one's; session.* and unnamed events pass", () => {
  const fin = (sid?: string): BridgeEvent => ({ type: "turn.finished", seq: 1, status: "completed", error: null, ...(sid ? { session_id: sid } : {}) });
  assert.equal(eventInSession(fin("B"), "B"), true);
  assert.equal(eventInSession(fin("B"), "A"), false);
  assert.equal(eventInSession(fin(), "A"), true);
  assert.equal(eventInSession({ type: "message.delta", seq: 1, agent_id: "rb", text: "x", session_id: "B" }, "A"), false);
  assert.equal(eventInSession({ type: "session.default", seq: 1, session_id: "B", previous_session_id: "A" }, "A"), true);
  assert.equal(eventInSession({ type: "approval.requested", seq: 1, approval: { id: "1", agent_id: "x", session_id: "B" } as Approval }, "A"), false);
  const cleared: BridgeEvent = {
    type: "conversation.cleared",
    seq: 1,
    project_id: "p",
    conversation_id: "c",
    upto_message_id: 0,
    at: "t",
    title: "",
    summary: "",
    summary_source: "stored",
    session_id: "C",
    previous_session_id: "B",
  };
  assert.equal(eventInSession(cleared, "B"), true);
  assert.equal(eventInSession(cleared, "A"), false);
});

type Call = { url: string; method: string | undefined; body: unknown };
function http(answer: (url: string) => { status: number; body: string }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    const a = answer(url);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

test("http: the session routes", async () => {
  const s = session({ id: "ses 2", root_agent_id: "r" });
  let r = http(() => ({ status: 202, body: JSON.stringify({ queued: { id: "q", text: "x", created_at: "t" }, waiting_for: "slot" }) }));
  assert.deepEqual(await r.bridge.sendSessionMessage("p", "ses 2", "x", { mode: "plan" }), {
    queued: { id: "q", text: "x", created_at: "t" },
    waiting_for: "slot",
  });
  assert.deepEqual([r.calls[0]?.url, r.calls[0]?.body], ["http://h:1/v1/projects/p/sessions/ses%202/messages", { text: "x", mode: "plan" }]);
  r = http(() => ({ status: 201, body: JSON.stringify({ session: s }) }));
  await r.bridge.createSession("p", { title: "T", make_default: false });
  assert.deepEqual(r.calls[0]?.body, { title: "T", make_default: false });
  r = http(() => ({ status: 200, body: JSON.stringify({ session: s }) }));
  await r.bridge.setDefaultSession("p", "ses 2");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions/ses%202/default");
  r = http(() => ({ status: 200, body: JSON.stringify({ sessions: [{ ...s, project_id: "p", project_name: "P" }] }) }));
  const all = await r.bridge.listAllSessions({ kind: "main", limit: 20 });
  assert.equal(all[0]?.project_name, "P");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/sessions?kind=main&limit=20");
  r = http(() => ({ status: 200, body: JSON.stringify({ approvals: [] }) }));
  await r.bridge.listApprovals?.("p", { sessionId: "B" });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/approvals?session=B");
  r = http(() => ({ status: 201, body: "{}" }));
  await assert.rejects(r.bridge.createSession("p"), (e: unknown) => e instanceof BridgeError && e.code === "invalid_response");
});

test("sessionBridge: the project's session routes go to the session; the rest is unchanged", async () => {
  const r = http((url) =>
    url.endsWith("/clear")
      ? { status: 201, body: JSON.stringify({ session: session({ id: "C", started_at: "2026-11-14T11:00:00.000Z" }) }) }
      : url.endsWith("/stop")
        ? { status: 409, body: JSON.stringify({ error: { code: "not_running", message: "idle" } }) }
        : { status: 200, body: JSON.stringify({ paused: false, messages: [], plan: null, approvals: [], message: { id: 1 } }) },
  );
  const b: Bridge = sessionBridge(r.bridge, "B");
  await b.getQueue?.("p");
  await b.resumeQueue?.("p");
  await b.getLatestPlan?.("p");
  await b.listApprovals?.("p");
  await b.compactNow?.("p");
  await b.cancelTurn("p"); // not_running is not an error, as for the project route
  const cleared = await b.clearConversation?.("p");
  await b.sendOrQueueMessage?.("p", "hi");
  assert.equal(cleared?.session_id, "C");
  assert.equal(cleared?.previous_session_id, "B");
  assert.equal(b.exportConversationUrl?.("p"), "http://h:1/v1/projects/p/sessions/B/export?format=md");
  await b.getTranscript("p", "rb");
  assert.deepEqual(
    r.calls.map((c) => `${c.method} ${c.url.replace("http://h:1/v1/projects/p", "")}`),
    [
      "GET /sessions/B/queue",
      "POST /sessions/B/queue/resume",
      "GET /sessions/B/plans/latest",
      "GET /approvals?session=B",
      "POST /sessions/B/compact",
      "POST /sessions/B/stop",
      "POST /sessions/B/clear",
      "POST /sessions/B/messages",
      "GET /agents/rb/messages",
    ],
  );
});

test("a session send that timed out reads back that session's root and queue", async () => {
  let posted = 0;
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url.replace("http://h:1/v1/projects/p", "")}`);
    if (init?.method === "POST") {
      posted += 1;
      return new Promise(() => undefined);
    }
    if (url.endsWith("/sessions/B")) return { ok: true, status: 200, text: async () => JSON.stringify({ session: session({ id: "B", root_agent_id: "rb" }) }) };
    if (url.endsWith("/agents/rb/messages"))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ messages: [{ ...ask(5, "rb"), content: [{ type: "text", text: "hi" }], created_at: new Date().toISOString() }] }),
      };
    return { ok: true, status: 200, text: async () => JSON.stringify({ paused: false, messages: [] }) };
  };
  // Manual timers: the send's timeout fires when the test says so.
  const due: (() => void)[] = [];
  const timers: TimersLike = { setTimeout: (fn) => due.push(fn), clearTimeout: () => undefined, now: () => Date.now() };
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch, timers });
  await import("./rare");
  const sending = bridge.sendSessionMessage("p", "B", "hi");
  // The lazy module loads first: let it, then fire the timeout.
  for (let i = 0; i < 50 && due.length === 0; i++) await Promise.resolve();
  due.shift()?.();
  const r = await sending;
  assert.equal(r.message?.id, 5);
  assert.equal(posted, 1);
  assert.deepEqual(calls, ["POST /sessions/B/messages", "GET /sessions/B", "GET /agents/rb/messages"]);
});
