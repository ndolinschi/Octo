import assert from "node:assert/strict";
import test from "node:test";
import { CompletionEngine, Lru, type Cancellation, type CompletionInput, type Fetcher } from "./engine";

const DEBOUNCE = 20;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fetcher that answers after `ms` (or rejects on abort) and records what it was asked and whether it was aborted. */
function fakeFetch(answer: (input: CompletionInput) => string | null, ms = 10) {
  const calls: { input: CompletionInput; aborted: () => boolean }[] = [];
  const fetch: Fetcher = (input, signal) => {
    calls.push({ input, aborted: () => signal.aborted });
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => resolve(answer(input)), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("aborted"));
      });
    });
  };
  return { fetch, calls };
}

const at = (prefix: string, suffix = "\n}"): CompletionInput => ({ path: "src/a.ts", language: "typescript", prefix, suffix });

function token(): Cancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get isCancellationRequested() {
      return cancelled;
    },
    onCancellationRequested(l) {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
    cancel() {
      cancelled = true;
      for (const l of listeners) l();
    },
  };
}

test("waits for the debounce before asking, and asks once for a burst of keystrokes", async () => {
  const { fetch, calls } = fakeFetch(() => "x");
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  const a = engine.suggest(at("const a"));
  const b = engine.suggest(at("const ab"));
  const c = engine.suggest(at("const abc"));
  await sleep(DEBOUNCE / 2);
  assert.equal(calls.length, 0, "nothing is sent inside the debounce");
  assert.deepEqual(await Promise.all([a, b, c]), [null, null, "x"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.prefix, "const abc");
});

test("a newer request aborts the one in flight", async () => {
  const { fetch, calls } = fakeFetch(() => "1", 60);
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  const first = engine.suggest(at("let x"));
  await sleep(DEBOUNCE + 10);
  assert.equal(calls.length, 1, "the first request is in flight");
  const second = engine.suggest(at("let xy"));
  assert.equal(calls[0]?.aborted(), true);
  assert.equal(await first, null);
  assert.equal(await second, "1");
  assert.equal(calls.length, 2);
});

test("Monaco's cancellation token aborts the debounce and the request", async () => {
  const { fetch, calls } = fakeFetch(() => "y", 60);
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  const t1 = token();
  const p1 = engine.suggest(at("a"), t1);
  t1.cancel();
  assert.equal(await p1, null);
  assert.equal(calls.length, 0, "cancelled during the debounce: never sent");
  const t2 = token();
  const p2 = engine.suggest(at("b"), t2);
  await sleep(DEBOUNCE + 10);
  t2.cancel();
  assert.equal(await p2, null);
  assert.equal(calls[0]?.aborted(), true);
});

test("the cache answers a repeated position without a request", async () => {
  const { fetch, calls } = fakeFetch(() => "Value;");
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  assert.equal(await engine.suggest(at("return ")), "Value;");
  assert.equal(await engine.suggest(at("return ")), "Value;");
  assert.equal(calls.length, 1);
});

test("typing the first characters of a suggestion is answered from the cache with the rest", async () => {
  const { fetch, calls } = fakeFetch(() => "items.length;");
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  assert.equal(await engine.suggest(at("return ")), "items.length;");
  assert.equal(await engine.suggest(at("return i")), "tems.length;");
  assert.equal(await engine.suggest(at("return items.")), "length;");
  assert.equal(await engine.suggest(at("return items.length;")), null, "fully typed: nothing left to suggest");
  assert.equal(calls.length, 1);
});

test("typing something else than the suggestion asks again", async () => {
  const { fetch, calls } = fakeFetch((i) => (i.prefix.endsWith("x") ? "yz" : "items;"));
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  await engine.suggest(at("return "));
  assert.equal(await engine.suggest(at("return x")), "yz");
  assert.equal(calls.length, 2);
});

test("a different suffix is a different position", async () => {
  const { fetch, calls } = fakeFetch(() => "a");
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  await engine.suggest(at("x = ", ";\n"));
  await engine.suggest(at("x = ", ")\n"));
  assert.equal(calls.length, 2);
});

test("'nothing to suggest' is cached too", async () => {
  const { fetch, calls } = fakeFetch(() => null);
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE });
  assert.equal(await engine.suggest(at("}")), null);
  assert.equal(await engine.suggest(at("}")), null);
  assert.equal(calls.length, 1);
});

test("busy is reported only while a request is out; errors are reported, aborts are not", async () => {
  const busy: boolean[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const fetch: Fetcher = () => (fail ? Promise.reject(new Error("upstream 502")) : Promise.resolve("ok"));
  const engine = new CompletionEngine({ fetch, debounceMs: DEBOUNCE, onBusy: (b) => busy.push(b), onError: (e) => errors.push(e) });
  assert.equal(await engine.suggest(at("a")), null);
  assert.deepEqual(busy, [true, false]);
  assert.equal(errors.length, 1);
  fail = false;
  const p = engine.suggest(at("b"));
  engine.cancel();
  assert.equal(await p, null);
  assert.equal(errors.length, 1, "an abort is not an error");
});

test("the LRU keeps the 50 most recently used entries", () => {
  const lru = new Lru<number>(3);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  lru.get("a");
  lru.set("d", 4);
  assert.equal(lru.get("b"), undefined, "the least recently used goes first");
  assert.deepEqual(lru.values(), [4, 1, 3]);
  assert.equal(lru.length, 3);
});
