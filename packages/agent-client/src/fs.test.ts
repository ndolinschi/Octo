import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type AbortSignalLike, type FetchLike } from "./client";

function bridgeWith(status: number, body: string) {
  const calls: { url: string; method?: string; body?: string; signal?: AbortSignalLike }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, ...(init ?? {}) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { bridge: createHttpBridge({ baseUrl: "http://h:1", fetch }), calls };
}

test("listDirs encodes the path (spaces, Cyrillic) and returns the listing", async () => {
  const listing = { base: "/home/u", entries: [{ name: "Мои проекты", path: "/home/u/Мои проекты", git: { branch: "main" } }] };
  const { bridge, calls } = bridgeWith(200, JSON.stringify(listing));
  const got = await bridge.listDirs?.("~/Мои п");
  assert.deepEqual(got, listing);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.url, `http://h:1/v1/fs/dirs?path=${encodeURIComponent("~/Мои п")}`);
});

test("listDirs passes the error of an unreadable base through", async () => {
  const { bridge } = bridgeWith(200, JSON.stringify({ base: "/x", entries: [], error: "not_found" }));
  assert.equal((await bridge.listDirs?.("/x/"))?.error, "not_found");
});

test("recentFolders unwraps the entries", async () => {
  const entries = [{ name: "a", path: "/a", git: null }];
  const { bridge, calls } = bridgeWith(200, JSON.stringify({ entries }));
  assert.deepEqual(await bridge.recentFolders?.(), entries);
  assert.equal(calls[0]?.url, "http://h:1/v1/fs/recent");
});

test("complete posts the request with the abort signal and maps 204 to null", async () => {
  const signal: AbortSignalLike = { aborted: false };
  const ok = bridgeWith(200, JSON.stringify({ text: "return 1", model: "m", ms: 12 }));
  const got = await ok.bridge.complete?.("p 1", { path: "a.go", prefix: "x" }, { signal });
  assert.deepEqual(got, { text: "return 1", model: "m", ms: 12 });
  assert.equal(ok.calls[0]?.url, "http://h:1/v1/projects/p%201/complete");
  assert.equal(ok.calls[0]?.method, "POST");
  assert.equal(ok.calls[0]?.signal, signal);
  assert.deepEqual(JSON.parse(ok.calls[0]?.body ?? "null"), { path: "a.go", prefix: "x" });

  const none = bridgeWith(204, "");
  assert.equal(await none.bridge.complete?.("p", { path: "a.go", prefix: "x" }), null);
});

test("complete surfaces the harness's error codes", async () => {
  const { bridge } = bridgeWith(409, JSON.stringify({ error: { code: "completion_off", message: "off" } }));
  await assert.rejects(
    (bridge.complete ?? (() => Promise.reject(new Error("no complete"))))("p", { path: "a", prefix: "x" }),
    (e: unknown) => e instanceof BridgeError && e.code === "completion_off" && e.status === 409,
  );
});
