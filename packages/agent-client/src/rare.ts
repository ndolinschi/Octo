import type {
  Attachment,
  BrowserProxySession,
  CompletionResult,
  ConversationMarker,
  FileStat,
  LanguageServerInfo,
  Plugin,
  Project,
  QueuedMessage,
  QueueState,
  Transcript,
  UsageParams,
} from "./types";
import type { CommandRun, CommandSuggestion, StartedCommandRun, WorkerProcess } from "./commands";
import type {
  ReviewBranchList,
  PullRequestList,
  ReviewSummary,
  Review,
  ReviewFiles,
  ReviewFileDiff,
  ReviewFile,
  ReviewComment,
  ReviewFinding,
  ReviewFindingResult,
  ReviewSubmitPreview,
  ReviewSubmitResult,
  ReviewThreads,
  ReviewCheckoutResult,
} from "./review";
import type {
  ContextReceipt,
  MemoryFile,
  MemoryList,
  MemorySearchResult,
  MemorySession,
  MemorySessionDetail,
  CreatedSession,
  DeleteAllSessionsResult,
  GlobalSession,
  ImportableSession,
  ImportSessionsResult,
  ProjectSession,
  ProjectMode,
  MoveToWorktreeResult,
  SendResult,
  ProjectSessionDetail,
  SessionMessageResult,
  Task,
  Workspace,
  Diagnostics,
  ApprovalRule,
  CompactResult,
  Plan,
  RequestHit,
  RewindReport,
  ChangeDetail,
  RevertResult,
  SecretInfo,
  TurnChanges,
  ContextBreakdown,
  ContextOverview,
  Limit,
  Message,
  Note,
  NoteDocument,
  DirListing,
  FolderEntry,
  SideMessage,
  PickFolderResult,
  SideStarted,
  ClearResult,
  CompactSentToAgent,
  RememberedFact,
  SlashCommands,
  UsageReport,
} from "./types";
import {
  BridgeError,
  retryDelay,
  type AbortSignalLike,
  type BinaryFetchLike,
  type BlobLike,
  type Bridge,
  type FetchResponseLike,
  type StreamHandle,
  type TimersLike,
} from "./client";
import type { RareMethod } from "./rareNames";

/** What the rare methods need from the client that loads them. */
export type RareContext = {
  request(method: string, path: string, body?: unknown, signal?: AbortSignalLike): Promise<unknown>;
  unwrap<T>(promise: Promise<unknown>, key: string): Promise<T>;
  /** `/v1/projects/<id>` */
  p(id: string): string;
  /** A memory path with its slashes kept: each segment is encoded. */
  memoryPath(path: string): string;
  base: string;
  token: string;
  timers: TimersLike | undefined;
  /** The send timeout (`POST …/messages`); default {@link SEND_TIMEOUT_MS}. */
  sendTimeout: number | undefined;
  /** The host's binary fetch (or the global one); throws `no_fetch` where there is none. */
  binaryFetch(): BinaryFetchLike;
  /** The error for a failed response. */
  fail(status: number, text: string): BridgeError;
};

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

function globalTimers(): TimersLike {
  const g = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  return {
    // Under Node a watchdog timer must not keep the process alive (`unref`); a browser's timer id is a number.
    setTimeout: (fn, ms) => {
      const id = g.setTimeout(fn, ms) as { unref?(): void };
      id.unref?.();
      return id;
    },
    clearTimeout: (id) => g.clearTimeout(id),
    now: () => Date.now(),
  };
}

/**
 * A send (`POST …/messages`) the harness has not answered in this time fails with code `timeout`. The harness answers in
 * milliseconds (the turn runs after the answer); 15 s covers a busy machine and still unlocks the composer long before
 * anyone reaches for a reload. The message may have arrived: the caller re-reads the conversation before offering Retry.
 */
export const SEND_TIMEOUT_MS = 15_000;
/**
 * The harness sends a `heartbeat` event every 15 s. A stream that carried nothing for this long (two heartbeats missed) is
 * half-open: it is closed and opened again, and the reopen's `onOpen` is the caller's cue to re-read the project.
 */
