import type { Bridge, Folder, LanguageServerInfo } from "@octo/agent-client";
import type * as Monaco from "monaco-editor";
import type { EditorBuffers } from "../components/files/buffers";
import { fileKey, splitKey, type FilePosition, type FileKey } from "../lib/files";
import { completionKind, documentation, toHoverContents, toLocations, toLspPosition, toMarkers, toMonacoRange, toProblems } from "./convert";
import type { EditorIntel, IntelClient } from "./hub";
import { LspSession } from "./session";
import { fileUri, fromFileUri } from "./uri";

type MonacoApi = typeof Monaco;

export type LspManagerOptions = {
  monaco: MonacoApi;
  bridge: Bridge;
  projectId: string;
  folders(): Folder[];
  buffers: EditorBuffers;
  intel: EditorIntel;
  /** Opens a project file as a tab at a position (go to definition). */
  open(folder: string, path: string, at: FilePosition): void;
};

type Doc = { key: FileKey; uri: string; model: Monaco.editor.ITextModel; session: LspSession; sub: Monaco.IDisposable };

const MARKER_OWNER = "lsp";
const live = new Set<LspManager>();
const registered = new Set<string>();
let opener: Monaco.IDisposable | null = null;

function managerFor(model: Monaco.editor.ITextModel): { manager: LspManager; doc: Doc } | null {
  for (const m of live) {
    const doc = m.docFor(model);
    if (doc) return { manager: m, doc };
  }
  return null;
}

/**
 * The project's language-server client: one session per server, started when the first file in
 * one of its languages opens; providers for hover, completion and definition are registered once
 * per language and routed to the session that owns the model.
 */
export class LspManager implements IntelClient {
  private servers: Promise<LanguageServerInfo[]> | null = null;
  private sessions = new Map<string, LspSession>();
  private docs = new Map<FileKey, Doc>();
  private byUri = new Map<string, Doc>();
  /** Models created only so Monaco can peek at a definition target; disposed with the manager. */
  private peeks = new Set<Monaco.editor.ITextModel>();
  private readonly unwatch: () => void;
  private disposed = false;

  constructor(private readonly o: LspManagerOptions) {
    live.add(this);
    installOpener(o.monaco);
    this.unwatch = o.buffers.watch({ opened: (key, model) => void this.attach(key, model), closed: (key) => this.detach(key) });
  }

  docFor(model: Monaco.editor.ITextModel): Doc | undefined {
    for (const d of this.docs.values()) if (d.model === model) return d;
    return undefined;
  }

  ownsAuthority(authority: string): boolean {
    return authority === this.o.projectId;
  }

  retry(key: FileKey): void {
    const doc = this.docs.get(key);
    if (doc && (doc.session.state === "failed" || doc.session.state === "stopped")) void doc.session.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    this.unwatch();
    for (const key of [...this.docs.keys()]) this.detach(key);
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    for (const m of this.peeks) if (!m.isDisposed() && !this.isBuffer(m)) m.dispose();
    this.peeks.clear();
  }

  /* ---------- documents ---------- */

  private async attach(key: FileKey, model: Monaco.editor.ITextModel) {
    const language = model.getLanguageId();
    this.servers ??= this.o.bridge.listLanguageServers(this.o.projectId).catch(() => []);
    const servers = await this.servers;
    const server = servers.find((s) => s.available && s.languages.includes(language));
    if (!server || this.disposed || this.docs.has(key) || model.isDisposed()) return;
    const { folder, path } = splitKey(key);
    const root = this.o.folders().find((f) => f.label === folder);
    if (!root) return;
    const session = this.sessionFor(server);
    const uri = fileUri(root.path, path);
    const doc: Doc = { key, uri, model, session, sub: model.onDidChangeContent(() => session.change(uri)) };
    this.docs.set(key, doc);
    this.byUri.set(uri, doc);
    session.open(uri, language, () => model.getValue());
    this.publishState(session);
    registerProviders(this.o.monaco, language);
  }

