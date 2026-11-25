import type * as Monaco from "monaco-editor";
import { useEffect } from "react";
import type { FileKey } from "../../../../lib/files";
import { modelName } from "../../../../lib/models";
import { useApp } from "../../../../state/app";
import { useProject } from "../../../../state/project";
import { cutPrefix, cutSuffix, fileExclusion, FILE_MAX, skipNow } from "./context";
import { CompletionEngine } from "./engine";
import { completionStatus, stateAfterError, type CompletionState } from "./status";

type MonacoApi = typeof Monaco;

/** At most this many lines in one suggestion (the harness accepts 1 to 20). */
const MAX_LINES = 8;

/**
 * Inline completion for one editor (inline completion design): grey ghost text at the cursor from the project's
 * completion model. Monaco's own keys do the rest: Tab accepts it, Ctrl/Cmd+→ accepts a word, Esc dismisses it.
 * Off (and free) when the bridge cannot complete or the project has no completion model; the file bar's status item
 * says which. Loaded with `import()` from the editor, after Monaco.
 */
export default function InlineCompletion({
  editor,
  monaco,
  fileKey,
  folder,
  path,
}: {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: MonacoApi;
  fileKey: FileKey;
  folder: string;
  path: string;
}) {
  const { bridge } = useApp();
  const { projectId, project } = useProject();
  const model = project?.models.completion;

  useEffect(() => {
    const set = (s: CompletionState | null) => completionStatus.set(fileKey, s);
    const complete = bridge.complete;
    if (!complete) {
      set({ kind: "off", reason: "This version of Octo's local service has no inline completion" });
      return () => set(null);
    }
    if (!model || model === "off") {
      set({ kind: "off", reason: "Choose a completion model in Settings → Editor" });
      return () => set(null);
    }
    const label = modelName(model);
    let paused: { until: number; timer: number } | null = null;
    let composing = false;
    let exclusion: string | null = null;

    const ready = (): CompletionState => (exclusion ? { kind: "off", reason: exclusion } : { kind: "ready", model: label });
    const readFile = () => {
      const m = editor.getModel();
      if (!m) return;
      const size = m.getValueLength();
      exclusion = fileExclusion({
        path,
        size,
        sample: size > FILE_MAX ? "" : m.getValue().slice(0, 8192),
        readOnly: editor.getOption(monaco.editor.EditorOption.readOnly),
      });
      if (!paused) set(ready());
    };

    const engine = new CompletionEngine({
      fetch: async (input, signal) => {
        const result = await complete.call(bridge, projectId, { ...input, max_lines: MAX_LINES }, { signal });
        return result?.text ?? null;
      },
      onBusy: (busy) => {
        if (!paused && !exclusion) set({ kind: busy ? "thinking" : "ready", model: label });
      },
      onError: (e) => {
        const next = stateAfterError(e, Date.now());
        set(next);
        if (paused) window.clearTimeout(paused.timer);
        if (next.kind !== "paused") {
          // Off for the rest of this editor's life (the model was cleared); a project update re-runs this effect.
          paused = { until: Number.POSITIVE_INFINITY, timer: 0 };
          return;
        }
        paused = {
          until: next.until,
          timer: window.setTimeout(() => {
            paused = null;
            set(ready());
          }, next.until - Date.now()),
        };
      },
    });

    const provider: Monaco.languages.InlineCompletionsProvider = {
      displayName: "Octo",
      provideInlineCompletions: async (textModel, position, context, token) => {
        const none = { items: [] };
        if (textModel !== editor.getModel() || !editor.hasTextFocus()) return none;
        if (exclusion || (paused && Date.now() < paused.until)) return none;
        const selection = editor.getSelection();
        const moment = {
          selection: selection !== null && !selection.isEmpty(),
          composing,
          // Monaco passes the selected item of the suggestion list while that list is open (the LSP's completions).
          suggestListOpen: context.selectedSuggestionInfo !== undefined,
        };
        if (skipNow(moment)) {
          engine.cancel();
          return none;
        }
        const end = textModel.getFullModelRange();
        const prefix = textModel.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
        const suffix = textModel.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: end.endLineNumber,
          endColumn: end.endColumn,
        });
        const text = await engine.suggest({ path, folder, language: textModel.getLanguageId(), prefix: cutPrefix(prefix), suffix: cutSuffix(suffix) }, token);
        if (!text || token.isCancellationRequested) return none;
        const at = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        return { items: [{ insertText: text, range: at }] };
      },
      disposeInlineCompletions: () => undefined,
    };

    editor.updateOptions({ inlineSuggest: { enabled: true, mode: "subwordSmart", showToolbar: "never", suppressSuggestions: false } });
    readFile();
    const subs = [
      monaco.languages.registerInlineCompletionsProvider("*", provider),
      editor.onDidChangeModel(readFile),
      editor.onDidCompositionStart(() => {
        composing = true;
        engine.cancel();
      }),
      editor.onDidCompositionEnd(() => {
        composing = false;
      }),
      editor.onDidChangeModelContent(() => {
        const m = editor.getModel();
        // Crossing 1 MB (a large paste) turns it off without re-reading the whole file on every keystroke.
        if (m && m.getValueLength() > FILE_MAX !== (exclusion !== null && exclusion.includes("1 MB"))) readFile();
      }),
      editor.onDidBlurEditorText(() => engine.cancel()),
    ];
    return () => {
      for (const s of subs) s.dispose();
      engine.cancel();
      if (paused) window.clearTimeout(paused.timer);
      set(null);
    };
  }, [bridge, model, editor, monaco, projectId, fileKey, folder, path]);

  return null;
}
