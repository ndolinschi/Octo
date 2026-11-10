/**
 * A scripted language server for the demo (TypeScript and Go). It speaks just enough JSON-RPC
 * to exercise the UI's LSP client: initialize, document sync, diagnostics (unused imports and
 * any line containing "TODO(error)"), hover, completion and go-to-definition across the
 * project's demo files. Loaded lazily, only when the editor asks for a language server.
 */
import type { LanguageServerExit, LanguageServerSession } from "@octo/agent-client";
import { fileUri, fromFileUri } from "../lsp/uri";
import type { ProjectRecord } from "./store";

export type DemoServerOptions = { serverId: string; startMs: number; exitAfterMs: number | null };

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
type Pos = { line: number; character: number };
type Range = { start: Pos; end: Pos };
type Decl = { name: string; kind: "function" | "const" | "class" | "type"; signature: string; folder: string; path: string; range: Range };

const TS_KEYWORDS = ["async", "await", "const", "export", "function", "import", "interface", "return", "throw"];
const GO_KEYWORDS = ["defer", "func", "go", "if", "range", "return", "struct", "var"];

function lines(text: string): string[] {
  return text.split("\n");
}

function isGo(path: string): boolean {
  return path.endsWith(".go");
}

/** Declarations in one file (top-level functions, consts, classes, types). */
function declarations(folder: string, path: string, text: string): Decl[] {
  const out: Decl[] = [];
  const go = isGo(path);
  lines(text).forEach((line, i) => {
    const m = go
      ? /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/.exec(line)
      : /^(?:export\s+)?(?:async\s+)?(function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) return;
    const name = go ? m[1] : m[2];
    const kind: Decl["kind"] = go
      ? "function"
      : m[1] === "function"
        ? "function"
        : m[1] === "class"
          ? "class"
          : m[1] === "interface" || m[1] === "type"
            ? "type"
            : "const";
    const character = line.indexOf(name, go ? 4 : 0);
    const signature = line
      .replace(/\s*[{=]\s*$/, "")
      .replace(/\s*\{\s*$/, "")
      .replace(/^export\s+/, "")
      .trim();
    out.push({ name, kind, signature, folder, path, range: { start: { line: i, character }, end: { line: i, character: character + name.length } } });
  });
  return out;
}

function wordAt(text: string, pos: Pos): string | null {
  const line = lines(text)[pos.line] ?? "";
  const re = /[A-Za-z_$][\w$]*/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (pos.character >= m.index && pos.character <= m.index + m[0].length) return m[0];
  }
  return null;
}

function diagnostics(path: string, text: string) {
  const out: unknown[] = [];
  const all = lines(text);
  const go = isGo(path);
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  all.forEach((line, i) => {
    const todo = line.indexOf("TODO(error)");
    if (todo >= 0) {
      out.push({
        range: { start: { line: i, character: todo }, end: { line: i, character: todo + 4 } },
        severity: 1,
        source: go ? "compiler" : "ts",
        code: go ? "UndeclaredName" : 2304,
        message: go ? "undefined: TODO" : "Cannot find name 'TODO'.",
      });
    }
    if (go) {
      const m = /^\s*"([^"]+)"\s*$/.exec(line);
      if (!m) return;
      const parts = m[1].split("/");
      const name = /^v\d+$/.test(parts[parts.length - 1]) ? parts[parts.length - 2] : parts[parts.length - 1];
      if (count(new RegExp(`\\b${name}\\.`, "g")) === 0) {
        const at = line.indexOf('"');
        out.push({
          range: { start: { line: i, character: at }, end: { line: i, character: at + m[1].length + 2 } },
          severity: 1,
          source: "compiler",
          code: "UnusedImport",
          message: `"${m[1]}" imported and not used`,
        });
      }
      return;
    }
    const m = /^import\s+(?:type\s+)?\{([^}]+)\}\s+from/.exec(line);
    if (!m) return;
    for (const raw of m[1].split(",")) {
      const name = raw
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (!name || count(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g")) > 1) continue;
      const at = line.indexOf(name);
      out.push({
        range: { start: { line: i, character: at }, end: { line: i, character: at + name.length } },
        severity: 2,
        source: "ts",
        code: 6133,
        tags: [1],
        message: `'${name}' is declared but its value is never read.`,
      });
    }
  });
  return out;
}

