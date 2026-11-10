import type * as Monaco from "monaco-editor";

export type MonacoApi = typeof Monaco;

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

  constructor(
    private readonly projectId: string,
    private readonly onModified: (key: string, modified: boolean) => void,
  ) {}

  attach(monaco: MonacoApi) {
    this.monaco = monaco;
  }

  /** The model for `key`, created from `content` on first use. */
  ensure(key: string, folder: string, path: string, content: string): Monaco.editor.ITextModel | null {
    const monaco = this.monaco;
    if (!monaco) return null;
    const existing = this.buffers.get(key);
    if (existing) return existing.model;
    const uri = monaco.Uri.from({ scheme: "octo", authority: this.projectId, path: `/${folder}/${path}` });
    // Language is inferred from the file name (extension) in the URI.
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri);
    const buffer: Buffer = { model, savedVersion: model.getAlternativeVersionId(), modified: false, view: null, sub: { dispose() {} } };
    buffer.sub = model.onDidChangeContent(() => this.check(key, buffer));
    this.buffers.set(key, buffer);
    return model;
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
      buffer.model.pushEditOperations([], [{ range: buffer.model.getFullModelRange(), text: content }], () => null);
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
