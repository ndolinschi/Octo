import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState, withApprovals, withInputs, withQueue, withTasks } from "./state";
import type { Approval, BridgeEvent, FileChange, InputRequest, Task } from "./types";

type Call = { url: string; method: string | undefined; body: string | undefined };

function bridgeWith(status: number, body: string) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

const change = (id: number, turn: number): FileChange => ({
  id,
  turn_id: turn,
  agent_id: "a",
  folder: "ws",
  path: "x.txt",
  kind: "created",
  added: 3,
  removed: 0,
  created_at: "t",
  note: "",
  source: "bash",
});

const approval = (id: string): Approval => ({
  id,
  agent_id: "a",
  agent_label: "Explorer",
  turn_id: 1,
  kind: "write",
  title: "Write x.txt",
  detail: { folder: "ws", path: "x.txt", diff: { added: 1, removed: 0 } },
  created_at: `t${id}`,
});

const form = (id: string): InputRequest => ({
  id,
  agent_id: "a",
  agent_label: "orchestrator",
  turn_id: 1,
  title: "Credentials",
  reason: "r",
  fields: [{ id: "api_key", label: "API key", kind: "secret", required: true }],
  created_at: `t${id}`,
});

test("every v7 event type is subscribed to", () => {
  for (const t of [
    "change.recorded",
    "approval.requested",
    "approval.resolved",
    "input.requested",
    "input.resolved",
    "queue.updated",
    "project.attention",
    "secrets.changed",
  ] as const) {
    assert.ok(BRIDGE_EVENT_TYPES.includes(t), t);
  }
});

test("changes: recorded events accumulate per turn and are deduplicated", () => {
  let s = emptyProjectState();
  const ev: BridgeEvent = { type: "change.recorded", seq: 1, turn_id: 7, change: change(1, 7) };
  s = applyEvent(s, ev);
  s = applyEvent(s, { ...ev, seq: 2 });
  s = applyEvent(s, { type: "change.recorded", seq: 3, turn_id: 7, change: change(2, 7) });
  assert.equal(s.changes[7]?.length, 2);
  assert.equal(s.lastSeq, 3);
});

test("approvals: requested then resolved", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "approval.requested", seq: 1, approval: approval("a1") });
  s = applyEvent(s, { type: "approval.requested", seq: 2, approval: approval("a2") });
  s = applyEvent(s, { type: "approval.requested", seq: 3, approval: approval("a2") });
  assert.deepEqual(
    s.approvals.map((a) => a.id),
    ["a1", "a2"],
  );
  s = applyEvent(s, { type: "approval.resolved", seq: 4, id: "a1", decision: "deny" });
  assert.deepEqual(
    s.approvals.map((a) => a.id),
    ["a2"],
  );
  s = withApprovals(s, [approval("b2"), approval("b1")]);
  assert.deepEqual(
    s.approvals.map((a) => a.id),
    ["b1", "b2"],
  );
});

test("forms: open, then answered keeps names and non-secret values only", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "input.requested", seq: 1, input: form("i1") });
  assert.equal(s.inputs.length, 1);
  s = applyEvent(s, {
    type: "input.resolved",
    seq: 2,
    id: "i1",
    status: "submitted",
    provided: ["api_key"],
    values: { region: "eu" },
  });
  assert.equal(s.inputs.length, 0);
  assert.deepEqual(s.answeredInputs.i1, { status: "submitted", provided: ["api_key"], values: { region: "eu" } });
  // A schema form keeps its schema in state and its typed values once answered.
  const schema: InputRequest["schema"] = {
    type: "object",
    required: ["replicas"],
    properties: { replicas: { type: "integer", minimum: 1, maximum: 10 }, checks: { type: "array", items: { type: "string", enum: ["unit", "lint"] } } },
  };
  s = applyEvent(s, { type: "input.requested", seq: 3, input: { ...form("i4"), schema } });
  assert.deepEqual(s.inputs[0]?.schema, schema);
  s = applyEvent(s, { type: "input.resolved", seq: 4, id: "i4", status: "submitted", provided: [], values: { replicas: 3, checks: ["unit"] } });
  assert.deepEqual(s.answeredInputs.i4?.values, { replicas: 3, checks: ["unit"] });
  s = withInputs(s, [form("i3"), form("i2")]);
  assert.deepEqual(
    s.inputs.map((i) => i.id),
    ["i2", "i3"],
  );
});

