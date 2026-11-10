import { BridgeError, type Bridge, type SubscribeHandlers } from "./client";
import {
  isHostMessage,
  type BridgeMethod,
  type ClientMessage,
  type HostMessage,
  type MessagePortLike,
  type ResultMessage,
  type Theme,
} from "./messageProtocol";

export type MessageClient = {
  bridge: Bridge;
  callHost(action: string, args?: unknown[]): Promise<unknown>;
  onTheme(cb: (theme: Theme) => void): () => void;
  dispose(): void;
};

type Pending = { resolve(value: unknown): void; reject(err: unknown): void };

export function createMessageClient(port: MessagePortLike): MessageClient {
  const pending = new Map<number, Pending>();
  const subs = new Map<number, SubscribeHandlers>();
  const themeListeners = new Set<(theme: Theme) => void>();
  let nextId = 1;
  let nextSub = 1;

  function send(msg: ClientMessage): void {
    port.postMessage(msg);
  }

  function settle(msg: ResultMessage): void {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new BridgeError(msg.error.status, msg.error.code, msg.error.message));
  }

  function route(msg: HostMessage): void {
    switch (msg.kind) {
      case "result":
        return settle(msg);
      case "event":
        return subs.get(msg.sub)?.onEvent(msg.event);
      case "open":
        return subs.get(msg.sub)?.onOpen?.();
      case "error":
        return subs.get(msg.sub)?.onError?.(new Error(msg.message));
      case "theme":
        return themeListeners.forEach((cb) => cb(msg.theme));
    }
  }

  const detach = port.onMessage((raw) => {
    if (isHostMessage(raw)) route(raw);
  });

  function request(build: (id: number) => ClientMessage): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(build(id));
    });
  }

  function call(method: BridgeMethod, args: unknown[]): Promise<never> {
    return request((id) => ({ kind: "call", id, method, args })) as Promise<never>;
  }

  function subscribe(projectId: string, handlers: SubscribeHandlers): () => void {
    const sub = nextSub++;
    subs.set(sub, handlers);
    send({ kind: "subscribe", sub, projectId });
    return () => {
      if (!subs.delete(sub)) return;
      send({ kind: "unsubscribe", sub });
    };
  }

  const bridge: Bridge = {
    health: () => call("health", []),
    getConfig: () => call("getConfig", []),
    listProjects: () => call("listProjects", []),
    createProject: (input) => call("createProject", [input]),
    getProject: (id) => call("getProject", [id]),
    updateProject: (id, patch) => call("updateProject", [id, patch]),
    deleteProject: (id) => call("deleteProject", [id]),
    listAgents: (id) => call("listAgents", [id]),
    getAgent: (id, agentId) => call("getAgent", [id, agentId]),
    listMessages: (id, agentId) => call("listMessages", [id, agentId]),
    sendMessage: (id, text) => call("sendMessage", [id, text]),
    cancelTurn: (id) => call("cancelTurn", [id]),
    listNotes: (id) => call("listNotes", [id]),
    createNote: (id, input) => call("createNote", [id, input]),
    updateNote: (id, noteId, patch) => call("updateNote", [id, noteId, patch]),
    deleteNote: (id, noteId) => call("deleteNote", [id, noteId]),
    listFiles: (id, folder, path) => call("listFiles", [id, folder, path]),
    readFile: (id, folder, path) => call("readFile", [id, folder, path]),
    writeFile: (id, input) => call("writeFile", [id, input]),
    subscribe,
  };

  function dispose(): void {
    detach();
    subs.clear();
    themeListeners.clear();
    const err = () => new BridgeError(0, "disposed", "message client disposed");
    for (const p of pending.values()) p.reject(err());
    pending.clear();
  }

  return {
    bridge,
    callHost: (action, args = []) => request((id) => ({ kind: "host", id, action, args })),
    onTheme(cb) {
      themeListeners.add(cb);
      return () => void themeListeners.delete(cb);
    },
    dispose,
  };
}