  private detach(key: FileKey) {
    const doc = this.docs.get(key);
    if (!doc) return;
    doc.sub.dispose();
    doc.session.close(doc.uri);
    this.docs.delete(key);
    this.byUri.delete(doc.uri);
    if (!doc.model.isDisposed()) this.o.monaco.editor.setModelMarkers(doc.model, MARKER_OWNER, []);
    this.o.intel.clear(key);
    // The last file of a server closed: stop it (it starts again with the next one).
    if (doc.session.docCount === 0) {
      doc.session.dispose();
      this.sessions.delete(doc.session.server.id);
    }
  }

  private sessionFor(server: LanguageServerInfo): LspSession {
    const existing = this.sessions.get(server.id);
    if (existing) return existing;
    const session: LspSession = new LspSession(this.o.bridge, this.o.projectId, server, {
      onState: (state) => {
        if (state !== "ready") this.clearMarkers(session);
        this.publishState(session);
      },
      onNotification: (method, params) => {
        if (method === "textDocument/publishDiagnostics") this.diagnostics(params);
      },
    });
    this.sessions.set(server.id, session);
    void session.start();
    return session;
  }

  private publishState(session: LspSession) {
    for (const d of this.docs.values()) {
      if (d.session !== session) continue;
      this.o.intel.setStatus(d.key, { label: session.server.label, state: session.state, error: session.error });
    }
  }

  private clearMarkers(session: LspSession) {
    for (const d of this.docs.values()) {
      if (d.session !== session || d.model.isDisposed()) continue;
      this.o.monaco.editor.setModelMarkers(d.model, MARKER_OWNER, []);
      this.o.intel.setProblems(d.key, []);
    }
  }

  private diagnostics(params: unknown) {
    const p = params as { uri?: unknown; diagnostics?: unknown } | null;
    const doc = typeof p?.uri === "string" ? this.byUri.get(p.uri) : undefined;
    if (!doc || doc.model.isDisposed()) return;
    const problems = toProblems(p?.diagnostics);
    this.o.monaco.editor.setModelMarkers(doc.model, MARKER_OWNER, toMarkers(this.o.monaco, problems));
    this.o.intel.setProblems(
      doc.key,
      problems.map(({ severity, message, source, line, column }) => ({ severity, message, source, line, column })),
    );
  }

  /* ---------- features ---------- */

  async hover(doc: Doc, position: Monaco.Position, token: Monaco.CancellationToken): Promise<Monaco.languages.Hover | null> {
    const result = await doc.session
      .request<{ contents?: unknown; range?: unknown }>("textDocument/hover", { textDocument: { uri: doc.uri }, position: toLspPosition(position) }, token)
      .catch(() => null);
    const contents = toHoverContents(result?.contents);
    if (!contents.length) return null;
    const range = toLocations([{ uri: doc.uri, range: result?.range }])[0]?.range;
    return { contents, ...(range ? { range: toMonacoRange(range) } : {}) };
  }

