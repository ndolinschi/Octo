import type { Attachment, CompletionResult, ConversationMarker, LanguageServerInfo, Plugin, QueuedMessage, Transcript, UsageParams } from "./types";
import type { CommandRun, CommandSuggestion, StartedCommandRun } from "./commands";
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
  ProjectSession,
  ProjectSessionDetail,
  SessionMessageResult,
  Task,
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
import { BridgeError, type AbortSignalLike, type BinaryFetchLike, type BlobLike, type Bridge, type FetchResponseLike } from "./client";
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

/**
 * The bridge methods the first paint never calls (notes, review, commands, memory, sessions' writes, secrets, plans, ...).
 * `createHttpBridge` imports this module on first use so the entry chunk does not carry it.
 */
export function createRareMethods({ request, unwrap, p, memoryPath, base, token, binaryFetch, fail }: RareContext): Pick<Bridge, RareMethod> {
  const usageQuery = (params: UsageParams | undefined) => {
    const parts: string[] = [];
    for (const k of ["from", "to", "group", "project"] as const) {
      const v = params?.[k];
      if (typeof v === "string" && v !== "") parts.push(`${k}=${encodeURIComponent(v)}`);
    }
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
  };

  return {
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
    getSession: (id, sid) => request("GET", `${p(id)}/sessions/${encodeURIComponent(sid)}`) as Promise<ProjectSessionDetail>,
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
    exportConversation: async (id) => {
      const doFetch = binaryFetch();
      const headers: Record<string, string> = {};
      if (token !== "") headers.Authorization = `Bearer ${token}`;
      let res: FetchResponseLike;
      try {
        res = await doFetch(`${base}${p(id)}/export?format=md`, { method: "GET", headers });
      } catch (e) {
        throw new BridgeError(0, "network_error", e instanceof Error ? e.message : String(e));
      }
      if (!res.ok) throw fail(res.status, await res.text());
      const type = res.headers?.get("Content-Type") ?? "text/markdown";
      const Blob = (globalThis as { Blob?: new (parts: unknown[], init?: { type?: string }) => BlobLike }).Blob;
      if (!Blob) throw new BridgeError(0, "no_blob", "this environment has no Blob");
      return new Blob([res.arrayBuffer ? await res.arrayBuffer() : await res.text()], { type });
    },
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
