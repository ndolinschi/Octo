import { RARE_METHODS, type RareMethod } from "./rareNames";
import type { RemoteAccessApi } from "./remoteAccess";
import type { CommandRun, CommandSuggestion, StartedCommandRun } from "./commands";
import type {
  ListPullRequestsParams,
  ListReviewBranchesParams,
  ReviewBranchList,
  RepoRef,
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
  ReviewThreads,
  ReviewCheckoutInput,
  ReviewCheckoutResult,
  ReviewDirtyFile,
} from "./review";
import type {
  Attachment,
  Agent,
  ContextReceipt,
  MemoryFile,
  MemoryList,
  MemorySearchParams,
  MemorySearchResult,
  MemorySession,
  MemorySessionDetail,
  MemorySessionsParams,
  ProjectSession,
  ProjectSessionDetail,
  AllSessionsParams,
  CreatedSession,
  GlobalSession,
  NewSessionInput,
  SessionMessageResult,
  SessionsParams,
  Task,
  Diagnostics,
  Approval,
  ApprovalAnswer,
  ApprovalRule,
  CompactResult,
  Plan,
  ProjectMode,
  RequestHit,
  RewindReport,
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
  NoteDocument,
  NoteInput,
  NotePatch,
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
  ClearResult,
  CompactSentToAgent,
  ConversationMarker,
  RememberKind,
  RememberedFact,
  SlashCommands,
  UsageParams,
  UsageReport,
  WriteFileInput,
  ErrorAction,
} from "./types";

/** A `Blob` without the DOM lib (this package type-checks without browser globals): what `new Blob(...)` returns where one exists. */
export type BlobLike = { readonly size: number; readonly type: string; text(): Promise<string> };

/** Loads the lazy half of the HTTP client (see `rare.ts`) ahead of its first use; call it when the app is idle. */
export function warmBridgeClient(): void {
  // A failed load here surfaces on the first real call, which retries.
  import("./rare").catch(() => undefined);
}

export class BridgeError extends Error {
  readonly status: number;
  readonly code: string;
  /** `model_unavailable` (422): the provider that would run the model, and what is missing. */
  readonly provider?: string;
  readonly reason?: string;
  /**
   * `model_unavailable` (422) only: the refusal rests on a login probe, which is advisory. Repeating the request with
   * `force_unverified: true` is accepted. Never true for a missing command. Additive: absent on older harnesses.
   */
  readonly can_force?: boolean;
  /** The command the server says fixes this (`not_logged_in`: "gh auth login"); additive, absent when it sends none. */
  readonly command?: string;
  /** `dirty_working_copy` (409) of a working-copy checkout: the uncommitted changes. */
  readonly files?: ReviewDirtyFile[];
  /** `repo_mismatch`, `invalid_repo`, `ambiguous_pr` (review): the repositories of the folder to choose from. */
  readonly repos?: RepoRef[];
  /** What to do next, in plain words (decision 94b); absent when the server sends none. `message` is the plain sentence. */
  readonly hint?: string;
  /** A button the UI may offer; absent means none. */
  readonly action?: ErrorAction;
  /** The technical text, for a "Details" fold. */
  readonly details?: string;
  /** `rewind_conflict`: `error.details` is the report object, kept here as data. */
  readonly data?: unknown;
  /**
   * `invalid_request` (400) of a form answer (dynamic forms, decision 4): a message by property id. Names fields, never
   * values; absent from an older harness, whose message names the field ids instead.
   */
  readonly fields?: Readonly<Record<string, string>>;

  constructor(
    status: number,
    code: string,
    message: string,
    detail?: {
      provider?: string;
      reason?: string;
      can_force?: boolean;
      command?: string;
      files?: ReviewDirtyFile[];
      repos?: RepoRef[];
      hint?: string;
      action?: ErrorAction;
      details?: string;
      data?: unknown;
      fields?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
    if (detail?.provider !== undefined) this.provider = detail.provider;
    if (detail?.reason !== undefined) this.reason = detail.reason;
    if (detail?.can_force !== undefined) this.can_force = detail.can_force;
    if (detail?.command !== undefined) this.command = detail.command;
    if (detail?.files !== undefined) this.files = detail.files;
    if (detail?.repos !== undefined) this.repos = detail.repos;
    if (detail?.hint !== undefined) this.hint = detail.hint;
    if (detail?.action !== undefined) this.action = detail.action;
    if (detail?.details !== undefined) this.details = detail.details;
    if (detail?.data !== undefined) this.data = detail.data;
    if (detail?.fields !== undefined) this.fields = detail.fields;
  }
}

export type FetchResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Present on a real fetch Response: the binary body (attachments). */
  arrayBuffer?(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
};

/** The part of AbortSignal the client passes on to fetch (this package builds without the DOM lib). */
export type AbortSignalLike = { readonly aborted: boolean };

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignalLike },
) => Promise<FetchResponseLike>;

