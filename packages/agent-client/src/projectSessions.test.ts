import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState, withSessions } from "./state";
import type { ProjectSession } from "./types";

type Call = { url: string; method: string | undefined; body: unknown };

function bridgeWith(status: number, body: string) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

function session(over: Partial<ProjectSession> & { id: string }): ProjectSession {
  return {
    kind: "main",
    title: over.id,
    state: "idle",
    model: "m",
    started_at: "2026-11-12T09:00:00.000Z",
    last_activity_at: "2026-11-12T09:00:00.000Z",
    exchanges: 1,
    children: 0,
    current: false,
    archived: false,
    can_message: false,
    ...over,
  };
}

test("sessions: list and detail requests build the query and unwrap", async () => {
  const s = session({ id: "ses_1", current: true, can_message: true });
  let r = bridgeWith(200, JSON.stringify({ sessions: [s] }));
  assert.deepEqual(await r.bridge.listSessions?.("p", { kind: "agent", state: "working", archived: "all", limit: 20, before: "2026-11-12T09:00:00.000Z" }), [
    s,
  ]);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions?kind=agent&state=working&archived=all&limit=20&before=2026-11-12T09%3A00%3A00.000Z");
  r = bridgeWith(200, JSON.stringify({ sessions: [] }));
  await r.bridge.listSessions?.("p", { archived: true });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions?archived=true");
  r = bridgeWith(200, JSON.stringify({ sessions: [] }));
  await r.bridge.listSessions?.("p");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions");
  const detail = { session: s, exchanges: [], children: [] };
  r = bridgeWith(200, JSON.stringify(detail));
  assert.deepEqual(await r.bridge.getSession?.("p", "ses/1"), detail);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions/ses%2F1");
});

test("sessions: transcripts, with and without a session filter", async () => {
  const body = { messages: [{ id: 1, agent_id: "a", role: "user", content: [], created_at: "x", session_id: "ses_1" }], compactions: [], conversations: [] };
  let r = bridgeWith(200, JSON.stringify(body));
  const t = await (r.bridge.getSessionTranscript?.("p", "ses_1") ?? Promise.resolve(null));
  assert.equal(t?.messages.length, 1);
  assert.deepEqual(t?.conversations, []);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/sessions/ses_1/messages");
  r = bridgeWith(200, JSON.stringify(body));
  await r.bridge.getTranscript("p", "agt_1", { sessionId: "ses 1" });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/agents/agt_1/messages?session_id=ses%201");
  r = bridgeWith(200, JSON.stringify(body));
  await r.bridge.getTranscript("p", "agt_1");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/agents/agt_1/messages");
  r = bridgeWith(200, "{}");
  await assert.rejects(
    r.bridge.getSessionTranscript?.("p", "ses_1") ?? Promise.resolve(null),
    (e: unknown) => e instanceof BridgeError && e.code === "invalid_response",
  );
});

test("sessions: create, resume, patch, delete, stop and message", async () => {
  const s = session({ id: "ses_2", current: true });
  let r = bridgeWith(201, JSON.stringify({ session: s }));
  assert.deepEqual(await r.bridge.createSession("p", { title: "Plan B" }), { session: s });
  assert.deepEqual([r.calls[0]?.method, r.calls[0]?.url, r.calls[0]?.body], ["POST", "http://h:1/v1/projects/p/sessions", { title: "Plan B" }]);
  r = bridgeWith(201, JSON.stringify({ session: s }));
  await r.bridge.createSession("p");
  assert.deepEqual(r.calls[0]?.body, {});
  r = bridgeWith(200, JSON.stringify({ session: s }));
  assert.deepEqual(await r.bridge.resumeSession?.("p", "ses_2"), s);
  assert.deepEqual([r.calls[0]?.method, r.calls[0]?.url], ["POST", "http://h:1/v1/projects/p/sessions/ses_2/resume"]);
  r = bridgeWith(200, JSON.stringify({ session: s }));
  await r.bridge.patchSession?.("p", "ses_2", { title: "T", archived: true });
  assert.deepEqual([r.calls[0]?.method, r.calls[0]?.body], ["PATCH", { title: "T", archived: true }]);
  r = bridgeWith(204, "");
  assert.equal(await r.bridge.deleteSession?.("p", "ses_2"), undefined);
  assert.deepEqual([r.calls[0]?.method, r.calls[0]?.url], ["DELETE", "http://h:1/v1/projects/p/sessions/ses_2"]);
  r = bridgeWith(200, JSON.stringify({ session: s }));
  await r.bridge.stopSession("p", "ses_2");
  assert.deepEqual([r.calls[0]?.method, r.calls[0]?.url], ["POST", "http://h:1/v1/projects/p/sessions/ses_2/stop"]);
  r = bridgeWith(202, JSON.stringify({ outcome: "steered", session: s }));
  assert.deepEqual(await r.bridge.messageSession?.("p", "ses_2", "also pelicans", { reportToParent: true }), { outcome: "steered", session: s });
  assert.deepEqual(
    [r.calls[0]?.url, r.calls[0]?.body],
    ["http://h:1/v1/projects/p/sessions/ses_2/messages", { text: "also pelicans", report_to_parent: true }],
  );
  r = bridgeWith(202, JSON.stringify({ outcome: "continued", session: s }));
  await r.bridge.messageSession?.("p", "ses_2", "again");
  assert.deepEqual(r.calls[0]?.body, { text: "again" });
});

