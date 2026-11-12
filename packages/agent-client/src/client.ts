import type {
  PullRequestList,
  ReviewState,
  ReviewSummary,
  OpenReviewInput,
  Review,
  ReviewPatch,
  ReviewFiles,
  ReviewDiffOptions,
  ReviewFileDiff,
  ReviewFile,
  ReviewComment,
  ReviewCommentInput,
  ReviewCommentUpdate,
  ReviewFinding,
  ReviewFindingDecision,
  ReviewFindingResult,
  ReviewSubmitInput,
  ReviewSubmitPreview,
  ReviewSubmitResult,
} from "./review";
import type {
  Agent,
  ContextReceipt,
  MemoryFile,
  MemoryList,
  MemorySearchParams,
  MemorySearchResult,
  Task,
  Diagnostics,
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
  ContextOverview,
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
  CompletionRequest,
  DirListing,
  FolderEntry,
  CompletionResult,
  SideMessage,
  PickFolderResult,
  Provider,
  ProviderPrefs,
  ProvidersResponse,
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
  /** `model_unavailable` (422): the provider that would run the model, and what is missing. */
  readonly provider?: string;
  readonly reason?: string;
  /** The command the server says fixes this (`not_logged_in`: "gh auth login"); additive, absent when it sends none. */
  readonly command?: string;

  constructor(status: number, code: string, message: string, detail?: { provider?: string; reason?: string; command?: string }) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    if (detail?.provider !== undefined) this.provider = detail.provider;
    if (detail?.reason !== undefined) this.reason = detail.reason;
    if (detail?.command !== undefined) this.command = detail.command;
  }
}

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
};

