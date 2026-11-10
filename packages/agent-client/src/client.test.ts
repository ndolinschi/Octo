import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeError,
  createHttpBridge,
  type EventSourceLike,
  type FetchLike,
} from "./client";
import type { BridgeEvent } from "./types";

type Call = { url: string; method: string | undefined; body: string | undefined };

function fakeFetch(status: number, body: string, calls: Call[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
}

function bridgeWith(status: number, body: string) {
  const calls: Call[] = [];
  const bridge = createHttpBridge({
    baseUrl: "http://h:1/",
    fetch: fakeFetch(status, body, calls),
  });
  return { bridge, calls };
}

test("request shapes and envelope unwrapping", async () => {
  const cases: {
    run: (b: ReturnType<typeof createHttpBridge>) => Promise<unknown>;
    reply: string;
    status?: number;
    method: string;
    path: string;
    body?: unknown;
    result?: unknown;
  }[] = [
    { run: (b) => b.health(), reply: '{"ok":true,"version":"1"}', method: "GET", path: "/health", result: { ok: true, version: "1" } },
    { run: (b) => b.getConfig(), reply: '{"default_max_depth":3}', method: "GET", path: "/v1/config", result: { default_max_depth: 3 } },
    { run: (b) => b.listProjects(), reply: '{"projects":[{"id":"a"}]}', method: "GET", path: "/v1/projects", result: [{ id: "a" }] },
    { run: (b) => b.createProject({ name: "n" }), reply: '{"id":"a"}', status: 201, method: "POST", path: "/v1/projects", body: { name: "n" }, result: { id: "a" } },
    { run: (b) => b.getProject("a/b"), reply: '{"id":"x"}', method: "GET", path: "/v1/projects/a%2Fb", result: { id: "x" } },
    { run: (b) => b.updateProject("p", { name: "z" }), reply: '{"id":"p"}', method: "PATCH", path: "/v1/projects/p", body: { name: "z" }, result: { id: "p" } },
    { run: (b) => b.deleteProject("p"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p", result: undefined },
    { run: (b) => b.listAgents("p"), reply: '{"agents":[{"id":"a"}]}', method: "GET", path: "/v1/projects/p/agents", result: [{ id: "a" }] },
    { run: (b) => b.getAgent("p", "a"), reply: '{"id":"a"}', method: "GET", path: "/v1/projects/p/agents/a", result: { id: "a" } },
    { run: (b) => b.listMessages("p", "a"), reply: '{"messages":[{"id":1}]}', method: "GET", path: "/v1/projects/p/agents/a/messages", result: [{ id: 1 }] },
    { run: (b) => b.sendMessage("p", "hi"), reply: '{"message":{"id":2}}', status: 202, method: "POST", path: "/v1/projects/p/messages", body: { text: "hi" }, result: { id: 2 } },
    { run: (b) => b.cancelTurn("p"), reply: "", status: 202, method: "POST", path: "/v1/projects/p/cancel", result: undefined },
    { run: (b) => b.listNotes("p"), reply: '{"notes":[{"id":"n"}]}', method: "GET", path: "/v1/projects/p/notes", result: [{ id: "n" }] },
    { run: (b) => b.createNote("p", { title: "t", content: "c" }), reply: '{"id":"n"}', status: 201, method: "POST", path: "/v1/projects/p/notes", body: { title: "t", content: "c" }, result: { id: "n" } },
    { run: (b) => b.updateNote("p", "n", { title: "t2" }), reply: '{"id":"n"}', method: "PATCH", path: "/v1/projects/p/notes/n", body: { title: "t2" }, result: { id: "n" } },
    { run: (b) => b.deleteNote("p", "n"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/notes/n", result: undefined },
  ];
  for (const c of cases) {
    const { bridge, calls } = bridgeWith(c.status ?? 200, c.reply);
    const result = await c.run(bridge);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://h:1${c.path}`);
    assert.equal(calls[0].method, c.method);
    assert.equal(calls[0].body, c.body === undefined ? undefined : JSON.stringify(c.body));
    assert.deepEqual(result, c.result);
  }
});

test("error body maps to BridgeError", async () => {
  const { bridge } = bridgeWith(409, '{"error":{"code":"turn_in_progress","message":"busy"}}');
  await assert.rejects(bridge.sendMessage("p", "x"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "turn_in_progress");
    assert.equal(e.message, "busy");
    return true;
  });
});

test("non-JSON error body falls back", async () => {
  const { bridge } = bridgeWith(502, "Bad Gateway");
  await assert.rejects(bridge.health(), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 502);
    assert.equal(e.code, "http_error");
    assert.equal(e.message, "Bad Gateway");
    return true;
  });
});

test("network failure maps to status 0", async () => {
  const bridge = createHttpBridge({
    baseUrl: "http://h",
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(bridge.health(), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 0);
    assert.equal(e.code, "network_error");
    return true;
  });
});

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, (ev: { data?: unknown }) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
}

test("subscribe dispatches named events, ignores malformed, unsubscribes", () => {
  const bridge = createHttpBridge({ baseUrl: "http://h", EventSource: FakeEventSource });
  const events: BridgeEvent[] = [];
  let opens = 0;
  const errors: unknown[] = [];
  const unsubscribe = bridge.subscribe("p", {
    onEvent: (e) => events.push(e),
    onOpen: () => opens++,
    onError: (e) => errors.push(e),
  });
  const es = FakeEventSource.last;
  assert.equal(es.url, "http://h/v1/projects/p/events");

  es.listeners.get("message.delta")?.({
    data: '{"type":"message.delta","seq":1,"agent_id":"a","text":"x"}',
  });
  es.listeners.get("turn.finished")?.({ data: "{not json" });
  es.listeners.get("turn.finished")?.({ data: undefined });
  es.listeners.get("turn.finished")?.({ data: "42" });
  assert.deepEqual(events, [{ type: "message.delta", seq: 1, agent_id: "a", text: "x" }]);

  es.onopen?.({});
  es.onopen?.({});
  es.onerror?.("boom");
  assert.equal(opens, 2);
  assert.deepEqual(errors, ["boom"]);

  assert.equal(es.closed, false);
  unsubscribe();
  assert.equal(es.closed, true);
});

test("subscribe registers every event type", () => {
  const bridge = createHttpBridge({ baseUrl: "http://h", EventSource: FakeEventSource });
  bridge.subscribe("p", { onEvent: () => {} });
  assert.equal(FakeEventSource.last.listeners.size, 9);
});
