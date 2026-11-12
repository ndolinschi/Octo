import { BRIDGE_EVENT_TYPES, type Bridge } from "./client";
import { isExitInfo } from "./lspChannel";
import type { BridgeEvent, LanguageServerFolder } from "./types";

export type MessagePortLike = {
  postMessage(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
};

export type Theme = "dark" | "light";
/** The methods the message bridge forwards: not the optional HTTP-only ones (settings and the v7 members). */
export type HttpOnlyMethod =
  | "getSettings"
  | "putSettings"
  | "getDiagnostics"
  | "listTasks"
  | "getTurnContext"
  | "listMemory"
  | "getMemoryFile"
  | "putMemoryFile"
  | "deleteMemoryFile"
  | "searchMemory"
  | "listMemorySessions"
  | "getMemorySession"
  | "forgetExchange"
  | "sendOrQueueMessage"
  | "getQueue"
  | "editQueued"
  | "removeQueued"
  | "clearQueue"
  | "resumeQueue"
  | "sendQueuedNow"
  | "listChanges"
  | "getChange"
  | "revertChange"
  | "listApprovals"
  | "resolveApproval"
  | "listInputs"
  | "submitInput"
  | "listSecrets"
  | "putSecret"
  | "deleteSecret"
  | "listPullRequests"
  | "listReviewBranches"
  | "listReviews"
  | "openReview"
  | "getReview"
  | "patchReview"
  | "listReviewFiles"
  | "getReviewFileDiff"
  | "reviewFileRawUrl"
  | "setReviewFileViewed"
  | "listReviewComments"
  | "createReviewComment"
  | "updateReviewComment"
  | "deleteReviewComment"
  | "listReviewFindings"
  | "decideReviewFinding"
  | "previewReviewSubmit"
  | "submitReview";
export type BridgeMethod = Exclude<keyof Bridge, "subscribe" | "openLanguageServer" | HttpOnlyMethod>;
export type WireError = { status: number; code: string; message: string };

export type ClientMessage =
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "subscribe"; sub: number; projectId: string }
  | { kind: "unsubscribe"; sub: number }
  | { kind: "host"; id: number; action: string; args: unknown[] }
  | { kind: "lsp-open"; id: number; projectId: string; serverId: string }
  | { kind: "lsp-send"; session: number; message: unknown }
  | { kind: "lsp-close"; session: number };

export type LspOpenedMessage =
  | {
      kind: "lsp-opened";
      id: number;
      ok: true;
      session: number;
      rootUri: string;
      workspaceFolders: LanguageServerFolder[];
    }
  | { kind: "lsp-opened"; id: number; ok: false; error: WireError };

export type ResultMessage = { kind: "result"; id: number; ok: true; value: unknown } | { kind: "result"; id: number; ok: false; error: WireError };

export type HostMessage =
  | ResultMessage
  | { kind: "event"; sub: number; event: BridgeEvent }
  | { kind: "open"; sub: number }
  | { kind: "error"; sub: number; message: string }
  | { kind: "theme"; theme: Theme }
  | LspOpenedMessage
  | { kind: "lsp-message"; session: number; message: unknown }
  | { kind: "lsp-exit"; session: number; code: number; reason?: string };

export const BRIDGE_METHODS: readonly BridgeMethod[] = [
  "health",
  "getConfig",
  "listProjects",
  "createProject",
  "getProject",
  "updateProject",
  "deleteProject",
  "listAgents",
  "getAgent",
  "listMessages",
  "getTranscript",
  "sendMessage",
  "cancelTurn",
  "getContext",
  "askSide",
  "listSide",
  "clearSide",
  "listNotes",
  "getNote",
  "createNote",
  "updateNote",
  "deleteNote",
  "listFiles",
  "readFile",
  "writeFile",
  "listPlugins",
  "getUsage",
  "getLimits",
  "listLanguageServers",
];

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isBridgeMethod(v: unknown): v is BridgeMethod {
  return typeof v === "string" && (BRIDGE_METHODS as readonly string[]).includes(v);
}

function isBridgeEvent(v: unknown): v is BridgeEvent {
  return isRec(v) && typeof v.type === "string" && (BRIDGE_EVENT_TYPES as readonly string[]).includes(v.type);
}

function isWireError(v: unknown): v is WireError {
  return isRec(v) && isNum(v.status) && typeof v.code === "string" && typeof v.message === "string";
}

function isFolder(v: unknown): v is LanguageServerFolder {
  return isRec(v) && typeof v.uri === "string" && typeof v.name === "string";
}

export function isTheme(v: unknown): v is Theme {
  return v === "dark" || v === "light";
}

export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (!isRec(msg)) return false;
  switch (msg.kind) {
    case "call":
      return isNum(msg.id) && typeof msg.method === "string" && Array.isArray(msg.args);
    case "subscribe":
      return isNum(msg.sub) && typeof msg.projectId === "string";
    case "unsubscribe":
      return isNum(msg.sub);
    case "host":
      return isNum(msg.id) && typeof msg.action === "string" && Array.isArray(msg.args);
    case "lsp-open":
      return isNum(msg.id) && typeof msg.projectId === "string" && typeof msg.serverId === "string";
    case "lsp-send":
      return isNum(msg.session) && "message" in msg;
    case "lsp-close":
      return isNum(msg.session);
    default:
      return false;
  }
}

export function isHostMessage(msg: unknown): msg is HostMessage {
  if (!isRec(msg)) return false;
  switch (msg.kind) {
    case "result":
      return isNum(msg.id) && (msg.ok === true || (msg.ok === false && isWireError(msg.error)));
    case "event":
      return isNum(msg.sub) && isBridgeEvent(msg.event);
    case "open":
      return isNum(msg.sub);
    case "error":
      return isNum(msg.sub) && typeof msg.message === "string";
    case "theme":
      return isTheme(msg.theme);
    case "lsp-opened":
      if (!isNum(msg.id)) return false;
      if (msg.ok === false) return isWireError(msg.error);
      return (
        msg.ok === true && isNum(msg.session) && typeof msg.rootUri === "string" && Array.isArray(msg.workspaceFolders) && msg.workspaceFolders.every(isFolder)
      );
    case "lsp-message":
      return isNum(msg.session) && "message" in msg;
    case "lsp-exit":
      return isNum(msg.session) && isExitInfo({ code: msg.code, reason: msg.reason });
    default:
      return false;
  }
}
