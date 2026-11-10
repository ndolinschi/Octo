import type { LanguageServerSession } from "@octo/agent-client";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Rpc, RpcError, type Cancellation } from "./rpc";

// The client uses window.setTimeout; in node the global object stands in for it.
(globalThis as unknown as { window: unknown }).window = globalThis;

type Sent = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

function setup() {
  const sent: Sent[] = [];
  const notifications: [string, unknown][] = [];
  let deliver: (m: unknown) => void = () => undefined;
  let unsubscribed = 0;
  let failSend = false;
  const session = {
    send: (m: unknown) => {
      if (failSend) return Promise.reject(new Error("socket closed"));
      sent.push(m as Sent);
      return Promise.resolve();
    },
    onMessage: (cb: (m: unknown) => void) => {
      deliver = cb;
      return () => void (unsubscribed += 1);
    },
  } as unknown as LanguageServerSession;
  const rpc = new Rpc(session, {
    notification: (method, params) => notifications.push([method, params]),
    folders: () => [{ uri: "file:///p", name: "p" }],
  });
  return { rpc, sent, notifications, deliver: (m: unknown) => deliver(m), unsubscribed: () => unsubscribed, failSend: () => void (failSend = true) };
}

function token() {
  let cb: (() => void) | null = null;
  let disposed = 0;
  const t: Cancellation & { cancel(): void; disposed(): number } = {
    isCancellationRequested: false,
    onCancellationRequested: (fn) => {
      cb = fn;
      return { dispose: () => void (disposed += 1) };
    },
    cancel: () => {
      t.isCancellationRequested = true;
      cb?.();
    },
    disposed: () => disposed,
  };
  return t;
}

const tick = () => Promise.resolve();

test("a response resolves the request with the matching id, in any order", async () => {
  const s = setup();
  const a = s.rpc.request("a", { x: 1 });
  const b = s.rpc.request("b", null);
  assert.deepEqual(
    s.sent.map((m) => [m.id, m.method]),
    [
      [1, "a"],
      [2, "b"],
    ],
  );
  s.deliver({ jsonrpc: "2.0", id: 2, result: "second" });
  s.deliver({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  assert.equal(await b, "second");
  assert.deepEqual(await a, { ok: true });
});

test("a null or missing result resolves to null; a server error rejects with its code", async () => {
  const s = setup();
  const empty = s.rpc.request("a", null);
  s.deliver({ id: 1 });
  assert.equal(await empty, null);
  const failed = s.rpc.request("b", null);
  s.deliver({ id: 2, error: { code: -32603, message: "boom" } });
  await assert.rejects(failed, (e) => e instanceof RpcError && e.code === -32603 && e.message === "boom");
});

test("responses for unknown ids and non-objects are ignored", async () => {
  const s = setup();
  const p = s.rpc.request("a", null);
  for (const junk of [null, 5, "x", { id: 99, result: 1 }, { id: "1", result: 1 }, {}]) s.deliver(junk);
  s.deliver({ id: 1, result: "real" });
  assert.equal(await p, "real");
});

test("a response just before the timeout wins; at the timeout the request rejects and a late answer is ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const s = setup();
    const inTime = s.rpc.request("fast", null, { timeoutMs: 1000 });
    mock.timers.tick(999);
    s.deliver({ id: 1, result: "just in time" });
    assert.equal(await inTime, "just in time");
    const late = s.rpc.request("slow", null, { timeoutMs: 1000 }).then(
      () => "resolved",
      (e: unknown) => e,
    );
    mock.timers.tick(1000);
    const err = await late;
    assert.ok(err instanceof RpcError && err.code === -32001 && err.message.includes("slow timed out"));
    s.deliver({ id: 2, result: "ignored" });
  } finally {
    mock.timers.reset();
  }
});

test("the default timeout is 5 seconds", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const s = setup();
    const p = s.rpc.request("x", null).then(
      () => "resolved",
      (e: unknown) => e,
    );
    mock.timers.tick(4999);
    mock.timers.tick(1);
    assert.ok((await p) instanceof RpcError);
  } finally {
    mock.timers.reset();
  }
});

