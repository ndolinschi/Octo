import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, type BinaryFetchLike, type Bridge, type EventSourceLike, type FetchLike, type TimersLike } from "./client";
import { withFileBytes } from "./fileBytes";
import { createLspChannel, MAX_CHANNEL_QUEUE } from "./lspChannel";
import { createMessageClient, serveBridge, type MessagePortLike } from "./messageBridge";
import { sessionBridge } from "./sessionBridge";
import { applyEvent, applyStreamEvent, descendantCount, emptyProjectState, resetEventSeq, withAgents, withMessages, withQueue, withSessions } from "./state";
import { decodeBase64, MAX_TERMINAL_QUEUE } from "./terminalSession";
import type { Agent, BridgeEvent, FileChange, LanguageServerSession, Message, ProjectInput, ProjectSession } from "./types";

class FakeEventSource implements EventSourceLike {
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

function portPair(): [MessagePortLike, MessagePortLike] {
  const aListeners = new Set<(m: unknown) => void>();
  const bListeners = new Set<(m: unknown) => void>();
  const a: MessagePortLike = {
    postMessage: (m) => bListeners.forEach((cb) => cb(m)),
    onMessage: (cb) => {
      aListeners.add(cb);
      return () => void aListeners.delete(cb);
    },
  };
  const b: MessagePortLike = {
    postMessage: (m) => aListeners.forEach((cb) => cb(m)),
    onMessage: (cb) => {
      bListeners.add(cb);
      return () => void bListeners.delete(cb);
    },
  };
  return [a, b];
}

function agent(id: string, parentId: string | null, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    project_id: "p1",
    parent_id: parentId,
    depth: parentId === null ? 0 : 1,
    role: parentId === null ? "orchestrator" : "worker",
    title: id,
    task: "",
    model: "m",
    tier: null,
    status: "idle",
    result: null,
    error: null,
    spawn_tool_use_id: null,
    input_tokens: 0,
    output_tokens: 0,
    created_at: "2026-11-22T00:00:00Z",
    started_at: null,
    finished_at: null,
    ...extra,
  };
}

function msg(id: number, agentId: string, text = "hi", role: "user" | "assistant" = "user"): Message {
  return { id, agent_id: agentId, role, content: [{ type: "text", text }], created_at: "2026-11-22T00:00:00Z" };
}

function session(id: string, extra: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id,
    kind: "main",
    title: id,
    state: "idle",
    model: "m",
    started_at: "2026-11-22T00:00:00Z",
    last_activity_at: "2026-11-22T00:00:00Z",
    exchanges: 0,
    children: 0,
    current: false,
    default: false,
    archived: false,
    can_message: true,
    ...extra,
  };
}

test("P1-1: createLspChannel bounds pre-listener queue to 1024 and clears on exit/close", () => {
  const ch = createLspChannel();
  for (let i = 0; i < MAX_CHANNEL_QUEUE + 50; i++) ch.push(i);
  const got: unknown[] = [];
  ch.onMessage((m) => got.push(m));
  assert.equal(got.length, MAX_CHANNEL_QUEUE);
  assert.equal(got[0], 50);
  assert.equal(got[got.length - 1], MAX_CHANNEL_QUEUE + 49);

  const ch2 = createLspChannel();
  ch2.push("before-exit");
  ch2.exit({ code: 0 });
  const got2: unknown[] = [];
  ch2.onMessage((m) => got2.push(m));
  assert.deepEqual(got2, []);

  const ch3 = createLspChannel();
  ch3.push("before-close");
  ch3.close();
  const got3: unknown[] = [];
  ch3.onMessage((m) => got3.push(m));
  assert.deepEqual(got3, []);
});

