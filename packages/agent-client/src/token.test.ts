import assert from "node:assert/strict";
import test from "node:test";
import { resolveBridgeToken } from "./bridge";
import { createHttpBridge, type EventSourceLike, type FetchLike } from "./client";

type Seen = { url: string; headers: Record<string, string> | undefined };

function recorder(): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, headers: init?.headers });
    return { ok: true, status: 200, text: async () => '{"projects":[]}' };
  };
  return { fetch, seen };
}

class Source implements EventSourceLike {
  static urls: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    Source.urls.push(url);
  }
  addEventListener(): void {}
  close(): void {}
}

test("with a token every request except /health carries Authorization: Bearer", async () => {
  const { fetch, seen } = recorder();
  const bridge = createHttpBridge({ baseUrl: "http://h:1/", fetch, token: " tok " });
  await bridge.health();
  await bridge.listProjects();
  await bridge.createProject({ name: "n" });
  assert.equal(seen[0]?.headers?.Authorization, undefined);
  assert.equal(seen[1]?.headers?.Authorization, "Bearer tok");
  assert.deepEqual(seen[2]?.headers, { Authorization: "Bearer tok", "Content-Type": "application/json" });
});

test("without a token no Authorization header is sent", async () => {
  const { fetch, seen } = recorder();
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch });
  await bridge.listProjects();
  assert.equal(seen[0]?.headers, undefined);
});

test("SSE streams carry the token as a query parameter, other URLs do not", () => {
  Source.urls = [];
  createHttpBridge({ baseUrl: "http://h", EventSource: Source, token: "a b&c" }).subscribe("p/1", { onEvent: () => {} });
  createHttpBridge({ baseUrl: "http://h", EventSource: Source }).subscribe("p", { onEvent: () => {} });
  assert.deepEqual(Source.urls, ["http://h/v1/projects/p%2F1/events?token=a%20b%26c", "http://h/v1/projects/p/events"]);
});

test("resolveBridgeToken", () => {
  assert.equal(resolveBridgeToken({ VITE_HARNESS_API_TOKEN: " v ", HARNESS_API_TOKEN: "h" }), "v");
  assert.equal(resolveBridgeToken({ HARNESS_API_TOKEN: "h" }), "h");
  assert.equal(resolveBridgeToken({}), "");
});