/** Creates one fake server session over a project's demo files. */
export function createDemoServer(rec: ProjectRecord, opts: DemoServerOptions): LanguageServerSession {
  const folders = () => rec.project.folders.map((f) => ({ label: f.label, path: f.path }));
  const docs = new Map<string, string>();
  const messageListeners = new Set<(m: unknown) => void>();
  const exitListeners = new Set<(e: LanguageServerExit) => void>();
  const queue: unknown[] = [];
  let exited: LanguageServerExit | null = null;
  let closed = false;
  const timers = new Set<number>();

  const later = (ms: number, fn: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!closed && !exited) fn();
    }, ms);
    timers.add(id);
  };
  const post = (message: unknown) => {
    if (messageListeners.size) messageListeners.forEach((cb) => cb(message));
    else queue.push(message);
  };
  const reply = (id: Msg["id"], result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: Msg["id"], code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });
  const exit = (info: LanguageServerExit) => {
    if (exited) return;
    exited = info;
    exitListeners.forEach((cb) => cb(info));
  };

  /** Text of a URI: the open document, else the demo file system. */
  const textOf = (uri: string): string | null => {
    const open = docs.get(uri);
    if (open !== undefined) return open;
    const loc = fromFileUri(uri, folders());
    return loc ? (rec.files.get(loc.folder)?.get(loc.path)?.content ?? null) : null;
  };

  const allDeclarations = (uri: string): Decl[] => {
    const here = fromFileUri(uri, folders());
    const go = here ? isGo(here.path) : false;
    const out: Decl[] = [];
    if (here) out.push(...declarations(here.folder, here.path, textOf(uri) ?? ""));
    for (const [folder, tree] of rec.files) {
      for (const [path, file] of tree) {
        if (here && folder === here.folder && path === here.path) continue;
        if (isGo(path) !== go || !/\.(ts|tsx|go)$/.test(path) || file.binary) continue;
        out.push(...declarations(folder, path, file.content));
      }
    }
    return out;
  };

  const publish = (uri: string) =>
    later(140, () => {
      const loc = fromFileUri(uri, folders());
      const text = docs.get(uri);
      post({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: text !== undefined && loc ? diagnostics(loc.path, text) : [] },
      });
    });

  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    hover: (p) => {
      const uri = (p.textDocument as { uri: string }).uri;
      const text = textOf(uri);
      const word = text !== null ? wordAt(text, p.position as Pos) : null;
      if (!word) return null;
      const decl = allDeclarations(uri).find((d) => d.name === word);
      const loc = fromFileUri(uri, folders());
      const lang = loc && isGo(loc.path) ? "go" : "typescript";
      if (!decl) {
        if ((lang === "go" ? GO_KEYWORDS : TS_KEYWORDS).includes(word)) return null;
        return { contents: { kind: "markdown", value: `\`\`\`${lang}\n(${lang === "go" ? "var" : "local"}) ${word}\n\`\`\`` } };
      }
      const where = decl.path === loc?.path ? "" : `\n\nDefined in \`${decl.folder}/${decl.path}\``;
      return { contents: { kind: "markdown", value: `\`\`\`${lang}\n${decl.signature}\n\`\`\`${where}` } };
    },
    completion: (p) => {
      const uri = (p.textDocument as { uri: string }).uri;
      const loc = fromFileUri(uri, folders());
      const go = loc ? isGo(loc.path) : false;
      // Like a real server: what starts with the word being typed, a handful at most.
      const line = lines(textOf(uri) ?? "")[(p.position as Pos).line] ?? "";
      const prefix = (/[A-Za-z_$][\w$]*$/.exec(line.slice(0, (p.position as Pos).character))?.[0] ?? "").toLowerCase();
      const seen = new Set<string>();
      const items: unknown[] = [];
      for (const d of allDeclarations(uri)) {
        if (seen.has(d.name) || items.length >= 8 || !d.name.toLowerCase().startsWith(prefix)) continue;
        seen.add(d.name);
        items.push({
          label: d.name,
          kind: d.kind === "function" ? 3 : d.kind === "class" ? 7 : d.kind === "type" ? 8 : 21,
          detail: d.signature,
          sortText: `0${d.name}`,
        });
      }
      for (const k of go ? GO_KEYWORDS : TS_KEYWORDS) if (k.startsWith(prefix)) items.push({ label: k, kind: 14, sortText: `1${k}` });
      return { isIncomplete: false, items };
    },
    definition: (p) => {
      const uri = (p.textDocument as { uri: string }).uri;
      const text = textOf(uri);
      const word = text !== null ? wordAt(text, p.position as Pos) : null;
      const decl = word ? allDeclarations(uri).find((d) => d.name === word) : undefined;
      if (!decl) return null;
      const folder = rec.project.folders.find((f) => f.label === decl.folder);
      return folder ? [{ uri: fileUri(folder.path, decl.path), range: decl.range }] : null;
    },
  };

  const receive = (msg: Msg) => {
    const { id, method, params = {} } = msg;
    if (!method) return; // a response to something we asked (workspace/configuration)
    switch (method) {
      case "initialize":
        return later(opts.startMs, () => {
          reply(id, {
            capabilities: { textDocumentSync: 1, hoverProvider: true, completionProvider: { triggerCharacters: ["."] }, definitionProvider: true },
            serverInfo: { name: opts.serverId, version: "demo" },
          });
          if (opts.exitAfterMs !== null) later(opts.exitAfterMs, () => exit({ code: 2, reason: "the language server crashed" }));
        });
      case "initialized":
        // Real servers ask the client things; the client must cope.
        post({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: opts.serverId }] } });
        return post({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: `${opts.serverId} (demo) ready` } });
      case "shutdown":
        return reply(id, null);
      case "exit":
        return exit({ code: 0 });
      case "textDocument/didOpen": {
        const doc = params.textDocument as { uri: string; text: string };
        docs.set(doc.uri, doc.text);
        return publish(doc.uri);
      }
      case "textDocument/didChange": {
        const uri = (params.textDocument as { uri: string }).uri;
        const changes = params.contentChanges as { text: string }[];
        if (changes.length) docs.set(uri, changes[changes.length - 1].text);
        return publish(uri);
      }
      case "textDocument/didClose": {
        const uri = (params.textDocument as { uri: string }).uri;
        docs.delete(uri);
        return post({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
      }
      case "$/cancelRequest":
        return;
    }
    const handler = handlers[method.replace(/^textDocument\//, "")];
    if (id === undefined) return;
    if (!handler) return later(10, () => fail(id, -32601, `method not found: ${method}`));
    later(40, () => reply(id, handler(params)));
  };

  const folderList = rec.project.folders;
  return {
    rootUri: folderList[0] ? fileUri(folderList[0].path) : "",
    workspaceFolders: folderList.map((f) => ({ uri: fileUri(f.path), name: f.label })),
    async send(message) {
      if (closed) throw new Error("language server session closed");
      // Like the relay: a JSON round trip, so nothing is shared by reference.
      receive(JSON.parse(JSON.stringify(message)) as Msg);
    },
    onMessage(cb) {
      messageListeners.add(cb);
      queue.splice(0).forEach(cb);
      return () => void messageListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      if (exited) cb(exited);
      return () => void exitListeners.delete(cb);
    },
    async close() {
      closed = true;
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    },
  };
}