test("P1-1 & P2-4: openLanguageServer emits synthetic exit on SSE readyState=2 and forwards workspace=review", async () => {
  const streams: FakeEventSource[] = [];
  const urls: string[] = [];
  const bridge = createHttpBridge({
    baseUrl: "http://h:1",
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    },
    fetch: async (url, init) => {
      urls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/lsp/ts/sessions")) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ session_id: "ls_1", root_uri: "file:///r", workspace_folders: [{ uri: "file:///r", name: "@review" }] }),
        };
      }
      return { ok: true, status: 204, text: async () => "" };
    },
  });

  const sess = await bridge.openLanguageServer("p1", "ts", { workspace: "review" });
  assert.equal(urls[0], "POST http://h:1/v1/projects/p1/lsp/ts/sessions?workspace=review");
  const exits: { code: number; reason?: string }[] = [];
  sess.onExit((e) => exits.push(e));

  const src = streams[0];
  assert.ok(src);
  // Transient error (readyState !== 2) must not emit synthetic exit.
  src.readyState = 0;
  src.onerror?.({});
  assert.deepEqual(exits, []);

  // Permanent SSE close (readyState === 2) emits synthetic exit and closes stream.
  src.readyState = 2;
  src.onerror?.({});
  assert.deepEqual(exits, [{ code: -1, reason: "stream_closed" }]);
  assert.equal(src.closed, true);
  await assert.rejects(sess.send({ jsonrpc: "2.0" }), (e: unknown) => e instanceof BridgeError && e.code === "session_closed");
});

test("P1-1: openTerminal emits synthetic exit on SSE readyState=2 and caps pre-listener output queue", async () => {
  const streams: FakeEventSource[] = [];
  const bridge = createHttpBridge({
    baseUrl: "http://h:1",
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    },
    fetch: async (url, init) => {
      if (url.endsWith("/terminals") && init?.method === "POST") {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ session_id: "tm_1", folder: "a", cwd: "/a", shell: "sh", pid: 1 }),
        };
      }
      return { ok: true, status: 204, text: async () => "" };
    },
  });

  assert.ok(bridge.openTerminal);
  const term = await bridge.openTerminal("p1");
  const src = streams[0];
  assert.ok(src);

  // Push more than MAX_TERMINAL_QUEUE frames before attaching listener ("QQ==" === "A").
  for (let i = 0; i < MAX_TERMINAL_QUEUE + 10; i++) {
    src.emit("output", JSON.stringify({ data: "QQ==" }));
  }
  const chunks: Uint8Array[] = [];
  term.onOutput((b) => chunks.push(b));
  assert.equal(chunks.length, MAX_TERMINAL_QUEUE);

  const exits: { code: number; reason?: string }[] = [];
  term.onExit((e) => exits.push(e));
  src.readyState = 2;
  src.onerror?.({});
  assert.deepEqual(exits, [{ code: -1, reason: "stream_closed" }]);
  assert.equal(src.closed, true);
});

test("P1-2 & P3: subscribe attaches watchStream synchronously, dedupes seq, resets on seq=1, and nulls handlers on cleanup", () => {
  const streams: FakeEventSource[] = [];
  const now = 0;
  const timers: TimersLike = {
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    now: () => now,
  };
  const bridge = createHttpBridge({
    baseUrl: "http://h:1",
    timers,
    EventSource: class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        streams.push(this);
      }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
  });

  const events: BridgeEvent[] = [];
  const unsub = bridge.subscribe("p1", { onEvent: (e) => events.push(e) });
  const src = streams[0];
  assert.ok(src);

  // Duplicate seq <= lastSeq is ignored; seq === 1 after lastSeq > 1 resets epoch.
  src.emit("message.delta", JSON.stringify({ type: "message.delta", seq: 2, agent_id: "a", text: "hi" }));
  src.emit("message.delta", JSON.stringify({ type: "message.delta", seq: 2, agent_id: "a", text: "dup" }));
  src.emit("message.delta", JSON.stringify({ type: "message.delta", seq: 1, agent_id: "a", text: "restarted" }));
  src.emit("message.delta", JSON.stringify({ type: "message.delta", seq: 1, agent_id: "a", text: "dup1" }));
  assert.deepEqual(
    events.map((e) => (e.type === "message.delta" ? `${e.seq}:${e.text}` : e.type)),
    ["2:hi", "1:restarted"],
  );

  unsub();
  assert.equal(src.closed, true);
  assert.equal(src.onopen, null);
  assert.equal(src.onerror, null);
});

test("P1-2: applyStreamEvent ignores duplicate seq and resets on seq=1 or resetEventSeq", () => {
  let s = emptyProjectState();
  s = applyStreamEvent(s, { type: "message.delta", seq: 2, agent_id: "a", text: "A" });
  const after2 = s;
  s = applyStreamEvent(s, { type: "message.delta", seq: 2, agent_id: "a", text: "DUP" });
  assert.equal(s, after2);
  s = applyStreamEvent(s, { type: "message.delta", seq: 1, agent_id: "a", text: "B" });
  assert.equal(s.lastSeq, 1);
  assert.equal(s.streaming.a, "AB");
  s = resetEventSeq(s);
  assert.equal(s.lastSeq, 0);
  s = applyStreamEvent(s, { type: "message.delta", seq: 1, agent_id: "a", text: "C" });
  assert.equal(s.streaming.a, "ABC");
});

