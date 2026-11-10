import type {
  Agent,
  BridgeConfig,
  BridgeEvent,
  BridgeEventType,
  FileContent,
  FileEntry,
  FileStat,
  LanguageServerInfo,
  LanguageServerSession,
  Limit,
  Message,
  Note,
  Plugin,
  Project,
  ProjectInput,
  ProjectSummary,
  UsageParams,
  UsageReport,
  WriteFileInput,
} from "./types";
import { openLspSession } from "./lspSession";

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export type EventSourceLike = {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
  close(): void;
};

export type EventSourceCtor = new (url: string) => EventSourceLike;

export type SubscribeHandlers = {
  onEvent(event: BridgeEvent): void;
  onOpen?(): void;
  onError?(err: unknown): void;
};

export type HealthResponse = { ok: boolean; version: string };

export interface Bridge {
  health(): Promise<HealthResponse>;
  getConfig(): Promise<BridgeConfig>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: ProjectInput): Promise<Project>;
  getProject(projectId: string): Promise<Project>;
  updateProject(projectId: string, patch: Partial<ProjectInput>): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  listAgents(projectId: string): Promise<Agent[]>;
  getAgent(projectId: string, agentId: string): Promise<Agent>;
  listMessages(projectId: string, agentId: string): Promise<Message[]>;
  sendMessage(projectId: string, text: string): Promise<Message>;
  cancelTurn(projectId: string): Promise<void>;
  listNotes(projectId: string): Promise<Note[]>;
  createNote(projectId: string, input: { title: string; content: string }): Promise<Note>;
  updateNote(
    projectId: string,
    noteId: string,
    patch: { title?: string; content?: string },
  ): Promise<Note>;
  deleteNote(projectId: string, noteId: string): Promise<void>;
  listFiles(projectId: string, folder: string, path: string): Promise<FileEntry[]>;
  readFile(projectId: string, folder: string, path: string): Promise<FileContent>;
  writeFile(projectId: string, input: WriteFileInput): Promise<FileStat>;
  listPlugins(): Promise<Plugin[]>;
  getUsage(params?: UsageParams): Promise<UsageReport>;
  getLimits(): Promise<Limit[]>;
  listLanguageServers(projectId: string): Promise<LanguageServerInfo[]>;
  openLanguageServer(projectId: string, serverId: string): Promise<LanguageServerSession>;
  subscribe(projectId: string, handlers: SubscribeHandlers): () => void;
}

export type HttpBridgeOptions = {
  baseUrl: string;
  fetch?: FetchLike;
  EventSource?: EventSourceCtor;
};

export const BRIDGE_EVENT_TYPES: readonly BridgeEventType[] = [
  "agent.created",
  "agent.updated",
  "message.created",
  "message.delta",
  "tool.started",
  "tool.finished",
  "note.changed",
  "project.updated",
  "file.changed",
  "turn.finished",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toBridgeError(status: number, text: string): BridgeError {
  const body = parseJson(text);
  const err = isRecord(body) ? body.error : undefined;
  if (isRecord(err) && typeof err.message === "string") {
    const code = typeof err.code === "string" ? err.code : "http_error";
    return new BridgeError(status, code, err.message);
  }
  const snippet = text.trim().slice(0, 200);
  return new BridgeError(status, "http_error", snippet || `HTTP ${status}`);
}

function globalFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new BridgeError(0, "network_error", "fetch is not available");
  return (url, init) => f(url, init);
}

function globalEventSource(): EventSourceCtor {
  const ctor = (globalThis as { EventSource?: EventSourceCtor }).EventSource;
  if (!ctor) throw new BridgeError(0, "network_error", "EventSource is not available");
  return ctor;
}

function parseEvent(data: unknown): BridgeEvent | undefined {
  if (typeof data !== "string") return undefined;
  const parsed = parseJson(data);
  if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;
  return parsed as BridgeEvent;
}