/** The same fetch, for binary bodies (attachments); the global `fetch` satisfies both. */
export type BinaryFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignalLike },
) => Promise<FetchResponseLike>;

export type EventSourceLike = {
  /** 0 connecting, 1 open, 2 closed (a refused connection: EventSource does not retry it). */
  readonly readyState?: number;
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

/** Timers and a clock, passed in like `fetch` (this package builds without DOM or Node types); default: the global ones. */
export type TimersLike = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void; now(): number };

/** The event stream as the watchdog (`watchStream`, lazy) sees it. */
export type StreamHandle = {
  /** When the stream last carried anything: opened, an event, a heartbeat. */
  seen: number;
  source: EventSourceLike | null;
  open(): void;
  /** Set by the watchdog: EventSource gave up on a refused connection. */
  refused?: () => void;
};

/** Backoff for retries after a failure: 1 s, 2 s, 4 s … up to `cap`. `attempt` counts from 1. */
export function retryDelay(attempt: number, cap = 30_000): number {
  return Math.min(cap, 1000 * 2 ** Math.min(Math.max(attempt - 1, 0), 20));
}

/**
 * P2-12: how far the service's clock (`Date` of its answer) is ahead of this machine's, in ms; 0 when the gap is under
 * 30 s (the header has 1 s resolution and a request takes time) or there is no usable header.
 */
export function clockSkew(dateHeader: string | null | undefined, localMs: number): number {
  const server = dateHeader ? Date.parse(dateHeader) : NaN;
  const skew = server - localMs;
  return Number.isFinite(skew) && Math.abs(skew) > 30_000 ? skew : 0;
}

/** The harness answered but refused this window's API token (it restarted with a new one): not "offline". */
export function isAuthRefused(e: unknown): boolean {
  return e instanceof BridgeError && e.status === 401;
}