/** The part of AbortSignal the client passes on to fetch (this package builds without the DOM lib). */
export type AbortSignalLike = { readonly aborted: boolean };

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignalLike },
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
  /** Same request as listMessages, plus the compaction markers of the transcript. */
  getTranscript(projectId: string, agentId: string): Promise<Transcript>;
  sendMessage(projectId: string, text: string): Promise<Message>;
  cancelTurn(projectId: string): Promise<void>;
  /** The orchestrator's context by part, or another agent's with `agentId`. */
  getContext(projectId: string, agentId?: string): Promise<ContextBreakdown>;
  /**
   * Decision 65: the context window by category, for the composer's context button. The same URL as `getContext` on
   * a harness that sends the new shape; the UI reads either (`ContextBreakdown` is the older one). Optional.
   */
  getContextOverview?(projectId: string): Promise<ContextOverview | ContextBreakdown>;
  /** `POST /v1/projects/{id}/compact`: compacts the conversation now. Optional; "Compact now" is hidden without it. */
  compactNow?(projectId: string): Promise<void>;
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
  /**
   * What can run a model right now (connect first, choose second): the built-in API loop, a detected router and every
   * ACP agent, each with a state, its models and how to make it ready, plus the models a new project would get.
   * Optional: only the HTTP bridge implements it; hosts check for presence. Refetch on `providers.updated`.
   * Creating or patching a project with a model whose provider is not ready answers 422 `model_unavailable`
   * (`BridgeError.provider` / `.reason`); creating with nothing connected answers 409 `no_provider`.
   */
  listProviders?(): Promise<ProvidersResponse>;
  /**
   * `POST /v1/providers/{id}/refresh-models`: starts the agent, reads the models it advertises (no prompt is sent) and
   * stores them; answers the provider (read `models_error` for a failure that is not an HTTP error). Optional.
   */
  refreshProviderModels?(id: string): Promise<Provider | null>;
  /** `PUT /v1/providers/{id}/custom-models`: replaces the model names the user added for an agent. Optional. */
  setProviderCustomModels?(id: string, models: string[]): Promise<Provider | null>;
  /**
   * `PUT /v1/providers/{id}/prefs`: the agent's preferred model and role models, stored globally by the harness.
   * Answers the updated provider entry. Optional.
   */
  setProviderPrefs?(id: string, prefs: ProviderPrefs): Promise<Provider | null>;
  /**
   * Folder picker. `path` is a directory path or a prefix of one (`~` is the home directory, empty is home): the
   * child directories of its directory whose names start with the last segment (case-insensitive, hidden ones only
   * when that segment starts with a dot), at most 50. HTTP bridge only; the harness answers 403 unless it listens on
   * loopback and the caller is loopback.
   */
  listDirs?(path: string): Promise<DirListing>;
  /** The folders of existing projects, newest first, at most 8. */
  recentFolders?(): Promise<FolderEntry[]>;
  /**
   * `POST /v1/fs/pick-folder`: the harness opens the operating system's folder dialog (starting at `start`) and answers the
   * chosen `path`, `cancelled`, or `error` + `message`. Loopback only; check `BridgeConfig.pick_folder`. Optional.
   */
  pickFolder?(start?: string): Promise<PickFolderResult>;
  /** R1: the diagnostics report (versions, PATH, per-agent resolution and login state, last 200 log lines). */
  getDiagnostics?(): Promise<Diagnostics>;
  /**
   * Decision 53: every provider (API key, router, agent CLIs) with its state and models. Optional: a harness that
   * predates `GET /v1/providers` answers 404, and the UI then derives the list from the config and the plugins.
   */
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
  /*
   * M1 members (orchestrator memory). Optional like the v7 ones: HTTP bridge only.
   */
  /** M2: the context receipt of a turn, by the id of its user message; 404 for a turn before receipts. */
  getTurnContext?(projectId: string, turnId: number): Promise<ContextReceipt>;
  listTasks?(projectId: string): Promise<Task[]>;
  listMemory?(projectId: string): Promise<MemoryList>;
  getMemoryFile?(projectId: string, path: string): Promise<MemoryFile>;
  /** Creates or replaces a file (the user's edit); `summary` is required for a new file. */
  putMemoryFile?(projectId: string, path: string, content: string, summary?: string): Promise<MemoryFile>;
  deleteMemoryFile?(projectId: string, path: string): Promise<void>;
  searchMemory?(projectId: string, params: MemorySearchParams): Promise<MemorySearchResult>;
  /*
   * Inline completion. Optional: HTTP bridge only, and not on the message bridge (an AbortSignal cannot cross a port).
   */
  /**
   * One fill-in-the-middle suggestion; `null` when there is nothing to suggest (204). 409 `completion_off` without
   * `models.completion`, 409 `budget_reached`, 502 `completion_failed`. Aborting `signal` aborts the model call.
   */
  complete?(projectId: string, input: CompletionRequest, options?: { signal?: AbortSignalLike }): Promise<CompletionResult | null>;
  /*
   * RV1 members (pull-request review, apps/harness/docs/review.md). Optional: HTTP bridge only. Nothing is posted to a
   * code host except by `submitReview`, which the user's own button calls.
   */
  /** Open pull requests of the project's repository (review requests first), or why they cannot be listed. */
  listPullRequests?(projectId: string, params?: { folder?: string }): Promise<PullRequestList>;
  listReviews?(projectId: string, state?: ReviewState): Promise<ReviewSummary[]>;
  /** Starts a review of a pull request or a local branch; the same source opened again returns the open review. */
  openReview?(projectId: string, input: OpenReviewInput): Promise<Review>;
  getReview?(projectId: string, reviewId: string): Promise<Review>;
  patchReview?(projectId: string, reviewId: string, patch: ReviewPatch): Promise<Review>;
  /** Changed files in reading order. */
  listReviewFiles?(projectId: string, reviewId: string): Promise<ReviewFiles>;
  getReviewFileDiff?(projectId: string, reviewId: string, path: string, options?: ReviewDiffOptions): Promise<ReviewFileDiff>;
  /** URL of a file's bytes at the head (`new`) or the base (`old`), for images next to their diff. */
  reviewFileRawUrl?(projectId: string, reviewId: string, path: string, side: "new" | "old"): string;
  setReviewFileViewed?(projectId: string, reviewId: string, path: string, viewed: boolean): Promise<ReviewFile>;
  listReviewComments?(projectId: string, reviewId: string): Promise<ReviewComment[]>;
  createReviewComment?(projectId: string, reviewId: string, input: ReviewCommentInput): Promise<ReviewComment>;
  updateReviewComment?(projectId: string, reviewId: string, commentId: string, patch: ReviewCommentUpdate): Promise<ReviewComment>;
  deleteReviewComment?(projectId: string, reviewId: string, commentId: string): Promise<void>;
  listReviewFindings?(projectId: string, reviewId: string): Promise<ReviewFinding[]>;
  /** Keep (makes a pending comment), dismiss (with a reason) or reset a finding. */
  decideReviewFinding?(projectId: string, reviewId: string, findingId: string, decision: ReviewFindingDecision): Promise<ReviewFindingResult>;
  /** What a submit would post, word for word; posts nothing. */
  previewReviewSubmit?(projectId: string, reviewId: string, input: ReviewSubmitInput): Promise<ReviewSubmitPreview>;
  /** Posts the pending comments and the verdict as one review. Only an explicit user action may call it. */
  submitReview?(projectId: string, reviewId: string, input: ReviewSubmitInput): Promise<ReviewSubmitResult>;
  openLanguageServer(projectId: string, serverId: string): Promise<LanguageServerSession>;
  subscribe(projectId: string, handlers: SubscribeHandlers): () => void;
}

