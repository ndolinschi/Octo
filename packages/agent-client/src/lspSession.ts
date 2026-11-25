import { BridgeError, type EventSourceLike } from "./client";
import { createLspChannel, isExitInfo } from "./lspChannel";
import type { LanguageServerFolder, LanguageServerSession } from "./types";

export type LspTransport = {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
  openStream(path: string): EventSourceLike;
};

function parseFrame(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isFolder(v: unknown): v is LanguageServerFolder {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.uri === "string" && typeof r.name === "string";
}

function parseCreated(body: unknown): {
  sessionId: string;
  rootUri: string;
  folders: LanguageServerFolder[];
} {
  const r = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (typeof r.session_id !== "string" || typeof r.root_uri !== "string" || !Array.isArray(r.workspace_folders) || !r.workspace_folders.every(isFolder)) {
    throw new BridgeError(0, "invalid_response", "malformed language server session response");
  }
  return { sessionId: r.session_id, rootUri: r.root_uri, folders: r.workspace_folders };
}

async function deleteSession(t: LspTransport, path: string): Promise<void> {
  try {
    await t.request("DELETE", path);
  } catch (e) {
    if (!(e instanceof BridgeError && e.status === 404)) throw e;
  }
}

export async function openLspSession(t: LspTransport, projectPath: string, serverId: string, opts?: { workspace?: "review" }): Promise<LanguageServerSession> {
  const q = opts?.workspace === "review" ? "?workspace=review" : "";
  const created = parseCreated(await t.request("POST", `${projectPath}/lsp/${encodeURIComponent(serverId)}/sessions${q}`));
  const sessionPath = `${projectPath}/lsp/sessions/${encodeURIComponent(created.sessionId)}`;
  const channel = createLspChannel();
  let source: EventSourceLike;
  try {
    source = t.openStream(`${sessionPath}/events`);
  } catch (e) {
    await deleteSession(t, sessionPath).catch(() => undefined);
    throw e;
  }
  let exited = false;
  let closing: Promise<void> | undefined;

  source.addEventListener("message", (ev) => {
    const message = parseFrame(ev.data);
    if (message !== undefined) channel.push(message);
  });
  source.addEventListener("exit", (ev) => {
    const info = parseFrame(ev.data);
    if (isExitInfo(info) && !exited) {
      exited = true;
      source.onerror = null;
      source.close();
      channel.exit(info);
    }
  });
  source.onerror = () => {
    if (source.readyState === 2 && !closing && !exited) {
      exited = true;
      source.onerror = null;
      source.close();
      channel.exit({ code: -1, reason: "stream_closed" });
    }
  };

  return {
    rootUri: created.rootUri,
    workspaceFolders: created.folders,
    async send(message) {
      if (closing || exited) throw new BridgeError(0, "session_closed", "language server session closed");
      await t.request("POST", `${sessionPath}/messages`, message);
    },
    onMessage: channel.onMessage,
    onExit: channel.onExit,
    close() {
      if (!closing) {
        source.onerror = null;
        source.close();
        channel.close();
        closing = deleteSession(t, sessionPath);
      }
      return closing;
    },
  };
}
