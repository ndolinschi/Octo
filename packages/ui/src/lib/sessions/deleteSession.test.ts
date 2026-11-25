import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, type Bridge, type ProjectSession } from "@octo/agent-client";
import { deleteSessionCleanly } from "./deleteSession";

function makeSession(overrides: Partial<ProjectSession> & { id: string }): ProjectSession {
  return {
    kind: "main",
    title: "",
    state: "idle",
    model: "",
    default: false,
    current: false,
    archived: false,
    exchanges: 0,
    children: 0,
    can_message: false,
    started_at: "2026-11-17T10:00:00Z",
    last_activity_at: "2026-11-17T10:00:00Z",
    ...overrides,
  };
}

test("deleteSessionCleanly stops running child agent and target session before deleting", async () => {
  const calls: string[] = [];
  const main = makeSession({ id: "s-main", state: "working" });
  const child = makeSession({ id: "s-agent", kind: "agent", parent_session_id: "s-main", state: "waiting" });
  const bridge = {
    listSessions: async () => [main, child],
    stopSession: async (_pid: string, sid: string) => {
      calls.push(`stop:${sid}`);
      return makeSession({ id: sid, state: "idle" });
    },
    deleteSession: async (_pid: string, sid: string) => {
      calls.push(`del:${sid}`);
    },
  } as unknown as Bridge;

  const res = await deleteSessionCleanly(bridge, "p1", main, [main, child]);
  assert.deepEqual(calls, ["stop:s-agent", "stop:s-main", "del:s-main"]);
  assert.equal(res.replacementId, null);
  assert.equal(res.createdSession, null);
});

test("deleteSessionCleanly promotes another main session when deleting the default session", async () => {
  const calls: string[] = [];
  const s1 = makeSession({ id: "s1", default: true, current: true });
  const s2 = makeSession({ id: "s2", title: "Second" });
  const bridge = {
    listSessions: async () => [s1, s2],
    setDefaultSession: async (_pid: string, sid: string) => {
      calls.push(`default:${sid}`);
      return { ...s2, default: true, current: true };
    },
    deleteSession: async (_pid: string, sid: string) => {
      calls.push(`del:${sid}`);
    },
  } as unknown as Bridge;

  const res = await deleteSessionCleanly(bridge, "p1", s1);
  assert.deepEqual(calls, ["default:s2", "del:s1"]);
  assert.equal(res.replacementId, "s2");
});

test("deleteSessionCleanly creates and promotes a fresh main session when deleting the only main session", async () => {
  const calls: string[] = [];
  const s1 = makeSession({ id: "s1", default: true, current: true });
  const fresh = makeSession({ id: "s-fresh" });
  const bridge = {
    listSessions: async () => [s1],
    createSession: async () => {
      calls.push("create");
      return { session: fresh };
    },
    setDefaultSession: async (_pid: string, sid: string) => {
      calls.push(`default:${sid}`);
      return { ...fresh, default: true, current: true };
    },
    deleteSession: async (_pid: string, sid: string) => {
      calls.push(`del:${sid}`);
    },
  } as unknown as Bridge;

  const res = await deleteSessionCleanly(bridge, "p1", s1);
  assert.deepEqual(calls, ["create", "default:s-fresh", "del:s1"]);
  assert.equal(res.replacementId, "s-fresh");
  assert.equal(res.createdSession?.id, "s-fresh");
});

test("deleteSessionCleanly retries when server responds with current_session race", async () => {
  const calls: string[] = [];
  const s1 = makeSession({ id: "s1", default: false });
  const s2 = makeSession({ id: "s2", default: false });
  let firstAttempt = true;
  const bridge = {
    listSessions: async () => [s1, s2],
    setDefaultSession: async (_pid: string, sid: string) => {
      calls.push(`default:${sid}`);
      return { ...s2, default: true, current: true };
    },
    deleteSession: async (_pid: string, sid: string) => {
      calls.push(`del:${sid}`);
      if (firstAttempt) {
        firstAttempt = false;
        throw new BridgeError(409, "current_session", "Session is current");
      }
    },
  } as unknown as Bridge;

  const res = await deleteSessionCleanly(bridge, "p1", s1);
  assert.deepEqual(calls, ["del:s1", "default:s2", "del:s1"]);
  assert.equal(res.replacementId, "s2");
});
