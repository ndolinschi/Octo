import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, type Bridge, type FetchLike } from "./client";
import { fileBytesReader, parseFileBytes, withFileBytes } from "./fileBytes";

const answer = { folder: "web", path: "logo.png", size: 3, mtime: "2026-11-14T00:00:00Z", content: "AAEC", encoding: "base64" };

function fakeFetch(status: number, body: string, seen: { url?: string; headers?: Record<string, string> }): FetchLike {
  return (url, init) => {
    seen.url = url;
    if (init?.headers) seen.headers = init.headers;
    return Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(body) });
  };
}

test("withFileBytes asks for base64 with the token and keeps the bridge's methods", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const base = { health: () => Promise.resolve({ ok: true, version: "x" }) } as Bridge;
  const b = withFileBytes(base, { baseUrl: "http://h:1/", token: "t", fetch: fakeFetch(200, JSON.stringify(answer), seen) });
  assert.equal(typeof b.health, "function");
  const got = await b.readFileBytes("p 1", "web", "public/logo.png");
  assert.deepEqual(got, answer);
  assert.equal(seen.url, "http://h:1/v1/projects/p%201/files/content?folder=web&path=public%2Flogo.png&encoding=base64");
  assert.deepEqual(seen.headers, { Authorization: "Bearer t" });
  const reader = fileBytesReader(b);
  assert.ok(reader);
  assert.deepEqual(await reader("p", "web", "a"), answer);
  await b.readFileBytes("p", "web", "a", { workspaceId: "wrk_1" });
  assert.equal(seen.url, "http://h:1/v1/projects/p/files/content?folder=web&path=a&encoding=base64&workspace=wrk_1");
  await b.readFileBytes("p", "web", "a", { workspaceId: "shared" });
  assert.equal(seen.url, "http://h:1/v1/projects/p/files/content?folder=web&path=a&encoding=base64");
});

test("errors keep the harness's code", async () => {
  const b = withFileBytes({} as Bridge, {
    baseUrl: "http://h",
    fetch: fakeFetch(413, JSON.stringify({ error: { code: "file_too_large", message: "file exceeds the 2 MiB limit" } }), {}),
  });
  await assert.rejects(b.readFileBytes("p", "f", "x"), (e: unknown) => e instanceof BridgeError && e.code === "file_too_large" && e.status === 413);
});

test("a bridge without the method has no reader; a bad answer is invalid_response", () => {
  assert.equal(fileBytesReader({}), undefined);
  let caught: unknown;
  try {
    parseFileBytes({ content: 1 });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof BridgeError && caught.code === "invalid_response");
});