test("P1-3: message bridge forwards getTranscript opts, preserves full WireError in call & openLanguageServer, and notifies LSP sessions on dispose", async () => {
  const [clientPort, serverPort] = portPair();
  const seenTranscript: unknown[] = [];
  const seenLsp: unknown[] = [];
  let lspShouldFail = false;

  const stubBridge = {
    getTranscript: async (id: string, agentId: string, opts?: { sessionId?: string }) => {
      seenTranscript.push([id, agentId, opts]);
      return { messages: [], compactions: [] };
    },
    sendMessage: async () => {
      throw new BridgeError(422, "model_unavailable", "missing login", {
        provider: "claude",
        reason: "not_logged_in",
        can_force: true,
        command: "claude login",
        files: [{ path: "a.ts", status: "modified", code: " M" }],
        repos: [{ host: "github", repo: "octo/repo", role: "origin", default: true }],
        data: { extra: 42 },
        hint: "Log in first",
        action: "recheck_provider",
        details: "stderr",
      });
    },
    openLanguageServer: async (projectId: string, serverId: string, opts?: { workspace?: "review" }): Promise<LanguageServerSession> => {
      seenLsp.push([projectId, serverId, opts]);
      if (lspShouldFail) {
        throw new BridgeError(409, "no_review_workspace", "no review", {
          hint: "Open a review first",
          command: "octo review",
          data: { workspace: "review" },
        });
      }
      return {
        rootUri: "file:///r",
        workspaceFolders: [{ uri: "file:///r", name: "r" }],
        send: async () => undefined,
        onMessage: () => () => undefined,
        onExit: () => () => undefined,
        close: async () => undefined,
      };
    },
  } as unknown as Bridge;

  const server = serveBridge(serverPort, stubBridge);
  const client = createMessageClient(clientPort);

  await client.bridge.getTranscript("p1", "a1", { sessionId: "s9" });
  assert.deepEqual(seenTranscript, [["p1", "a1", { sessionId: "s9" }]]);

  await assert.rejects(client.bridge.sendMessage("p1", "hi"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.provider, "claude");
    assert.equal(e.reason, "not_logged_in");
    assert.equal(e.can_force, true);
    assert.equal(e.command, "claude login");
    assert.deepEqual(e.files, [{ path: "a.ts", status: "modified", code: " M" }]);
    assert.deepEqual(e.repos, [{ host: "github", repo: "octo/repo", role: "origin", default: true }]);
    assert.deepEqual(e.data, { extra: 42 });
    assert.equal(e.hint, "Log in first");
    assert.equal(e.action, "recheck_provider");
    assert.equal(e.details, "stderr");
    return true;
  });

  lspShouldFail = true;
  await assert.rejects(client.bridge.openLanguageServer("p1", "ts", { workspace: "review" }), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "no_review_workspace");
    assert.equal(e.hint, "Open a review first");
    assert.equal(e.command, "octo review");
    assert.deepEqual(e.data, { workspace: "review" });
    return true;
  });

  lspShouldFail = false;
  const sess = await client.bridge.openLanguageServer("p1", "ts", { workspace: "review" });
  assert.deepEqual(seenLsp[1], ["p1", "ts", { workspace: "review" }]);
  const exits: { code: number; reason?: string }[] = [];
  sess.onExit((info) => exits.push(info));
  client.dispose();
  assert.deepEqual(exits, [{ code: -1, reason: "disposed" }]);
  server.dispose();
});

test("P1-4: exportConversation and fetchAttachment wrap body-read failures as network_error", async () => {
  const badBodyFetch: BinaryFetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => {
      throw new Error("stream reset");
    },
    arrayBuffer: async () => {
      throw new Error("stream reset");
    },
  });
  const b = createHttpBridge({
    baseUrl: "http://h:1",
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    fetchBinary: badBodyFetch,
  });
  await assert.rejects(
    Promise.resolve(b.exportConversation?.("p1")),
    (e: unknown) => e instanceof BridgeError && e.code === "network_error" && e.message.includes("stream reset"),
  );
  await assert.rejects(
    Promise.resolve(b.fetchAttachment?.("p1", "att_1")),
    (e: unknown) => e instanceof BridgeError && e.code === "network_error" && e.message.includes("stream reset"),
  );
});

