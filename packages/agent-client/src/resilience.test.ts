import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError, createHttpBridge, clockSkew, isAuthRefused, retryDelay, type EventSourceLike, type FetchLike, type TimersLike } from "./client";
import { SEND_TIMEOUT_MS, STREAM_STALE_MS } from "./rare";
import { emptyProjectState, settleStreams, withAgents } from "./state";
import type { Agent, BridgeEvent } from "./types";

/** Timers on a clock the test moves. */
const T0 = Date.parse("2026-11-14T10:00:00.000Z");

function fakeTimers() {
  let now = T0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: TimersLike = {
    setTimeout: (fn, ms) => {
      seq += 1;
      queue.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id) => void queue.delete(id as number),
    now: () => now,
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of queue) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      queue.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  return { timers, advance, pending: () => queue.size };
}

function must<T>(v: T | undefined): T {
  assert.ok(v);
  return v;
}

const hanging: FetchLike = () => new Promise(() => undefined);

test("a send the harness does not answer fails with `timeout` after SEND_TIMEOUT_MS, and the fetch is aborted", async () => {
  const t = fakeTimers();
  const signals: { aborted: boolean }[] = [];
  const fetch: FetchLike = (_url, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise(() => undefined);
  };
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch, timers: t.timers });
  await import("./rare");
  const sent = must(bridge.sendOrQueueMessage)("p", "hi");
  let settled = false;
  void sent.catch(() => (settled = true));
  // The send lives in the lazy half: let it load and start its timer.
  for (let i = 0; i < 50 && t.pending() === 0; i++) await Promise.resolve();
  t.advance(SEND_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false, "not before the timeout");
  t.advance(1);
  // Then the read-back (which this fetch never answers either) gives up after the same time.
  await settleTimers(t, SEND_TIMEOUT_MS);
  await assert.rejects(sent, (e) => e instanceof BridgeError && e.code === "timeout" && e.status === 0 && e.action === "retry");
  assert.equal(signals[0]?.aborted, true, "the POST is aborted");
});

test("sendMessage has the same timeout; a quick answer clears the timer", async () => {
  const t = fakeTimers();
  const slow = createHttpBridge({ baseUrl: "http://h", fetch: hanging, timers: t.timers, sendTimeoutMs: 50 });
  await import("./rare");
  const sent = slow.sendMessage("p", "hi");
  // The lazy module loads first: let it, then move the clock.
  for (let i = 0; i < 50 && t.pending() === 0; i++) await Promise.resolve();
  assert.equal(t.pending(), 1);
  await settleTimers(t, 50);
  await assert.rejects(sent, (e) => e instanceof BridgeError && e.code === "timeout");

  const quick: FetchLike = async () => ({ ok: true, status: 202, text: async () => '{"message":{"id":3,"agent_id":"a"}}' });
  const fast = createHttpBridge({ baseUrl: "http://h", fetch: quick, timers: t.timers });
  const r = await must(fast.sendOrQueueMessage)("p", "hi");
  assert.equal(r.message?.id, 3);
  assert.equal(t.pending(), 0, "the timeout timer is cleared");
});

test("reads have no timeout (only sends do)", async () => {
  const t = fakeTimers();
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch: hanging, timers: t.timers });
  let settled = false;
  void bridge.listProjects().then(
    () => (settled = true),
    () => (settled = true),
  );
  t.advance(10 * SEND_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(t.pending(), 0);
});

