import assert from "node:assert/strict";
import test from "node:test";
import type { AbortSignalLike, FetchLike } from "./client";
import { abortingReads, type AbortPlatform } from "./readDeadline";

type Seen = { url: string; signal: AbortSignalLike | undefined };

function fakes() {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const aborted: boolean[] = [];
  const platform: AbortPlatform = {
    controller() {
      const i = aborted.push(false) - 1;
      return {
        signal: {
          get aborted() {
            return aborted[i] ?? false;
          },
        },
        abort: () => void (aborted[i] = true),
      };
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
    clearTimeout: (id) => {
      const t = typeof id === "number" ? timers[id] : undefined;
      if (t) t.cleared = true;
    },
  };
  const seen: Seen[] = [];
  let settle: (() => void) | undefined;
  const fetch: FetchLike = (url, init) => {
    seen.push({ url, signal: init?.signal });
    return new Promise((resolve) => {
      settle = () => resolve({ ok: true, status: 200, text: async () => "{}" });
    });
  };
  return { platform, timers, seen, fetch, settle: () => settle?.() };
}

test("a GET without its own signal is aborted after the deadline", () => {
  const f = fakes();
  void abortingReads(f.fetch, 12_000, f.platform)("http://h/v1/projects");
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0]?.ms, 12_000);
  assert.equal(f.seen[0]?.signal?.aborted, false);
  f.timers[0]?.fn();
  assert.equal(f.seen[0]?.signal?.aborted, true);
});

test("the timer stays active until the body read settles, and clears once text() resolves", async () => {
  const f = fakes();
  const p = abortingReads(f.fetch, 12_000, f.platform)("http://h/health");
  f.settle();
  const res = await p;
  assert.equal(f.timers[0]?.cleared, false, "timer remains armed while body has not finished reading");
  assert.equal(await res.text(), "{}");
  assert.equal(f.timers[0]?.cleared, true);
});

test("a hung body read is aborted when the deadline expires, and arrayBuffer() clears the timer", async () => {
  const f = fakes();
  let finishBody: (() => void) | undefined;
  const fetchWithBody: FetchLike = (url, init) => {
    f.seen.push({ url, signal: init?.signal });
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>((resolve) => {
          finishBody = () => resolve("ok");
        }),
      arrayBuffer: async () => new ArrayBuffer(4),
    });
  };
  const read = abortingReads(fetchWithBody, 12_000, f.platform);
  const res1 = await read("http://h/slow-body");
  const textPromise = res1.text();
  assert.equal(f.timers[0]?.cleared, false);
  f.timers[0]?.fn();
  assert.equal(f.seen[0]?.signal?.aborted, true);
  finishBody?.();
  await textPromise;
  assert.equal(f.timers[0]?.cleared, true);

  const res2 = await read("http://h/bin");
  assert.equal(f.timers[1]?.cleared, false);
  await res2.arrayBuffer?.();
  assert.equal(f.timers[1]?.cleared, true);
});

test("the timer is cleared when fetch itself rejects", async () => {
  const f = fakes();
  const failing: FetchLike = async () => {
    throw new Error("boom");
  };
  await assert.rejects(abortingReads(failing, 12_000, f.platform)("http://h/fail"), (e: unknown) => e instanceof Error && e.message === "boom");
  assert.equal(f.timers[0]?.cleared, true);
});

test("sends, reads with their own signal and long polls go out untouched", () => {
  const f = fakes();
  const read = abortingReads(f.fetch, 12_000, f.platform);
  const own = { aborted: false };
  void read("http://h/v1/projects", { method: "POST", body: "{}" });
  void read("http://h/v1/projects", { signal: own });
  void read("http://h/v1/projects/p1/events/poll?stream=s&wait=20");
  assert.equal(f.timers.length, 0);
  assert.equal(f.seen[0]?.signal, undefined);
  assert.equal(f.seen[1]?.signal, own);
  assert.equal(f.seen[2]?.signal, undefined);
});

test("without a platform the fetch is returned as it is", () => {
  const f = fakes();
  assert.equal(abortingReads(f.fetch, 12_000, null), f.fetch);
});
