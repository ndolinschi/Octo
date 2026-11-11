import { BridgeError, type Bridge, type SubscribeHandlers } from "./client";
import { createLspChannel, type LspChannel } from "./lspChannel";
import {
  isHostMessage,
  type LspOpenedMessage,
  type BridgeMethod,
  type ClientMessage,
  type HostMessage,
  type MessagePortLike,
  type ResultMessage,
  type Theme,
} from "./messageProtocol";
import type { LanguageServerSession } from "./types";

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
  const lspOpens = new Map<number, Pending>();
  const lspSessions = new Map<number, LspChannel>();
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

  function openedSession(msg: Extract<LspOpenedMessage, { ok: true }>): LanguageServerSession {
    const { session } = msg;
    const channel = createLspChannel();
    lspSessions.set(session, channel);
    return {
      rootUri: msg.rootUri,
      workspaceFolders: msg.workspaceFolders,
      send: async (message) => send({ kind: "lsp-send", session, message }),
      onMessage: channel.onMessage,
      onExit: channel.onExit,
      close: async () => {
        if (lspSessions.delete(session)) send({ kind: "lsp-close", session });
      },
    };
  }

  function settleOpen(msg: LspOpenedMessage): void {
    const p = lspOpens.get(msg.id);
    if (!p) return;
    lspOpens.delete(msg.id);
    if (msg.ok) p.resolve(openedSession(msg));
    else p.reject(new BridgeError(msg.error.status, msg.error.code, msg.error.message));
  }

  function exitSession(msg: Extract<HostMessage, { kind: "lsp-exit" }>): void {
    const channel = lspSessions.get(msg.session);
    lspSessions.delete(msg.session);
    channel?.exit(msg.reason === undefined ? { code: msg.code } : { code: msg.code, reason: msg.reason });
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
      case "lsp-opened":
        return settleOpen(msg);
      case "lsp-message":
        return lspSessions.get(msg.session)?.push(msg.message);
      case "lsp-exit":
        return exitSession(msg);
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
    getTranscript: (id, agentId) => call("getTranscript", [id, agentId]),
    sendMessage: (id, text) => call("sendMessage", [id, text]),
    cancelTurn: (id) => call("cancelTurn", [id]),
    getContext: (id, agentId) => call("getContext", agentId === undefined ? [id] : [id, agentId]),
    askSide: (id, text) => call("askSide", [id, text]),
    listSide: (id) => call("listSide", [id]),
    clearSide: (id) => call("clearSide", [id]),
    listNotes: (id) => call("listNotes", [id]),
    createNote: (id, input) => call("createNote", [id, input]),
    updateNote: (id, noteId, patch) => call("updateNote", [id, noteId, patch]),
    deleteNote: (id, noteId) => call("deleteNote", [id, noteId]),
    listFiles: (id, folder, path) => call("listFiles", [id, folder, path]),
    readFile: (id, folder, path) => call("readFile", [id, folder, path]),
    writeFile: (id, input) => call("writeFile", [id, input]),
    listPlugins: () => call("listPlugins", []),
    getUsage: (params) => call("getUsage", params === undefined ? [] : [params]),
    getLimits: () => call("getLimits", []),
    listLanguageServers: (id) => call("listLanguageServers", [id]),
    openLanguageServer: (projectId, serverId) => {
      const id = nextId++;
      return new Promise<LanguageServerSession>((resolve, reject) => {
        lspOpens.set(id, { resolve: (v) => resolve(v as LanguageServerSession), reject });
        send({ kind: "lsp-open", id, projectId, serverId });
      });
    },
    subscribe,
  };

  function dispose(): void {
    detach();
    subs.clear();
    themeListeners.clear();
    const err = () => new BridgeError(0, "disposed", "message client disposed");
    for (const p of pending.values()) p.reject(err());
    pending.clear();
    for (const p of lspOpens.values()) p.reject(err());
    lspOpens.clear();
    lspSessions.clear();
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
