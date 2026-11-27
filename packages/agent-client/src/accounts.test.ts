import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, isErrorAction, type EventSourceLike, type FetchLike } from "./client";
import { BRIDGE_METHODS } from "./messageProtocol";
import { agentIdOf, splitAgentId, type AgentLoginState } from "./types";

type Seen = { method: string | undefined; url: string; body: unknown };

const account = { id: "work", name: "Work", default: false, dir: "/d/work", owned: true };
const provider = { id: "claude-code@work", kind: "agent", label: "Claude Code", base_id: "claude-code", account };

function recorder(status: number, reply: unknown): { seen: Seen[]; fetch: FetchLike } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ method: init?.method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    return { ok: status < 400, status, text: async () => (reply === undefined ? "" : JSON.stringify(reply)) };
  };
  return { seen, fetch };
}

test("addAgentAccount posts name and dir to the base's accounts path", async () => {
  const { seen, fetch } = recorder(201, { account, provider });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  const r = await bridge.addAgentAccount("claude-code", { name: "Work", dir: "/d/work" });
  assert.deepEqual(seen, [{ method: "POST", url: "http://h:1/v1/providers/claude-code/accounts", body: { name: "Work", dir: "/d/work" } }]);
  assert.equal(r.account.id, "work");
  assert.equal(r.provider.id, "claude-code@work");
});

test("renameAgentAccount patches the account path with the id percent-encoded", async () => {
  const { seen, fetch } = recorder(200, { account: { ...account, name: "Job" }, provider });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  const r = await bridge.renameAgentAccount("claude-code@work", "Job");
  assert.deepEqual(seen, [{ method: "PATCH", url: "http://h:1/v1/providers/claude-code%40work/account", body: { name: "Job" } }]);
  assert.equal(r.account.name, "Job");
});

test("removeAgentAccount sends delete_data and parses the answer", async () => {
  const { seen, fetch } = recorder(200, { removed: "claude-code@work", deleted_dir: "/d/work" });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  assert.deepEqual(await bridge.removeAgentAccount("claude-code@work", { deleteData: true }), { removed: "claude-code@work", deleted_dir: "/d/work" });
  assert.deepEqual(seen, [{ method: "DELETE", url: "http://h:1/v1/providers/claude-code%40work/account?delete_data=true", body: undefined }]);

  const kept = recorder(200, { removed: "claude-code@work", deleted_dir: null });
  const b2 = createHttpBridge({ baseUrl: "http://h:1", fetch: kept.fetch });
  assert.equal((await b2.removeAgentAccount("claude-code@work", { deleteData: false })).deleted_dir, null);
  assert.ok(kept.seen[0]?.url.endsWith("?delete_data=false"));
});

test("a malformed account answer is an invalid_response", async () => {
  const { fetch } = recorder(200, { nope: true });
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  await assert.rejects(bridge.addAgentAccount("x", { name: "n" }), (e: unknown) => e instanceof BridgeError && e.code === "invalid_response");
  await assert.rejects(bridge.removeAgentAccount("x", { deleteData: false }), (e: unknown) => e instanceof BridgeError && e.code === "invalid_response");
});

test("a limit refusal keeps the switch_account action; the new methods are HTTP-only", async () => {
  const body = { error: { code: "agent_limit_reached", message: "Limit reached.", hint: "Switch account.", action: "switch_account" } };
  const { fetch } = recorder(409, body);
  const bridge = createHttpBridge({ baseUrl: "http://h:1", fetch });
  await assert.rejects(bridge.startAgentLogin("claude-code@work"), (e: unknown) => {
    assert.ok(e instanceof BridgeError);
    assert.equal(e.code, "agent_limit_reached");
    assert.equal(e.action, "switch_account");
    return true;
  });
  assert.equal(isErrorAction("switch_account"), true);
  assert.equal(isErrorAction("nope"), false);
  for (const m of ["addAgentAccount", "renameAgentAccount", "removeAgentAccount", "startAgentLogin"]) {
    assert.equal((BRIDGE_METHODS as readonly string[]).includes(m), false, `${m} is HTTP-only`);
  }
});