test("queue, attention and secrets revision", () => {
  let s = emptyProjectState();
  s = applyEvent(s, { type: "queue.updated", seq: 1, paused: true, messages: [{ id: "q1", text: "x", created_at: "t" }] });
  assert.equal(s.queue.paused, true);
  assert.equal(s.queue.messages[0]?.id, "q1");
  s = applyEvent(s, { type: "project.attention", seq: 2, needs_you: true, approvals: 1, inputs: 2 });
  assert.deepEqual(s.attention, { needs_you: true, approvals: 1, inputs: 2 });
  s = applyEvent(s, { type: "secrets.changed", seq: 3, names: ["api_key"] });
  assert.equal(s.secretsRevision, 1);
  s = withQueue(s, { paused: false, messages: [] });
  assert.equal(s.queue.messages.length, 0);
});

test("http: changes, queue, approvals, forms and secrets request shapes", async () => {
  const cases: {
    run: (b: ReturnType<typeof bridgeWith>["bridge"]) => Promise<unknown> | undefined;
    reply: string;
    status?: number;
    method: string;
    path: string;
    body?: unknown;
    result?: unknown;
  }[] = [
    { run: (b) => b.listChanges?.("p"), reply: '{"turns":[{"turn_id":1}]}', method: "GET", path: "/v1/projects/p/changes", result: [{ turn_id: 1 }] },
    { run: (b) => b.listChanges?.("p", 5), reply: '{"turns":[]}', method: "GET", path: "/v1/projects/p/changes?turn=5", result: [] },
    { run: (b) => b.getChange?.("p", 3), reply: '{"id":3}', method: "GET", path: "/v1/projects/p/changes/3", result: { id: 3 } },
    { run: (b) => b.revertChange?.("p", 3), reply: '{"folder":"ws"}', method: "POST", path: "/v1/projects/p/changes/3/revert", result: { folder: "ws" } },
    {
      run: (b) => b.getQueue?.("p"),
      reply: '{"paused":false,"messages":[]}',
      method: "GET",
      path: "/v1/projects/p/queue",
      result: { paused: false, messages: [] },
    },
    {
      run: (b) => b.editQueued?.("p", "q 1", "t"),
      reply: '{"id":"q 1"}',
      method: "PATCH",
      path: "/v1/projects/p/queue/q%201",
      body: { text: "t" },
      result: { id: "q 1" },
    },
    { run: (b) => b.removeQueued?.("p", "q"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/queue/q", result: undefined },
    { run: (b) => b.clearQueue?.("p"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/queue", result: undefined },
    { run: (b) => b.resumeQueue?.("p"), reply: "{}", status: 202, method: "POST", path: "/v1/projects/p/queue/resume", result: undefined },
    { run: (b) => b.sendQueuedNow?.("p", "q"), reply: "{}", status: 202, method: "POST", path: "/v1/projects/p/queue/q/send-now", result: undefined },
    { run: (b) => b.listApprovals?.("p"), reply: '{"approvals":[]}', method: "GET", path: "/v1/projects/p/approvals", result: [] },
    {
      run: (b) => b.resolveApproval?.("p", "a1", { decision: "deny", note: "no" }),
      reply: "",
      status: 204,
      method: "POST",
      path: "/v1/projects/p/approvals/a1",
      body: { decision: "deny", note: "no" },
      result: undefined,
    },
    {
      run: (b) => b.resolveApproval?.("p", "a1", { decision: "allow_always", match: "git status" }),
      reply: "",
      status: 204,
      method: "POST",
      path: "/v1/projects/p/approvals/a1",
      body: { decision: "allow_always", match: "git status" },
      result: undefined,
    },
    {
      run: (b) => b.listApprovalRules?.("p"),
      reply: '{"rules":[{"id":"rul_1","tool":"bash","match":"git status","exact":false,"created_at":"t"}]}',
      method: "GET",
      path: "/v1/projects/p/approval-rules",
      result: [{ id: "rul_1", tool: "bash", match: "git status", exact: false, created_at: "t" }],
    },
    {
      run: (b) => b.deleteApprovalRule?.("p", "rul 1"),
      reply: "",
      status: 204,
      method: "DELETE",
      path: "/v1/projects/p/approval-rules/rul%201",
      result: undefined,
    },
    {
      run: (b) => b.sendQueuedNow?.("p", "q", { interrupt: true }),
      reply: "{}",
      status: 202,
      method: "POST",
      path: "/v1/projects/p/queue/q/send-now",
      body: { interrupt: true },
      result: undefined,
    },
    {
      run: (b) => b.steerQueued?.("p", "q"),
      reply: '{"steered":true}',
      status: 202,
      method: "POST",
      path: "/v1/projects/p/queue/q/send-now",
      result: { steered: true },
    },
    {
      run: (b) => b.getLatestPlan?.("p"),
      reply: '{"plan":{"id":"pln_1","turn_id":4,"text":"1. x","status":"pending","created_at":"t","approved_at":null}}',
      method: "GET",
      path: "/v1/projects/p/plans/latest",
      result: { id: "pln_1", turn_id: 4, text: "1. x", status: "pending", created_at: "t", approved_at: null },
    },
    {
      run: (b) => b.approvePlan?.("p", "pln 1"),
      reply: '{"plan":{"id":"pln 1"},"message":{"id":9}}',
      status: 202,
      method: "POST",
      path: "/v1/projects/p/plans/pln%201/approve",
      result: { plan: { id: "pln 1" }, message: { id: 9 } },
    },
    {
      run: (b) => b.rewind?.("p", { message_id: 3, dry_run: true }),
      reply: '{"dry_run":true,"message_id":3,"request_text":"r","files":[],"conflicts":[],"messages_cut":2,"agents_cut":0,"acp_session_reset":false}',
      method: "POST",
      path: "/v1/projects/p/rewind",
      body: { message_id: 3, dry_run: true },
      result: { dry_run: true, message_id: 3, request_text: "r", files: [], conflicts: [], messages_cut: 2, agents_cut: 0, acp_session_reset: false },
    },
    {
      run: (b) => b.compactNow?.("p"),
      reply: '{"upto_message_id":8,"at":"t","summary_tokens":120,"message_count":8,"manual":true}',
      method: "POST",
      path: "/v1/projects/p/compact",
      result: { upto_message_id: 8, at: "t", summary_tokens: 120, message_count: 8, manual: true },
    },
    {
      run: (b) => b.searchRequests?.("zebra fish", 5),
      reply: '{"results":[{"project_id":"p","project_name":"P","message_id":2,"snippet":"s","date":"d"}]}',
      method: "GET",
      path: "/v1/search?q=zebra%20fish&limit=5",
      result: [{ project_id: "p", project_name: "P", message_id: 2, snippet: "s", date: "d" }],
    },
    {
      run: (b) => b.sendOrQueueMessage?.("p", "hi", { mode: "plan" }),
      reply: '{"queued":{"id":"q1","text":"hi","created_at":"t","mode":"plan"}}',
      status: 202,
      method: "POST",
      path: "/v1/projects/p/messages",
      body: { text: "hi", mode: "plan" },
      result: { queued: { id: "q1", text: "hi", created_at: "t", mode: "plan" } },
    },
    { run: (b) => b.listInputs?.("p"), reply: '{"inputs":[]}', method: "GET", path: "/v1/projects/p/inputs", result: [] },
    {
      run: (b) => b.submitInput?.("p", "i1", { values: { api_key: "k" } }),
      reply: "",
      status: 204,
      method: "POST",
      path: "/v1/projects/p/inputs/i1",
      body: { values: { api_key: "k" } },
      result: undefined,
    },
    {
      // Dynamic forms: numbers stay numbers and many-of answers arrays on the wire.
      run: (b) => b.submitInput?.("p", "i2", { values: { replicas: 3, checks: ["unit", "lint"], canary: true } }),
      reply: "",
      status: 204,
      method: "POST",
      path: "/v1/projects/p/inputs/i2",
      body: { values: { replicas: 3, checks: ["unit", "lint"], canary: true } },
      result: undefined,
    },
    {
      run: (b) => b.listSecrets?.("p"),
      reply: '{"secrets":[{"name":"k","updated_at":"t"}]}',
      method: "GET",
      path: "/v1/projects/p/secrets",
      result: [{ name: "k", updated_at: "t" }],
    },
    {
      run: (b) => b.putSecret?.("p", "k", "v"),
      reply: "",
      status: 204,
      method: "PUT",
      path: "/v1/projects/p/secrets/k",
      body: { value: "v" },
      result: undefined,
    },
    { run: (b) => b.deleteSecret?.("p", "k"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/secrets/k", result: undefined },
  ];
  for (const c of cases) {
    const { bridge, calls } = bridgeWith(c.status ?? 200, c.reply);
    const got = await c.run(bridge);
    assert.equal(calls.length, 1, c.path);
    assert.equal(calls[0]?.method, c.method, c.path);
    assert.equal(calls[0]?.url, `http://h:1${c.path}`);
    if (c.body !== undefined) assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), c.body);
    assert.deepEqual(got, c.result, c.path);
  }
});

test("getLatestPlan: no plan is null, from `{plan: null}` and from an older harness's 404", async () => {
  assert.equal(await bridgeWith(200, '{"plan":null}').bridge.getLatestPlan?.("p"), null);
  assert.equal(await bridgeWith(404, '{"error":{"code":"not_found","message":"no plan"}}').bridge.getLatestPlan?.("p"), null);
  await assert.rejects(
    bridgeWith(404, '{"error":{"code":"project_not_found","message":"x"}}').bridge.getLatestPlan?.("p") ?? Promise.resolve(),
    (e: unknown) => e instanceof BridgeError && e.code === "project_not_found",
  );
});

test("sendOrQueueMessage tells a started turn from a queued message; sendMessage refuses a queued one", async () => {
  const started = bridgeWith(202, '{"message":{"id":4}}').bridge;
  assert.deepEqual(await started.sendOrQueueMessage?.("p", "hi"), { message: { id: 4 } });
  const queued = bridgeWith(202, '{"queued":{"id":"q1","text":"hi","created_at":"t"}}').bridge;
  assert.deepEqual(await queued.sendOrQueueMessage?.("p", "hi"), { queued: { id: "q1", text: "hi", created_at: "t" } });
  await assert.rejects(queued.sendMessage("p", "hi"), (e: unknown) => e instanceof BridgeError && e.code === "queued");
  assert.deepEqual(await started.sendMessage("p", "hi"), { id: 4 });
  const full = bridgeWith(409, '{"error":{"code":"queue_full","message":"full"}}').bridge;
  await assert.rejects(
    full.sendOrQueueMessage?.("p", "x") ?? Promise.reject(new Error("missing")),
    (e: unknown) => e instanceof BridgeError && e.code === "queue_full",
  );
});

test("http: diagnostics", async () => {
  const { bridge, calls } = bridgeWith(200, '{"version":"1","agents":[],"problems":[]}');
  const got = await bridge.getDiagnostics?.();
  assert.equal(calls[0]?.url, "http://h:1/v1/diagnostics");
  assert.equal(got?.version, "1");
});

test("M1: task and memory events and request shapes", async () => {
  let s = emptyProjectState();
  const task: Task = {
    id: "tsk_1",
    title: "t",
    status: "open",
    goal: "g",
    goal_by: "harness",
    auto: true,
    constraints: [],
    acceptance: [],
    quotes: [],
    decisions: [],
    outcome: "",
    files: [],
    facts: [],
    message_ids: [1],
    created_at: "t",
    updated_at: "t",
    state_summary: "Did: changed 1 file (a.go).",
    open_questions: [],
    unfinished: false,
    exchange_ids: ["exc_1"],
  };
  s = applyEvent(s, { type: "task.updated", seq: 1, task: { ...task } });
  assert.equal(s.tasks.tsk_1?.goal, "g");
  assert.deepEqual(s.tasks.tsk_1?.exchange_ids, ["exc_1"]);
  assert.equal(s.tasks.tsk_1?.state_summary, "Did: changed 1 file (a.go).");
  const closed: Task = { ...task, id: "tsk_2", goal_by: "rule", status: "dropped", closed_reason: "dropped: no activity" };
  s = applyEvent(s, { type: "task.updated", seq: 9, task: closed });
  assert.equal(s.tasks.tsk_2?.closed_reason, "dropped: no activity");
  s = applyEvent(s, { type: "task.updated", seq: 10, task_id: "tsk_2", deleted: true });
  s = applyEvent(s, { type: "task.updated", seq: 2, task_id: "tsk_1", deleted: true });
  assert.equal(Object.keys(s.tasks).length, 0);
  s = applyEvent(s, { type: "memory.updated", seq: 3, path: "a.md" });
  assert.equal(s.memoryRevision, 1);
  s = withTasks(s, [{ ...task }]);
  assert.equal(s.tasks.tsk_1?.id, "tsk_1");

  const cases: {
    run: (b: ReturnType<typeof bridgeWith>["bridge"]) => Promise<unknown> | undefined;
    reply: string;
    status?: number;
    method: string;
    path: string;
    body?: unknown;
    result?: unknown;
  }[] = [
    { run: (b) => b.listTasks?.("p"), reply: '{"tasks":[]}', method: "GET", path: "/v1/projects/p/tasks", result: [] },
    { run: (b) => b.listMemory?.("p"), reply: '{"files":[],"index":"#"}', method: "GET", path: "/v1/projects/p/memory", result: { files: [], index: "#" } },
    {
      run: (b) => b.getMemoryFile?.("p", "notes/a b.md"),
      reply: '{"path":"notes/a b.md"}',
      method: "GET",
      path: "/v1/projects/p/memory/notes/a%20b.md",
      result: { path: "notes/a b.md" },
    },
    {
      run: (b) => b.putMemoryFile?.("p", "a.md", "x", "s"),
      reply: '{"path":"a.md"}',
      method: "PUT",
      path: "/v1/projects/p/memory/a.md",
      body: { content: "x", summary: "s" },
      result: { path: "a.md" },
    },
    { run: (b) => b.deleteMemoryFile?.("p", "a.md"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/memory/a.md", result: undefined },
    {
      run: (b) => b.searchMemory?.("p", { q: "бюджет", in: ["facts", "messages"], after: "2026-10-01", limit: 5 }),
      reply: '{"hits":[],"message":"nothing in memory matches"}',
      method: "GET",
      path: "/v1/projects/p/memory/search?q=%D0%B1%D1%8E%D0%B4%D0%B6%D0%B5%D1%82&in=facts,messages&after=2026-10-01&limit=5",
      result: { hits: [], message: "nothing in memory matches" },
    },
  ];
  for (const c of cases) {
    const { bridge, calls } = bridgeWith(c.status ?? 200, c.reply);
    const got = await c.run(bridge);
    assert.equal(calls[0]?.method, c.method, c.path);
    assert.equal(calls[0]?.url, `http://h:1${c.path}`);
    if (c.body !== undefined) assert.deepEqual(JSON.parse(calls[0]?.body ?? "null"), c.body);
    assert.deepEqual(got, c.result, c.path);
  }
});

test("M2: turn context receipt request", async () => {
  const { bridge, calls } = bridgeWith(200, '{"turn_id":7,"mode":"window","blocks":[]}');
  const got = await bridge.getTurnContext?.("p", 7);
  assert.equal(calls[0]?.url, "http://h:1/v1/projects/p/turns/7/context");
  assert.equal(got?.mode, "window");
  const upd = bridgeWith(200, '{"id":"p"}');
  await upd.bridge.updateProject("p", { memory: { context: "window" } });
  assert.deepEqual(JSON.parse(upd.calls[0]?.body ?? "null"), { memory: { context: "window" } });
});
