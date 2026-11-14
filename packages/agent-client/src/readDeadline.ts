import type { AbortSignalLike, FetchLike } from "./client";

/**
 * P2-4: how long a read may hold its connection. A read the service takes and never answers (a hung proxy or tunnel, a stuck
 * handler) is abandoned after this, so it gives its connection back: the browser keeps six per host, and a handful of hung
 * reads would hold every later request (the health check included) in its queue for good. The UI's own deadline (10 s)
 * says "didn't answer in time" first.
 */
export const READ_ABORT_MS = 12_000;

/** What `abortingReads` needs from the platform (the global `AbortController` and timers by default; tests pass fakes). */
export type AbortPlatform = {
  controller(): { signal: AbortSignalLike; abort(): void };
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

type Globals = {
  AbortController?: new () => { signal: AbortSignalLike; abort(): void };
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
};

/** The platform's own; null where it has no `AbortController` (reads then go out as they are). */
function globalPlatform(): AbortPlatform | null {
  // This package builds without the DOM lib; both hosts (a browser, a webview) have these globals.
  const g = globalThis as Globals;
  const Ctl = g.AbortController;
  if (!Ctl || !g.setTimeout || !g.clearTimeout) return null;
  // Called on `globalThis` (a detached timer function can throw "Illegal invocation" in some engines).
  return { controller: () => new Ctl(), setTimeout: (fn, ms) => g.setTimeout?.(fn, ms), clearTimeout: (id) => g.clearTimeout?.(id) };
}

/**
 * `fetch`, with every GET that has no signal of its own aborted after `ms`. Untouched: sends (they keep their own timeout and
 * read-back), requests with their own signal, and long polls (`…/events/poll`, which wait up to 25 s by design; the poller
 * passes its own signal and deadline).
 */
export function abortingReads(fetch: FetchLike, ms: number = READ_ABORT_MS, platform: AbortPlatform | null = globalPlatform()): FetchLike {
  if (!platform) return fetch;
  return (url, init) => {
    if ((init?.method ?? "GET") !== "GET" || init?.signal || url.includes("/events/poll")) return fetch(url, init);
    const ctl = platform.controller();
    const id = platform.setTimeout(() => ctl.abort(), ms);
    return fetch(url, { ...init, signal: ctl.signal }).finally(() => platform.clearTimeout(id));
  };
}
