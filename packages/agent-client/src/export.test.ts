import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type BinaryFetchLike } from "./client";

type Call = { url: string; method?: string; headers?: Record<string, string> };

function bridge(status: number, body: string, calls: Call[], type: string | null = "text/markdown; charset=utf-8") {
  const fetch: BinaryFetchLike = async (url, init) => {
    calls.push({ url, ...(init?.method ? { method: init.method } : {}), ...(init?.headers ? { headers: init.headers } : {}) });
    const bytes = Uint8Array.from(Array.from(body, (c) => c.charCodeAt(0)));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      arrayBuffer: async () => bytes.buffer,
      headers: { get: (n: string) => (n === "Content-Type" ? type : null) },
    };
  };
  return createHttpBridge({ baseUrl: "http://h:1/", token: "tok", fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }), fetchBinary: fetch });
}

test("exportConversation fetches with the Authorization header and returns the Markdown as a Blob", async () => {
  const calls: Call[] = [];
  const b = bridge(200, "# Project\n\nhello", calls);
  const blob = await b.exportConversation?.("p 1");
  assert.equal(calls[0]?.url, "http://h:1/v1/projects/p%201/export?format=md");
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers?.Authorization, "Bearer tok");
  assert.ok(!calls[0]?.url.includes("token="), "the token never travels in the URL");
  assert.equal(await blob?.text(), "# Project\n\nhello");
  assert.ok((blob?.type ?? "").includes("text/markdown"));
});

test("exportConversation surfaces a harness error", async () => {
  const b = bridge(401, JSON.stringify({ error: { code: "unauthorized", message: "Octo's local server did not accept this app." } }), []);
  await assert.rejects(Promise.resolve(b.exportConversation?.("p")), (e: unknown) => e instanceof BridgeError && e.status === 401 && e.code === "unauthorized");
});

test("exportConversationUrl stays a plain link (the demo's data URL, a no-token harness)", () => {
  const b = bridge(200, "", []);
  assert.equal(b.exportConversationUrl?.("p"), "http://h:1/v1/projects/p/export?format=md");
});
