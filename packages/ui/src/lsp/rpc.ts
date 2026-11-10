import type { LanguageServerSession } from "@octo/agent-client";

/** The part of Monaco's CancellationToken the client needs. */
export type Cancellation = { isCancellationRequested: boolean; onCancellationRequested(cb: () => void): { dispose(): void } };

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** JSON-RPC error codes the client produces itself. */
const TIMEOUT = -32001;
const CLOSED = -32002;
const METHOD_NOT_FOUND = -32601;

type Pending = { resolve(v: unknown): void; reject(e: unknown): void; timer: number; cancel?: { dispose(): void } };

type Incoming = { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

/**
 * JSON-RPC 2.0 over a language server session: numbered requests with a timeout and LSP
 * cancellation (`$/cancelRequest`), notifications, and answers to the few requests servers send
 * clients (configuration, capability registration, progress) — anything else is "method not found".
 */
export class Rpc {
  private next = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly session: LanguageServerSession,
    private readonly handlers: {
      notification(method: string, params: unknown): void;
      /** Folders for `workspace/workspaceFolders`. */
      folders(): { uri: string; name: string }[];
    },
  ) {
    this.unsubscribe = session.onMessage((m) => this.receive(m));
  }

  request<T>(method: string, params: unknown, options: { timeoutMs?: number; token?: Cancellation } = {}): Promise<T | null> {
    if (this.closed) return Promise.reject(new RpcError(CLOSED, "language server session closed"));
    const token = options.token;
    if (token?.isCancellationRequested) return Promise.resolve(null);
    const id = this.next++;
    return new Promise<T | null>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: window.setTimeout(() => this.settle(id, new RpcError(TIMEOUT, `${method} timed out`)), options.timeoutMs ?? 5_000),
      };
      // A cancelled request resolves to nothing at once; the server is told so it can stop.
      entry.cancel = token?.onCancellationRequested(() => {
        if (!this.pending.has(id)) return;
        this.settle(id, null, true);
        this.notify("$/cancelRequest", { id });
      });
      this.pending.set(id, entry);
      this.session.send({ jsonrpc: "2.0", id, method, params }).catch((e: unknown) => this.settle(id, e));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.session.send({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  /** Rejects whatever is in flight; the session itself is closed by its owner. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const id of [...this.pending.keys()]) this.settle(id, new RpcError(CLOSED, "language server session closed"));
  }

  private settle(id: number, outcome: unknown, ok = false) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    window.clearTimeout(p.timer);
    p.cancel?.dispose();
    if (ok) p.resolve(outcome);
    else p.reject(outcome);
  }

  private receive(raw: unknown) {
    if (typeof raw !== "object" || raw === null) return;
    const m = raw as Incoming;
    if (m.method === undefined) {
      if (typeof m.id !== "number") return;
      if (m.error) this.settle(m.id, new RpcError(m.error.code ?? 0, m.error.message ?? "language server error"));
      else this.settle(m.id, m.result ?? null, true);
      return;
    }
    if (m.id === undefined || m.id === null) {
      this.handlers.notification(m.method, m.params);
      return;
    }
    this.answer(m.id, m.method, m.params);
  }

  private answer(id: number | string, method: string, params: unknown) {
    const respond = (body: { result: unknown } | { error: { code: number; message: string } }) => {
      if (!this.closed) this.session.send({ jsonrpc: "2.0", id, ...body }).catch(() => undefined);
    };
    switch (method) {
      case "workspace/configuration": {
        const items = (params as { items?: unknown[] } | null)?.items;
        return respond({ result: Array.isArray(items) ? items.map(() => null) : [] });
      }
      case "workspace/workspaceFolders":
        return respond({ result: this.handlers.folders() });
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "window/showMessageRequest":
        return respond({ result: null });
      default:
        return respond({ error: { code: METHOD_NOT_FOUND, message: `method not found: ${method}` } });
    }
  }
}
