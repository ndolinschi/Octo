/**
 * The client side of inline completion (design decision 5), without Monaco: a 120 ms debounce, one request in flight
 * (a newer one aborts it), and a 50-entry LRU that answers repeats and "typed the first characters of the suggestion"
 * without a request.
 */

export const DEBOUNCE_MS = 120;
export const CACHE_SIZE = 50;
/** How much of the prefix and suffix identify a position for the cache (design: "prefix tail + suffix head"). */
const PREFIX_KEY = 400;
const SUFFIX_KEY = 200;

export type CompletionInput = { path: string; folder?: string; language?: string; prefix: string; suffix: string };

/** One request to the harness; resolves `null` for "nothing to suggest". Must reject (or resolve) when `signal` aborts. */
export type Fetcher = (input: CompletionInput, signal: AbortSignal) => Promise<string | null>;

/** Monaco's CancellationToken, structurally (so the engine is testable without Monaco). */
export type Cancellation = { readonly isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } };

type Entry = { path: string; tail: string; head: string; text: string | null };

/** Small LRU on a Map (insertion order = recency). */
export class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly size: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.size) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }
  /** Most recent first. */
  values(): V[] {
    return [...this.map.values()].reverse();
  }
  get length(): number {
    return this.map.size;
  }
}

function keyOf(path: string, tail: string, head: string): string {
  return JSON.stringify([path, tail, head]);
}

/**
 * A cached answer for `input`: the exact position, or a position reached by typing the first characters of a cached
 * suggestion (the rest of it is the answer; fully typed is `null`). `undefined` is a miss.
 */
export function lookup(cache: Lru<Entry>, input: CompletionInput): string | null | undefined {
  const tail = input.prefix.slice(-PREFIX_KEY);
  const head = input.suffix.slice(0, SUFFIX_KEY);
  const exact = cache.get(keyOf(input.path, tail, head));
  if (exact) return exact.text;
  for (const e of cache.values()) {
    if (e.text === null || e.path !== input.path || e.head !== head) continue;
    const max = Math.min(e.text.length, input.prefix.length);
    for (let typed = 1; typed <= max; typed++) {
      const end = input.prefix.length - typed;
      if (!e.text.startsWith(input.prefix.slice(end))) continue;
      if (!input.prefix.slice(0, end).endsWith(e.tail)) continue;
      return typed === e.text.length ? null : e.text.slice(typed);
    }
  }
  return undefined;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");
}

/** Resolves after `ms`, or rejects at once when `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const id = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type EngineOptions = {
  fetch: Fetcher;
  debounceMs?: number;
  cacheSize?: number;
  /** True from the moment a request is sent until it answers (not during the debounce, not for cache hits). */
  onBusy?(busy: boolean): void;
  /** A request failed (not an abort). The caller decides whether completion pauses. */
  onError?(error: unknown): void;
};

export class CompletionEngine {
  private readonly cache: Lru<Entry>;
  private current: AbortController | null = null;
  private busy = false;
  /** Requests actually sent (for tests and the demo's trace). */
  sent = 0;

  constructor(private readonly opts: EngineOptions) {
    this.cache = new Lru<Entry>(opts.cacheSize ?? CACHE_SIZE);
  }

  private setBusy(busy: boolean) {
    if (busy === this.busy) return;
    this.busy = busy;
    this.opts.onBusy?.(busy);
  }

  /** Aborts whatever is waiting or in flight (a newer keystroke, the editor going away). */
  cancel(): void {
    this.current?.abort();
    this.current = null;
    this.setBusy(false);
  }

  /**
   * The suggestion for a cursor position: from the cache, else after the debounce from one request. A newer call
   * aborts this one (it resolves `null`), as does `token`.
   */
  async suggest(input: CompletionInput, token?: Cancellation): Promise<string | null> {
    this.current?.abort();
    this.current = null;
    const hit = lookup(this.cache, input);
    if (hit !== undefined) {
      this.setBusy(false);
      return hit;
    }
    const controller = new AbortController();
    this.current = controller;
    const sub = token?.onCancellationRequested(() => controller.abort());
    if (token?.isCancellationRequested) controller.abort();
    try {
      await wait(this.opts.debounceMs ?? DEBOUNCE_MS, controller.signal);
      this.setBusy(true);
      this.sent++;
      const text = await this.opts.fetch(input, controller.signal);
      if (controller.signal.aborted) return null;
      const clean = text === null || text === "" ? null : text;
      this.cache.set(keyOf(input.path, input.prefix.slice(-PREFIX_KEY), input.suffix.slice(0, SUFFIX_KEY)), {
        path: input.path,
        tail: input.prefix.slice(-PREFIX_KEY),
        head: input.suffix.slice(0, SUFFIX_KEY),
        text: clean,
      });
      return clean;
    } catch (e) {
      if (!controller.signal.aborted) this.opts.onError?.(e);
      return null;
    } finally {
      sub?.dispose();
      if (this.current === controller) {
        this.current = null;
        this.setBusy(false);
      }
    }
  }
}