test("cancelling resolves to null at once and tells the server with $/cancelRequest", async () => {
  const s = setup();
  const t = token();
  const p = s.rpc.request("hover", null, { token: t });
  t.cancel();
  assert.equal(await p, null);
  assert.deepEqual(s.sent[1], { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } });
  s.deliver({ id: 1, result: "late" });
  assert.equal(s.sent.length, 2);
});

test("an already cancelled token sends nothing", async () => {
  const s = setup();
  const t = token();
  t.isCancellationRequested = true;
  assert.equal(await s.rpc.request("hover", null, { token: t }), null);
  assert.equal(s.sent.length, 0);
});

test("a settled request releases its cancellation listener and does not cancel afterwards", async () => {
  const s = setup();
  const t = token();
  const p = s.rpc.request("hover", null, { token: t });
  s.deliver({ id: 1, result: 1 });
  await p;
  assert.equal(t.disposed(), 1);
  t.cancel();
  assert.equal(s.sent.length, 1, "no $/cancelRequest for a finished request");
});

test("a failing send rejects the request", async () => {
  const s = setup();
  s.failSend();
  await assert.rejects(s.rpc.request("a", null), (e) => e instanceof Error && e.message === "socket closed");
});

test("notifications from the server reach the handler; the client's own go out without an id", () => {
  const s = setup();
  s.deliver({ method: "textDocument/publishDiagnostics", params: { uri: "u" } });
  s.deliver({ method: "x", id: null, params: 1 });
  assert.deepEqual(s.notifications, [
    ["textDocument/publishDiagnostics", { uri: "u" }],
    ["x", 1],
  ]);
  s.rpc.notify("initialized", {});
  assert.deepEqual(s.sent[0], { jsonrpc: "2.0", method: "initialized", params: {} });
});

test("requests from the server are answered: configuration, folders, registration, progress", async () => {
  const s = setup();
  s.deliver({ id: 7, method: "workspace/configuration", params: { items: [{}, {}, {}] } });
  s.deliver({ id: "s", method: "workspace/workspaceFolders" });
  for (const [i, method] of [
    "client/registerCapability",
    "client/unregisterCapability",
    "window/workDoneProgress/create",
    "window/showMessageRequest",
  ].entries()) {
    s.deliver({ id: 10 + i, method, params: {} });
  }
  s.deliver({ id: 20, method: "workspace/configuration", params: null });
  await tick();
  const by = (id: number | string) => s.sent.find((m) => m.id === id);
  assert.deepEqual(by(7)?.result, [null, null, null], "one null per requested item");
  assert.deepEqual(by("s")?.result, [{ uri: "file:///p", name: "p" }]);
  for (const id of [10, 11, 12, 13]) assert.equal(by(id)?.result, null, `answer ${id}`);
  assert.deepEqual(by(20)?.result, []);
});

test("any other server request gets method-not-found", () => {
  const s = setup();
  s.deliver({ id: 3, method: "workspace/applyEdit", params: {} });
  assert.deepEqual(s.sent[0]?.error, { code: -32601, message: "method not found: workspace/applyEdit" });
});

test("dispose rejects what is in flight, unsubscribes, and later calls fail or do nothing", async () => {
  const s = setup();
  const p = s.rpc.request("a", null);
  s.rpc.dispose();
  s.rpc.dispose();
  await assert.rejects(p, (e) => e instanceof RpcError && e.code === -32002);
  assert.equal(s.unsubscribed(), 1, "disposing twice unsubscribes once");
  await assert.rejects(s.rpc.request("b", null), (e) => e instanceof RpcError && e.code === -32002);
  const before = s.sent.length;
  s.rpc.notify("n", null);
  s.deliver({ id: 5, method: "workspace/workspaceFolders" });
  assert.equal(s.sent.length, before, "a closed client sends nothing, not even answers");
});
