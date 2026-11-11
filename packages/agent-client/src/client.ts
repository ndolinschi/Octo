import type {
  Agent,
  Approval,
  ApprovalAnswer,
  ChangeDetail,
  InputAnswer,
  InputRequest,
  QueuedMessage,
  QueueState,
  RevertResult,
  SecretInfo,
  SendResult,
  TurnChanges,
  BridgeConfig,
  BridgeEvent,
  BridgeEventType,
  ContextBreakdown,
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
  SideMessage,
  SettingsUpdate,
  SettingsView,
  SideStarted,
  Transcript,
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

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

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
  /** Same request as listMessages, plus the compaction markers of the transcript. */
  getTranscript(projectId: string, agentId: string): Promise<Transcript>;
  sendMessage(projectId: string, text: string): Promise<Message>;
  cancelTurn(projectId: string): Promise<void>;
  /** The orchestrator's context by part, or another agent's with `agentId`. */
  getContext(projectId: string, agentId?: string): Promise<ContextBreakdown>;
  /** Ask the side question; resolves with the stored question, the answer streams as side.* events. */
  askSide(projectId: string, text: string): Promise<SideStarted>;
  listSide(projectId: string): Promise<SideMessage[]>;
  /** Cancels a running side question and deletes the side conversation. */
  clearSide(projectId: string): Promise<void>;
  listNotes(projectId: string): Promise<Note[]>;
  createNote(projectId: string, input: { title: string; content: string }): Promise<Note>;
  updateNote(projectId: string, noteId: string, patch: { title?: string; content?: string }): Promise<Note>;
  deleteNote(projectId: string, noteId: string): Promise<void>;
  listFiles(projectId: string, folder: string, path: string): Promise<FileEntry[]>;
  readFile(projectId: string, folder: string, path: string): Promise<FileContent>;
  writeFile(projectId: string, input: WriteFileInput): Promise<FileStat>;
  listPlugins(): Promise<Plugin[]>;
  getUsage(params?: UsageParams): Promise<UsageReport>;
  getLimits(): Promise<Limit[]>;
  listLanguageServers(projectId: string): Promise<LanguageServerInfo[]>;
  /**
   * Settings (provider keys, default models, router switch, child-env allow list) stored in the harness's
   * `harness.env`. Optional: only the HTTP bridge implements them (the message bridge and the demo bridge do not);
   * hosts check for presence. The harness answers 403 unless it listens on loopback and the caller is loopback.
   */
  getSettings?(): Promise<SettingsView>;
  /** Validates the whole update, writes it atomically, applies what can apply at once. Secrets are write-only. */
  putSettings?(update: SettingsUpdate): Promise<SettingsView>;
  /*
   * v7 members. All optional (only the HTTP bridge implements them; the message and demo bridges do not), so a host
   * that predates them keeps compiling; hosts check for presence.
   */
  /** Like sendMessage, but a message sent while a turn runs is queued (202) and resolves as `{ queued }`. */
  sendOrQueueMessage?(projectId: string, text: string): Promise<SendResult>;
  getQueue?(projectId: string): Promise<QueueState>;
  editQueued?(projectId: string, queueId: string, text: string): Promise<QueuedMessage>;
  removeQueued?(projectId: string, queueId: string): Promise<void>;
  /** Removes every queued message. */
  clearQueue?(projectId: string): Promise<void>;
  /** Lifts the pause after a failed or cancelled turn. */
  resumeQueue?(projectId: string): Promise<void>;
  /** Cancels the running turn and runs that queued message next. */
  sendQueuedNow?(projectId: string, queueId: string): Promise<void>;
  /** What agents changed, one entry per file per turn, newest turn first; `turnId` narrows to one turn. */
  listChanges?(projectId: string, turnId?: number): Promise<TurnChanges[]>;
  getChange?(projectId: string, changeId: number): Promise<ChangeDetail>;
  /** Writes the content before the change back; 409 `file_changed` when the file moved on, 409 `revert_unavailable` without a stored original. */
  revertChange?(projectId: string, changeId: number): Promise<RevertResult>;
  listApprovals?(projectId: string): Promise<Approval[]>;
  resolveApproval?(projectId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  listInputs?(projectId: string): Promise<InputRequest[]>;
  /** Submits or skips an open form. Secret values go to the harness's secret store and are never echoed. */
  submitInput?(projectId: string, inputId: string, answer: InputAnswer): Promise<void>;
  listSecrets?(projectId: string): Promise<SecretInfo[]>;
  putSecret?(projectId: string, name: string, value: string): Promise<void>;
  deleteSecret?(projectId: string, name: string): Promise<void>;
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
  "agent.compacted",
  "side.delta",
  "side.done",
  "side.error",
  "settings.changed",
  "change.recorded",
  "approval.requested",
  "approval.resolved",
  "input.requested",
  "input.resolved",
  "queue.updated",
  "project.attention",
  "secrets.changed",
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

/** What {@link createHttpBridge} returns: every method is implemented, the optional ones included. */
export type HttpBridge = Bridge & Required<Pick<Bridge, "getSettings" | "putSettings">>;

export function createHttpBridge(options: HttpBridgeOptions): HttpBridge {
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

  async function unwrap<T>(promise: Promise<unknown>, key: string): Promise<T> {
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
  const fileQuery = (folder: string, path: string) => `folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`;

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
    getAgent: (id, agentId) => request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}`) as Promise<Agent>,
    listMessages: (id, agentId) => unwrap<Message[]>(request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}/messages`), "messages"),
    getTranscript: async (id, agentId) => {
      const body = await request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}/messages`);
      if (!isRecord(body) || !Array.isArray(body.messages)) {
        throw new BridgeError(0, "invalid_response", 'missing "messages" in response');
      }
      return { messages: body.messages as Message[], compactions: Array.isArray(body.compactions) ? (body.compactions as Transcript["compactions"]) : [] };
    },
    sendMessage: async (id, text) => {
      const body = await request("POST", `${p(id)}/messages`, { text });
      if (isRecord(body) && isRecord(body.queued)) {
        throw new BridgeError(202, "queued", "a turn is running: the message was queued (use sendOrQueueMessage)");
      }
      if (!isRecord(body) || !isRecord(body.message)) throw new BridgeError(0, "invalid_response", 'missing "message" in response');
      return body.message as unknown as Message;
    },
    cancelTurn: async (id) => {
      await request("POST", `${p(id)}/cancel`);
    },
    getContext: (id, agentId) =>
      request("GET", `${p(id)}/context${agentId === undefined ? "" : `?agent=${encodeURIComponent(agentId)}`}`) as Promise<ContextBreakdown>,
    askSide: (id, text) => request("POST", `${p(id)}/side`, { text }) as Promise<SideStarted>,
    listSide: (id) => unwrap<SideMessage[]>(request("GET", `${p(id)}/side`), "messages"),
    clearSide: async (id) => {
      await request("DELETE", `${p(id)}/side`);
    },
    listNotes: (id) => unwrap<Note[]>(request("GET", `${p(id)}/notes`), "notes"),
    createNote: (id, input) => request("POST", `${p(id)}/notes`, input) as Promise<Note>,
    updateNote: (id, noteId, patch) => request("PATCH", `${p(id)}/notes/${encodeURIComponent(noteId)}`, patch) as Promise<Note>,
    deleteNote: async (id, noteId) => {
      await request("DELETE", `${p(id)}/notes/${encodeURIComponent(noteId)}`);
    },
    listFiles: (id, folder, path) => unwrap<FileEntry[]>(request("GET", `${p(id)}/files?${fileQuery(folder, path)}`), "entries"),
    readFile: (id, folder, path) => request("GET", `${p(id)}/files/content?${fileQuery(folder, path)}`) as Promise<FileContent>,
    writeFile: (id, input) => request("PUT", `${p(id)}/files/content`, input) as Promise<FileStat>,
    listPlugins: () => unwrap<Plugin[]>(request("GET", "/v1/plugins"), "plugins"),
    getUsage: (params) => request("GET", `/v1/usage${usageQuery(params)}`) as Promise<UsageReport>,
    getLimits: () => unwrap<Limit[]>(request("GET", "/v1/limits"), "limits"),
    listLanguageServers: (id) => unwrap<LanguageServerInfo[]>(request("GET", `${p(id)}/lsp`), "servers"),
    sendOrQueueMessage: async (id, text) => {
      const body = await request("POST", `${p(id)}/messages`, { text });
      if (isRecord(body) && isRecord(body.queued)) return { queued: body.queued as QueuedMessage };
      if (isRecord(body) && isRecord(body.message)) return { message: body.message as unknown as Message };
      throw new BridgeError(0, "invalid_response", 'missing "message" or "queued" in response');
    },
    getQueue: (id) => request("GET", `${p(id)}/queue`) as Promise<QueueState>,
    editQueued: (id, qid, text) => request("PATCH", `${p(id)}/queue/${encodeURIComponent(qid)}`, { text }) as Promise<QueuedMessage>,
    removeQueued: async (id, qid) => {
      await request("DELETE", `${p(id)}/queue/${encodeURIComponent(qid)}`);
    },
    clearQueue: async (id) => {
      await request("DELETE", `${p(id)}/queue`);
    },
    resumeQueue: async (id) => {
      await request("POST", `${p(id)}/queue/resume`);
    },
    sendQueuedNow: async (id, qid) => {
      await request("POST", `${p(id)}/queue/${encodeURIComponent(qid)}/send-now`);
    },
    listChanges: (id, turnId) => unwrap<TurnChanges[]>(request("GET", `${p(id)}/changes${turnId === undefined ? "" : `?turn=${turnId}`}`), "turns"),
    getChange: (id, cid) => request("GET", `${p(id)}/changes/${cid}`) as Promise<ChangeDetail>,
    revertChange: (id, cid) => request("POST", `${p(id)}/changes/${cid}/revert`) as Promise<RevertResult>,
    listApprovals: (id) => unwrap<Approval[]>(request("GET", `${p(id)}/approvals`), "approvals"),
    resolveApproval: async (id, aid, answer) => {
      await request("POST", `${p(id)}/approvals/${encodeURIComponent(aid)}`, answer);
    },
    listInputs: (id) => unwrap<InputRequest[]>(request("GET", `${p(id)}/inputs`), "inputs"),
    submitInput: async (id, iid, answer) => {
      await request("POST", `${p(id)}/inputs/${encodeURIComponent(iid)}`, answer);
    },
    listSecrets: (id) => unwrap<SecretInfo[]>(request("GET", `${p(id)}/secrets`), "secrets"),
    putSecret: async (id, name, value) => {
      await request("PUT", `${p(id)}/secrets/${encodeURIComponent(name)}`, { value });
    },
    deleteSecret: async (id, name) => {
      await request("DELETE", `${p(id)}/secrets/${encodeURIComponent(name)}`);
    },
    getSettings: () => request("GET", "/v1/settings") as Promise<SettingsView>,
    putSettings: (update) => request("PUT", "/v1/settings", update) as Promise<SettingsView>,
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
