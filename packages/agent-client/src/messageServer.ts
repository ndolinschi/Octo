import { BridgeError, type Bridge } from "./client";
import type { LanguageServerSession } from "./types";
import {
  isClientMessage,
  type ClientMessage,
  type HostMessage,
  type BridgeMethod,
  type MessagePortLike,
  type ResultMessage,
  type Theme,
  type WireError,
  isBridgeMethod,
} from "./messageProtocol";

export type ServeBridgeOptions = {
  onHost?(action: string, args: unknown[]): unknown;
};

export type BridgeServer = { setTheme(theme: Theme): void; dispose(): void };

function toWireError(err: unknown): WireError {
  if (err instanceof BridgeError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.fields ? { fields: { ...err.fields } } : {}),
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
      ...(err.action !== undefined ? { action: err.action } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...(err.command !== undefined ? { command: err.command } : {}),
      ...(err.provider !== undefined ? { provider: err.provider } : {}),
      ...(err.reason !== undefined ? { reason: err.reason } : {}),
      ...(err.can_force !== undefined ? { can_force: err.can_force } : {}),
      ...(err.files !== undefined ? { files: err.files } : {}),
      ...(err.repos !== undefined ? { repos: err.repos } : {}),
      ...(err.data !== undefined ? { data: err.data } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 0, code: "internal", message };
}

function failure(id: number, status: number, code: string, message: string): ResultMessage {
  return { kind: "result", id, ok: false, error: { status, code, message } };
}

async function settle(id: number, run: () => unknown): Promise<ResultMessage> {
  try {
    return { kind: "result", id, ok: true, value: await run() };
  } catch (err) {
    return { kind: "result", id, ok: false, error: toWireError(err) };
  }
}

function invoke(bridge: Bridge, method: BridgeMethod, args: unknown[]): unknown {
  const fn = bridge[method] as ((...a: unknown[]) => unknown) | undefined;
  // An optional member the host bridge lacks (an older harness client): a plain refusal, not a TypeError.
  if (typeof fn !== "function") throw new BridgeError(0, "unsupported", `the host does not support ${method}`);
  return fn.apply(bridge, args);
}

export function serveBridge(port: MessagePortLike, bridge: Bridge, options: ServeBridgeOptions = {}): BridgeServer {
  const subs = new Map<number, () => void>();
  const lsp = new Map<number, LanguageServerSession>();
  let nextSession = 1;
  let disposed = false;

  function post(msg: HostMessage): void {
    if (!disposed) port.postMessage(msg);
  }

  function handleCall(id: number, method: string, args: unknown[]): Promise<void> {
    if (!isBridgeMethod(method)) {
      post(failure(id, 0, "unknown_method", `unknown method: ${method}`));
      return Promise.resolve();
    }
    return settle(id, () => invoke(bridge, method, args)).then(post);
  }

  function handleHost(id: number, action: string, args: unknown[]): Promise<void> {
    const { onHost } = options;
    if (!onHost) {
      post(failure(id, 0, "unsupported", `host action not supported: ${action}`));
      return Promise.resolve();
    }
    return settle(id, () => onHost(action, args)).then(post);
  }

  function handleSubscribe(sub: number, projectId: string): void {
    subs.get(sub)?.();
    const live = () => subs.has(sub) && !disposed;
    const unsubscribe = bridge.subscribe(projectId, {
      onEvent: (event) => live() && post({ kind: "event", sub, event }),
      onOpen: () => live() && post({ kind: "open", sub }),
      onError: (err) => live() && post({ kind: "error", sub, message: err instanceof Error ? err.message : String(err) }),
    });
    subs.set(sub, unsubscribe);
  }

  function handleUnsubscribe(sub: number): void {
    const unsubscribe = subs.get(sub);
    subs.delete(sub);
    unsubscribe?.();
  }

  function handleLspOpen(id: number, projectId: string, serverId: string, workspace?: "review"): void {
    bridge.openLanguageServer(projectId, serverId, workspace ? { workspace } : undefined).then(
      (sess) => {
        if (disposed) {
          void sess.close().catch(() => undefined);
          return;
        }
        const session = nextSession++;
        lsp.set(session, sess);
        post({
          kind: "lsp-opened",
          id,
          ok: true,
          session,
          rootUri: sess.rootUri,
          workspaceFolders: sess.workspaceFolders,
        });
        sess.onMessage((message) => post({ kind: "lsp-message", session, message }));
        sess.onExit((info) => {
          lsp.delete(session);
          post(
            info.reason === undefined ? { kind: "lsp-exit", session, code: info.code } : { kind: "lsp-exit", session, code: info.code, reason: info.reason },
          );
        });
      },
      (err: unknown) => post({ kind: "lsp-opened", id, ok: false, error: toWireError(err) }),
    );
  }

  function handleLspClose(session: number): void {
    const sess = lsp.get(session);
    lsp.delete(session);
    void sess?.close().catch(() => undefined);
  }

  function dispatch(msg: ClientMessage): void {
    switch (msg.kind) {
      case "call":
        void handleCall(msg.id, msg.method, msg.args);
        return;
      case "host":
        void handleHost(msg.id, msg.action, msg.args);
        return;
      case "lsp-open":
        return handleLspOpen(msg.id, msg.projectId, msg.serverId, msg.workspace);
      case "lsp-send":
        void lsp
          .get(msg.session)
          ?.send(msg.message)
          .catch(() => undefined);
        return;
      case "lsp-close":
        return handleLspClose(msg.session);
      case "subscribe":
        return handleSubscribe(msg.sub, msg.projectId);
      case "unsubscribe":
        return handleUnsubscribe(msg.sub);
    }
  }

  const detach = port.onMessage((raw) => {
    if (!disposed && isClientMessage(raw)) dispatch(raw);
  });

  return {
    setTheme: (theme) => post({ kind: "theme", theme }),
    dispose() {
      if (disposed) return;
      detach();
      for (const unsubscribe of subs.values()) unsubscribe();
      subs.clear();
      for (const sess of lsp.values()) void sess.close().catch(() => undefined);
      lsp.clear();
      disposed = true;
    },
  };
}
