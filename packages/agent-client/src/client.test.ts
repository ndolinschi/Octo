import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_EVENT_TYPES, BridgeError, createHttpBridge, type EventSourceLike, type FetchLike } from "./client";
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
    {
      run: (b) => b.createProject({ name: "n" }),
      reply: '{"id":"a"}',
      status: 201,
      method: "POST",
      path: "/v1/projects",
      body: { name: "n" },
      result: { id: "a" },
    },
    { run: (b) => b.getProject("a/b"), reply: '{"id":"x"}', method: "GET", path: "/v1/projects/a%2Fb", result: { id: "x" } },
    { run: (b) => b.updateProject("p", { name: "z" }), reply: '{"id":"p"}', method: "PATCH", path: "/v1/projects/p", body: { name: "z" }, result: { id: "p" } },
    { run: (b) => b.deleteProject("p"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p", result: undefined },
    { run: (b) => b.listAgents("p"), reply: '{"agents":[{"id":"a"}]}', method: "GET", path: "/v1/projects/p/agents", result: [{ id: "a" }] },
    { run: (b) => b.getAgent("p", "a"), reply: '{"id":"a"}', method: "GET", path: "/v1/projects/p/agents/a", result: { id: "a" } },
    { run: (b) => b.listMessages("p", "a"), reply: '{"messages":[{"id":1}]}', method: "GET", path: "/v1/projects/p/agents/a/messages", result: [{ id: 1 }] },
    {
      run: (b) => b.sendMessage("p", "hi"),
      reply: '{"message":{"id":2}}',
      status: 202,
      method: "POST",
      path: "/v1/projects/p/messages",
      body: { text: "hi" },
      result: { id: 2 },
    },
    { run: (b) => b.cancelTurn("p"), reply: "", status: 202, method: "POST", path: "/v1/projects/p/cancel", result: undefined },
    { run: (b) => b.listNotes("p"), reply: '{"notes":[{"id":"n"}]}', method: "GET", path: "/v1/projects/p/notes", result: [{ id: "n" }] },
    {
      run: (b) => b.getNote?.("p", "n 1") ?? Promise.reject(new Error("no getNote")),
      reply: '{"id":"n 1","content":"c","markdown":"---\\n---\\nc"}',
      method: "GET",
      path: "/v1/projects/p/notes/n%201",
      result: { id: "n 1", content: "c", markdown: "---\n---\nc" },
    },
    {
      run: (b) => b.createNote("p", { markdown: "---\ntitle: t\n---\nc", tags: ["a"], pinned: true }),
      reply: '{"id":"n"}',
      status: 201,
      method: "POST",
      path: "/v1/projects/p/notes",
      body: { markdown: "---\ntitle: t\n---\nc", tags: ["a"], pinned: true },
      result: { id: "n" },
    },
    {
      run: (b) => b.createNote("p", { title: "t", content: "c" }),
      reply: '{"id":"n"}',
      status: 201,
      method: "POST",
      path: "/v1/projects/p/notes",
      body: { title: "t", content: "c" },
      result: { id: "n" },
    },
    {
      run: (b) => b.updateNote("p", "n", { title: "t2" }),
      reply: '{"id":"n"}',
      method: "PATCH",
      path: "/v1/projects/p/notes/n",
      body: { title: "t2" },
      result: { id: "n" },
    },
    { run: (b) => b.deleteNote("p", "n"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p/notes/n", result: undefined },
    {
      run: (b) => b.listFiles("p", "src dir", "a b/c.txt"),
      reply: '{"entries":[{"name":"c.txt"}]}',
      method: "GET",
      path: "/v1/projects/p/files?folder=src%20dir&path=a%20b%2Fc.txt",
      result: [{ name: "c.txt" }],
    },
    { run: (b) => b.listFiles("p", "src", ""), reply: '{"entries":[]}', method: "GET", path: "/v1/projects/p/files?folder=src&path=", result: [] },
    {
      run: (b) => b.readFile("p", "src", "x/y z.ts"),
      reply: '{"content":"hi","mtime":"t"}',
      method: "GET",
      path: "/v1/projects/p/files/content?folder=src&path=x%2Fy%20z.ts",
      result: { content: "hi", mtime: "t" },
    },
    {
      run: (b) => b.writeFile("p", { folder: "src", path: "a b.ts", content: "c", expected_mtime: "t" }),
      reply: '{"size":1,"mtime":"t2"}',
      method: "PUT",
      path: "/v1/projects/p/files/content",
      body: { folder: "src", path: "a b.ts", content: "c", expected_mtime: "t" },
      result: { size: 1, mtime: "t2" },
    },
    { run: (b) => b.listPlugins(), reply: '{"plugins":[{"name":"go-tools"}]}', method: "GET", path: "/v1/plugins", result: [{ name: "go-tools" }] },
    { run: (b) => b.getUsage(), reply: '{"group":"day","buckets":[]}', method: "GET", path: "/v1/usage", result: { group: "day", buckets: [] } },
    { run: (b) => b.getUsage({}), reply: '{"group":"day"}', method: "GET", path: "/v1/usage", result: { group: "day" } },
    {
      run: (b) => b.getUsage({ from: "2026-11-01", to: "2026-11-10T00:00:00+02:00", group: "model", project: "prj a/b" }),
      reply: '{"group":"model"}',
      method: "GET",
      path: "/v1/usage?from=2026-11-01&to=2026-11-10T00%3A00%3A00%2B02%3A00&group=model&project=prj%20a%2Fb",
      result: { group: "model" },
    },
    {
      run: (b) => b.getUsage({ group: "agent", from: "" }),
      reply: '{"group":"agent"}',
      method: "GET",
      path: "/v1/usage?group=agent",
      result: { group: "agent" },
    },
    {
      run: (b) => b.getLimits(),
      reply: '{"limits":[{"provider":"api.anthropic.com","kind":"requests"}]}',
      method: "GET",
      path: "/v1/limits",
      result: [{ provider: "api.anthropic.com", kind: "requests" }],
    },
    {
      run: (b) => b.askSide("p", "what is this?"),
      reply: '{"side_id":"sid_1","message":{"id":3,"side_id":"sid_1","role":"user","text":"what is this?","created_at":"t"}}',
      status: 202,
      method: "POST",
      path: "/v1/projects/p/side",
      body: { text: "what is this?" },
      result: { side_id: "sid_1", message: { id: 3, side_id: "sid_1", role: "user", text: "what is this?", created_at: "t" } },
    },
    { run: (b) => b.listSide("p"), reply: '{"messages":[{"id":3}]}', method: "GET", path: "/v1/projects/p/side", result: [{ id: 3 }] },
    { run: (b) => b.clearSide("p/q"), reply: "", status: 204, method: "DELETE", path: "/v1/projects/p%2Fq/side", result: undefined },
    {
      run: (b) => b.getContext("p"),
      reply: '{"agent_id":"o","model":"m","window_tokens":null,"used_tokens":9,"estimated":true,"parts":[{"key":"system","tokens":9}]}',
      method: "GET",
      path: "/v1/projects/p/context",
      result: { agent_id: "o", model: "m", window_tokens: null, used_tokens: 9, estimated: true, parts: [{ key: "system", tokens: 9 }] },
    },
    {
      run: (b) => b.getContext("p"),
      reply:
        '{"agent_id":"o","model":"m","window_tokens":null,"used_tokens":9,"estimated":true,"parts":[],"categories":[{"id":"mcp_tools","label":"MCP tools","tokens":9,"items":[{"id":"tool:s:t","label":"s · t","tokens":9,"server":"s","group":"s","loaded":true,"estimated":true}]}],"not_loaded":[{"id":"memory_file:/memories/a.md","label":"/memories/a.md","tokens":3,"path":"/memories/a.md","loaded":false,"estimated":true}],"buffer_tokens":0,"largest_messages":[{"message_id":4,"role":"user","tokens":7,"preview":"hi"}]}',
      method: "GET",
      path: "/v1/projects/p/context",
      result: {
        agent_id: "o",
        model: "m",
        window_tokens: null,
        used_tokens: 9,
        estimated: true,
        parts: [],
        categories: [
          {
            id: "mcp_tools",
            label: "MCP tools",
            tokens: 9,
            items: [{ id: "tool:s:t", label: "s · t", tokens: 9, server: "s", group: "s", loaded: true, estimated: true }],
          },
        ],
        not_loaded: [{ id: "memory_file:/memories/a.md", label: "/memories/a.md", tokens: 3, path: "/memories/a.md", loaded: false, estimated: true }],
        buffer_tokens: 0,
        largest_messages: [{ message_id: 4, role: "user", tokens: 7, preview: "hi" }],
      },
    },
    {
      run: (b) => b.getContext("p/q", "a b"),
      reply: '{"agent_id":"a b"}',
      method: "GET",
      path: "/v1/projects/p%2Fq/context?agent=a%20b",
      result: { agent_id: "a b" },
    },
    {
      run: (b) => b.getTranscript("p", "a"),
      reply: '{"messages":[{"id":1}],"compactions":[{"upto_message_id":1,"at":"t","summary_tokens":5}]}',
      method: "GET",
      path: "/v1/projects/p/agents/a/messages",
      result: { messages: [{ id: 1 }], compactions: [{ upto_message_id: 1, at: "t", summary_tokens: 5 }] },
    },
    {
      run: (b) => b.getTranscript("p", "a"),
      reply: '{"messages":[]}',
      method: "GET",
      path: "/v1/projects/p/agents/a/messages",
      result: { messages: [], compactions: [] },
    },
    { run: (b) => b.getLimits(), reply: '{"limits":[]}', method: "GET", path: "/v1/limits", result: [] },
    {
      run: (b) => b.listLanguageServers("a/b"),
      reply: '{"servers":[{"id":"gopls"}]}',
      method: "GET",
      path: "/v1/projects/a%2Fb/lsp",
      result: [{ id: "gopls" }],
    },
  ];
  for (const c of cases) {
    const { bridge, calls } = bridgeWith(c.status ?? 200, c.reply);
    const result = await c.run(bridge);
    const [call] = calls;
    assert.equal(calls.length, 1);
    assert.ok(call);
    assert.equal(call.url, `http://h:1${c.path}`);
    assert.equal(call.method, c.method);
    assert.equal(call.body, c.body === undefined ? undefined : JSON.stringify(c.body));
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

test("error body carries the server's command when it sends one", async () => {
  const { bridge } = bridgeWith(409, '{"error":{"code":"not_logged_in","message":"not logged in","command":" gh auth login --hostname ghe.example.com "}}');
  await assert.rejects(bridge.sendMessage("p", "x"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.command, "gh auth login --hostname ghe.example.com");
    return true;
  });
});

test("writeFile 409 maps to BridgeError file_changed", async () => {
  const { bridge } = bridgeWith(409, '{"error":{"code":"file_changed","message":"changed on disk"}}');
  await assert.rejects(bridge.writeFile("p", { folder: "f", path: "a", content: "x", expected_mtime: "t" }), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "file_changed");
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
  // Every event type, and the harness's `heartbeat` (it only feeds the stream watchdog).
  assert.equal(FakeEventSource.last.listeners.size, BRIDGE_EVENT_TYPES.length + 1);
  assert.ok(FakeEventSource.last.listeners.has("heartbeat"));
  for (const type of ["agent.compacted", "side.delta", "side.done", "side.error"]) {
    assert.ok(FakeEventSource.last.listeners.has(type), type);
  }
});

test("subscribe delivers file.changed", () => {
  const bridge = createHttpBridge({ baseUrl: "http://h", EventSource: FakeEventSource });
  const events: BridgeEvent[] = [];
  bridge.subscribe("p", { onEvent: (e) => events.push(e) });
  FakeEventSource.last.listeners.get("file.changed")?.({
    data: '{"type":"file.changed","seq":4,"folder":"src","path":"a.ts","source":"agent"}',
  });
  assert.deepEqual(events, [{ type: "file.changed", seq: 4, folder: "src", path: "a.ts", source: "agent" }]);
});