export interface Bridge {
  health(): Promise<HealthResponse>;
  /** P2-12: the service's clock minus this machine's (ms), from the last answer's `Date` header; 0 when close. HTTP bridge only. */
  clockOffset?(): number;
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
  /** With `sessionId`, only that main session's part of the orchestrator's conversation (project sessions). */
  getTranscript(projectId: string, agentId: string, opts?: { sessionId?: string }): Promise<Transcript>;
  sendMessage(projectId: string, text: string): Promise<Message>;
  cancelTurn(projectId: string): Promise<void>;
  /** The orchestrator's context by part, or another agent's with `agentId`. */
  getContext(projectId: string, agentId?: string): Promise<ContextBreakdown>;
  /**
   * Decision 65: the context window by category, for the composer's context button. The same URL as `getContext` on
   * a harness that sends the new shape; the UI reads either (`ContextBreakdown` is the older one). Optional.
   */
  getContextOverview?(projectId: string): Promise<ContextOverview | ContextBreakdown>;
  /** Ask the side question; resolves with the stored question, the answer streams as side.* events. */
  askSide(projectId: string, text: string): Promise<SideStarted>;
  listSide(projectId: string): Promise<SideMessage[]>;
  /** Cancels a running side question and deletes the side conversation. */
  clearSide(projectId: string): Promise<void>;
  listNotes(projectId: string): Promise<Note[]>;
  /** One note with its body and Markdown source (lists leave bodies out). Optional: older harnesses return bodies in the list. */
  getNote?(projectId: string, noteId: string): Promise<NoteDocument>;
  createNote(projectId: string, input: NoteInput): Promise<NoteDocument>;
  updateNote(projectId: string, noteId: string, patch: NotePatch): Promise<NoteDocument>;
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
  /**
   * `POST /v1/providers/{id}/recheck`: runs the agent's login probe now ("I have logged in: check again"; the detail
   * pane's "Check again", decision 89 d) and answers the provider entry; `providers.updated` follows. 404 for an id that
   * is not an agent. Optional; a host without it re-reads `listProviders`.
   */
  recheckProvider?(id: string): Promise<Provider | null>;
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
  /** Remote access: the computer's `/v1/remote` control routes (local token only), loaded on first use. Optional; HTTP only. */
  remoteAccess?(): Promise<RemoteAccessApi>;
  /**
   * Decision 53: every provider (API key, router, agent CLIs) with its state and models. Optional: a harness that
   * predates `GET /v1/providers` answers 404, and the UI then derives the list from the config and the plugins.
   */
  /*
   * v7 members. All optional (only the HTTP bridge implements them; the message and demo bridges do not), so a host
   * that predates them keeps compiling; hosts check for presence.
   */
  /** Like sendMessage, but a message sent while a turn runs is queued (202) and resolves as `{ queued }`. */
  sendOrQueueMessage?(projectId: string, text: string, opts?: { mode?: ProjectMode; attachments?: string[] }): Promise<SendResult>;
  /**
   * Parity B12: stores one image (raw bytes; the harness decides the type by sniffing and refuses above 5 MB: 413
   * `attachment_too_large`, 415 `unsupported_media_type`). Optional like the v7 members.
   */
  uploadAttachment?(projectId: string, data: Uint8Array, opts?: { name?: string }): Promise<Attachment>;
  /** Parity B12: the bytes of an attachment (for thumbnails and the preview). */
  fetchAttachment?(projectId: string, attachmentId: string): Promise<{ data: ArrayBuffer; type: string }>;
  /** Parity B13: stops the running side question, keeping the side conversation and its agent session. */
  stopSide?(projectId: string): Promise<void>;
  getQueue?(projectId: string): Promise<QueueState>;
  editQueued?(projectId: string, queueId: string, text: string): Promise<QueuedMessage>;
  removeQueued?(projectId: string, queueId: string): Promise<void>;
  /** Removes every queued message. */
  clearQueue?(projectId: string): Promise<void>;
  /** Lifts the pause after a failed or cancelled turn. */
  resumeQueue?(projectId: string): Promise<void>;
  /** Cancels the running turn and runs that queued message next. */
  sendQueuedNow?(projectId: string, queueId: string, opts?: { interrupt?: boolean }): Promise<void>;
  /**
   * Parity B6: "send now" without cancelling. A running built-in turn takes the message at its next tool boundary
   * (`steered: true`, event `message.steered`; if the turn ends first it runs next); an ACP turn answers 409
   * `steer_unsupported`: say the message is sent when the turn ends, or use `sendQueuedNow(..., { interrupt: true })`.
   */
  steerQueued?(projectId: string, queueId: string): Promise<{ steered: boolean }>;
  /**
   * Parity B3: the plan the newest plan-mode turn produced; `null` without one (the harness answers `{"plan": null}`;
   * an older harness answered 404 `not_found`, which this client also turns into `null`).
   */
  getLatestPlan?(projectId: string): Promise<Plan | null>;
  /** Approves a plan and starts an `agent` turn with it pinned; 409 `plan_not_pending` / `turn_in_progress`. */
  approvePlan?(projectId: string, planId: string): Promise<{ plan: Plan; message: Message }>;
  /** Parity B5: cut the conversation back to a request and restore the files after it (see {@link RewindReport}). */
  rewind?(projectId: string, input: { message_id: number; dry_run?: boolean }): Promise<RewindReport>;
  /** Parity B7 (`POST /v1/projects/{id}/compact`; "Compact now" is hidden without it): summarise the conversation now; 409 `nothing_to_compact` / `compact_unsupported` / `turn_in_progress`. */
  compactNow?(projectId: string): Promise<CompactResult | CompactSentToAgent>;
  /** B11 (`GET .../slash-commands`): the Octo commands and the ACP agent's own; the menu is Octo-only without it. */
  getSlashCommands?(projectId: string): Promise<SlashCommands>;
  /**
   * B11 (`POST .../clear`; `/clear`): tidy the project: the on-screen transcript restarts under a marker, the model's history is
   * dropped and replaced by a short carry-over (a summary written now, the open tasks, a pointer to recall the rest). Nothing is deleted.
   * 409 `turn_in_progress`.
   */
  clearConversation?(projectId: string): Promise<ClearResult>;
  /** B11 (`POST .../facts`; `/remember <text>`): keep a note as a dated fact; `kind` defaults to `fact`. */
  rememberFact?(projectId: string, input: { text: string; kind?: RememberKind; about?: string }): Promise<RememberedFact>;
  /** B11 (`DELETE .../facts/{task}/{fact}`): the undo of a remembered item. */
  forgetFact?(projectId: string, taskId: string, factId: string): Promise<void>;
  /** Parity B7: where the conversation as Markdown is (`GET`, `text/markdown`); the host downloads it. */
  exportConversationUrl?(projectId: string): string;
  /**
   * The conversation as Markdown, fetched with the `Authorization` header (a plain link carries no token, and the harness
   * takes `?token=` only on its two SSE routes). The host saves the Blob; prefer this over the URL against a real harness.
   */
  exportConversation?(projectId: string): Promise<BlobLike>;
  /** Parity B7: past requests of all projects (the palette). */
  searchRequests?(query: string, limit?: number): Promise<RequestHit[]>;
  /** What agents changed, one entry per file per turn, newest turn first; `turnId` narrows to one turn. */
  listChanges?(projectId: string, turnId?: number): Promise<TurnChanges[]>;
  getChange?(projectId: string, changeId: number): Promise<ChangeDetail>;
  /** Writes the content before the change back; 409 `file_changed` when the file moved on, 409 `revert_unavailable` without a stored original. */
  revertChange?(projectId: string, changeId: number): Promise<RevertResult>;
  /** Pending approvals; `sessionId` keeps one main session's (`?session=`). */
  listApprovals?(projectId: string, opts?: { sessionId?: string }): Promise<Approval[]>;
  resolveApproval?(projectId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  /** The project's saved "always allow" rules (parity B4), oldest first. */
  listApprovalRules?(projectId: string): Promise<ApprovalRule[]>;
  /** Removes a rule: requests it covered are asked about again. 404 `not_found` for an unknown id. */
  deleteApprovalRule?(projectId: string, ruleId: string): Promise<void>;
  listInputs?(projectId: string, opts?: { sessionId?: string }): Promise<InputRequest[]>;
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
  /** M4: sessions, newest first (`before` is a `started_at` to page from), one session with its exchanges, forget one exchange. */
  listMemorySessions?(projectId: string, params?: MemorySessionsParams): Promise<MemorySession[]>;
  getMemorySession?(projectId: string, sessionId: string): Promise<MemorySessionDetail>;
  forgetExchange?(projectId: string, exchangeId: string): Promise<void>;
  /** Project sessions: list (default: not archived, newest first), one with its exchanges and children, and its own transcript. */
  listSessions?(projectId: string, params?: SessionsParams): Promise<ProjectSession[]>;
  getSession?(projectId: string, sessionId: string): Promise<ProjectSessionDetail>;
  getSessionTranscript?(projectId: string, sessionId: string): Promise<Transcript>;
  /**
   * Parallel sessions: a new main session (not the default unless `make_default`; with `from_session_id` and `clear` it is
   * `/clear` of that session); `text` sends its first message. 404 `workspace_not_found`, 409 `worktree_unavailable`,
   * 409 `turn_in_progress` (clear of a running session).
   */
  createSession(projectId: string, input?: NewSessionInput): Promise<CreatedSession>;
  /** Makes a main session the default (where unaddressed messages go); nothing stops or rebuilds. 409 `not_main_session`. */
  setDefaultSession(projectId: string, sessionId: string): Promise<ProjectSession>;
  /** The old name of {@link setDefaultSession} (`POST /sessions/{sid}/resume`). */
  resumeSession?(projectId: string, sessionId: string): Promise<ProjectSession>;
  /** Title and/or archive flag; 409 `current_session` when archiving the default one. */
  patchSession?(projectId: string, sessionId: string, patch: { title?: string; archived?: boolean }): Promise<ProjectSession>;
  /** 409 `current_session` (the default), `session_running`. */
  deleteSession?(projectId: string, sessionId: string): Promise<void>;
  /** Stops a main session's running turn (pausing its queue) or one sub-agent; 409 `not_running`. */
  stopSession(projectId: string, sessionId: string): Promise<ProjectSession>;
  /**
   * A message to a main session: it starts that session's turn, or waits in its queue (`waiting_for`: its own turn, or a
   * free slot under the running caps). The same timeout and read-back as `sendOrQueueMessage`. 409 `queue_full`.
   */
  sendSessionMessage(projectId: string, sessionId: string, text: string, opts?: { mode?: ProjectMode; attachments?: string[] }): Promise<SendResult>;
  /** `GET /v1/sessions`: main sessions across projects, newest activity first, each with its project. */
  listAllSessions(params?: AllSessionsParams): Promise<GlobalSession[]>;
  /** One main session's queue (the project routes of the same name act on the default session). */
  getSessionQueue?(projectId: string, sessionId: string): Promise<QueueState>;
  editSessionQueued?(projectId: string, sessionId: string, queueId: string, text: string): Promise<QueuedMessage>;
  removeSessionQueued?(projectId: string, sessionId: string, queueId: string): Promise<void>;
  clearSessionQueue?(projectId: string, sessionId: string): Promise<void>;
  resumeSessionQueue?(projectId: string, sessionId: string): Promise<void>;
  sendSessionQueuedNow?(projectId: string, sessionId: string, queueId: string, opts?: { interrupt?: boolean }): Promise<void>;
  /** One main session's context report, compaction, rewind, latest plan and export (the project routes act on the default). */
  getSessionContext?(projectId: string, sessionId: string): Promise<ContextOverview | ContextBreakdown>;
  compactSession?(projectId: string, sessionId: string): Promise<CompactResult | CompactSentToAgent>;
  /** `/clear` of one session: the answer is the new session (the default when the cleared one was). */
  clearSession?(projectId: string, sessionId: string): Promise<CreatedSession>;
  rewindSession?(projectId: string, sessionId: string, input: { message_id: number; dry_run?: boolean }): Promise<RewindReport>;
  getSessionLatestPlan?(projectId: string, sessionId: string): Promise<Plan | null>;
  exportSessionUrl?(projectId: string, sessionId: string): string;
  exportSession?(projectId: string, sessionId: string): Promise<BlobLike>;
  /** A message to a sub-agent's session; 409 `steer_unsupported`, `not_continuable`, `not_running`, `builtin_loop_unavailable`, `not_agent_session`. */
  messageSession?(projectId: string, sessionId: string, text: string, opts?: { reportToParent?: boolean }): Promise<SessionMessageResult>;
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
  /**
   * All open pull requests of the project's repository, newest activity first, filtered and paged; or why they cannot be
   * listed. Answered from a 60 s per-folder cache (`stale: true` while refreshing; `review.list_updated` when it is in).
   */
  listPullRequests?(projectId: string, params?: ListPullRequestsParams): Promise<PullRequestList>;
  /**
   * The folder's local branches for a local-branch review (`GET /review/branches`): git only, no network. The current
   * branch first, then newest last commit first, each with ahead/behind against `base` (default: the default remote's default branch).
   */
  listReviewBranches?(projectId: string, params?: ListReviewBranchesParams): Promise<ReviewBranchList>;
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
  /** The review threads the code host already has, grouped, with counts per file (refreshed with the review; `refresh` asks the host now). */
  listReviewThreads?(projectId: string, reviewId: string, options?: { refresh?: boolean }): Promise<ReviewThreads>;
  /**
   * Check a pull request out. `workspace` points the project at the review's worktree (see `Project.review_workspace`);
   * `working_copy` switches the project's own folder to a local branch: 409 `dirty_working_copy` (`BridgeError.files`) unless
   * `confirm`, 409 `checkout_conflict` / `branch_diverged` / `detached_head` when git must not be forced.
   */
  checkoutReview?(projectId: string, reviewId: string, input: ReviewCheckoutInput): Promise<ReviewCheckoutResult>;
  /** Points the project back at its own folders. */
  clearReviewWorkspace?(projectId: string): Promise<void>;
  /*
   * Project commands (decision 68, apps/harness/docs/commands.md). Optional: HTTP bridge only. The list itself is
   * `Project.commands` (set with `updateProject`). A command runs only when these are called, by the user's own button.
   */
  /** Commands the project's package.json scripts, Makefile targets and justfile recipes suggest; reads files, runs nothing. */
  listCommandSuggestions?(projectId: string): Promise<CommandSuggestion[]>;
  /** Runs the named command (case-insensitive) in the project's folder, or in the review's worktree with `reviewId`; output follows as `command.*` events. 409 `too_many_runs` above 4 at once. */
  runCommand?(projectId: string, name: string, options?: { reviewId?: string }): Promise<StartedCommandRun>;
  /** Newest first, without output; `reviewId` narrows to one review's runs. */
  listCommandRuns?(projectId: string, options?: { reviewId?: string; limit?: number }): Promise<CommandRun[]>;
  /** Status and the tail of the output. */
  getCommandRun?(projectId: string, runId: string): Promise<CommandRun>;
  /** Ends the run's process group (SIGTERM, then SIGKILL); answers with the run once it ended. */
  stopCommandRun?(projectId: string, runId: string): Promise<CommandRun>;
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
  timers?: TimersLike;
  /** Defaults (in `rare.ts`): `SEND_TIMEOUT_MS`, `STREAM_STALE_MS`. */
  sendTimeoutMs?: number;
  streamStaleMs?: number;
  /** Used for attachment upload and download; defaults to the global `fetch`. */
  fetchBinary?: BinaryFetchLike;
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
  "plan.created",
  "plan.approved",
  "conversation.rewound",
  "message.steered",
  "context.updated",
  "slash_commands.updated",
  "conversation.cleared",
  "session.created",
  "session.updated",
  "session.current",
  "session.default",
  "fact.remembered",
  "fact.forgotten",
  "side.delta",
  "side.done",
  "side.error",
  "side.thinking",
  "side.activity",
  "side.tool",
  "settings.changed",
  "change.recorded",
  "approval.requested",
  "approval.resolved",
  "approval_rule.created",
  "approval_rule.deleted",
  "input.requested",
  "input.resolved",
  "queue.updated",
  "project.attention",
  "secrets.changed",
  "providers.updated",
  "task.updated",
  "memory.updated",
  "review.updated",
  "review.list_updated",
  "review.workspace",
  "command.started",
  "command.output",
  "command.finished",
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

const ERROR_ACTIONS: readonly string[] = ["recheck_provider", "connect_provider", "retry", "open_settings", "update_agent"];

function isErrorAction(v: unknown): v is ErrorAction {
  return typeof v === "string" && ERROR_ACTIONS.includes(v);
}

/** `error.fields` of a refused form answer: only string messages under non-empty ids are kept. */
function fieldMessages(v: unknown): { fields: Record<string, string> } | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [id, message] of Object.entries(v)) if (id && typeof message === "string" && message.trim()) out[id] = message.trim();
  return Object.keys(out).length ? { fields: out } : null;
}

