import type { BinaryFetchLike, FetchLike } from "@octo/agent-client";
import { isDeviceGone, type FetchFn } from "./pairing";

type Init = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: unknown };

/**
 * The page's `fetch` for the bridge client and the event poller: unchanged, except that an answer saying this phone's
 * token is no longer any good (`401 device_not_paired` / `device_expired`: revoked on the computer, expired, or unknown
 * after a new tunnel URL) calls `onGone` once, which sends the page back to pairing.
 */
export function guardedFetch(base: typeof globalThis.fetch, onGone: () => void): { fetch: FetchLike; fetchBinary: BinaryFetchLike; poll: FetchFn } {
  let fired = false;
  const run = async (url: string, init: Init | undefined): Promise<Response> => {
    const req: RequestInit = {};
    if (init?.method) req.method = init.method;
    if (init?.headers) req.headers = init.headers;
    // A view onto its own ArrayBuffer: what `BodyInit` accepts.
    if (init?.body !== undefined) req.body = typeof init.body === "string" ? init.body : init.body.slice();
    if (init?.signal instanceof AbortSignal) req.signal = init.signal;
    const res = await base(url, req);
    if (res.status === 401 && !fired) {
      const code = await codeOf(res.clone());
      if (isDeviceGone(res.status, code)) {
        fired = true;
        onGone();
      }
    }
    return res;
  };
  return { fetch: run, fetchBinary: run, poll: run };
}

async function codeOf(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      const e = body.error;
      if (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string") return e.code;
    }
  } catch {
    // Not the harness's error shape: not a device refusal.
  }
  return undefined;
}
