import { BridgeError } from "./client";
import { isExitInfo } from "./lspChannel";
import type { LspTransport } from "./lspSession";
import type { AgentLoginOptions, AgentLoginSession, AgentLoginState, TerminalExit, TerminalOpenOptions, TerminalSession } from "./types";

export const MAX_TERMINAL_QUEUE = 1024;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function decodeBase64(b64: string): Uint8Array {
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  if (atobFn) {
    const bin = atobFn(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const clean = b64.replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length % 4 === 1) throw new Error("invalid base64");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let pos = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i] ?? "");
    const b = B64.indexOf(clean[i + 1] ?? "");
    const hasC = i + 2 < clean.length;
    const hasD = i + 3 < clean.length;
    const c = hasC ? B64.indexOf(clean[i + 2] ?? "") : -1;
    const d = hasD ? B64.indexOf(clean[i + 3] ?? "") : -1;
    if (a < 0 || b < 0 || (hasC && c < 0) || (hasD && d < 0)) throw new Error("invalid base64");
    out[pos++] = (a << 2) | (b >> 4);
    if (hasC) out[pos++] = ((b & 15) << 4) | (c >> 2);
    if (hasD) out[pos++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, pos);
}

function parseFrame(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function parseLoginCreated(body: unknown): { sessionId: string; command: string; pid: number } {
  const r = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof r.session_id !== "string" || typeof r.pid !== "number") {
    throw new BridgeError(0, "invalid_response", "malformed login session response");
  }
  return { sessionId: r.session_id, command: typeof r.command === "string" ? r.command : "", pid: r.pid };
}

function parseCreated(body: unknown): {
  sessionId: string;
  folder: string;
  cwd: string;
  shell: string;
  pid: number;
} {
  const r = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (
    typeof r.session_id !== "string" ||
    typeof r.folder !== "string" ||
    typeof r.cwd !== "string" ||
    typeof r.shell !== "string" ||
    typeof r.pid !== "number"
  ) {
    throw new BridgeError(0, "invalid_response", "malformed terminal session response");
  }
  return { sessionId: r.session_id, folder: r.folder, cwd: r.cwd, shell: r.shell, pid: r.pid };
}

async function deleteSession(t: LspTransport, path: string): Promise<void> {
  try {
    await t.request("DELETE", path);
  } catch (e) {
    if (!(e instanceof BridgeError && e.status === 404)) throw e;
  }
}

type PtyCreated = { sessionId: string; pid: number };
type PtyCore<C extends PtyCreated> = {
  created: C;
  session: Omit<TerminalSession, "folder" | "cwd" | "shell">;
  /** The event stream, so a caller can listen for frames of its own (a login's `login`). */
  source: ReturnType<LspTransport["openStream"]>;
};

/**
 * What terminals and logins share: POST `collectionPath`, then the session's SSE `/events` (`output`, `exit`),
 * `/input`, `/resize` and DELETE. `parse` validates the start response. `keepStreamAfterExit` (logins) leaves the
 * stream open after `exit`, because the server sends the last `login` check after it and then ends the stream.
 */
async function openPtySession<C extends PtyCreated>(
  t: LspTransport,
  collectionPath: string,
  body: unknown,
  parse: (body: unknown) => C,
  keepStreamAfterExit = false,
): Promise<PtyCore<C>> {
  const created = parse(await t.request("POST", collectionPath, body));
  const sessionPath = `${collectionPath}/${encodeURIComponent(created.sessionId)}`;

  const outputListeners = new Set<(data: Uint8Array) => void>();
  const exitListeners = new Set<(info: TerminalExit) => void>();
  let queue: Uint8Array[] = [];
  let buffering = true;
  let exited: TerminalExit | undefined;

  let source: ReturnType<LspTransport["openStream"]>;
  try {
    source = t.openStream(`${sessionPath}/events`);
  } catch (e) {
    await deleteSession(t, sessionPath).catch(() => undefined);
    throw e;
  }

  let closing: Promise<void> | undefined;

  const emitExit = (info: TerminalExit) => {
    if (exited) return;
    exited = info;
    buffering = false;
    queue = [];
    if (!keepStreamAfterExit) {
      source.onerror = null;
      source.close();
    }
    exitListeners.forEach((cb) => cb(info));
  };

  source.addEventListener("output", (ev) => {
    if (exited || closing) return;
    const parsed = parseFrame(ev.data);
    if (typeof parsed !== "object" || parsed === null) return;
    const data = (parsed as Record<string, unknown>).data;
    if (typeof data !== "string" || data.length === 0) return;
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      return;
    }
    if (buffering) {
      queue.push(bytes);
      if (queue.length > MAX_TERMINAL_QUEUE) queue.shift();
    } else {
      outputListeners.forEach((cb) => cb(bytes));
    }
  });

  source.addEventListener("exit", (ev) => {
    const info = parseFrame(ev.data);
    if (!isExitInfo(info)) return;
    emitExit(info);
  });

  source.onerror = () => {
    // After `exit` the server's end of the stream is the end of the session: EventSource would reconnect on that
    // EOF (readyState 0), so close it here.
    if (exited) {
      source.onerror = null;
      source.close();
      return;
    }
    if (source.readyState === 2 && !closing) {
      emitExit({ code: -1, reason: "stream_closed" });
    }
  };

  const session: Omit<TerminalSession, "folder" | "cwd" | "shell"> = {
    sessionId: created.sessionId,
    pid: created.pid,
    async write(data) {
      if (closing || exited) throw new BridgeError(0, "session_closed", "terminal session closed");
      await t.request("POST", `${sessionPath}/input`, { data });
    },
    async resize(cols, rows) {
      if (closing || exited) return;
      await t.request("POST", `${sessionPath}/resize`, { cols, rows });
    },
    onOutput(cb) {
      outputListeners.add(cb);
      if (buffering) {
        buffering = false;
        const pending = queue;
        queue = [];
        pending.forEach(cb);
      }
      return () => void outputListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      if (exited) cb(exited);
      return () => void exitListeners.delete(cb);
    },
    close() {
      if (!closing) {
        buffering = false;
        queue = [];
        source.onerror = null;
        source.close();
        closing = deleteSession(t, sessionPath);
      }
      return closing;
    },
  };
  return { created, session, source };
}

export async function openTerminalSession(t: LspTransport, projectPath: string, options?: TerminalOpenOptions): Promise<TerminalSession> {
  const { created, session } = await openPtySession(t, `${projectPath}/terminals`, options ?? {}, parseCreated);
  return { ...session, folder: created.folder, cwd: created.cwd, shell: created.shell };
}

/** `POST /v1/providers/{id}/login`: a PTY that logs an agent account in; `login` frames carry the recheck's result. */
export async function openLoginSession(t: LspTransport, providerId: string, options?: AgentLoginOptions): Promise<AgentLoginSession> {
  const { created, session, source } = await openPtySession(t, `/v1/providers/${encodeURIComponent(providerId)}/login`, options ?? {}, parseLoginCreated, true);
  const loginListeners = new Set<(state: AgentLoginState) => void>();
  let last: AgentLoginState | undefined;
  source.addEventListener("login", (ev) => {
    const parsed = parseFrame(ev.data);
    const state = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).state : undefined;
    if (state !== "ok" && state !== "not_logged_in" && state !== "unchecked") return;
    last = state;
    loginListeners.forEach((cb) => cb(state));
  });
  return {
    ...session,
    command: created.command,
    onLogin(cb) {
      loginListeners.add(cb);
      if (last !== undefined) cb(last);
      return () => void loginListeners.delete(cb);
    },
  };
}
