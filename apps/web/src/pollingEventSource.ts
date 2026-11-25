import type { EventSourceCtor, EventSourceLike } from "@octo/agent-client";
import type { FetchFn } from "./pairing";

/**
 * The project event stream over long polls (spec 2026-11-14-remote-access-mobile-design.md, section 4): Cloudflare's quick
 * tunnels do not carry Server-Sent Events, so the harness's tunnel listener offers `GET …/events/poll`. This class is the
 * `EventSourceLike` the agent-client already accepts as an option, so the client and the UI are unchanged.
 *
 * - The URL the client builds (`…/v1/projects/{pid}/events?token=…`) is read for its project; the token in it is
 *   dropped (the tunnel refuses tokens in addresses) and sent as a header instead.
 * - Opening a stream fires `open` (the client re-reads what it may have missed); every answered poll fires `heartbeat`
 *   (the client's stale-stream watchdog); each event is dispatched under its `type` with its JSON as `data`.
 * - `410 stream_gone`: a new stream (and `open` again). `401`: closed for good (`readyState` 2); the page's fetch guard
 *   has already sent the phone back to pairing. A network failure: retry after 1, 2, 4 … 15 s.
 */
export type PollingOptions = {
  token: string;
  fetch: FetchFn;
  /** Seconds a poll may wait for an event (the harness caps it at 25; Cloudflare ends silent requests near 100 s). */
  wait?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * P2-4: how long one poll may take before it is abandoned (a tunnel that stalls must not hold the stream for good); then it
   * counts as a network failure and the stream reopens. Default: `wait` + 20 s.
   */
  deadlineMs?: number;
  /** Optional wake-up hook for tests; defaults to browser `document` (`visibilitychange`) and `window` (`online`). */
  wakeTarget?: {
    onResume(cb: () => void): () => void;
  };
};

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function subscribeWake(onWake: () => void, custom?: PollingOptions["wakeTarget"]): () => void {
  if (custom) return custom.onResume(onWake);
  const cleanups: (() => void)[] = [];
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    const onVisibility = () => {
      if (document.visibilityState === "visible") onWake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    cleanups.push(() => document.removeEventListener("visibilitychange", onVisibility));
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("online", onWake);
    cleanups.push(() => window.removeEventListener("online", onWake));
  }
  return () => {
    for (const fn of cleanups) fn();
  };
}

/** `/v1/projects/{pid}/events` of an EventSource URL, as the poll URL; null for any other stream. */
export function pollUrlOf(url: string): string | null {
  const m = /^(.*\/v1\/projects\/[^/?#]+\/events)(?:\?.*)?$/.exec(url);
  return m?.[1] ? `${m[1]}/poll` : null;
}

type Listener = (ev: { data?: unknown }) => void;

export function pollingEventSource(opts: PollingOptions): EventSourceCtor {
  const sleep = opts.sleep ?? defaultSleep;
  const wait = opts.wait ?? 20;
  const deadlineMs = opts.deadlineMs ?? (wait + 20) * 1000;
  return class PollingEventSource implements EventSourceLike {
    readyState = 0;
    onopen: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    private readonly listeners = new Map<string, Listener[]>();
    private readonly abort = new AbortController();
    private stepAbort: AbortController | null = null;
    private unlistenWake: (() => void) | null = null;
    private woke = false;
    private closed = false;

    constructor(url: string) {
      const poll = pollUrlOf(url);
      if (!poll) {
        this.readyState = 2;
        queueMicrotask(() => this.onerror?.({ type: "error" }));
        return;
      }
      this.unlistenWake = subscribeWake(() => this.wake(), opts.wakeTarget);
      void this.run(poll);
    }

    addEventListener(type: string, listener: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    close(): void {
      this.closed = true;
      this.readyState = 2;
      this.cleanupWake();
      this.abort.abort();
      this.stepAbort?.abort();
    }

    private cleanupWake(): void {
      this.unlistenWake?.();
      this.unlistenWake = null;
    }

    /** Wakes mobile clients immediately on `visibilitychange` (visible) or `online`: cancels backoff or a stale poll. */
    private wake(): void {
      if (this.closed) return;
      this.woke = true;
      this.stepAbort?.abort();
    }

    /** Read through a method: `close()` may run while a poll is awaited, which narrowing cannot see. */
    private isClosed(): boolean {
      return this.closed;
    }

    private emit(type: string, data: string): void {
      for (const l of this.listeners.get(type) ?? []) l({ data });
    }

    private async get(url: string): Promise<{ status: number; body: unknown }> {
      // This poll's own signal: aborted by `close()`, by `wake()`, or by its deadline.
      const one = new AbortController();
      this.stepAbort = one;
      const stop = () => one.abort();
      this.abort.signal.addEventListener("abort", stop);
      const timer = setTimeout(stop, deadlineMs);
      one.signal.addEventListener("abort", () => clearTimeout(timer));
      let res: Awaited<ReturnType<FetchFn>>;
      try {
        res = await opts.fetch(url, { headers: { Authorization: `Bearer ${opts.token}` }, signal: one.signal });
      } finally {
        clearTimeout(timer);
        this.abort.signal.removeEventListener("abort", stop);
        if (this.stepAbort === one) this.stepAbort = null;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null; // an unreadable answer counts as an empty poll; the next one tries again
      }
      return { status: res.status, body };
    }

    private async backoffSleep(ms: number): Promise<void> {
      const backoff = new AbortController();
      this.stepAbort = backoff;
      const stop = () => backoff.abort();
      this.abort.signal.addEventListener("abort", stop);
      try {
        await sleep(ms, backoff.signal);
      } finally {
        this.abort.signal.removeEventListener("abort", stop);
        if (this.stepAbort === backoff) this.stepAbort = null;
      }
    }

    private async run(poll: string): Promise<void> {
      let stream: string | null = null;
      let failures = 0;
      try {
        while (!this.closed) {
          try {
            this.woke = false;
            const url: string = stream ? `${poll}?stream=${encodeURIComponent(stream)}&wait=${String(wait)}` : poll;
            const { status, body } = await this.get(url);
            if (this.isClosed()) return;
            if (status === 401 || status === 403) {
              this.readyState = 2;
              this.onerror?.({ type: "error", status });
              return;
            }
            if (status === 410) {
              stream = null;
              this.readyState = 0;
              continue;
            }
            if (status !== 200 || !isPoll(body)) throw new Error(`poll answered ${String(status)}`);
            failures = 0;
            if (!stream) {
              stream = body.stream;
              this.readyState = 1;
              this.onopen?.({ type: "open" });
            }
            for (const ev of body.events) {
              if (this.isClosed()) return;
              if (isRecord(ev) && typeof ev.type === "string") this.emit(ev.type, JSON.stringify(ev));
            }
            this.emit("heartbeat", "{}");
          } catch {
            if (this.isClosed()) return;
            if (this.woke) {
              this.woke = false;
              failures = 0;
              stream = null;
              this.readyState = 0;
              continue;
            }
            failures++;
            stream = null;
            this.readyState = 0;
            this.onerror?.({ type: "error" });
            await this.backoffSleep(Math.min(15_000, 1000 * 2 ** Math.min(failures - 1, 4)));
            if (this.woke) {
              this.woke = false;
              failures = 0;
            }
          }
        }
      } finally {
        this.cleanupWake();
      }
    }
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPoll(v: unknown): v is { stream: string; events: unknown[] } {
  return isRecord(v) && typeof v.stream === "string" && Array.isArray(v.events);
}