test("P2-1 & P2-2: deleted session evicts its agents, maps are capped, descendantCount handles cycles, message.updated upserts, turnFinished avoids wrong-session fallback, withQueue syncs default slice", () => {
  let s = withSessions(emptyProjectState(), [session("A", { default: true, current: true, root_agent_id: "ra" }), session("B", { root_agent_id: "rb" })]);
  s = withAgents(s, [agent("ra", null, { session_id: "A" }), agent("rb", null, { session_id: "B" }), agent("sub_b", "rb", { session_id: "B" })]);
  s = withMessages(s, "ra", [msg(1, "ra", "qA")]);
  s = withMessages(s, "rb", [msg(2, "rb", "qB")]);
  s = applyEvent(s, { type: "message.delta", seq: 1, agent_id: "rb", text: "streamB" });

  // P2-2: withQueue syncs default session slice.
  s = withQueue(s, { paused: true, messages: [{ id: "q1", text: "queued", created_at: "t" }] });
  assert.equal(s.sessions.byId.A?.queue.paused, true);
  assert.equal(s.sessions.byId.A?.queue.messages[0]?.id, "q1");

  // P2-2: turnFinished with unknown session_id and no root must not file outcome under A's request 1.
  s = applyEvent(s, { type: "turn.finished", seq: 2, status: "failed", error: "x", session_id: "C" });
  assert.equal(s.sessions.byId.C?.turnOutcomes[1], undefined);
  assert.equal(s.turnOutcomes[1], undefined);

  // P2-2: message.updated upserts unseen message.
  s = applyEvent(s, { type: "message.updated", seq: 3, message: msg(99, "ra", "upserted", "assistant") });
  assert.equal(
    s.messages.ra?.some((m) => m.id === 99),
    true,
  );

  // P2-1: deleting session B evicts rb and sub_b and their messages/streaming, keeping ra.
  s = applyEvent(s, { type: "session.updated", seq: 4, session_id: "B", deleted: true });
  assert.deepEqual(s.agentOrder, ["ra"]);
  assert.equal(s.agents.rb, undefined);
  assert.equal(s.agents.sub_b, undefined);
  assert.equal(s.messages.rb, undefined);
  assert.equal(s.streaming.rb, undefined);
  assert.ok(s.agents.ra);

  // P2-2: descendantCount cycle guard.
  const cyclic = withAgents(emptyProjectState(), [agent("x", "y"), agent("y", "x")]);
  assert.equal(descendantCount(cyclic, "x"), 1);

  // P2-1: cap changes, answeredInputs, and turnOutcomes at 200.
  let capped = emptyProjectState();
  for (let i = 1; i <= 210; i++) {
    const ch: FileChange = {
      id: i,
      turn_id: i,
      agent_id: "a",
      folder: "f",
      path: `f${i}.ts`,
      kind: "modified",
      added: 1,
      removed: 0,
      note: "",
      source: "write_file",
      created_at: "t",
    };
    capped = applyEvent(capped, { type: "change.recorded", seq: i, turn_id: i, change: ch });
    capped = applyEvent(capped, { type: "input.resolved", seq: i + 300, id: `in_${i}`, status: "submitted", provided: [], values: {} });
  }
  assert.equal(Object.keys(capped.changes).length, 200);
  assert.equal(capped.changes[1], undefined);
  assert.ok(capped.changes[210]);
  assert.equal(Object.keys(capped.answeredInputs).length, 200);
  assert.equal(capped.answeredInputs.in_1, undefined);
  assert.ok(capped.answeredInputs.in_210);
});

