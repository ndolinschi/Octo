import assert from "node:assert/strict";
import test from "node:test";
import { createHttpBridge, type FetchLike } from "./client";
import { applyEvent, emptyProjectState } from "./state";

function bridgeWith(status: number, body: string) {
  const calls: { url: string; method: string | undefined }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

test("M4: sessions requests unwrap the list and encode ids", async () => {
  const session = { id: "ses_1", title: "t", started_at: "a", ended_at: "b", exchanges: 2, open: true };
  let r = bridgeWith(200, JSON.stringify({ sessions: [session] }));
  assert.deepEqual(await r.bridge.listMemorySessions?.("p", { limit: 5, before: "2026-11-12T09:00:00.000Z" }), [session]);
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/memory/sessions?limit=5&before=2026-11-12T09%3A00%3A00.000Z");
  r = bridgeWith(200, JSON.stringify({ sessions: [] }));
  await r.bridge.listMemorySessions?.("p");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/memory/sessions");
  r = bridgeWith(200, JSON.stringify({ session, exchanges: [] }));
  assert.deepEqual(await r.bridge.getMemorySession?.("p", "ses/1"), { session, exchanges: [] });
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/memory/sessions/ses%2F1");
  r = bridgeWith(204, "");
  assert.equal(await r.bridge.forgetExchange?.("p", "exc_1"), undefined);
  assert.equal(r.calls[0]?.method, "DELETE");
  assert.equal(r.calls[0]?.url, "http://h:1/v1/projects/p/memory/exchanges/exc_1");
});

test("M4: a session event without a path still bumps the memory revision", () => {
  const s = applyEvent(emptyProjectState(), { type: "memory.updated", seq: 1, session_id: "ses_1", exchange_id: "exc_1" });
  assert.equal(s.memoryRevision, 1);
});
