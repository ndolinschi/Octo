import type { Bridge, LanguageServerInfo, LanguageServerSession } from "@octo/agent-client";
import type { LspState } from "./hub";
import { Rpc, type Cancellation } from "./rpc";
import { errorMessage } from "../lib/format";

/** Full-document sync: one `didChange` with the whole text after typing pauses this long. */
const CHANGE_DEBOUNCE_MS = 250;
const INITIALIZE_TIMEOUT_MS = 20_000;

type Doc = { uri: string; languageId: string; version: number; text(): string; timer: number; opened: boolean };

export type SessionHooks = {
  onState(state: LspState, error: string | null): void;
  onNotification(method: string, params: unknown): void;
};

const CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false, willSaveWaitUntil: false },
    hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
    completion: {
      dynamicRegistration: false,
      contextSupport: true,
      completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"], deprecatedSupport: true, insertReplaceSupport: false },
    },
    definition: { dynamicRegistration: false, linkSupport: true },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
  },
  workspace: { workspaceFolders: true, configuration: true },
  window: { workDoneProgress: false },
};

function message(e: unknown): string {
  return errorMessage(e).replace(/\.$/, "");
}

/**
 * One language server for one project: started on demand, `initialize` → `initialized`, then
 * full-document sync for the files attached to it. Restartable after a failure or exit.
 */
export class LspSession {
  state: LspState = "starting";
  error: string | null = null;
  private rpc: Rpc | null = null;
  private session: LanguageServerSession | null = null;
  private docs = new Map<string, Doc>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly bridge: Bridge,
    private readonly projectId: string,
    readonly server: LanguageServerInfo,
    private readonly hooks: SessionHooks,
  ) {}

  get docCount(): number {
    return this.docs.size;
  }

  get ready(): boolean {
    return this.state === "ready";
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    this.teardown();
    this.set("starting", null);
    let session: LanguageServerSession;
    try {
      session = await this.bridge.openLanguageServer(this.projectId, this.server.id);
    } catch (e) {
      if (gen === this.generation && !this.disposed) this.set("failed", message(e));
      return;
    }
    if (gen !== this.generation || this.disposed) {
      void session.close().catch(() => undefined);
      return;
    }
    this.session = session;
    const rpc = new Rpc(session, {
      notification: (method, params) => this.hooks.onNotification(method, params),
      folders: () => session.workspaceFolders,
    });
    this.rpc = rpc;
    session.onExit((info) => {
      if (gen !== this.generation || this.disposed) return;
      this.teardown();
      this.set("stopped", info.reason ?? (info.code === 0 ? "the server exited" : `exit code ${info.code}`));
    });
    try {
      await rpc.request(
        "initialize",
        {
          processId: null,
          clientInfo: { name: "Octo" },
          rootUri: session.rootUri || null,
          workspaceFolders: session.workspaceFolders.length ? session.workspaceFolders : null,
          capabilities: CAPABILITIES,
        },
        { timeoutMs: INITIALIZE_TIMEOUT_MS },
      );
    } catch (e) {
      if (gen !== this.generation || this.disposed) return;
      this.teardown();
      this.set("failed", message(e));
      return;
    }
    if (gen !== this.generation || this.disposed) return;
    rpc.notify("initialized", {});
    this.set("ready", null);
    for (const doc of this.docs.values()) this.sendOpen(doc);
  }

  open(uri: string, languageId: string, text: () => string): void {
    if (this.docs.has(uri)) return;
    const doc: Doc = { uri, languageId, version: 1, text, timer: 0, opened: false };
    this.docs.set(uri, doc);
    if (this.ready) this.sendOpen(doc);
  }

  /** The document changed; the full text follows once typing pauses. */
  change(uri: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    window.clearTimeout(doc.timer);
    doc.timer = window.setTimeout(() => this.flush(uri), CHANGE_DEBOUNCE_MS);
  }

  /** Sends a pending change now (before a request that must see the latest text). */
  flush(uri: string): void {
    const doc = this.docs.get(uri);
    if (!doc?.timer) return;
    window.clearTimeout(doc.timer);
    doc.timer = 0;
    if (!this.ready || !doc.opened) return;
    doc.version += 1;
    this.rpc?.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text: doc.text() }] });
  }

  close(uri: string): void {
    const doc = this.docs.get(uri);
    if (!doc) return;
    window.clearTimeout(doc.timer);
    this.docs.delete(uri);
    if (this.ready && doc.opened) this.rpc?.notify("textDocument/didClose", { textDocument: { uri } });
  }

  request<T>(method: string, params: { textDocument: { uri: string } } & Record<string, unknown>, token?: Cancellation): Promise<T | null> {
    if (!this.ready || !this.rpc) return Promise.resolve(null);
    this.flush(params.textDocument.uri);
    return this.rpc.request<T>(method, params, token ? { token } : {});
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const doc of this.docs.values()) window.clearTimeout(doc.timer);
    this.docs.clear();
    this.teardown();
  }

  private sendOpen(doc: Doc) {
    doc.opened = true;
    window.clearTimeout(doc.timer);
    doc.timer = 0;
    this.rpc?.notify("textDocument/didOpen", { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text() } });
  }

  private teardown() {
    this.rpc?.dispose();
    this.rpc = null;
    for (const doc of this.docs.values()) doc.opened = false;
    const s = this.session;
    this.session = null;
    void s?.close().catch(() => undefined);
  }

  private set(state: LspState, error: string | null) {
    this.state = state;
    this.error = error;
    this.hooks.onState(state, error);
  }
}