export function createHttpBridge(options: HttpBridgeOptions): Bridge {
  const base = options.baseUrl.replace(/\/+$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = options.fetch ?? globalFetch();
    const init: { method: string; headers?: Record<string, string>; body?: string } = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    let res: FetchResponseLike;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, init);
      text = await res.text();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BridgeError(0, "network_error", msg);
    }
    if (!res.ok) throw toBridgeError(res.status, text);
    return parseJson(text);
  }

  async function unwrap<T>(
    promise: Promise<unknown>,
    key: string,
  ): Promise<T> {
    const body = await promise;
    if (!isRecord(body) || !(key in body)) {
      throw new BridgeError(0, "invalid_response", `missing "${key}" in response`);
    }
    return body[key] as T;
  }

  const usageQuery = (params: UsageParams | undefined) => {
    const parts: string[] = [];
    for (const k of ["from", "to", "group", "project"] as const) {
      const v = params?.[k];
      if (typeof v === "string" && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
  };

  const p = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;
  const fileQuery = (folder: string, path: string) =>
    `folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`;

  return {
    health: () => request("GET", "/health") as Promise<HealthResponse>,
    getConfig: () => request("GET", "/v1/config") as Promise<BridgeConfig>,
    listProjects: () => unwrap<ProjectSummary[]>(request("GET", "/v1/projects"), "projects"),
    createProject: (input) => request("POST", "/v1/projects", input) as Promise<Project>,
    getProject: (id) => request("GET", p(id)) as Promise<Project>,
    updateProject: (id, patch) => request("PATCH", p(id), patch) as Promise<Project>,
    deleteProject: async (id) => {
      await request("DELETE", p(id));
    },
    listAgents: (id) => unwrap<Agent[]>(request("GET", `${p(id)}/agents`), "agents"),
    getAgent: (id, agentId) =>
      request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}`) as Promise<Agent>,
    listMessages: (id, agentId) =>
      unwrap<Message[]>(
        request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}/messages`),
        "messages",
      ),
    sendMessage: (id, text) =>
      unwrap<Message>(request("POST", `${p(id)}/messages`, { text }), "message"),
    cancelTurn: async (id) => {
      await request("POST", `${p(id)}/cancel`);
    },
    listNotes: (id) => unwrap<Note[]>(request("GET", `${p(id)}/notes`), "notes"),
    createNote: (id, input) => request("POST", `${p(id)}/notes`, input) as Promise<Note>,
    updateNote: (id, noteId, patch) =>
      request("PATCH", `${p(id)}/notes/${encodeURIComponent(noteId)}`, patch) as Promise<Note>,
    deleteNote: async (id, noteId) => {
      await request("DELETE", `${p(id)}/notes/${encodeURIComponent(noteId)}`);
    },
    listFiles: (id, folder, path) =>
      unwrap<FileEntry[]>(request("GET", `${p(id)}/files?${fileQuery(folder, path)}`), "entries"),
    readFile: (id, folder, path) =>
      request("GET", `${p(id)}/files/content?${fileQuery(folder, path)}`) as Promise<FileContent>,
    writeFile: (id, input) =>
      request("PUT", `${p(id)}/files/content`, input) as Promise<FileStat>,
    listPlugins: () => unwrap<Plugin[]>(request("GET", "/v1/plugins"), "plugins"),
    getUsage: (params) => request("GET", `/v1/usage${usageQuery(params)}`) as Promise<UsageReport>,
    getLimits: () => unwrap<Limit[]>(request("GET", "/v1/limits"), "limits"),
    listLanguageServers: (id) =>
      unwrap<LanguageServerInfo[]>(request("GET", `${p(id)}/lsp`), "servers"),
    openLanguageServer: (id, serverId) =>
      openLspSession(
        {
          request,
          openStream: (path) => new (options.EventSource ?? globalEventSource())(`${base}${path}`),
        },
        p(id),
        serverId,
      ),
    subscribe(id, handlers) {
      const Ctor = options.EventSource ?? globalEventSource();
      const source = new Ctor(`${base}${p(id)}/events`);
      source.onopen = () => handlers.onOpen?.();
      source.onerror = (err) => handlers.onError?.(err);
      for (const type of BRIDGE_EVENT_TYPES) {
        source.addEventListener(type, (ev) => {
          const event = parseEvent(ev.data);
          if (event) handlers.onEvent(event);
        });
      }
      return () => source.close();
    },
  };
}
