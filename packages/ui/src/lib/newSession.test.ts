import assert from "node:assert/strict";
import test from "node:test";
import { newSessionTitle, runNewSession, type NewSessionDeps } from "./newSession";

function fake(over: Partial<NewSessionDeps> = {}) {
  const calls: string[] = [];
  const deps: NewSessionDeps = {
    create: async (input) => {
      calls.push(`create ${input.title ?? ""}`);
      return { session: { id: "s2", title: input.title ?? "" } };
    },
    send: async (sid, text, att) => {
      calls.push(`send ${sid} ${text} ${att.join(",")}`);
      return {};
    },
    ...over,
  };
  return { deps, calls };
}

test("newSessionTitle cuts at a word boundary near 60 characters", () => {
  assert.equal(newSessionTitle("Fix the  flaky\nupload test"), "Fix the flaky upload test");
  const long = "Find out why the upload test fails one run in five and propose a fix without changing code";
  const t = newSessionTitle(long);
  assert.ok(t.length <= 61, t);
  assert.ok(t.endsWith("…"));
  assert.ok(long.startsWith(t.slice(0, -1)));
});

test("/new with text creates a session and sends the text there, with its attachments", async () => {
  const { deps, calls } = fake();
  const out = await runNewSession(deps, "  Check the logs  ", ["img1"]);
  assert.deepEqual(out, { kind: "started", sessionId: "s2", title: "Check the logs", waiting: false });
  assert.deepEqual(calls, ["create ", "send s2 Check the logs img1"]);
});

test("/new alone creates an empty session to open, and sends nothing", async () => {
  const { deps, calls } = fake();
  assert.deepEqual(await runNewSession(deps, " "), { kind: "open", sessionId: "s2" });
  assert.deepEqual(calls, ["create "]);
});

test("a failed create keeps the text (nothing sent); a failed send opens the new session", async () => {
  const boom = new Error("no");
  const a = fake({ create: async () => Promise.reject(boom) });
  assert.deepEqual(await runNewSession(a.deps, "x"), { kind: "create-failed", error: boom });
  assert.deepEqual(a.calls, []);
  const b = fake({ send: async () => Promise.reject(boom) });
  assert.deepEqual(await runNewSession(b.deps, "x"), { kind: "send-failed", sessionId: "s2", error: boom });
});

test("a request waiting for a free place to start is started, not failed", async () => {
  const { deps } = fake({ send: async () => ({ queued: {}, waiting_for: "slot" }) });
  assert.deepEqual(await runNewSession(deps, "x"), { kind: "started", sessionId: "s2", title: "x", waiting: true });
});
