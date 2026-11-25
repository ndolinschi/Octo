import assert from "node:assert/strict";
import test from "node:test";
import type { FetchFn } from "./pairing";
import { pollingEventSource, pollUrlOf } from "./pollingEventSource";

test("the poll URL comes from the event stream URL, without its token", () => {
  assert.equal(pollUrlOf("https://x.trycloudflare.com/v1/projects/p1/events?token=abc"), "https://x.trycloudflare.com/v1/projects/p1/events/poll");
  assert.equal(pollUrlOf("/v1/projects/p1/events"), "/v1/projects/p1/events/poll");
  assert.equal(pollUrlOf("/v1/projects/p1/lsp/sessions/s/events"), null);
});

type Answer = { status: number; body: unknown };

function scripted(answers: Answer[]) {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  let release: () => void = () => undefined;
  const done = new Promise<void>((r) => (release = r));
  const f: FetchFn = (url, init) => {
    urls.push(url);
    headers.push(init?.headers ?? {});
    const a = answers.shift();
    if (!a) {
      release();
      return new Promise(() => undefined); // the last poll stays open
    }
    return Promise.resolve({ ok: a.status < 300, status: a.status, json: () => Promise.resolve(a.body) });
  };
  return { f, urls, headers, done };
}

test("opens, delivers events by type with heartbeats, reopens a gone stream", async () => {
  const s = scripted([
    { status: 200, body: { stream: "ps_1", events: [] } },
    {
      status: 200,
      body: {
        stream: "ps_1",
        events: [
          { type: "message.delta", seq: 1, text: "hi" },
          { type: "turn.finished", seq: 2 },
        ],
      },
    },
    { status: 410, body: { error: { code: "stream_gone" } } },
    { status: 200, body: { stream: "ps_2", events: [] } },
  ]);
  const Ctor = pollingEventSource({ token: "octo_dev_t", fetch: s.f, wait: 5, sleep: () => Promise.resolve() });
  const got: string[] = [];
  let opens = 0;
  const es = new Ctor("https://h/v1/projects/p1/events?token=octo_dev_t");
  es.onopen = () => opens++;
  for (const t of ["message.delta", "turn.finished", "heartbeat"]) es.addEventListener(t, (ev) => got.push(`${t}:${String(ev.data)}`));
  await s.done;
  es.close();
  assert.equal(opens, 2);
  assert.deepEqual(got, [
    "heartbeat:{}",
    'message.delta:{"type":"message.delta","seq":1,"text":"hi"}',
    'turn.finished:{"type":"turn.finished","seq":2}',
    "heartbeat:{}",
    "heartbeat:{}",
  ]);
  assert.equal(s.urls[0], "https://h/v1/projects/p1/events/poll");
  assert.equal(s.urls[1], "https://h/v1/projects/p1/events/poll?stream=ps_1&wait=5");
  assert.equal(s.urls[3], "https://h/v1/projects/p1/events/poll");
  assert.ok(s.urls.every((u) => !u.includes("token=")));
  assert.equal(s.headers[0]?.Authorization, "Bearer octo_dev_t");
  assert.equal(es.readyState, 2);
});

test("a revoked device closes the stream for good", async () => {
  const s = scripted([{ status: 401, body: { error: { code: "device_not_paired" } } }]);
  const Ctor = pollingEventSource({ token: "t", fetch: s.f, sleep: () => Promise.resolve() });
  const es = new Ctor("/v1/projects/p1/events");
  let errors = 0;
  es.onerror = () => errors++;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(es.readyState, 2);
  assert.equal(errors, 1);
  assert.equal(s.urls.length, 1);
});

test("a network failure is retried after a pause", async () => {
  let n = 0;
  const pauses: number[] = [];
  const f: FetchFn = () => {
    n++;
    if (n <= 2) return Promise.reject(new Error("offline"));
    if (n === 3) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stream: "ps", events: [] }) });
    return new Promise(() => undefined);
  };
  const Ctor = pollingEventSource({ token: "t", fetch: f, sleep: (ms) => (pauses.push(ms), Promise.resolve()) });
  const es = new Ctor("/v1/projects/p1/events");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(pauses, [1000, 2000]);
  assert.equal(es.readyState, 1);
  es.close();
});

test("a poll that never answers is abandoned after its deadline and the stream reopens", async () => {
  let n = 0;
  const pauses: number[] = [];
  const f: FetchFn = (_url, init) => {
    n++;
    if (n === 1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stream: "ps", events: [] }) });
    // A stalled tunnel: no answer until the poll's signal gives up on it.
    return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  };
  const Ctor = pollingEventSource({ token: "t", fetch: f, deadlineMs: 20, sleep: (ms) => (pauses.push(ms), Promise.resolve()) });
  const es = new Ctor("/v1/projects/p1/events");
  let errors = 0;
  es.onerror = () => errors++;
  await new Promise((r) => setTimeout(r, 60));
  es.close();
  assert.ok(errors >= 1, "the stalled poll counts as a failure");
  assert.equal(pauses[0], 1000);
  assert.ok(n >= 3, "a new stream was opened after the stalled poll");
});

test("mobile resume cancels backoff sleep immediately and cleans up listeners on close", async () => {
  let n = 0;
  const wake: { fire?: () => void } = {};
  let cleanedUp = false;
  const f: FetchFn = () => {
    n++;
    if (n === 1) return Promise.reject(new Error("offline"));
    if (n === 2) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stream: "ps_ok", events: [] }) });
    return new Promise(() => undefined);
  };
  const Ctor = pollingEventSource({
    token: "t",
    fetch: f,
    wakeTarget: {
      onResume(cb) {
        wake.fire = cb;
        return () => {
          cleanedUp = true;
        };
      },
    },
  });
  const es = new Ctor("/v1/projects/p1/events");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(n, 1, "waiting in 1s backoff sleep");
  assert.equal(es.readyState, 0);
  const t0 = Date.now();
  const fire1 = wake.fire;
  if (!fire1) throw new Error("expected wake listener");
  fire1();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(Date.now() - t0 < 500, "backoff sleep aborted well before 1000ms");
  assert.equal(es.readyState, 1, "reconnected immediately on wake");
  assert.equal(cleanedUp, false);
  es.close();
  assert.equal(cleanedUp, true, "wake listener removed on close");
});

test("mobile resume aborts a stale in-flight poll and reopens without backoff", async () => {
  let n = 0;
  const wake: { fire?: () => void } = {};
  const pauses: number[] = [];
  const f: FetchFn = (_url, init) => {
    n++;
    if (n === 1) {
      return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (n === 2) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ stream: "ps_fresh", events: [] }) });
    return new Promise(() => undefined);
  };
  const Ctor = pollingEventSource({
    token: "t",
    fetch: f,
    deadlineMs: 60_000,
    sleep: (ms) => (pauses.push(ms), Promise.resolve()),
    wakeTarget: {
      onResume(cb) {
        wake.fire = cb;
        return () => undefined;
      },
    },
  });
  const es = new Ctor("/v1/projects/p1/events");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(n, 1);
  const fire2 = wake.fire;
  if (!fire2) throw new Error("expected wake listener");
  fire2();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(es.readyState, 1, "reopened immediately after aborting stale poll");
  assert.deepEqual(pauses, [], "no backoff sleep on wake-triggered reopen");
  es.close();
});
