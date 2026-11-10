import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type EventSourceLike, type FetchLike } from "./client";
import type { LanguageServerSession } from "./types";

type Call = { url: string; method: string | undefined; body: string | undefined };

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
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data });
  }
}

const CREATED = '{"session_id":"s 1","root_uri":"file:///w","workspace_folders":[{"uri":"file:///w","name":"w"}]}';

function setup(replies: Record<string, [number, string]> = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    const key = `${init?.method} ${url}`;
    const [status, body] = replies[key] ?? [200, ""];
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch, EventSource: FakeEventSource });
  return { bridge, calls };
}

const CREATE_KEY = "POST http://h/v1/projects/p/lsp/gopls/sessions";

async function open(extra: Record<string, [number, string]> = {}) {
  const ctx = setup({ [CREATE_KEY]: [201, CREATED], ...extra });
  const session = await ctx.bridge.openLanguageServer("p", "gopls");
  return { ...ctx, session, es: FakeEventSource.last };
}

test("open creates the session and attaches the event stream", async () => {
  const { session, calls, es } = await open();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://h/v1/projects/p/lsp/gopls/sessions");
  assert.equal(calls[0].method, "POST");
  assert.equal(es.url, "http://h/v1/projects/p/lsp/sessions/s%201/events");
  assert.equal(session.rootUri, "file:///w");
  assert.deepEqual(session.workspaceFolders, [{ uri: "file:///w", name: "w" }]);
});

test("early messages are buffered for the first listener, then delivered live", async () => {
  const { session, es } = await open();
  es.emit("message", '{"id":1}');
  es.emit("message", "{bad");
  es.emit("message", undefined);
  es.emit("message", '{"id":2}');
  const got: unknown[] = [];
  const off = session.onMessage((m) => got.push(m));
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }]);
  const second: unknown[] = [];
  session.onMessage((m) => second.push(m));
  es.emit("message", '{"id":3}');
  assert.deepEqual(got, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(second, [{ id: 3 }]);
  off();
  es.emit("message", '{"id":4}');
  assert.equal(got.length, 3);
});

test("send posts one JSON-RPC message", async () => {
  const { session, calls } = await open({
    "POST http://h/v1/projects/p/lsp/sessions/s%201/messages": [202, ""],
  });
  await session.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const last = calls[calls.length - 1];
  assert.equal(last.url, "http://h/v1/projects/p/lsp/sessions/s%201/messages");
  assert.equal(last.method, "POST");
  assert.equal(last.body, '{"jsonrpc":"2.0","id":1,"method":"initialize"}');
});

test("send maps server errors to BridgeError", async () => {
  const { session } = await open({
    "POST http://h/v1/projects/p/lsp/sessions/s%201/messages": [413, '{"error":{"code":"message_too_large","message":"too big"}}'],
  });
  await assert.rejects(session.send({}), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 413);
    assert.equal(e.code, "message_too_large");
    return true;
  });
});

test("exit event notifies listeners, closes the stream, ignores malformed exits", async () => {
  const { session, es } = await open();
  const exits: unknown[] = [];
  session.onExit((i) => exits.push(i));
  es.emit("exit", '{"code":"x"}');
  es.emit("exit", "nope");
  assert.equal(es.closed, false);
  es.emit("exit", '{"code":-1,"reason":"idle"}');
  assert.deepEqual(exits, [{ code: -1, reason: "idle" }]);
  assert.equal(es.closed, true);
  const late: unknown[] = [];
  session.onExit((i) => late.push(i));
  assert.deepEqual(late, [{ code: -1, reason: "idle" }]);
});

test("close is idempotent, deletes once and tolerates 404", async () => {
  const del = "DELETE http://h/v1/projects/p/lsp/sessions/s%201";
  const { session, calls, es } = await open({
    [del]: [404, '{"error":{"code":"not_found","message":"gone"}}'],
  });
  await session.close();
  await session.close();
  assert.equal(es.closed, true);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  await assert.rejects(session.send({}), (e: unknown) => e instanceof BridgeError && e.code === "session_closed");
});

test("close surfaces non-404 delete failures", async () => {
  const { session } = await open({
    "DELETE http://h/v1/projects/p/lsp/sessions/s%201": [500, '{"error":{"code":"internal","message":"x"}}'],
  });
  await assert.rejects(session.close(), (e: unknown) => e instanceof BridgeError && e.status === 500);
});

test("unavailable server maps to BridgeError and opens no stream", async () => {
  const { bridge } = setup({
    [CREATE_KEY]: [404, '{"error":{"code":"not_found","message":"language server not found or unavailable"}}'],
  });
  const before = FakeEventSource.last;
  await assert.rejects(bridge.openLanguageServer("p", "gopls"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 404);
    assert.equal(e.code, "not_found");
    return true;
  });
  assert.equal(FakeEventSource.last, before);
});

test("malformed create response is invalid_response", async () => {
  const { bridge } = setup({ [CREATE_KEY]: [201, '{"session_id":"s"}'] });
  await assert.rejects(bridge.openLanguageServer("p", "gopls"), (e: unknown) => e instanceof BridgeError && e.code === "invalid_response");
});

test("session satisfies the public type", async () => {
  const { session } = await open();
  const typed: LanguageServerSession = session;
  assert.equal(typeof typed.close, "function");
});