class Source implements EventSourceLike {
  static all: Source[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, (ev: { data?: unknown }) => void>();
  closed = false;
  constructor(readonly url: string) {
    Source.all.push(this);
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
}

async function watched() {
  Source.all = [];
  const t = fakeTimers();
  const bridge = createHttpBridge({ baseUrl: "http://h", EventSource: Source, timers: t.timers });
  const log: string[] = [];
  const events: BridgeEvent[] = [];
  const stop = bridge.subscribe("p", {
    onEvent: (e) => events.push(e),
    onOpen: () => log.push("open"),
    onError: (e) => log.push(e instanceof BridgeError ? e.code : "error"),
  });
  const current = () => {
    const s = Source.all.at(-1);
    assert.ok(s);
    return s;
  };
  // The watchdog is in the lazy half: let it load and arm.
  await import("./rare");
  for (let i = 0; i < 50 && t.pending() === 0; i++) await Promise.resolve();
  assert.equal(t.pending(), 1, "the watchdog is armed");
  return { t, log, events, stop, current };
}

test("a half-open stream (nothing, not even a heartbeat) is reopened after STREAM_STALE_MS", async () => {
  const w = await watched();
  w.current().open();
  // Heartbeats and events keep it alive.
  for (let i = 0; i < 6; i++) {
    w.t.advance(15_000);
    w.current().listeners.get("heartbeat")?.({ data: "{}" });
  }
  w.current().listeners.get("message.delta")?.({ data: '{"type":"message.delta","seq":2,"agent_id":"a","text":"x"}' });
  assert.equal(Source.all.length, 1);
  assert.equal(w.events.length, 1, "the heartbeat is not an event");
  // Silence.
  w.t.advance(STREAM_STALE_MS + 5_000);
  assert.equal(Source.all.length, 2);
  assert.equal(Source.all[0]?.closed, true);
  assert.deepEqual(w.log, ["open", "stream_stale"]);
  w.current().open();
  assert.deepEqual(w.log, ["open", "stream_stale", "open"], "the reopen ends in onOpen: the caller re-reads");
  w.stop();
  assert.equal(w.current().closed, true);
  assert.equal(w.t.pending(), 0, "unsubscribing clears the watchdog");
});

test("a quiet but healthy stream costs nothing: no reopen while heartbeats arrive", async () => {
  const w = await watched();
  w.current().open();
  for (let i = 0; i < 40; i++) {
    w.t.advance(15_000);
    w.current().listeners.get("heartbeat")?.({ data: "{}" });
  }
  assert.equal(Source.all.length, 1);
  w.stop();
});

test("a refused stream (closed after an HTTP error) is reopened with backoff; a dropped one is left to EventSource", async () => {
  const w = await watched();
  // Dropped: EventSource is reconnecting by itself (readyState 0); nothing to do.
  w.current().readyState = 0;
  w.current().onerror?.("drop");
  w.t.advance(3_000);
  assert.equal(Source.all.length, 1);
  // Refused: closed for good.
  w.current().readyState = 2;
  w.current().onerror?.("502");
  w.t.advance(999);
  assert.equal(Source.all.length, 1);
  w.t.advance(1);
  assert.equal(Source.all.length, 2, "first retry after 1 s");
  w.current().readyState = 2;
  w.current().onerror?.("502");
  w.t.advance(1_999);
  assert.equal(Source.all.length, 2);
  w.t.advance(1);
  assert.equal(Source.all.length, 3, "second after 2 s");
  w.current().open();
  w.t.advance(5_000);
  w.current().readyState = 2;
  w.current().onerror?.("502");
  w.t.advance(1_000);
  assert.equal(Source.all.length, 4, "a stream that stayed open resets the backoff");
  w.stop();
  w.t.advance(60_000);
  assert.equal(Source.all.length, 4, "nothing after unsubscribe");
});

test("a stream refused before the watchdog loaded is reopened once it is in", async () => {
  Source.all = [];
  const t = fakeTimers();
  const bridge = createHttpBridge({ baseUrl: "http://h", EventSource: Source, timers: t.timers });
  const stop = bridge.subscribe("p", { onEvent: () => undefined });
  const first = Source.all[0];
  assert.ok(first);
  first.readyState = 2;
  first.onerror?.("502");
  await import("./rare");
  for (let i = 0; i < 50 && t.pending() === 0; i++) await Promise.resolve();
  t.advance(1_000);
  assert.equal(Source.all.length, 2);
  stop();
  assert.equal(t.pending(), 0);
});

test("retryDelay doubles from 1 s up to the cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 40].map((n) => retryDelay(n)),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );
  assert.equal(retryDelay(5, 10_000), 10_000);
  assert.equal(retryDelay(0), 1000);
});

test("a 401 is a refused token, not an unreachable harness", async () => {
  const fetch: FetchLike = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"code":"unauthorized","message":"missing or invalid API token"}}',
  });
  const err = await createHttpBridge({ baseUrl: "http://h", fetch, token: "old" })
    .listProjects()
    .catch((e: unknown) => e);
  assert.equal(isAuthRefused(err), true);
  assert.equal(isAuthRefused(new BridgeError(0, "network_error", "Failed to fetch")), false);
  assert.equal(isAuthRefused(new BridgeError(403, "forbidden", "x")), false);
  assert.equal(isAuthRefused(new Error("401")), false);
});

const agent = (id: string, status: "idle" | "running"): Agent => ({ id, parent_id: null, status }) as Agent;

test("settleStreams drops the live parts of agents that finished while the stream was down", () => {
  let s = withAgents(emptyProjectState(), [agent("a", "idle"), agent("b", "running")]);
  s = {
    ...s,
    streaming: { a: "half an ans", b: "still going" },
    thinking: { a: "hmm" },
    activeTools: { a: { t1: { name: "bash" } }, b: { t2: { name: "read" } } },
    activity: { a: { kind: "tool", label: "bash" } },
  };
  const out = settleStreams(s);
  assert.deepEqual(out.streaming, { b: "still going" });
  assert.deepEqual(out.thinking, {});
  assert.deepEqual(out.activeTools, { b: { t2: { name: "read" } } });
  assert.deepEqual(out.activity, {});
  assert.deepEqual(settleStreams(out), out, "nothing stale: nothing changes");
});

type Route = { method: string; path: string; status?: number; body: unknown } | { method: string; path: string; hang: true };

/** A harness on a fake fetch: answers by method and path; `hang` never answers. Records the calls. */
function harness(routes: Route[]) {
  const calls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("http://h", "");
    calls.push(`${method} ${path}`);
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) return Promise.resolve({ ok: false, status: 404, text: async () => "{}" });
    if ("hang" in r) return new Promise(() => undefined);
    return Promise.resolve({ ok: (r.status ?? 200) < 300, status: r.status ?? 200, text: async () => JSON.stringify(r.body) });
  };
  return { fetch, calls };
}