test("P2-3 & P2-4: steerSessionQueued via sessionBridge, fetchReviewFileRaw, and ProjectInput parity", async () => {
  const calls: string[] = [];
  const rawBuf = new Uint8Array([1, 2, 3]).buffer;
  const fetch: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return { ok: true, status: 200, text: async () => JSON.stringify({ steered: true }) };
  };
  const fetchBinary: BinaryFetchLike = async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url} auth=${init?.headers?.Authorization ?? ""}`);
    return {
      ok: true,
      status: 200,
      text: async () => "",
      arrayBuffer: async () => rawBuf,
      headers: { get: (n: string) => (n === "Content-Type" ? "image/png" : null) },
    };
  };
  const b = createHttpBridge({ baseUrl: "http://h:1", token: "tok", fetch, fetchBinary });
  const scoped = sessionBridge(b, "sid_1");
  const res = await scoped.steerQueued?.("p1", "q1");
  assert.deepEqual(res, { steered: true });
  assert.equal(calls[0], "POST http://h:1/v1/projects/p1/sessions/sid_1/queue/q1/send-now");

  const raw = await b.fetchReviewFileRaw?.("p1", "rev_1", "dir/a.png", "new");
  assert.equal(raw?.type, "image/png");
  assert.equal(raw?.data, rawBuf);
  assert.equal(calls[1], "GET http://h:1/v1/projects/p1/reviews/rev_1/files/dir/a.png?raw=new auth=Bearer tok");

  // Type-level parity check for ProjectInput fields.
  const input: ProjectInput = {
    name: "p",
    session_settings: { max_running: 4, default_workspace: "worktree" },
    network: "on",
    network_private: true,
  };
  assert.equal(input.network, "on");
});

test("P2-5: stored() uses clockOffset after send timeout, and fileBytes preserves full BridgeError metadata", async () => {
  // Server clock is 2 minutes ahead of local clock (+120_000 ms).
  const localNow = Date.now();
  const serverDate = new Date(localNow + 120_000).toUTCString();
  const serverCreatedAt = new Date(localNow + 120_000).toISOString();
  let timerFn: (() => void) | undefined;
  const timers: TimersLike = {
    setTimeout: (fn) => {
      timerFn = fn;
      return 1;
    },
    clearTimeout: () => undefined,
    now: () => localNow,
  };

  const fetch: FetchLike = async (url, init) => {
    const headers = { get: (n: string) => (n.toLowerCase() === "date" ? serverDate : null) };
    if (url.endsWith("/health")) return { ok: true, status: 200, text: async () => '{"ok":true,"version":"1"}', headers };
    if (init?.method === "POST" && url.endsWith("/messages")) {
      return new Promise(() => {
        // Trigger send timeout immediately on next microtask.
        void Promise.resolve().then(() => timerFn?.());
      });
    }
    if (url.endsWith("/projects/p1")) return { ok: true, status: 200, text: async () => JSON.stringify({ orchestrator_agent_id: "o1" }), headers };
    if (url.endsWith("/agents/o1/messages")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ messages: [{ id: 7, agent_id: "o1", role: "user", content: [{ type: "text", text: "hello" }], created_at: serverCreatedAt }] }),
        headers,
      };
    }
    return { ok: true, status: 200, text: async () => '{"paused":false,"messages":[]}', headers };
  };

  const b = createHttpBridge({ baseUrl: "http://h:1", fetch, timers, sendTimeoutMs: 50 });
  await b.health();
  assert.ok((b.clockOffset?.() ?? 0) > 30_000);
  const sent = await b.sendOrQueueMessage?.("p1", "hello");
  assert.ok(sent && "message" in sent && sent.message?.id === 7);

  // fileBytes reuses toBridgeError and preserves action/details/command.
  const fb = withFileBytes(b, {
    baseUrl: "http://h:1",
    fetch: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { code: "forbidden", message: "no", hint: "check", action: "open_settings", command: "fix" } }),
    }),
  });
  await assert.rejects(fb.readFileBytes("p1", "f", "a.png"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "forbidden");
    assert.equal(e.hint, "check");
    assert.equal(e.action, "open_settings");
    assert.equal(e.command, "fix");
    return true;
  });
});

test("P3: fallback decodeBase64 strips whitespace and rejects invalid base64", () => {
  const g = globalThis as { atob?: ((s: string) => string) | undefined };
  const orig = g.atob;
  g.atob = undefined;
  try {
    assert.equal(String.fromCharCode(...decodeBase64("T2N0\nbw==")), "Octo");
    for (const bad of ["A", "T2N!"]) {
      let threw = false;
      try {
        decodeBase64(bad);
      } catch {
        threw = true;
      }
      assert.equal(threw, true, `expected decodeBase64(${bad}) to throw`);
    }
  } finally {
    g.atob = orig;
  }
});
