import { BridgeError, type Bridge } from "./client";
import {
  isClientMessage,
  type ClientMessage,
  type HostMessage,
  type MessagePortLike,
  type ResultMessage,
  type Theme,
  type WireError,
  isBridgeMethod,
} from "./messageProtocol";

export type ServeBridgeOptions = {
  onHost?(action: string, args: unknown[]): Promise<unknown> | unknown;
};

export type BridgeServer = { setTheme(theme: Theme): void; dispose(): void };

function toWireError(err: unknown): WireError {
  if (err instanceof BridgeError) {
    return { status: err.status, code: err.code, message: err.message };
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

function invoke(bridge: Bridge, method: Exclude<keyof Bridge, "subscribe">, args: unknown[]): unknown {
  const fn = bridge[method] as (...a: unknown[]) => unknown;
  return fn.apply(bridge, args);
}

export function serveBridge(
  port: MessagePortLike,
  bridge: Bridge,
  options: ServeBridgeOptions = {},
): BridgeServer {
  const subs = new Map<number, () => void>();
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
      onError: (err) =>
        live() &&
        post({ kind: "error", sub, message: err instanceof Error ? err.message : String(err) }),
    });
    subs.set(sub, unsubscribe);
  }

  function handleUnsubscribe(sub: number): void {
    const unsubscribe = subs.get(sub);
    subs.delete(sub);
    unsubscribe?.();
  }

  function dispatch(msg: ClientMessage): void {
    switch (msg.kind) {
      case "call":
        void handleCall(msg.id, msg.method, msg.args);
        return;
      case "host":
        void handleHost(msg.id, msg.action, msg.args);
        return;
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
      disposed = true;
    },
  };
}