export const STREAM_STALE_MS = 35_000;
/** How often the watchdog looks at the stream (it sends nothing; the cost is one timer). */
const STREAM_CHECK_MS = 5_000;

/**
 * The event stream's watchdog (A16, A11): a stream silent for `staleMs` (the harness sends a heartbeat every 15 s) is
 * closed and opened again; one EventSource closed for good (a refused connection) is opened again after 1 s, 2 s, 4 s …
 * 10 s. Returns the stop.
 */
export function watchStream(
  h: StreamHandle,
  onError: ((e: unknown) => void) | undefined,
  given: TimersLike | undefined,
  staleMs = STREAM_STALE_MS,
): () => void {
  const timers = given ?? globalTimers();
  let retryAt = 0;
  let fails = 0;
  let timer: unknown;
  let stopped = false;
  const watch = () => {
    timers.clearTimeout(timer);
    if (stopped) return;
    const now = timers.now();
    // Refused opens in a row set the backoff; an open stream ends the run.
    if (h.source?.readyState === 1) fails = 0;
    if (!h.source && now >= retryAt) h.open();
    else if (h.source && now - h.seen > staleMs) {
      h.source.close();
      onError?.(new BridgeError(0, "stream_stale", "the event stream went quiet"));
      h.open();
    }
    timer = timers.setTimeout(watch, h.source ? STREAM_CHECK_MS : retryAt - now);
  };
  h.refused = () => {
    h.source?.close();
    h.source = null;
    retryAt = timers.now() + retryDelay((fails += 1), 10_000);
    watch();
  };
  if (h.source?.readyState === 2) h.refused();
  else watch();
  return () => {
    stopped = true;
    timers.clearTimeout(timer);
    delete h.refused;
  };
}

/**
 * The bridge methods the first paint never calls (notes, review, commands, memory, sessions' writes, secrets, plans, ...).
 * `createHttpBridge` imports this module on first use so the entry chunk does not carry it.
 */
