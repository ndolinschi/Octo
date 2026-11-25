import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type BinaryFetchLike, type FetchLike } from "./client";
import { applyEvent, emptyProjectState } from "./state";
import type { BridgeEvent } from "./types";

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array };

function bridge(status: number, body: string, calls: Call[], extra: Partial<Awaited<ReturnType<FetchLike>>> = {}) {
  const fetch: BinaryFetchLike & FetchLike = async (url, init) => {
    calls.push({
      url,
      ...(init?.method ? { method: init.method } : {}),
      ...(init?.headers ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    return { ok: status >= 200 && status < 300, status, text: async () => body, ...extra };
  };
  return createHttpBridge({ baseUrl: "http://h:1/", token: "tok", fetch, fetchBinary: fetch });
}

test("uploadAttachment sends the raw bytes with the token and returns the record", async () => {
  const calls: Call[] = [];
  const b = bridge(201, '{"id":"att_aaaaaaaaaaaaaaaaaaaaaaaa","media_type":"image/png","bytes":3,"width":2,"height":2}', calls);
  const bytes = new Uint8Array([1, 2, 3]);
  const a = await b.uploadAttachment?.("p", bytes, { name: "a b.png" });
  assert.equal(a?.id, "att_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(calls[0]?.url, "http://h:1/v1/projects/p/attachments?name=a%20b.png");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers?.Authorization, "Bearer tok");
  assert.equal(calls[0]?.body, bytes);
});

test("uploadAttachment surfaces the typed errors", async () => {
  for (const [status, code] of [
    [413, "attachment_too_large"],
    [415, "unsupported_media_type"],
  ] as const) {
    const b = bridge(status, JSON.stringify({ error: { code, message: "no" } }), []);
    await assert.rejects(
      Promise.resolve(b.uploadAttachment?.("p", new Uint8Array(1))),
      (e: unknown) => e instanceof BridgeError && e.status === status && e.code === code,
    );
  }
});

test("fetchAttachment returns the bytes and the type", async () => {
  const calls: Call[] = [];
  const buf = new Uint8Array([9, 8]).buffer;
  const b = bridge(200, "", calls, { arrayBuffer: async () => buf, headers: { get: (n: string) => (n === "Content-Type" ? "image/png" : null) } });
  const got = await b.fetchAttachment?.("p", "att_x");
  assert.equal(got?.type, "image/png");
  assert.equal(got?.data, buf);
  assert.equal(calls[0]?.url, "http://h:1/v1/projects/p/attachments/att_x");
});

test("sendOrQueueMessage carries attachments and a queued entry lists them", async () => {
  const calls: Call[] = [];
  const b = bridge(202, '{"queued":{"id":"q1","text":"t","created_at":"x","attachments":["att_a"]}}', calls);
  const r = await b.sendOrQueueMessage?.("p", "t", { attachments: ["att_a"] });
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { text: "t", attachments: ["att_a"] });
  assert.ok(r !== undefined && "queued" in r && r.queued?.attachments?.[0] === "att_a");
  const c2: Call[] = [];
  await bridge(202, '{"message":{"id":1}}', c2).sendOrQueueMessage?.("p", "t");
  assert.deepEqual(JSON.parse(String(c2[0]?.body)), { text: "t" });
});

test("a 422 images_unsupported is a BridgeError with its code", async () => {
  const b = bridge(422, '{"error":{"code":"images_unsupported","message":"X does not accept images"}}', []);
  await assert.rejects(
    Promise.resolve(b.sendOrQueueMessage?.("p", "t", { attachments: ["att_a"] })),
    (e: unknown) => e instanceof BridgeError && e.status === 422 && e.code === "images_unsupported",
  );
});

test("stopSide posts to /side/stop", async () => {
  const calls: Call[] = [];
  await bridge(204, "", calls).stopSide?.("p");
  assert.equal(calls[0]?.url, "http://h:1/v1/projects/p/side/stop");
  assert.equal(calls[0]?.method, "POST");
});

test("the side live events fill the pending answer, a no_provider error keeps its code", () => {
  let s = emptyProjectState();
  s = { ...s, side: { messages: [], pending: { side_id: "sid1", text: "" }, error: null } };
  const ev = (e: unknown) => e as BridgeEvent;
  s = applyEvent(s, ev({ type: "side.activity", seq: 1, side_id: "sid1", kind: "tool", label: "Reading a.go", tool_use_id: "t1" }));
  s = applyEvent(s, ev({ type: "side.thinking", seq: 2, side_id: "sid1", text: "hm" }));
  s = applyEvent(s, ev({ type: "side.delta", seq: 3, side_id: "sid1", text: "answer" }));
  assert.deepEqual(s.side.pending, { side_id: "sid1", text: "answer", thinking: "hm", activity: { kind: "tool", label: "Reading a.go", tool_use_id: "t1" } });
  s = applyEvent(s, ev({ type: "side.error", seq: 4, side_id: "sid1", error: "nothing can answer", code: "no_provider" }));
  assert.equal(s.side.pending, null);
  assert.deepEqual(s.side.error, { side_id: "sid1", message: "nothing can answer", code: "no_provider" });
});