function toBridgeError(status: number, text: string): BridgeError {
  const body = parseJson(text);
  const err = isRecord(body) ? body.error : undefined;
  if (isRecord(err) && typeof err.message === "string") {
    const code = typeof err.code === "string" ? err.code : "http_error";
    const detail = {
      ...(typeof err.provider === "string" ? { provider: err.provider } : {}),
      ...(typeof err.reason === "string" ? { reason: err.reason } : {}),
      ...(typeof err.can_force === "boolean" ? { can_force: err.can_force } : {}),
      ...(typeof err.command === "string" && err.command.trim() ? { command: err.command.trim() } : {}),
      ...(Array.isArray(err.files) ? { files: err.files as ReviewDirtyFile[] } : {}),
      ...(Array.isArray(err.repos) ? { repos: err.repos as RepoRef[] } : {}),
      ...(typeof err.hint === "string" && err.hint ? { hint: err.hint } : {}),
      ...(isErrorAction(err.action) ? { action: err.action } : {}),
      ...(typeof err.details === "string" && err.details ? { details: err.details } : {}),
      ...(err.details !== undefined && typeof err.details !== "string" ? { data: err.details } : {}),
      ...(fieldMessages(err.fields) ?? {}),
    };
    return new BridgeError(status, code, err.message, detail);
  }
  const snippet = text.trim().slice(0, 200);
  return new BridgeError(status, "http_error", snippet || `HTTP ${status}`);
}