const at = (ms: number) => new Date(T0 + ms).toISOString();
const userMessage = (id: number, text: string, created: number) => ({
  id,
  agent_id: "o",
  role: "user",
  content: [{ type: "text", text }],
  created_at: at(created),
});

async function settleTimers(t: ReturnType<typeof fakeTimers>, ms: number) {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    t.advance(ms);
  }
}

test("a send the harness took late is found by the read-back and answered as if in time; nothing is posted twice", async () => {
  const t = fakeTimers();
  const h = harness([
    { method: "POST", path: "/v1/projects/p/messages", hang: true },
    { method: "GET", path: "/v1/projects/p", body: { id: "p", orchestrator_agent_id: "o" } },
    { method: "GET", path: "/v1/projects/p/agents/o/messages", body: { messages: [userMessage(1, "hi", -60_000), userMessage(7, "hi", 50)] } },
  ]);
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch: h.fetch, timers: t.timers });
  const sent = must(bridge.sendOrQueueMessage)("p", "hi");
  await settleTimers(t, SEND_TIMEOUT_MS);
  const r = await sent;
  assert.equal(r.message?.id, 7, "the copy stored after the send started, not the older one with the same text");
  assert.equal(h.calls.filter((c) => c.startsWith("POST")).length, 1);
});

test("not found: the timeout error says the text is kept; Retry looks again first and does not post a late arrival twice", async () => {
  const t = fakeTimers();
  const stored: unknown[] = [userMessage(1, "hi", -60_000)];
  const h = harness([
    { method: "POST", path: "/v1/projects/p/messages", hang: true },
    { method: "GET", path: "/v1/projects/p", body: { id: "p", orchestrator_agent_id: "o" } },
    { method: "GET", path: "/v1/projects/p/agents/o/messages", body: { messages: stored } },
    { method: "GET", path: "/v1/projects/p/queue", body: { paused: false, messages: [] } },
  ]);
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch: h.fetch, timers: t.timers });
  const first = must(bridge.sendOrQueueMessage)("p", "hi");
  void first.catch(() => undefined);
  await settleTimers(t, SEND_TIMEOUT_MS);
  await assert.rejects(first, (e) => e instanceof BridgeError && e.code === "timeout" && e.action === "retry" && (e.hint ?? "").includes("kept"));
  // The harness stores it after all, then the person presses Retry.
  stored.push(userMessage(9, "hi", 20_000));
  const retry = await must(bridge.sendOrQueueMessage)("p", "hi");
  assert.equal(retry.message?.id, 9);
  assert.equal(h.calls.filter((c) => c.startsWith("POST")).length, 1, "Retry found it: no second POST");
});

test("a send found waiting in the queue counts as sent", async () => {
  const t = fakeTimers();
  const h = harness([
    { method: "POST", path: "/v1/projects/p/messages", hang: true },
    { method: "GET", path: "/v1/projects/p", body: { id: "p", orchestrator_agent_id: "o" } },
    { method: "GET", path: "/v1/projects/p/agents/o/messages", body: { messages: [] } },
    { method: "GET", path: "/v1/projects/p/queue", body: { paused: false, messages: [{ id: "q1", text: "hi", created_at: at(10) }] } },
  ]);
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch: h.fetch, timers: t.timers });
  const sent = must(bridge.sendOrQueueMessage)("p", "hi");
  await settleTimers(t, SEND_TIMEOUT_MS);
  assert.equal((await sent).queued?.id, "q1");
});

test("clockSkew: the service's clock minus ours, only when it is more than 30 s off", () => {
  const local = Date.parse("2026-11-14T10:00:00Z");
  assert.equal(clockSkew("Sat, 14 Nov 2026 10:00:05 GMT", local), 0);
  assert.equal(clockSkew("Sat, 14 Nov 2026 10:00:31 GMT", local), 31_000);
  assert.equal(clockSkew("Wed, 11 Nov 2026 10:00:00 GMT", local), -3 * 86_400_000);
  assert.equal(clockSkew(null, local), 0);
  assert.equal(clockSkew("not a date", local), 0);
});

test("the bridge keeps the offset of the last answer's Date header", async () => {
  const fetch: FetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => '{"ok":true,"version":"1"}',
    headers: { get: (n: string) => (n.toLowerCase() === "date" ? new Date(Date.now() + 3 * 86_400_000).toUTCString() : null) },
  });
  const bridge = createHttpBridge({ baseUrl: "http://h", fetch });
  assert.equal(must(bridge.clockOffset)(), 0);
  await bridge.health();
  const off = must(bridge.clockOffset)();
  assert.ok(Math.abs(off - 3 * 86_400_000) < 2000, String(off));
});

test("an answer that is not JSON is `invalid_response`, not an empty value", async () => {
  const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => '{"projects": [{"id": "x", "name": ' });
  const err = await createHttpBridge({ baseUrl: "http://h", fetch })
    .listProjects()
    .catch((e: unknown) => e);
  assert.ok(err instanceof BridgeError && err.code === "invalid_response");
});