class FakeEventSource implements EventSourceLike {
  static last: FakeEventSource | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Set<(ev: { data?: unknown }) => void>>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  emit(type: string, data: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }
  close(): void {
    this.closed = true;
  }
}

test("startAgentLogin opens the login PTY and delivers output, login and exit frames", async () => {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ method: init?.method, url, body: init?.body === undefined ? undefined : JSON.parse(init.body) });
    if (init?.method === "POST" && url.endsWith("/login")) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ session_id: "lg_1", command: "claude auth login", pid: 77 }) };
    }
    return { ok: true, status: 204, text: async () => "" };
  };
  const bridge = createHttpBridge({ baseUrl: "http://h:1", token: "tk", fetch, EventSource: FakeEventSource });
  const login = await bridge.startAgentLogin("claude-code@work", { method: "console", cols: 80, rows: 24 });
  assert.deepEqual(seen[0], { method: "POST", url: "http://h:1/v1/providers/claude-code%40work/login", body: { method: "console", cols: 80, rows: 24 } });
  assert.equal(login.sessionId, "lg_1");
  assert.equal(login.command, "claude auth login");
  assert.equal(login.pid, 77);
  const es = FakeEventSource.last;
  assert.ok(es);
  assert.equal(es.url, "http://h:1/v1/providers/claude-code%40work/login/lg_1/events?token=tk");

  const out: string[] = [];
  const states: AgentLoginState[] = [];
  const exits: number[] = [];
  login.onOutput((b) => out.push(String.fromCharCode(...b)));
  login.onLogin((s) => states.push(s));
  login.onExit((i) => exits.push(i.code));
  es.emit("output", { data: "aGk=" });
  es.emit("login", { state: "bogus" });
  es.emit("login", { state: "ok" });
  await login.write("x");
  assert.deepEqual(seen.at(-1), { method: "POST", url: "http://h:1/v1/providers/claude-code%40work/login/lg_1/input", body: { data: "x" } });
  es.emit("exit", { code: 0, reason: "exited" });
  assert.deepEqual(out, ["hi"]);
  assert.deepEqual(states, ["ok"]);
  assert.deepEqual(exits, [0]);

  const late: AgentLoginState[] = [];
  login.onLogin((s) => late.push(s));
  assert.deepEqual(late, ["ok"], "a late listener gets the settled state");
});

test("a login start response without a session id is invalid_response; close deletes the session", async () => {
  const bad = recorder(201, { command: "x" });
  const b1 = createHttpBridge({ baseUrl: "http://h:1", fetch: bad.fetch, EventSource: FakeEventSource });
  await assert.rejects(b1.startAgentLogin("a"), (e: unknown) => e instanceof BridgeError && e.code === "invalid_response");

  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({ method: init?.method, url, body: undefined });
    return {
      ok: true,
      status: init?.method === "POST" ? 201 : 204,
      text: async () => (init?.method === "POST" ? JSON.stringify({ session_id: "l2", pid: 1 }) : ""),
    };
  };
  const b2 = createHttpBridge({ baseUrl: "http://h:1", fetch, EventSource: FakeEventSource });
  const s = await b2.startAgentLogin("a");
  assert.equal(s.command, "");
  await s.close();
  assert.deepEqual(seen.at(-1), { method: "DELETE", url: "http://h:1/v1/providers/a/login/l2", body: undefined });
});

test("splitAgentId and agentIdOf", () => {
  const rows: [string, { base: string; account: string }][] = [
    ["claude-code", { base: "claude-code", account: "" }],
    ["claude-code@work", { base: "claude-code", account: "work" }],
    ["codex@a@b", { base: "codex", account: "a@b" }],
    ["", { base: "", account: "" }],
    ["x@", { base: "x", account: "" }],
  ];
  for (const [id, want] of rows) assert.deepEqual(splitAgentId(id), want, id);
  assert.equal(agentIdOf("claude-code", ""), "claude-code");
  assert.equal(agentIdOf("claude-code", "work"), "claude-code@work");
  assert.equal(agentIdOf(splitAgentId("codex@second").base, splitAgentId("codex@second").account), "codex@second");
});
