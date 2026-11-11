import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, type Bridge, type SubscribeHandlers } from "./client";
import { createMessageClient, isClientMessage, isHostMessage, serveBridge, type MessagePortLike } from "./messageBridge";
import type { BridgeEvent } from "./types";

type Listener = (msg: unknown) => void;

function portPair(): { a: MessagePortLike; b: MessagePortLike; sent: unknown[] } {
  const la = new Set<Listener>();
  const lb = new Set<Listener>();
  const sent: unknown[] = [];
  const mk = (out: Set<Listener>, inn: Set<Listener>, log: boolean): MessagePortLike => ({
    postMessage(msg) {
      if (log) sent.push(msg);
      const copy = msg === undefined ? msg : (JSON.parse(JSON.stringify(msg)) as unknown);
      void Promise.resolve().then(() => out.forEach((cb) => cb(copy)));
    },
    onMessage(cb) {
      inn.add(cb);
      return () => void inn.delete(cb);
    },
  });
  return { a: mk(lb, la, true), b: mk(la, lb, false), sent };
}

type FakeBridge = Bridge & {
  log: [string, unknown[]][];
  handlers: Map<string, SubscribeHandlers>;
  unsubscribed: string[];
  failWith?: unknown;
};

function fakeBridge(): FakeBridge {
  const log: [string, unknown[]][] = [];
  const handlers = new Map<string, SubscribeHandlers>();
  const unsubscribed: string[] = [];
  const self: FakeBridge = { log, handlers, unsubscribed } as FakeBridge;
  const names = [
    "health",
    "getConfig",
    "listProjects",
    "createProject",
    "getProject",
    "updateProject",
    "deleteProject",
    "listAgents",
    "getAgent",
    "listMessages",
    "getTranscript",
    "sendMessage",
    "cancelTurn",
    "getContext",
    "askSide",
    "listSide",
    "clearSide",
    "listNotes",
    "createNote",
    "updateNote",
    "deleteNote",
    "listFiles",
    "readFile",
    "writeFile",
    "listPlugins",
    "getUsage",
    "getLimits",
    "listLanguageServers",
  ];
  for (const name of names) {
    (self as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      log.push([name, args]);
      if (self.failWith) throw self.failWith;
      return { name, args };
    };
  }
  self.subscribe = (projectId, h) => {
    handlers.set(projectId, h);
    return () => void unsubscribed.push(projectId);
  };
  return self;
}