export function createRareMethods({
  request,
  unwrap,
  p,
  memoryPath,
  base,
  token,
  timers: given,
  sendTimeout = SEND_TIMEOUT_MS,
  binaryFetch,
  fail,
}: RareContext): Pick<Bridge, RareMethod> {
  const timers = given ?? globalTimers();
  /**
   * A9. A send (`POST …/messages`) gives up after `sendTimeout` with code `timeout` and aborts its fetch (where
   * AbortController exists). The harness has no idempotency key, so a send it took late must not be repeated: after a
   * timeout the conversation and the queue are read back, and a message with this text stored since the send started
   * is the answer (as if it had come in time). Not found: the error, and the next send of the same text to that project
   * (the notice's Retry) looks once more before it posts.
   */
  const unconfirmed = new Map<string, { text: string; since: number }>();
  /** Where a send goes: the project (its default session) or one main session (`sid`). */
  const messagesPath = (id: string, sid?: string) => (sid === undefined ? `${p(id)}/messages` : `${p(id)}/sessions/${encodeURIComponent(sid)}/messages`);
  const post = async (id: string, payload: Record<string, unknown>, sid?: string) => {
    const Abort = (globalThis as { AbortController?: new () => { signal: AbortSignalLike; abort(): void } }).AbortController;
    const ctl = Abort ? new Abort() : undefined;
    const call = request("POST", messagesPath(id, sid), payload, ctl?.signal);
    let timer: unknown;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = timers.setTimeout(() => {
            call.catch(() => undefined);
            ctl?.abort();
            reject(new BridgeError(0, "timeout", "timeout"));
          }, sendTimeout);
        }),
      ]);
    } finally {
      timers.clearTimeout(timer);
    }
  };
  /**
   * `{ message }` or `{ queued }` when the harness stored this text at or after `since` (same machine, same clock): in the
   * project's default conversation, or in main session `sid` (its root agent's messages and its own queue).
   */
  const stored = async (id: string, text: string, since: number, sid?: string): Promise<unknown> => {
    const after = (at: string) => Date.parse(at) >= since - 1000;
    const look = async () => {
      let root: string;
      if (sid === undefined) root = ((await request("GET", p(id))) as Project).orchestrator_agent_id;
      else {
        const detail = await request("GET", `${p(id)}/sessions/${encodeURIComponent(sid)}`);
        root = isRecord(detail) && isRecord(detail.session) && typeof detail.session.root_agent_id === "string" ? detail.session.root_agent_id : "";
      }
      const body = root === "" ? null : await request("GET", `${p(id)}/agents/${encodeURIComponent(root)}/messages`);
      const messages = isRecord(body) && Array.isArray(body.messages) ? (body.messages as Message[]) : [];
      const message = messages.find((m) => m.role === "user" && after(m.created_at) && m.content.some((b) => b.type === "text" && b.text === text));
      if (message) return { message };
      const queue = (await request("GET", sid === undefined ? `${p(id)}/queue` : `${p(id)}/sessions/${encodeURIComponent(sid)}/queue`)) as
        QueueState | undefined;
      const queued = queue?.messages.find((m) => m.text === text && after(m.created_at));
      return queued ? { queued } : null;
    };
    let timer: unknown;
    try {
      // A harness that answers nothing at all must not hold the composer again: give up after the same timeout.
      return await Promise.race([look().catch(() => null), new Promise((resolve) => (timer = timers.setTimeout(() => resolve(null), sendTimeout)))]);
    } finally {
      timers.clearTimeout(timer);
    }
  };
  const send = async (id: string, payload: Record<string, unknown>, sid?: string): Promise<unknown> => {
    const text = String(payload.text);
    // One unconfirmed send per conversation: the project's default one, or each main session's.
    const key = sid === undefined ? id : `${id}\u0001${sid}`;
    const prior = unconfirmed.get(key);
    unconfirmed.delete(key);
    if (prior?.text === text) {
      const found = await stored(id, text, prior.since, sid);
      if (found) return found;
    }
    const since = timers.now();
    try {
      return await post(id, payload, sid);
    } catch (e) {
      if (!(e instanceof BridgeError) || e.code !== "timeout") throw e;
      const found = await stored(id, text, since, sid);
      if (found) return found;
      unconfirmed.set(key, { text, since });
      throw new BridgeError(0, "timeout", "Octo's local service didn't answer in time.", {
        action: "retry",
        hint: "Your text is kept. Retry looks in the conversation first, so nothing is sent twice.",
      });
    }
  };
  /** The body of a send that may queue: a mode and attachments only when given. */
  const sendPayload = (text: string, opts: { mode?: ProjectMode; attachments?: string[] } | undefined) => {
    const payload: Record<string, unknown> = { text };
    if (opts?.mode) payload.mode = opts.mode;
    if (opts?.attachments && opts.attachments.length > 0) payload.attachments = opts.attachments;
    return payload;
  };
  /** `{ message }` or `{ queued, waiting_for? }` from a send's answer. */
  const sent = (body: unknown): SendResult => {
    if (isRecord(body) && isRecord(body.queued)) {
      const w = body.waiting_for;
      return w === "turn" || w === "slot" ? { queued: body.queued as QueuedMessage, waiting_for: w } : { queued: body.queued as QueuedMessage };
    }
    if (isRecord(body) && isRecord(body.message)) return { message: body.message as unknown as Message };
    throw new BridgeError(0, "invalid_response", 'missing "message" or "queued" in response');
  };
  /** `{ session, message?, queued?, waiting_for? }` of `POST /sessions` and `POST /sessions/{sid}/clear`. */
  const created = (body: unknown): CreatedSession => {
    if (!isRecord(body) || !isRecord(body.session)) throw new BridgeError(0, "invalid_response", 'missing "session" in response');
    return body as unknown as CreatedSession;
  };
  const s = (id: string, sid: string) => `${p(id)}/sessions/${encodeURIComponent(sid)}`;
  const exportFrom = async (path: string): Promise<BlobLike> => {
    const doFetch = binaryFetch();
    const headers: Record<string, string> = {};
    if (token !== "") headers.Authorization = `Bearer ${token}`;
    let res: FetchResponseLike;
    try {
      res = await doFetch(`${base}${path}`, { method: "GET", headers });
    } catch (e) {
      throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw fail(res.status, await res.text());
    const type = res.headers?.get("Content-Type") ?? "text/markdown";
    const Blob = (globalThis as { Blob?: new (parts: unknown[], init?: { type?: string }) => BlobLike }).Blob;
    if (!Blob) throw new BridgeError(0, "no_blob", "this environment has no Blob");
    return new Blob([res.arrayBuffer ? await res.arrayBuffer() : await res.text()], { type });
  };
  const latestPlan = async (path: string) => {
    try {
      // `{"plan": null}` is "no plan"; an older harness answered 404 `not_found` instead.
      return await unwrap<Plan | null>(request("GET", path), "plan");
    } catch (e) {
      if (e instanceof BridgeError && e.status === 404 && e.code === "not_found") return null;
      throw e;
    }
  };

  const usageQuery = (params: UsageParams | undefined) => {
    const parts: string[] = [];
    for (const k of ["from", "to", "group", "project"] as const) {
      const v = params?.[k];
      if (typeof v === "string" && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
  };

  return {
    createProject: (input) => request("POST", "/v1/projects", input) as Promise<Project>,
    updateProject: (id, patch) => request("PATCH", p(id), patch) as Promise<Project>,
    deleteProject: async (id) => {
      await request("DELETE", p(id));
    },
    sendMessage: async (id, text) => {
      const body = await send(id, { text });
      if (isRecord(body) && isRecord(body.queued)) {
        throw new BridgeError(202, "queued", "a turn is running: the message was queued (use sendOrQueueMessage)");
      }
      if (!isRecord(body) || !isRecord(body.message)) throw new BridgeError(0, "invalid_response", 'missing "message" in response');
      return body.message as unknown as Message;
    },
    sendOrQueueMessage: async (id, text, opts) => sent(await send(id, sendPayload(text, opts))),
    sendSessionMessage: async (id, sid, text, opts) => sent(await send(id, sendPayload(text, opts), sid)),
    cancelTurn: async (id) => {
      await request("POST", `${p(id)}/cancel`);
    },
    getContext: (id, agentId) =>
      request("GET", `${p(id)}/context${agentId === undefined ? "" : `?agent=${encodeURIComponent(agentId)}`}`) as Promise<ContextBreakdown>,
    writeFile: (id, input) => request("PUT", `${p(id)}/files/content`, input) as Promise<FileStat>,
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
    getUsage: (params) => request("GET", `/v1/usage${usageQuery(params)}`) as Promise<UsageReport>,
    getLimits: () => unwrap<Limit[]>(request("GET", "/v1/limits"), "limits"),
    getLatestPlan: (id) => latestPlan(`${p(id)}/plans/latest`),
    approvePlan: (id, planId) => request("POST", `${p(id)}/plans/${encodeURIComponent(planId)}/approve`) as Promise<{ plan: Plan; message: Message }>,
    rewind: (id, input) => request("POST", `${p(id)}/rewind`, input) as Promise<RewindReport>,
    compactNow: (id) => request("POST", `${p(id)}/compact`) as Promise<CompactResult | CompactSentToAgent>,
    getSlashCommands: (id) => request("GET", `${p(id)}/slash-commands`) as Promise<SlashCommands>,
    clearConversation: (id) => request("POST", `${p(id)}/clear`) as Promise<ClearResult>,
    rememberFact: (id, input) => request("POST", `${p(id)}/facts`, input) as Promise<RememberedFact>,
    forgetFact: async (id, taskId, factId) => {
      await request("DELETE", `${p(id)}/facts/${encodeURIComponent(taskId)}/${encodeURIComponent(factId)}`);
    },
    searchRequests: (query, limit) =>
      unwrap<RequestHit[]>(request("GET", `/v1/search?q=${encodeURIComponent(query)}${limit === undefined ? "" : `&limit=${limit}`}`), "results"),
    listChanges: (id, turnId) => unwrap<TurnChanges[]>(request("GET", `${p(id)}/changes${turnId === undefined ? "" : `?turn=${turnId}`}`), "turns"),
    getChange: (id, cid) => request("GET", `${p(id)}/changes/${cid}`) as Promise<ChangeDetail>,
    revertChange: (id, cid) => request("POST", `${p(id)}/changes/${cid}/revert`) as Promise<RevertResult>,
    listApprovalRules: (id) => unwrap<ApprovalRule[]>(request("GET", `${p(id)}/approval-rules`), "rules"),
    deleteApprovalRule: async (id, rid) => {
      await request("DELETE", `${p(id)}/approval-rules/${encodeURIComponent(rid)}`);
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
      if (params?.page) q.push(`page=${params.page}`);
      if (params?.per_page) q.push(`per_page=${params.per_page}`);
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
    startCommandRun: (id, input) => request("POST", `${p(id)}/runs`, input) as Promise<StartedCommandRun>,
    listCommandRuns: (id, options) => {
      const q: string[] = [];
      if (options?.reviewId) q.push(`review_id=${encodeURIComponent(options.reviewId)}`);
      if (options?.limit) q.push(`limit=${options.limit}`);
      return unwrap<CommandRun[]>(request("GET", `${p(id)}/runs${q.length ? `?${q.join("&")}` : ""}`), "runs");
    },
    getCommandRun: (id, rid) => request("GET", `${p(id)}/runs/${encodeURIComponent(rid)}`) as Promise<CommandRun>,
    stopCommandRun: (id, rid, options) =>
      request("POST", `${p(id)}/runs/${encodeURIComponent(rid)}/stop${options?.force ? "?force=1" : ""}`) as Promise<CommandRun>,
    restartCommandRun: (id, rid) => request("POST", `${p(id)}/runs/${encodeURIComponent(rid)}/restart`) as Promise<StartedCommandRun>,
    listWorkerProcesses: (id) => unwrap<WorkerProcess[]>(request("GET", `${p(id)}/processes`), "processes"),
    stopWorkerProcess: async (id, procId) => {
      await request("POST", `${p(id)}/processes/${encodeURIComponent(procId)}/stop`);
    },
    restartWorkerProcess: async (id, procId) => {
      const body = await request("POST", `${p(id)}/processes/${encodeURIComponent(procId)}/restart`);
      return isRecord(body) && isRecord(body.process) ? (body.process as unknown as WorkerProcess) : null;
    },
    openBrowserProxy: (id, url) => request("POST", `${p(id)}/browser/proxy`, { url }) as Promise<BrowserProxySession>,
    closeBrowserProxy: async (id) => {
      await request("DELETE", `${p(id)}/browser/proxy`);
    },
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
    getSession: (id, sid) => request("GET", `${p(id)}/sessions/${encodeURIComponent(sid)}`) as Promise<ProjectSessionDetail>,
    createSession: async (id, input) => created(await request("POST", `${p(id)}/sessions`, input ?? {})),
    setDefaultSession: (id, sid) => unwrap<ProjectSession>(request("POST", `${s(id, sid)}/default`), "session"),
    resumeSession: (id, sid) => unwrap<ProjectSession>(request("POST", `${s(id, sid)}/resume`), "session"),
    listAllSessions: (params) => {
      const q: string[] = [];
      if (params?.kind !== undefined) q.push(`kind=${params.kind}`);
      if (params?.state !== undefined) q.push(`state=${params.state}`);
      if (params?.archived !== undefined) q.push(`archived=${params.archived}`);
      if (params?.limit !== undefined) q.push(`limit=${params.limit}`);
      if (params?.before !== undefined) q.push(`before=${encodeURIComponent(params.before)}`);
      return unwrap<GlobalSession[]>(request("GET", `/v1/sessions${q.length ? `?${q.join("&")}` : ""}`), "sessions");
    },
    getSessionQueue: (id, sid) => request("GET", `${s(id, sid)}/queue`) as Promise<QueueState>,
    editSessionQueued: (id, sid, qid, text) => request("PATCH", `${s(id, sid)}/queue/${encodeURIComponent(qid)}`, { text }) as Promise<QueuedMessage>,
    removeSessionQueued: async (id, sid, qid) => {
      await request("DELETE", `${s(id, sid)}/queue/${encodeURIComponent(qid)}`);
    },
    clearSessionQueue: async (id, sid) => {
      await request("DELETE", `${s(id, sid)}/queue`);
    },
    resumeSessionQueue: async (id, sid) => {
      await request("POST", `${s(id, sid)}/queue/resume`);
    },
    sendSessionQueuedNow: async (id, sid, qid, opts) => {
      await request("POST", `${s(id, sid)}/queue/${encodeURIComponent(qid)}/send-now`, opts?.interrupt ? { interrupt: true } : undefined);
    },
    getSessionContext: (id, sid) => request("GET", `${s(id, sid)}/context`) as Promise<ContextOverview | ContextBreakdown>,
    compactSession: (id, sid) => request("POST", `${s(id, sid)}/compact`) as Promise<CompactResult | CompactSentToAgent>,
    clearSession: async (id, sid) => created(await request("POST", `${s(id, sid)}/clear`)),
    rewindSession: (id, sid, input) => request("POST", `${s(id, sid)}/rewind`, input) as Promise<RewindReport>,
    getSessionLatestPlan: (id, sid) => latestPlan(`${s(id, sid)}/plans/latest`),
    exportSession: (id, sid) => exportFrom(`${s(id, sid)}/export?format=md`),
    patchSession: (id, sid, patch) => unwrap<ProjectSession>(request("PATCH", `${p(id)}/sessions/${encodeURIComponent(sid)}`, patch), "session"),
    deleteSession: async (id, sid) => {
      await request("DELETE", `${p(id)}/sessions/${encodeURIComponent(sid)}`);
    },
    deleteAllSessions: () => request("DELETE", "/v1/sessions") as Promise<DeleteAllSessionsResult>,
    listImportableSessions: () => unwrap<ImportableSession[]>(request("GET", "/v1/sessions/importable"), "sessions"),
    importSessions: (id, sessions) => request("POST", `${p(id)}/sessions/import`, { sessions }) as Promise<ImportSessionsResult>,
    listWorkspaces: (id) => unwrap<Workspace[]>(request("GET", `${p(id)}/workspaces`), "workspaces"),
    moveSessionToWorktree: (id, sid, input) => request("POST", `${s(id, sid)}/worktree`, input ?? {}) as Promise<MoveToWorktreeResult>,
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
    complete: async (id, input, opts) => {
      const body = await request("POST", `${p(id)}/complete`, input, opts?.signal);
      return isRecord(body) && typeof body.text === "string" ? (body as CompletionResult) : null;
    },
    stopSide: async (id) => {
      await request("POST", `${p(id)}/side/stop`);
    },
    uploadAttachment: async (id, data, opts) => {
      const doFetch = binaryFetch();
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
      if (!res.ok) throw fail(res.status, text);
      const body = parseJson(text);
      if (!isRecord(body) || typeof body.id !== "string") throw new BridgeError(0, "invalid_response", 'missing "id" in response');
      return body as unknown as Attachment;
    },
    fetchAttachment: async (id, attachmentId) => {
      const doFetch = binaryFetch();
      const headers: Record<string, string> = {};
      if (token !== "") headers.Authorization = `Bearer ${token}`;
      let res: FetchResponseLike;
      try {
        res = await doFetch(`${base}${p(id)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "GET", headers });
      } catch (e) {
        throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw fail(res.status, await res.text());
      if (!res.arrayBuffer) throw new BridgeError(0, "invalid_response", "this fetch cannot read binary bodies");
      return { data: await res.arrayBuffer(), type: res.headers?.get("Content-Type") ?? "application/octet-stream" };
    },
    listPlugins: () => unwrap<Plugin[]>(request("GET", "/v1/plugins"), "plugins"),
    listLanguageServers: (id) => unwrap<LanguageServerInfo[]>(request("GET", `${p(id)}/lsp`), "servers"),
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
    exportConversation: (id) => exportFrom(`${p(id)}/export?format=md`),
    resolveApproval: async (id, aid, answer) => {
      await request("POST", `${p(id)}/approvals/${encodeURIComponent(aid)}`, answer);
    },
    submitInput: async (id, iid, answer) => {
      await request("POST", `${p(id)}/inputs/${encodeURIComponent(iid)}`, answer);
    },
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
  };
}