test("sessions: a refusal carries the error code the UI shows", async () => {
  const r = bridgeWith(409, JSON.stringify({ error: { code: "steer_unsupported", message: "cannot add input to a running ACP prompt" } }));
  await assert.rejects(
    r.bridge.messageSession?.("p", "ses_3", "hi") ?? Promise.resolve(null),
    (e: unknown) => e instanceof BridgeError && e.status === 409 && e.code === "steer_unsupported",
  );
});

test("sessions: the reducer keeps the list and the current main session from events", () => {
  let s = withSessions(emptyProjectState(), [
    session({ id: "old", started_at: "2026-11-10T09:00:00.000Z" }),
    session({ id: "now", started_at: "2026-11-12T09:00:00.000Z", current: true }),
  ]);
  assert.deepEqual(
    s.sessions.list.map((x) => x.id),
    ["now", "old"],
  );
  assert.equal(s.sessions.currentId, "now");

  // A new main session that is current demotes the others; an agent session joins without touching them.
  s = applyEvent(s, { type: "session.created", seq: 1, session: session({ id: "fresh", started_at: "2026-11-12T10:00:00.000Z", current: true }) });
  assert.equal(s.sessions.currentId, "fresh");
  assert.deepEqual(
    s.sessions.list.filter((x) => x.current).map((x) => x.id),
    ["fresh"],
  );
  s = applyEvent(s, {
    type: "session.created",
    seq: 2,
    session: session({ id: "worker", kind: "agent", parent_session_id: "fresh", state: "working", started_at: "2026-11-12T10:01:00.000Z" }),
  });
  assert.equal(s.sessions.currentId, "fresh");
  assert.equal(s.sessions.list[0]?.id, "worker");

  // updated replaces by id (state change), current moves the flag, deleted removes.
  s = applyEvent(s, {
    type: "session.updated",
    seq: 3,
    session: session({ id: "worker", kind: "agent", parent_session_id: "fresh", state: "idle", started_at: "2026-11-12T10:01:00.000Z" }),
  });
  assert.equal(s.sessions.list.find((x) => x.id === "worker")?.state, "idle");
  s = applyEvent(s, { type: "session.current", seq: 4, session_id: "old", previous_session_id: "fresh" });
  assert.equal(s.sessions.currentId, "old");
  assert.deepEqual(
    s.sessions.list.filter((x) => x.kind === "main" && x.current).map((x) => x.id),
    ["old"],
  );
  s = applyEvent(s, { type: "session.updated", seq: 5, session_id: "now", deleted: true });
  assert.equal(
    s.sessions.list.some((x) => x.id === "now"),
    false,
  );
  // The same session twice is one row.
  s = applyEvent(s, {
    type: "session.created",
    seq: 6,
    session: session({ id: "old", started_at: "2026-11-10T09:00:00.000Z", current: true, title: "renamed" }),
  });
  assert.equal(s.sessions.list.filter((x) => x.id === "old").length, 1);
  assert.equal(s.sessions.list.find((x) => x.id === "old")?.title, "renamed");
});

test("workspaces: listWorkspaces, moveSessionToWorktree, and file workspace queries", async () => {
  const ws = {
    id: "wrk_1",
    kind: "worktree" as const,
    title: "Worktree · octo/fix",
    state: "ready",
    branch: "octo/fix",
    created_at: "2026-11-16T00:00:00Z",
    folders: [{ workspace_id: "wrk_1", folder_id: "fld_1", folder_label: "web", path: "/tmp/wt", branch: "octo/fix", shared: false }],
  };
  let r = bridgeWith(200, JSON.stringify({ workspaces: [ws] }));
  assert.deepEqual(await r.bridge.listWorkspaces?.("p"), [ws]);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/workspaces");

  const movedSession = session({ id: "ses_1", workspace: { id: "wrk_1", kind: "worktree", title: ws.title, branch: "octo/fix" } });
  r = bridgeWith(200, JSON.stringify({ session: movedSession, workspace: ws }));
  assert.deepEqual(await r.bridge.moveSessionToWorktree?.("p", "ses_1", { branch: "octo/fix", carry_changes: true }), {
    session: movedSession,
    workspace: ws,
  });
  assert.deepEqual(
    [r.calls[0]?.method, r.calls[0]?.url, r.calls[0]?.body],
    ["POST", "http://h:1/v1/projects/p/sessions/ses_1/worktree", { branch: "octo/fix", carry_changes: true }],
  );

  r = bridgeWith(200, JSON.stringify({ entries: [] }));
  await r.bridge.listFiles("p", "web", "", { workspaceId: "wrk_1" });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/files?folder=web&path=&workspace=wrk_1");

  r = bridgeWith(200, JSON.stringify({ folder: "web", path: "a.ts", size: 1, mtime: "t", content: "x" }));
  await r.bridge.readFile("p", "web", "a.ts", { workspaceId: "wrk_1" });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/files/content?folder=web&path=a.ts&workspace=wrk_1");

  r = bridgeWith(200, JSON.stringify({ folder: "web", path: "a.ts", size: 1, mtime: "t" }));
  await r.bridge.writeFile("p", { folder: "web", path: "a.ts", content: "x", workspace_id: "wrk_1" });
  assert.deepEqual(r.calls[0]?.body, { folder: "web", path: "a.ts", content: "x", workspace_id: "wrk_1" });
});
