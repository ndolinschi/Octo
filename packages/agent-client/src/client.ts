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
} from "./types";

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
  /** Parity B3: the plan the newest plan-mode turn produced; 404 `not_found` without one. */
  getLatestPlan?(projectId: string): Promise<Plan>;
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
  /** Parity B7: past requests of all projects (the palette). */
  searchRequests?(query: string, limit?: number): Promise<RequestHit[]>;
  /** What agents changed, one entry per file per turn, newest turn first; `turnId` narrows to one turn. */
  listChanges?(projectId: string, turnId?: number): Promise<TurnChanges[]>;
  getChange?(projectId: string, changeId: number): Promise<ChangeDetail>;
  /** Writes the content before the change back; 409 `file_changed` when the file moved on, 409 `revert_unavailable` without a stored original. */
  revertChange?(projectId: string, changeId: number): Promise<RevertResult>;
  listApprovals?(projectId: string): Promise<Approval[]>;
  resolveApproval?(projectId: string, approvalId: string, answer: ApprovalAnswer): Promise<void>;
  /** The project's saved "always allow" rules (parity B4), oldest first. */
  listApprovalRules?(projectId: string): Promise<ApprovalRule[]>;
  /** Removes a rule: requests it covered are asked about again. 404 `not_found` for an unknown id. */
  deleteApprovalRule?(projectId: string, ruleId: string): Promise<void>;
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
  /** M4: sessions, newest first (`before` is a `started_at` to page from), one session with its exchanges, forget one exchange. */
  listMemorySessions?(projectId: string, params?: MemorySessionsParams): Promise<MemorySession[]>;
  getMemorySession?(projectId: string, sessionId: string): Promise<MemorySessionDetail>;
  forgetExchange?(projectId: string, exchangeId: string): Promise<void>;
  /** Project sessions: list (default: not archived, newest first), one with its exchanges and children, and its own transcript. */
  listSessions?(projectId: string, params?: SessionsParams): Promise<ProjectSession[]>;
  getSession?(projectId: string, sessionId: string): Promise<ProjectSessionDetail>;
  getSessionTranscript?(projectId: string, sessionId: string): Promise<Transcript>;
  /** A new main session, made current (like `/clear`); 409 `turn_in_progress` while a turn runs. */
  createSession?(projectId: string, title?: string): Promise<ProjectSession>;
  /** Makes a main session current; 409 `turn_in_progress`, `not_main_session`. */
  resumeSession?(projectId: string, sessionId: string): Promise<ProjectSession>;
  /** Title and/or archive flag; 409 `current_session` when archiving the current one. */
  patchSession?(projectId: string, sessionId: string, patch: { title?: string; archived?: boolean }): Promise<ProjectSession>;
  /** 409 `current_session`, `session_running`. */
  deleteSession?(projectId: string, sessionId: string): Promise<void>;
  /** Stops the project's running turn (current main session) or one sub-agent; 409 `not_running`. */
  stopSession?(projectId: string, sessionId: string): Promise<ProjectSession>;
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
    stopSide: async (id) => {
      await request("POST", `${p(id)}/side/stop`);
    },
    uploadAttachment: async (id, data, opts) => {
      const doFetch = options.fetchBinary ?? globalBinaryFetch();
      const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (token !== "") headers.Authorization = `Bearer ${token}`;
      const name = opts?.name ? `?name=${encodeURIComponent(opts.name)}` : "";
      let res: FetchResponseLike;
      let text: string;
      try {
        res = await doFetch(`${base}${p(id)}/attachments${name}`, { method: "POST", headers, body: data });
        text = await res.text();
      } catch (e) {
        throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw toBridgeError(res.status, text);
      const body = parseJson(text);
      if (!isRecord(body) || typeof body.id !== "string") throw new BridgeError(0, "invalid_response", 'missing "id" in response');
      return body as unknown as Attachment;
    },
    fetchAttachment: async (id, attachmentId) => {
      const doFetch = options.fetchBinary ?? globalBinaryFetch();
      const headers: Record<string, string> = {};
      if (token !== "") headers.Authorization = `Bearer ${token}`;
      let res: FetchResponseLike;
      try {
        res = await doFetch(`${base}${p(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "GET", headers });
      } catch (e) {
        throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw toBridgeError(res.status, await res.text());
      if (!res.arrayBuffer) throw new BridgeError(0, "invalid_response", "this fetch cannot read binary bodies");
      return { data: await res.arrayBuffer(), type: res.headers?.get("Content-Type") ?? "application/octet-stream" };
    },
    askSide: (id, text) => request("POST", `${p(id)}/side`, { text }) as Promise<SideStarted>,
    listSide: (id) => unwrap<SideMessage[]>(request("GET", `${p(id)}/side`), "messages"),
    clearSide: async (id) => {
      await request("DELETE", `${p(id)}/side`);
    },
    listNotes: (id) => unwrap<Note[]>(request("GET", `${p(id)}/notes`), "notes"),
    getNote: (id, noteId) => request("GET", `${p(id)}/notes/${encodeURIComponent(noteId)}`) as Promise<NoteDocument>,
    createNote: (id, input) => request("POST", `${p(id)}/notes`, input) as Promise<NoteDocument>,
    updateNote: (id, noteId, patch) => request("PATCH", `${p(id)}/notes/${encodeURIComponent(noteId)}`, patch) as Promise<NoteDocument>,
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
    sendOrQueueMessage: async (id, text, opts) => {
      const payload: Record<string, unknown> = { text };
      if (opts?.mode) payload.mode = opts.mode;
      if (opts?.attachments && opts.attachments.length > 0) payload.attachments = opts.attachments;
      const body = await request("POST", `${p(id)}/messages`, payload);
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
    sendQueuedNow: async (id, qid, opts) => {
      await request("POST", `${p(id)}/queue/${encodeURIComponent(qid)}/send-now`, opts?.interrupt ? { interrupt: true } : undefined);
    },
    steerQueued: async (id, qid) => {
      const body = await request("POST", `${p(id)}/queue/${encodeURIComponent(qid)}/send-now`);
      return { steered: isRecord(body) && body.steered === true };
    },
    getLatestPlan: (id) => unwrap<Plan>(request("GET", `${p(id)}/plans/latest`), "plan"),
    approvePlan: (id, planId) => request("POST", `${p(id)}/plans/${encodeURIComponent(planId)}/approve`) as Promise<{ plan: Plan; message: Message }>,
    rewind: (id, input) => request("POST", `${p(id)}/rewind`, input) as Promise<RewindReport>,
    compactNow: (id) => request("POST", `${p(id)}/compact`) as Promise<CompactResult | CompactSentToAgent>,
    getSlashCommands: (id) => request("GET", `${p(id)}/slash-commands`) as Promise<SlashCommands>,
    clearConversation: (id) => request("POST", `${p(id)}/clear`) as Promise<ClearResult>,
    rememberFact: (id, input) => request("POST", `${p(id)}/facts`, input) as Promise<RememberedFact>,
    forgetFact: async (id, taskId, factId) => {
      await request("DELETE", `${p(id)}/facts/${encodeURIComponent(taskId)}/${encodeURIComponent(factId)}`);
    },
    exportConversationUrl: (id) => `${base}${p(id)}/export?format=md`,
    searchRequests: (query, limit) =>
      unwrap<RequestHit[]>(request("GET", `/v1/search?q=${encodeURIComponent(query)}${limit === undefined ? "" : `&limit=${limit}`}`), "results"),
    listChanges: (id, turnId) => unwrap<TurnChanges[]>(request("GET", `${p(id)}/changes${turnId === undefined ? "" : `?turn=${turnId}`}`), "turns"),
    getChange: (id, cid) => request("GET", `${p(id)}/changes/${cid}`) as Promise<ChangeDetail>,
    revertChange: (id, cid) => request("POST", `${p(id)}/changes/${cid}/revert`) as Promise<RevertResult>,
    listApprovals: (id) => unwrap<Approval[]>(request("GET", `${p(id)}/approvals`), "approvals"),
    resolveApproval: async (id, aid, answer) => {
      await request("POST", `${p(id)}/approvals/${encodeURIComponent(aid)}`, answer);
    },
    listApprovalRules: (id) => unwrap<ApprovalRule[]>(request("GET", `${p(id)}/approval-rules`), "rules"),
    deleteApprovalRule: async (id, rid) => {
      await request("DELETE", `${p(id)}/approval-rules/${encodeURIComponent(rid)}`);
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
    listPullRequests: (id, params) => {
      const q: string[] = [];
      if (params?.folder) q.push(`folder=${encodeURIComponent(params.folder)}`);
      if (params?.filter) q.push(`filter=${params.filter}`);
      if (params?.q) q.push(`q=${encodeURIComponent(params.q)}`);
      if (params?.page) q.push(`page=${params.page}`);
      if (params?.per_page) q.push(`per_page=${params.per_page}`);
      if (params?.refresh) q.push("refresh=1");
      if (params?.repo) q.push(`repo=${encodeURIComponent(params.repo)}`);
      return request("GET", `${p(id)}/prs${q.length ? `?${q.join("&")}` : ""}`) as Promise<PullRequestList>;
    },
    listReviewBranches: (id, params) => {
      const q: string[] = [];
      if (params?.folder) q.push(`folder=${encodeURIComponent(params.folder)}`);
      if (params?.base) q.push(`base=${encodeURIComponent(params.base)}`);
      return request("GET", `${p(id)}/review/branches${q.length ? `?${q.join("&")}` : ""}`) as Promise<ReviewBranchList>;
    },
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
    listReviewThreads: (id, rid, options) =>
      request("GET", `${p(id)}/reviews/${encodeURIComponent(rid)}/threads${options?.refresh ? "?refresh=1" : ""}`) as Promise<ReviewThreads>,
    checkoutReview: (id, rid, input) => request("POST", `${p(id)}/reviews/${encodeURIComponent(rid)}/checkout`, input) as Promise<ReviewCheckoutResult>,
    clearReviewWorkspace: async (id) => {
      await request("DELETE", `${p(id)}/review-workspace`);
    },
    listCommandSuggestions: (id) => unwrap<CommandSuggestion[]>(request("GET", `${p(id)}/commands/suggestions`), "suggestions"),
    runCommand: (id, name, options) =>
      request(
        "POST",
        `${p(id)}/commands/${encodeURIComponent(name)}/run`,
        options?.reviewId ? { review_id: options.reviewId } : {},
      ) as Promise<StartedCommandRun>,
    listCommandRuns: (id, options) => {
      const q: string[] = [];
      if (options?.reviewId) q.push(`review_id=${encodeURIComponent(options.reviewId)}`);
      if (options?.limit) q.push(`limit=${options.limit}`);
      return unwrap<CommandRun[]>(request("GET", `${p(id)}/runs${q.length ? `?${q.join("&")}` : ""}`), "runs");
    },
    getCommandRun: (id, rid) => request("GET", `${p(id)}/runs/${encodeURIComponent(rid)}`) as Promise<CommandRun>,
    stopCommandRun: (id, rid) => request("POST", `${p(id)}/runs/${encodeURIComponent(rid)}/stop`) as Promise<CommandRun>,
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
    listMemorySessions: (id, params) => {
      const q: string[] = [];
      if (params?.limit !== undefined) q.push(`limit=${params.limit}`);
      if (params?.before !== undefined) q.push(`before=${encodeURIComponent(params.before)}`);
      return unwrap<MemorySession[]>(request("GET", `${p(id)}/memory/sessions${q.length ? `?${q.join("&")}` : ""}`), "sessions");
    },
    getMemorySession: (id, sid) => request("GET", `${p(id)}/memory/sessions/${encodeURIComponent(sid)}`) as Promise<MemorySessionDetail>,
    forgetExchange: async (id, eid) => {
      await request("DELETE", `${p(id)}/memory/exchanges/${encodeURIComponent(eid)}`);
    },
    listSessions: (id, params) => {
      const q: string[] = [];
      if (params?.kind !== undefined) q.push(`kind=${params.kind}`);
      if (params?.state !== undefined) q.push(`state=${params.state}`);
      if (params?.archived !== undefined) q.push(`archived=${params.archived}`);
      if (params?.limit !== undefined) q.push(`limit=${params.limit}`);
      if (params?.before !== undefined) q.push(`before=${encodeURIComponent(params.before)}`);
      return unwrap<ProjectSession[]>(request("GET", `${p(id)}/sessions${q.length ? `?${q.join("&")}` : ""}`), "sessions");
    },
    getSession: (id, sid) => request("GET", `${p(id)}/sessions/${encodeURIComponent(sid)}`) as Promise<ProjectSessionDetail>,
    getSessionTranscript: async (id, sid) => {
      const body = await request("GET", `${p(id)}/sessions/${encodeURIComponent(sid)}/messages`);
      if (!isRecord(body) || !Array.isArray(body.messages)) {
        throw new BridgeError(0, "invalid_response", 'missing "messages" in response');
      }
      return {
        messages: body.messages as Message[],
        compactions: Array.isArray(body.compactions) ? (body.compactions as Transcript["compactions"]) : [],
        ...(Array.isArray(body.conversations) ? { conversations: body.conversations as ConversationMarker[] } : {}),
      };
    },
    createSession: (id, title) => unwrap<ProjectSession>(request("POST", `${p(id)}/sessions`, title === undefined ? undefined : { title }), "session"),
    resumeSession: (id, sid) => unwrap<ProjectSession>(request("POST", `${p(id)}/sessions/${encodeURIComponent(sid)}/resume`), "session"),
    patchSession: (id, sid, patch) => unwrap<ProjectSession>(request("PATCH", `${p(id)}/sessions/${encodeURIComponent(sid)}`, patch), "session"),
    deleteSession: async (id, sid) => {
      await request("DELETE", `${p(id)}/sessions/${encodeURIComponent(sid)}`);
    },
    stopSession: (id, sid) => unwrap<ProjectSession>(request("POST", `${p(id)}/sessions/${encodeURIComponent(sid)}/stop`), "session"),
    messageSession: async (id, sid, text, opts) => {
      const body: { text: string; report_to_parent?: boolean } = { text };
      if (opts?.reportToParent) body.report_to_parent = true;
      return (await request("POST", `${p(id)}/sessions/${encodeURIComponent(sid)}/messages`, body)) as SessionMessageResult;
    },
    listDirs: (path) => request("GET", `/v1/fs/dirs?path=${encodeURIComponent(path)}`) as Promise<DirListing>,
    recentFolders: () => unwrap<FolderEntry[]>(request("GET", "/v1/fs/recent"), "entries"),
    pickFolder: (start) => request("POST", "/v1/fs/pick-folder", start === undefined ? undefined : { start }) as Promise<PickFolderResult>,
    getDiagnostics: () => request("GET", "/v1/diagnostics") as Promise<Diagnostics>,
    getSettings: () => request("GET", "/v1/settings") as Promise<SettingsView>,
    putSettings: (update) => request("PUT", "/v1/settings", update) as Promise<SettingsView>,
    listProviders: () => request("GET", "/v1/providers") as Promise<ProvidersResponse>,
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
