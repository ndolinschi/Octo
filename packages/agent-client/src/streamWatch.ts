import { BridgeError, retryDelay, type StreamHandle, type TimersLike } from "./client";

export function globalTimers(): TimersLike {
  const g = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  return {
    // Under Node a watchdog timer must not keep the process alive (`unref`); a browser's timer id is a number.
    setTimeout: (fn, ms) => {
      const id = g.setTimeout(fn, ms) as { unref?(): void };
      id.unref?.();
      return id;
    },
    clearTimeout: (id) => g.clearTimeout(id),
    now: () => Date.now(),
  };
}

/**
 * The harness sends a `heartbeat` event every 15 s. A stream that carried nothing for this long (two heartbeats missed) is
 * half-open: it is closed and opened again, and the reopen's `onOpen` is the caller's cue to re-read the project.
 */
export const STREAM_STALE_MS = 35_000;
/** How often the watchdog looks at the stream (it sends nothing; the cost is one timer). */
const STREAM_CHECK_MS = 5_000;

function closeSource(h: StreamHandle): void {
  const s = h.source;
  if (!s) return;
  s.onopen = null;
  s.onerror = null;
  s.close();
}

/**
 * The event stream's watchdog (A16, A11): a stream silent for `staleMs` (the harness sends a heartbeat every 15 s) is
 * closed and opened again; one EventSource closed for good (a refused connection) is opened again after 1 s, 2 s, 4 s …
 * 10 s. Returns the stop.
 */
export function watchStream(
  h: StreamHandle,
  onError: ((e: unknown) => void) | undefined,
  given: TimersLike | undefined,
  staleMs = STREAM_STALE_MS,
): () => void {
  const timers = given ?? globalTimers();
  let retryAt = 0;
  let fails = 0;
  let timer: unknown;
  let stopped = false;
  const watch = () => {
    timers.clearTimeout(timer);
    if (stopped) return;
    const now = timers.now();
    // Refused opens in a row set the backoff; an open stream ends the run.
    if (h.source?.readyState === 1) fails = 0;
    if (!h.source && now >= retryAt) h.open();
    else if (h.source && now - h.seen > staleMs) {
      closeSource(h);
      onError?.(new BridgeError(0, "stream_stale", "the event stream went quiet"));
      h.open();
    }
    timer = timers.setTimeout(watch, h.source ? STREAM_CHECK_MS : retryAt - now);
  };
  h.refused = () => {
    closeSource(h);
    h.source = null;
    retryAt = timers.now() + retryDelay((fails += 1), 10_000);
    watch();
  };
  if (h.source?.readyState === 2) h.refused();
  else watch();
  return () => {
    stopped = true;
    timers.clearTimeout(timer);
    delete h.refused;
  };
}