export type HttpBridgeOptions = {
  baseUrl: string;
  /**
   * The harness API token. Sent as `Authorization: Bearer <token>` on every request except `/health`; the two SSE
   * streams (project events, language-server sessions) take it as a `?token=` query parameter instead, because
   * `EventSource` cannot set headers. Leave it out when the harness runs with `--no-api-token`.
   */
  token?: string;
  fetch?: FetchLike;
  EventSource?: EventSourceCtor;
};

export const BRIDGE_EVENT_TYPES: readonly BridgeEventType[] = [
  "agent.created",
  "agent.updated",
  "message.created",
  "message.updated",
  "message.delta",
  "message.thinking_delta",
  "agent.plan",
  "agent.activity",
  "tool.updated",
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
  "providers.updated",
  "task.updated",
  "memory.updated",
  "review.updated",
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

/** The answer of a provider call: the provider itself, or the whole list it sits in; null when the body says neither. */
function asProvider(body: unknown, id: string): Provider | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.providers)) return (body.providers.find((p) => isRecord(p) && p.id === id) as Provider | undefined) ?? null;
  return typeof body.id === "string" && Array.isArray(body.models) ? (body as Provider) : null;
}

function toBridgeError(status: number, text: string): BridgeError {
  const body = parseJson(text);
  const err = isRecord(body) ? body.error : undefined;
  if (isRecord(err) && typeof err.message === "string") {
    const code = typeof err.code === "string" ? err.code : "http_error";
    const detail = {
      ...(typeof err.provider === "string" ? { provider: err.provider } : {}),
      ...(typeof err.reason === "string" ? { reason: err.reason } : {}),
      ...(typeof err.command === "string" && err.command.trim() ? { command: err.command.trim() } : {}),
    };
    return new BridgeError(status, code, err.message, detail);
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
export type HttpBridge = Bridge & Required<Pick<Bridge, "getSettings" | "putSettings" | "listProviders" | "refreshProviderModels" | "setProviderCustomModels">>;

export function createHttpBridge(options: HttpBridgeOptions): HttpBridge {
  const base = options.baseUrl.replace(/\/+$/, "");
  const token = (options.token ?? "").trim();
  /** An SSE URL: EventSource sends no headers, so the token travels in the query. */
  const streamUrl = (path: string) => `${base}${path}${token === "" ? "" : `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`}`;

  async function request(method: string, path: string, body?: unknown, signal?: AbortSignalLike): Promise<unknown> {
    const doFetch = options.fetch ?? globalFetch();
    const init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignalLike } = { method };
    if (signal) init.signal = signal;
    const headers: Record<string, string> = {};
    if (token !== "" && path !== "/health") headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (Object.keys(headers).length > 0) init.headers = headers;
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

  /** A memory path with its slashes kept: each segment is encoded. */
  const memoryPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

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
    complete: async (id, input, opts) => {
      const body = await request("POST", `${p(id)}/complete`, input, opts?.signal);
      return isRecord(body) && typeof body.text === "string" ? (body as CompletionResult) : null;
    },
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
    listPullRequests: (id, params) =>
      request("GET", `${p(id)}/prs${params?.folder ? `?folder=${encodeURIComponent(params.folder)}` : ""}`) as Promise<PullRequestList>,
    listReviews: (id, state) => unwrap<ReviewSummary[]>(request("GET", `${p(id)}/reviews${state ? `?state=${state}` : ""}`), "reviews"),
    openReview: (id, input) => request("POST", `${p(id)}/reviews`, input) as Promise<Review>,
    getReview: (id, rid) => request("GET", `${p(id)}/reviews/${encodeURIComponent(rid)}`) as Promise<Review>,
    patchReview: (id, rid, patch) => request("PATCH", `${p(id)}/reviews/${encodeURIComponent(rid)}`, patch) as Promise<Review>,
    listReviewFiles: (id, rid) => request("GET", `${p(id)}/reviews/${encodeURIComponent(rid)}/files`) as Promise<ReviewFiles>,
    getReviewFileDiff: (id, rid, path, o) => {
      const q: string[] = [];
      if (o?.context !== undefined) q.push(`context=${o.context}`);
      if (o?.ignoreWhitespace) q.push("ignore_whitespace=1");
      if (o?.since) q.push(`since=${encodeURIComponent(o.since)}`);
      return request(
        "GET",
        `${p(id)}/reviews/${encodeURIComponent(rid)}/files/${memoryPath(path)}${q.length ? `?${q.join("&")}` : ""}`,
      ) as Promise<ReviewFileDiff>;
    },
    reviewFileRawUrl: (id, rid, path, side) => `${base}${p(id)}/reviews/${encodeURIComponent(rid)}/files/${memoryPath(path)}?raw=${side}`,
    setReviewFileViewed: (id, rid, path, viewed) =>
      request("PATCH", `${p(id)}/reviews/${encodeURIComponent(rid)}/files/${memoryPath(path)}`, { viewed }) as Promise<ReviewFile>,
    listReviewComments: (id, rid) => unwrap<ReviewComment[]>(request("GET", `${p(id)}/reviews/${encodeURIComponent(rid)}/comments`), "comments"),
    createReviewComment: (id, rid, input) => request("POST", `${p(id)}/reviews/${encodeURIComponent(rid)}/comments`, input) as Promise<ReviewComment>,
    updateReviewComment: (id, rid, cid, patch) =>
      request("PATCH", `${p(id)}/reviews/${encodeURIComponent(rid)}/comments/${encodeURIComponent(cid)}`, patch) as Promise<ReviewComment>,
    deleteReviewComment: async (id, rid, cid) => {
      await request("DELETE", `${p(id)}/reviews/${encodeURIComponent(rid)}/comments/${encodeURIComponent(cid)}`);
    },
    listReviewFindings: (id, rid) => unwrap<ReviewFinding[]>(request("GET", `${p(id)}/reviews/${encodeURIComponent(rid)}/findings`), "findings"),
    decideReviewFinding: (id, rid, fid, d) =>
      request("PATCH", `${p(id)}/reviews/${encodeURIComponent(rid)}/findings/${encodeURIComponent(fid)}`, d) as Promise<ReviewFindingResult>,
    previewReviewSubmit: (id, rid, input) =>
      request("POST", `${p(id)}/reviews/${encodeURIComponent(rid)}/submit-preview`, input) as Promise<ReviewSubmitPreview>,
    submitReview: (id, rid, input) => request("POST", `${p(id)}/reviews/${encodeURIComponent(rid)}/submit`, input) as Promise<ReviewSubmitResult>,
    getContextOverview: (id) => request("GET", `${p(id)}/context`) as Promise<ContextOverview | ContextBreakdown>,
    compactNow: async (id) => {
      await request("POST", `${p(id)}/compact`, {});
    },
    getTurnContext: (id, turnId) => request("GET", `${p(id)}/turns/${turnId}/context`) as Promise<ContextReceipt>,
    listTasks: (id) => unwrap<Task[]>(request("GET", `${p(id)}/tasks`), "tasks"),
    listMemory: (id) => request("GET", `${p(id)}/memory`) as Promise<MemoryList>,
    getMemoryFile: (id, path) => request("GET", `${p(id)}/memory/${memoryPath(path)}`) as Promise<MemoryFile>,
    putMemoryFile: (id, path, content, summary) =>
      request("PUT", `${p(id)}/memory/${memoryPath(path)}`, summary === undefined ? { content } : { content, summary }) as Promise<MemoryFile>,
    deleteMemoryFile: async (id, path) => {
      await request("DELETE", `${p(id)}/memory/${memoryPath(path)}`);
    },
    searchMemory: (id, params) => {
      const q = [`q=${encodeURIComponent(params.q)}`];
      if (params.in !== undefined && params.in.length > 0) q.push(`in=${params.in.join(",")}`);
      if (params.after !== undefined) q.push(`after=${encodeURIComponent(params.after)}`);
      if (params.before !== undefined) q.push(`before=${encodeURIComponent(params.before)}`);
      if (params.limit !== undefined) q.push(`limit=${params.limit}`);
      return request("GET", `${p(id)}/memory/search?${q.join("&")}`) as Promise<MemorySearchResult>;
    },
    listDirs: (path) => request("GET", `/v1/fs/dirs?path=${encodeURIComponent(path)}`) as Promise<DirListing>,
    recentFolders: () => unwrap<FolderEntry[]>(request("GET", "/v1/fs/recent"), "entries"),
    pickFolder: (start) => request("POST", "/v1/fs/pick-folder", start === undefined ? undefined : { start }) as Promise<PickFolderResult>,
    getDiagnostics: () => request("GET", "/v1/diagnostics") as Promise<Diagnostics>,
    getSettings: () => request("GET", "/v1/settings") as Promise<SettingsView>,
    putSettings: (update) => request("PUT", "/v1/settings", update) as Promise<SettingsView>,
    listProviders: () => request("GET", "/v1/providers") as Promise<ProvidersResponse>,
    refreshProviderModels: async (id) => asProvider(await request("POST", `/v1/providers/${encodeURIComponent(id)}/refresh-models`), id),
    setProviderCustomModels: async (id, models) => asProvider(await request("PUT", `/v1/providers/${encodeURIComponent(id)}/custom-models`, { models }), id),
    setProviderPrefs: async (id, prefs) => asProvider(await request("PUT", `/v1/providers/${encodeURIComponent(id)}/prefs`, prefs), id),
    openLanguageServer: (id, serverId) =>
      openLspSession(
        {
          request,
          openStream: (path) => new (options.EventSource ?? globalEventSource())(streamUrl(path)),
        },
        p(id),
        serverId,
      ),
    subscribe(id, handlers) {
      const Ctor = options.EventSource ?? globalEventSource();
      const source = new Ctor(streamUrl(`${p(id)}/events`));
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