function setup(onHost?: Parameters<typeof serveBridge>[2]) {
  const { a, b, sent } = portPair();
  const bridge = fakeBridge();
  const server = serveBridge(b, bridge, onHost);
  const client = createMessageClient(a);
  return { bridge, server, client, sent };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const ev = (seq: number): BridgeEvent => ({ type: "turn.finished", seq, status: "completed", error: null });

test("every Bridge method round-trips args and return value", async () => {
  const { client, bridge } = setup();
  const b = client.bridge;
  const calls: [string, Promise<unknown>, unknown[]][] = [
    ["health", b.health(), []],
    ["getConfig", b.getConfig(), []],
    ["listProjects", b.listProjects(), []],
    ["createProject", b.createProject({ name: "n" }), [{ name: "n" }]],
    ["getProject", b.getProject("p"), ["p"]],
    ["updateProject", b.updateProject("p", { name: "m" }), ["p", { name: "m" }]],
    ["deleteProject", b.deleteProject("p"), ["p"]],
    ["listAgents", b.listAgents("p"), ["p"]],
    ["getAgent", b.getAgent("p", "a"), ["p", "a"]],
    ["listMessages", b.listMessages("p", "a"), ["p", "a"]],
    ["getTranscript", b.getTranscript("p", "a"), ["p", "a"]],
    ["sendMessage", b.sendMessage("p", "hi"), ["p", "hi"]],
    ["cancelTurn", b.cancelTurn("p"), ["p"]],
    ["getContext", b.getContext("p"), ["p"]],
    ["getContext", b.getContext("p", "a"), ["p", "a"]],
    ["askSide", b.askSide("p", "why?"), ["p", "why?"]],
    ["listSide", b.listSide("p"), ["p"]],
    ["clearSide", b.clearSide("p"), ["p"]],
    ["listNotes", b.listNotes("p"), ["p"]],
    ["createNote", b.createNote("p", { title: "t", content: "c" }), ["p", { title: "t", content: "c" }]],
    ["updateNote", b.updateNote("p", "n", { title: "t" }), ["p", "n", { title: "t" }]],
    ["deleteNote", b.deleteNote("p", "n"), ["p", "n"]],
    ["listFiles", b.listFiles("p", "f", "a/b"), ["p", "f", "a/b"]],
    ["readFile", b.readFile("p", "f", "a/b"), ["p", "f", "a/b"]],
    [
      "writeFile",
      b.writeFile("p", { folder: "f", path: "a", content: "c", expected_mtime: "t" }),
      ["p", { folder: "f", path: "a", content: "c", expected_mtime: "t" }],
    ],
    ["listPlugins", b.listPlugins(), []],
    ["getUsage", b.getUsage(), []],
    ["getUsage", b.getUsage({ group: "model", project: "p" }), [{ group: "model", project: "p" }]],
    ["getLimits", b.getLimits(), []],
    ["listLanguageServers", b.listLanguageServers("p"), ["p"]],
  ];
  for (const [name, promise, args] of calls) {
    assert.deepEqual(await promise, { name, args });
  }
  assert.equal(bridge.log.length, calls.length);
});

test("BridgeError round-trips with status, code and message", async () => {
  const { client, bridge } = setup();
  bridge.failWith = new BridgeError(404, "not_found", "no such project");
  await assert.rejects(client.bridge.getProject("x"), (err) => {
    return err instanceof BridgeError && err.status === 404 && err.code === "not_found" && err.message === "no such project";
  });
});

test("non-BridgeError failures map to internal", async () => {
  const { client, bridge } = setup();
  bridge.failWith = new Error("boom");
  await assert.rejects(client.bridge.health(), (err) => err instanceof BridgeError && err.status === 0 && err.code === "internal" && err.message === "boom");
});

test("unknown and disallowed methods yield unknown_method", async () => {
  const { a, b } = portPair();
  const bridge = fakeBridge();
  serveBridge(b, bridge);
  const replies: unknown[] = [];
  a.onMessage((m) => replies.push(m));
  a.postMessage({ kind: "call", id: 1, method: "nope", args: [] });
  a.postMessage({ kind: "call", id: 2, method: "subscribe", args: [] });
  a.postMessage({ kind: "call", id: 3, method: "constructor", args: [] });
  await tick();
  assert.equal(replies.length, 3);
  for (const r of replies) {
    assert.ok(isHostMessage(r));
    assert.deepEqual((r as { error: { code: string } }).error.code, "unknown_method");
  }
  assert.equal(bridge.log.length, 0);
});

test("subscribe routes event, open and error; unsubscribe stops routing", async () => {
  const { client, bridge } = setup();
  const got: string[] = [];
  const stop = client.bridge.subscribe("p", {
    onEvent: (e) => got.push(`event:${e.seq}`),
    onOpen: () => got.push("open"),
    onError: (e) => got.push(`error:${(e as Error).message}`),
  });
  await tick();
  const h = bridge.handlers.get("p");
  assert.ok(h);
  h.onOpen?.();
  h.onEvent(ev(1));
  h.onError?.(new Error("down"));
  await tick();
  assert.deepEqual(got, ["open", "event:1", "error:down"]);
  stop();
  await tick();
  assert.deepEqual(bridge.unsubscribed, ["p"]);
  h.onEvent(ev(2));
  await tick();
  assert.equal(got.length, 3);
});

test("concurrent subscriptions are isolated", async () => {
  const { client, bridge } = setup();
  const one: number[] = [];
  const two: number[] = [];
  const stop1 = client.bridge.subscribe("p1", { onEvent: (e) => one.push(e.seq) });
  client.bridge.subscribe("p2", { onEvent: (e) => two.push(e.seq) });
  await tick();
  bridge.handlers.get("p1")?.onEvent(ev(1));
  bridge.handlers.get("p2")?.onEvent(ev(2));
  await tick();
  stop1();
  await tick();
  bridge.handlers.get("p1")?.onEvent(ev(3));
  bridge.handlers.get("p2")?.onEvent(ev(4));
  await tick();
  assert.deepEqual(one, [1]);
  assert.deepEqual(two, [2, 4]);
});

test("host actions: success, throw, unsupported", async () => {
  const withHost = setup({
    onHost: (action, args) => {
      if (action === "boom") throw new BridgeError(500, "bad", "nope");
      return { action, args };
    },
  });
  assert.deepEqual(await withHost.client.callHost("pick", [1, "x"]), { action: "pick", args: [1, "x"] });
  assert.deepEqual(await withHost.client.callHost("pick"), { action: "pick", args: [] });
  await assert.rejects(withHost.client.callHost("boom"), (err) => err instanceof BridgeError && err.code === "bad" && err.status === 500);
  const bare = setup();
  await assert.rejects(bare.client.callHost("pick"), (err) => err instanceof BridgeError && err.code === "unsupported");
});

test("theme messages reach listeners until unsubscribed", async () => {
  const { client, server } = setup();
  const seen: string[] = [];
  const off = client.onTheme((t) => seen.push(t));
  server.setTheme("dark");
  await tick();
  off();
  server.setTheme("light");
  await tick();
  assert.deepEqual(seen, ["dark"]);
});

test("malformed messages are ignored on both sides", async () => {
  const { a, b } = portPair();
  const bridge = fakeBridge();
  serveBridge(b, bridge);
  const client = createMessageClient(a);
  const junk = [
    null,
    undefined,
    3,
    "x",
    [],
    {},
    { kind: "call" },
    { kind: "call", id: "1", method: "health", args: [] },
    { kind: "call", id: 1, method: "health", args: "no" },
    { kind: "subscribe", sub: 1 },
    { kind: "result", id: 1, ok: false },
    { kind: "event", sub: 1, event: { type: "bogus" } },
    { kind: "theme", theme: "blue" },
    { kind: "wat" },
  ];
  for (const m of junk) {
    assert.equal(isClientMessage(m), false);
    assert.equal(isHostMessage(m), false);
    a.postMessage(m);
  }
  await tick();
  assert.equal(bridge.log.length, 0);
  assert.deepEqual(await client.bridge.health(), { name: "health", args: [] });
});

test("client dispose rejects pending calls and detaches", async () => {
  const { a, b } = portPair();
  const client = createMessageClient(a);
  const received: unknown[] = [];
  b.onMessage((m) => received.push(m));
  const p = client.bridge.health();
  const q = client.callHost("x");
  client.dispose();
  for (const pr of [p, q]) {
    await assert.rejects(pr, (e) => e instanceof BridgeError && e.status === 0 && e.code === "disposed");
  }
  const themes: string[] = [];
  client.onTheme((t) => themes.push(t));
  b.postMessage({ kind: "theme", theme: "dark" });
  await tick();
  assert.deepEqual(themes, []);
});

test("server dispose unsubscribes, stops replying and ignores calls", async () => {
  const { client, bridge, server, sent } = setup();
  const got: number[] = [];
  client.bridge.subscribe("p", { onEvent: (e) => got.push(e.seq) });
  await tick();
  const h = bridge.handlers.get("p");
  assert.ok(h);
  server.dispose();
  assert.deepEqual(bridge.unsubscribed, ["p"]);
  h.onEvent(ev(1));
  server.setTheme("dark");
  void client.bridge.health().catch(() => undefined);
  await tick();
  assert.deepEqual(got, []);
  assert.equal(bridge.log.length, 0);
  assert.ok(sent.length > 0);
});