  async completion(doc: Doc, position: Monaco.Position, token: Monaco.CancellationToken): Promise<Monaco.languages.CompletionList | null> {
    const result = await doc.session
      .request<unknown>("textDocument/completion", { textDocument: { uri: doc.uri }, position: toLspPosition(position) }, token)
      .catch(() => null);
    const list = Array.isArray(result) ? result : (result as { items?: unknown } | null)?.items;
    if (!Array.isArray(list)) return null;
    const word = doc.model.getWordUntilPosition(position);
    const fallback = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: position.column };
    const monaco = this.o.monaco;
    const suggestions = list.flatMap((item: Record<string, unknown>): Monaco.languages.CompletionItem[] => {
      if (typeof item !== "object" || item === null || typeof item.label !== "string") return [];
      const edit = item.textEdit as { newText?: unknown; range?: unknown } | undefined;
      const editRange = edit && toLocations([{ uri: "", range: edit.range }])[0]?.range;
      const suggestion: Monaco.languages.CompletionItem = {
        label: item.label,
        kind: completionKind(monaco, item.kind),
        insertText: typeof edit?.newText === "string" ? edit.newText : typeof item.insertText === "string" ? item.insertText : item.label,
        range: editRange ? toMonacoRange(editRange) : fallback,
      };
      // Optional fields are set only when the server sent them (exactOptionalPropertyTypes).
      if (typeof item.detail === "string") suggestion.detail = item.detail;
      const docs = documentation(item.documentation);
      if (docs !== undefined) suggestion.documentation = docs;
      if (typeof item.sortText === "string") suggestion.sortText = item.sortText;
      if (typeof item.filterText === "string") suggestion.filterText = item.filterText;
      if (item.deprecated === true) suggestion.tags = [monaco.languages.CompletionItemTag.Deprecated];
      return [suggestion];
    });
    return { suggestions, incomplete: (result as { isIncomplete?: unknown } | null)?.isIncomplete === true };
  }

  async definition(doc: Doc, position: Monaco.Position, token: Monaco.CancellationToken): Promise<Monaco.languages.Location[] | null> {
    const result = await doc.session
      .request<unknown>("textDocument/definition", { textDocument: { uri: doc.uri }, position: toLspPosition(position) }, token)
      .catch(() => null);
    const locations = toLocations(result);
    if (!locations.length) return null;
    const out: Monaco.languages.Location[] = [];
    for (const loc of locations) {
      const same = this.byUri.get(loc.uri);
      if (same) {
        out.push({ uri: same.model.uri, range: toMonacoRange(loc.range) });
        continue;
      }
      const target = fromFileUri(loc.uri, this.o.folders());
      if (!target) continue;
      const model = await this.peekModel(target.folder, target.path);
      if (model) out.push({ uri: model.uri, range: toMonacoRange(loc.range) });
    }
    if (!out.length) this.o.intel.notify(doc.key, "That definition is outside this project's folders.");
    return out;
  }

  /** Monaco needs a model to peek at or jump to; reuse the open buffer, else read the file once. */
  private async peekModel(folder: string, path: string): Promise<Monaco.editor.ITextModel | null> {
    const uri = this.o.buffers.uriFor(folder, path);
    if (!uri) return null;
    const existing = this.o.monaco.editor.getModel(uri);
    if (existing) return existing;
    const content = await this.o.bridge.readFile(this.o.projectId, folder, path).then(
      (f) => f.content,
      () => null,
    );
    if (content === null || this.disposed) return null;
    const model = this.o.monaco.editor.getModel(uri) ?? this.o.monaco.editor.createModel(content, undefined, uri);
    this.peeks.add(model);
    return model;
  }

  /** Opens an `octo:` model location as a tab; false when the URI isn't one of this project's files. */
  openLocation(resource: Monaco.Uri, selection: Monaco.IRange | Monaco.IPosition | undefined): boolean {
    const [, folder, ...rest] = resource.path.split("/");
    if (!folder || !rest.length) return false;
    const line = selection ? ("startLineNumber" in selection ? selection.startLineNumber : selection.lineNumber) : 1;
    const column = selection ? ("startColumn" in selection ? selection.startColumn : selection.column) : 1;
    this.o.open(folder, rest.join("/"), { line, column });
    return true;
  }

  private isBuffer(model: Monaco.editor.ITextModel): boolean {
    const [, folder, ...rest] = model.uri.path.split("/");
    if (folder === undefined) return false;
    return this.o.buffers.has(fileKey(folder, rest.join("/")));
  }
}

/** Jumps to another file (go to definition) open it as a tab instead of in a Monaco-managed editor. */
function installOpener(monaco: MonacoApi) {
  opener ??= monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selection) {
      if (resource.scheme !== "octo" || source.getModel()?.uri.toString() === resource.toString()) return false;
      for (const m of live) if (m.ownsAuthority(resource.authority)) return m.openLocation(resource, selection);
      return false;
    },
  });
}

function registerProviders(monaco: MonacoApi, language: string) {
  if (registered.has(language)) return;
  registered.add(language);
  const L = monaco.languages;
  L.registerHoverProvider(language, {
    provideHover: (model, position, token) => {
      const hit = managerFor(model);
      return hit ? hit.manager.hover(hit.doc, position, token) : null;
    },
  });
  L.registerCompletionItemProvider(language, {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position, _context, token) => {
      const hit = managerFor(model);
      return hit ? hit.manager.completion(hit.doc, position, token) : null;
    },
  });
  L.registerDefinitionProvider(language, {
    provideDefinition: (model, position, token) => {
      const hit = managerFor(model);
      return hit ? hit.manager.definition(hit.doc, position, token) : null;
    },
  });
}