function globalBinaryFetch(): BinaryFetchLike {
  const f = (globalThis as { fetch?: BinaryFetchLike }).fetch;
  if (!f) throw new BridgeError(0, "no_fetch", "no global fetch: pass `fetchBinary` in the options");
  return f.bind(globalThis);
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
export type HttpBridge = Bridge &
  Required<Pick<Bridge, "getSettings" | "putSettings" | "listProviders" | "refreshProviderModels" | "recheckProvider" | "setProviderCustomModels">>;

export function createHttpBridge(options: HttpBridgeOptions): HttpBridge {
  const base = options.baseUrl.replace(/\/+$/, "");
  const token = (options.token ?? "").trim();
  /** An SSE URL: EventSource sends no headers, so the token travels in the query. */
  const streamUrl = (path: string) => `${base}${path}${token === "" ? "" : `${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`}`;

  // Default timers live in the lazy half (`rare.ts`), the only place that sets any.
  const timers = options.timers;
  let offset = 0;

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
      offset = clockSkew(res.headers?.get("date"), Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BridgeError(0, "network_error", msg);
    }
    if (!res.ok) throw toBridgeError(res.status, text);
    const parsed = parseJson(text);
    // P2-4: an answer that is not JSON is a failure with its own words, not an empty value that leaves a screen waiting.
    if (parsed === undefined && text.trim() !== "") throw new BridgeError(0, "invalid_response", "Octo's local service sent an answer that could not be read.");
    return parsed;
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

  const p = (id: string) => `/v1/projects/${encodeURIComponent(id)}`;
  const sessionQuery = (o: { sessionId?: string } | undefined) => (o?.sessionId ? `?session=${encodeURIComponent(o.sessionId)}` : "");
  const fileQuery = (folder: string, path: string) => `folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`;

  let rare: Promise<Pick<Bridge, RareMethod>> | undefined;
  const loadRare = () => {
    rare ??= import("./rare").then((m) =>
      m.createRareMethods({
        request,
        unwrap,
        p,
        memoryPath,
        base,
        token,
        timers,
        sendTimeout: options.sendTimeoutMs,
        binaryFetch: () => options.fetchBinary ?? globalBinaryFetch(),
        fail: toBridgeError,
      }),
    );
    // A failed chunk load must not stick: the next call tries again.
    rare.catch(() => (rare = undefined));
    return rare;
  };
  type Forward = (...args: never[]) => Promise<unknown>;
  const forwarded = Object.fromEntries(
    RARE_METHODS.map((name) => [name, (...args: never[]) => loadRare().then((m) => (m[name] as Forward)(...args))] as const),
  );

  return {
    // The keys come from RARE_METHODS and `createRareMethods` returns exactly that Pick, so each forwarder has its method's type.
    ...(forwarded as Pick<Bridge, RareMethod>),
    health: () => request("GET", "/health") as Promise<HealthResponse>,
    clockOffset: () => offset,
    getConfig: () => request("GET", "/v1/config") as Promise<BridgeConfig>,
    listProjects: () => unwrap<ProjectSummary[]>(request("GET", "/v1/projects"), "projects"),
    getProject: (id) => request("GET", p(id)) as Promise<Project>,
    listAgents: (id) => unwrap<Agent[]>(request("GET", `${p(id)}/agents`), "agents"),
    getAgent: (id, agentId) => request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}`) as Promise<Agent>,
    listMessages: (id, agentId) => unwrap<Message[]>(request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}/messages`), "messages"),
    getTranscript: async (id, agentId, opts) => {
      const q = opts?.sessionId !== undefined ? `?session_id=${encodeURIComponent(opts.sessionId)}` : "";
      const body = await request("GET", `${p(id)}/agents/${encodeURIComponent(agentId)}/messages${q}`);
      if (!isRecord(body) || !Array.isArray(body.messages)) {
        throw new BridgeError(0, "invalid_response", 'missing "messages" in response');
      }
      return {
        messages: body.messages as Message[],
        compactions: Array.isArray(body.compactions) ? (body.compactions as Transcript["compactions"]) : [],
        ...(Array.isArray(body.conversations) ? { conversations: body.conversations as ConversationMarker[] } : {}),
      };
    },
    listFiles: (id, folder, path) => unwrap<FileEntry[]>(request("GET", `${p(id)}/files?${fileQuery(folder, path)}`), "entries"),
    readFile: (id, folder, path) => request("GET", `${p(id)}/files/content?${fileQuery(folder, path)}`) as Promise<FileContent>,
    getQueue: (id) => request("GET", `${p(id)}/queue`) as Promise<QueueState>,
    exportConversationUrl: (id) => `${base}${p(id)}/export?format=md`,
    listApprovals: (id, o) => unwrap<Approval[]>(request("GET", `${p(id)}/approvals${sessionQuery(o)}`), "approvals"),
    listInputs: (id, o) => unwrap<InputRequest[]>(request("GET", `${p(id)}/inputs${sessionQuery(o)}`), "inputs"),
    exportSessionUrl: (id, sid) => `${base}${p(id)}/sessions/${encodeURIComponent(sid)}/export?format=md`,
    reviewFileRawUrl: (id, rid, path, side) => `${base}${p(id)}/reviews/${encodeURIComponent(rid)}/files/${memoryPath(path)}?raw=${side}`,
    listSessions: (id, params) => {
      const q: string[] = [];
      if (params?.kind !== undefined) q.push(`kind=${params.kind}`);
      if (params?.state !== undefined) q.push(`state=${params.state}`);
      if (params?.archived !== undefined) q.push(`archived=${params.archived}`);
      if (params?.limit !== undefined) q.push(`limit=${params.limit}`);
      if (params?.before !== undefined) q.push(`before=${encodeURIComponent(params.before)}`);
      return unwrap<ProjectSession[]>(request("GET", `${p(id)}/sessions${q.length ? `?${q.join("&")}` : ""}`), "sessions");
    },
    getSettings: () => request("GET", "/v1/settings") as Promise<SettingsView>,
    putSettings: (update) => request("PUT", "/v1/settings", update) as Promise<SettingsView>,
    listProviders: () => request("GET", "/v1/providers") as Promise<ProvidersResponse>,
    remoteAccess: async () => (await import("./remoteAccess")).remoteAccessApi(request),
    refreshProviderModels: async (id) => asProvider(await request("POST", `/v1/providers/${encodeURIComponent(id)}/refresh-models`), id),
    recheckProvider: async (id) => asProvider(await request("POST", `/v1/providers/${encodeURIComponent(id)}/recheck`), id),
    setProviderCustomModels: async (id, models) => asProvider(await request("PUT", `/v1/providers/${encodeURIComponent(id)}/custom-models`, { models }), id),
    setProviderPrefs: async (id, prefs) => asProvider(await request("PUT", `/v1/providers/${encodeURIComponent(id)}/prefs`, prefs), id),
    // Only the editor opens language servers: the session code is its own chunk (it keeps the entry small).
    openLanguageServer: async (id, serverId) =>
      (await import("./lspSession")).openLspSession(
        {
          request,
          openStream: (path) => new (options.EventSource ?? globalEventSource())(streamUrl(path)),
        },
        p(id),
        serverId,
      ),
    /**
     * The project's events. EventSource retries a dropped connection itself; the watchdog (`watchStream`, in the lazy
     * half) also reopens a refused one (closed for good after an HTTP error) with backoff, and a half-open one: nothing
     * at all, not even the harness's `heartbeat`, for `streamStaleMs`. Every reopen ends in `onOpen`, where the caller
     * re-reads what it may have missed.
     */
    subscribe(id, handlers) {
      const Ctor = options.EventSource ?? globalEventSource();
      const h: StreamHandle = {
        seen: 0,
        source: null,
        open: () => {
          const s = new Ctor(streamUrl(`${p(id)}/events`));
          const alive = () => (h.seen = timers?.now() ?? Date.now());
          h.source = s;
          alive();
          s.onopen = () => {
            alive();
            handlers.onOpen?.();
          };
          s.onerror = (err) => {
            handlers.onError?.(err);
            if (s.readyState === 2 && h.source === s) h.refused?.();
          };
          s.addEventListener("heartbeat", alive);
          for (const type of BRIDGE_EVENT_TYPES) {
            s.addEventListener(type, (ev) => {
              alive();
              const event = parseEvent(ev.data);
              if (event) handlers.onEvent(event);
            });
          }
        },
      };
      h.open();
      let stop: (() => void) | undefined;
      let stopped = false;
      // A failed chunk load leaves the stream as EventSource keeps it (no watchdog).
      void import("./rare").then(
        (m) => {
          if (!stopped) stop = m.watchStream(h, handlers.onError, timers, options.streamStaleMs);
        },
        () => undefined,
      );
      return () => {
        stopped = true;
        stop?.();
        h.source?.close();
      };
    },
  };
}
