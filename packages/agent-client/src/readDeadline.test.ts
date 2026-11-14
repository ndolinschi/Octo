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

test("the timer is cleared when the read answers", async () => {
  const f = fakes();
  const p = abortingReads(f.fetch, 12_000, f.platform)("http://h/health");
  f.settle();
  await p;
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
