/**
 * The phone's side of pairing (spec 2026-11-14-remote-access-mobile-design.md, section 5): read a code from the address,
 * claim it, keep the device token, ask the harness what this device is. Pure: `fetch` and the storage come in as arguments.
 */

/** Where the device token is kept: `localStorage` of the tunnel's origin (a new quick-tunnel URL is a new origin). */
export const TOKEN_KEY = "octo.remote.device";

export type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

export type DeviceStatus = "pending" | "active";
export type Me = { device_id: string; name: string; status: DeviceStatus; read_only: boolean; permissions: string[] };
export type Claimed = { device_id: string; name: string; token: string; status: DeviceStatus };

/** A refusal in the harness's error shape, with the person's words. */
export class PairingError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string;
  constructor(status: number, code: string, message: string, hint = "") {
    super(message);
    this.name = "PairingError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** The codes after which this phone has to pair again (its token is gone or no good). */
const GONE = new Set(["device_not_paired", "device_expired"]);

/** True when an answer means the stored token is no longer any good: the phone must pair again. */
export function isDeviceGone(status: number, code: string | undefined): boolean {
  return status === 401 && code !== undefined && GONE.has(code);
}

/** The pairing code a QR link carried (`#pair=ABCD1234`), or null. */
export function codeFromHash(hash: string): string | null {
  const m = /(?:^#|&)pair=([0-9A-Za-z-]{4,16})(?:&|$)/.exec(hash);
  return m?.[1] ? formatCode(m[1]) : null;
}

/** A typed code as the computer shows it: upper case, two groups of four. */
export function formatCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

/** A default name for this device from its user agent; the person can change it. */
export function deviceNameFromUA(ua: string): string {
  if (ua.includes("iPhone")) return "iPhone";
  if (ua.includes("iPad") || (ua.includes("Macintosh") && ua.includes("Mobile"))) return "iPad";
  if (ua.includes("Android")) return ua.includes("Mobile") ? "Android phone" : "Android tablet";
  if (ua.includes("Macintosh")) return "Mac browser";
  if (ua.includes("Windows")) return "Windows browser";
  if (ua.includes("Linux")) return "Linux browser";
  return "Browser";
}

export function loadToken(storage: StorageLike | null): string | null {
  try {
    const t = storage?.getItem(TOKEN_KEY) ?? null;
    return t?.startsWith("octo_dev_") ? t : null;
  } catch {
    return null;
  }
}

export function saveToken(storage: StorageLike | null, token: string): void {
  try {
    storage?.setItem(TOKEN_KEY, token);
  } catch {
    // Private mode: the token lives for this page only; the phone pairs again next time.
  }
}

export function clearToken(storage: StorageLike | null): void {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function errorOf(res: FetchResponse): Promise<PairingError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const e = isRecord(body) && isRecord(body.error) ? body.error : {};
  const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
  return new PairingError(res.status, str(e.code, "http_error"), str(e.message, `The computer answered ${String(res.status)}.`), str(e.hint, ""));
}

async function call<T>(fetch: FetchFn, url: string, init: Parameters<FetchFn>[1]): Promise<T> {
  let res: FetchResponse;
  try {
    res = await fetch(url, init);
  } catch {
    throw new PairingError(0, "network_error", "Your computer cannot be reached.", "Check that Octo is running there and remote access is on.");
  }
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as T;
}

/** POST /pair/claim: trades the code for a device token (pending until the computer allows it). */
export function claim(fetch: FetchFn, base: string, code: string, name: string): Promise<Claimed> {
  return call<Claimed>(fetch, `${base}/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: formatCode(code), name: name.trim() }),
  });
}

/** GET /pair/me: what this device is now (pending or active) and may do. */
export function whoAmI(fetch: FetchFn, base: string, token: string, signal?: AbortSignal): Promise<Me> {
  return call<Me>(fetch, `${base}/pair/me`, { headers: { Authorization: `Bearer ${token}` }, ...(signal ? { signal } : {}) });
}

/** What the page shows. */
export type Phase =
  | { kind: "checking" }
  | { kind: "pair"; code: string; notice: string | null }
  | { kind: "waiting"; token: string; name: string }
  | { kind: "ready"; token: string; me: Me };

export const NOTICE_DISCONNECTED = "This phone was disconnected on your computer. Pair it again with a new code.";
export const NOTICE_DENIED = "Your computer did not allow this phone. Ask it for a new code to try again.";

/**
 * The first phase from what is stored and what the harness says about it. A stored token the harness does not know any
 * more (revoked, expired, or a new quick-tunnel URL that lost the storage) leads to the pairing screen with the notice.
 */
export async function startPhase(fetch: FetchFn, base: string, storage: StorageLike | null, hashCode: string | null): Promise<Phase> {
  const token = loadToken(storage);
  if (!token) return { kind: "pair", code: hashCode ?? "", notice: null };
  try {
    const me = await whoAmI(fetch, base, token);
    return me.status === "active" ? { kind: "ready", token, me } : { kind: "waiting", token, name: me.name };
  } catch (e) {
    if (e instanceof PairingError && isDeviceGone(e.status, e.code)) {
      clearToken(storage);
      return { kind: "pair", code: hashCode ?? "", notice: NOTICE_DISCONNECTED };
    }
    throw e;
  }
}
