import type * as Monaco from "monaco-editor";
import type { FilePosition } from "../../lib/files";

export type MonacoApi = typeof Monaco;

/** Told when a file's model is created (shown in an editor for the first time) and before it is disposed. */
export type BufferWatcher = { opened(key: string, model: Monaco.editor.ITextModel): void; closed(key: string): void };

type Buffer = {
  model: Monaco.editor.ITextModel;
  /** Alternative version id of the content last loaded from or saved to disk. */
  savedVersion: number;
  modified: boolean;
  view: Monaco.editor.ICodeEditorViewState | null;
  sub: Monaco.IDisposable;
};

/**
 * Monaco models for one project's open files, keyed by folder + path. Lives in the
 * project's code state (not in the editor component) so unsaved edits and view state
 * survive a File tab moving to another group (which remounts its editor). Only `import type` from Monaco here: the
 * runtime arrives later through `attach()` from the lazily loaded editor chunk.
 */
export class EditorBuffers {
  monaco: MonacoApi | null = null;
  /** Live editors (one per mounted File tab). */
  readonly editors = new Set<Monaco.editor.IStandaloneCodeEditor>();
  private buffers = new Map<string, Buffer>();
  private watchers = new Set<BufferWatcher>();
  private reveals = new Map<string, FilePosition>();
  private revealListeners = new Set<(key: string) => void>();
  /** True while disk content replaces a buffer (comment ranges keep their line numbers then). */
  replacing = false;

  constructor(
    private readonly projectId: string,
    private readonly onModified: (key: string, modified: boolean) => void,
  ) {}

  attach(monaco: MonacoApi) {
    this.monaco = monaco;
  }

  /** The model URI of a project file (`octo://{projectId}/{folder}/{path}`). */
  uriFor(folder: string, path: string): Monaco.Uri | null {
    return this.monaco?.Uri.from({ scheme: "octo", authority: this.projectId, path: `/${folder}/${path}` }) ?? null;
  }

  /** The model for `key`, created from `content` on first use. */
  ensure(key: string, folder: string, path: string, content: string): Monaco.editor.ITextModel | null {
    const monaco = this.monaco;
    const uri = this.uriFor(folder, path);
    if (!monaco || !uri) return null;
    const existing = this.buffers.get(key);
    if (existing) return existing.model;
    // Language is inferred from the file name (extension) in the URI. A model made earlier for a
    // definition peek is adopted, with the content just read from disk.
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri);
    if (model.getValue() !== content) model.setValue(content);
    const buffer: Buffer = { model, savedVersion: model.getAlternativeVersionId(), modified: false, view: null, sub: { dispose() {} } };
    buffer.sub = model.onDidChangeContent(() => this.check(key, buffer));
    this.buffers.set(key, buffer);
    this.watchers.forEach((w) => w.opened(key, model));
    return model;
  }

  /** Follows models as they open and close (the language-server client); called at once for open ones. */
  watch(watcher: BufferWatcher): () => void {
    this.watchers.add(watcher);
    for (const [key, b] of this.buffers) watcher.opened(key, b.model);
    return () => void this.watchers.delete(watcher);
  }

  /** Asks the editor showing `key` (now or once it does) to select and reveal a position. */
  reveal(key: string, at: FilePosition) {
    this.reveals.set(key, at);
    this.revealListeners.forEach((l) => l(key));
  }

  takeReveal(key: string): FilePosition | null {
    const at = this.reveals.get(key) ?? null;
    this.reveals.delete(key);
    return at;
  }

  onReveal(listener: (key: string) => void): () => void {
    this.revealListeners.add(listener);
    return () => void this.revealListeners.delete(listener);
  }

  has(key: string): boolean {
    return this.buffers.has(key);
  }

  value(key: string): string | null {
    return this.buffers.get(key)?.model.getValue() ?? null;
  }

  version(key: string): number | null {
    return this.buffers.get(key)?.model.getAlternativeVersionId() ?? null;
  }

  /** Records that the buffer at `version` now matches the disk. */
  markSaved(key: string, version: number) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    buffer.savedVersion = version;
    this.check(key, buffer);
  }

  /** Replaces the buffer with disk content, keeping cursor and scroll where they were. */
  replace(key: string, content: string) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    if (buffer.model.getValue() !== content) {
      const editor = this.editorFor(buffer.model);
      const view = editor ? editor.saveViewState() : buffer.view;
      this.replacing = true;
      try {
        buffer.model.pushEditOperations([], [{ range: buffer.model.getFullModelRange(), text: content }], () => null);
      } finally {
        this.replacing = false;
      }
      if (editor && view) editor.restoreViewState(view);
      else buffer.view = view;
    }
    buffer.savedVersion = buffer.model.getAlternativeVersionId();
    this.check(key, buffer);
  }

  saveView(key: string, view: Monaco.editor.ICodeEditorViewState | null) {
    const buffer = this.buffers.get(key);
    if (buffer) buffer.view = view;
  }

  view(key: string): Monaco.editor.ICodeEditorViewState | null {
    return this.buffers.get(key)?.view ?? null;
  }

  dispose(key: string) {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    this.watchers.forEach((w) => w.closed(key));
    this.reveals.delete(key);
    this.editorFor(buffer.model)?.setModel(null);
    buffer.sub.dispose();
    buffer.model.dispose();
    this.buffers.delete(key);
  }

  disposeAll() {
    for (const key of [...this.buffers.keys()]) this.dispose(key);
  }

  private editorFor(model: Monaco.editor.ITextModel) {
    for (const e of this.editors) if (e.getModel() === model) return e;
    return null;
  }

  private check(key: string, buffer: Buffer) {
    const modified = buffer.model.getAlternativeVersionId() !== buffer.savedVersion;
    if (modified === buffer.modified) return;
    buffer.modified = modified;
    this.onModified(key, modified);
  }
}
