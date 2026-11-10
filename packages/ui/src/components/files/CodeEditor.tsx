import type * as Monaco from "monaco-editor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FilePosition } from "../../lib/files";
import type { OpenFile } from "../../state/code";
import { useDelayedLoading } from "../../lib/hooks";
import { Spinner } from "../primitives/Status";
import type { EditorBuffers, MonacoApi } from "./buffers";

type MonacoModule = typeof import("./monaco");

let pending: Promise<MonacoModule> | null = null;

/** Loads Monaco (and defines the themes) once, on first use. */
export function loadMonaco(): Promise<MonacoModule> {
  pending ??= import("./monaco").catch((e: unknown) => {
    pending = null;
    throw e;
  });
  return pending;
}

/**
 * Selects `at` and scrolls it to the middle; in a hidden tab (no layout yet) it waits for the
 * first layout, so the position is right once the tab shows.
 */
function reveal(editor: Monaco.editor.IStandaloneCodeEditor, at: FilePosition | null) {
  if (!at) return;
  const apply = () => {
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, at.line), model.getLineCount());
    const end = Math.min(Math.max(line, at.endLine ?? line), model.getLineCount());
    const column = at.endLine === undefined ? Math.max(1, at.column ?? 1) : 1;
    editor.setSelection(at.endLine === undefined ? { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column } : { startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) });
    editor.revealLinesInCenterIfOutsideViewport(line, end);
    editor.focus();
  };
  if (editor.getLayoutInfo().height > 0) return apply();
  const sub = editor.onDidLayoutChange((info) => {
    if (info.height <= 0) return;
    sub.dispose();
    apply();
  });
}

/** Same stack as the `--font-mono` token. */
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Thin Monaco wrapper: one editor instance per File tab, showing that file's model (kept in
 * `buffers` so edits outlive this component); view state is saved on unmount and restored.
 */
export function CodeEditor(props: {
  file: OpenFile;
  buffers: EditorBuffers;
  theme: "dark" | "light";
  onSave(): void;
  /** Monaco is in: start the editor services that need it (the language-server client). */
  onMonaco(mod: MonacoModule): void;
}) {
  const { file, buffers } = props;
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const onMonaco = useRef(props.onMonaco);
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<MonacoModule | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const loadingShown = useDelayedLoading(!mod && !failed);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownKey = useRef<string | null>(null);
  const onSave = useRef(props.onSave);
  useLayoutEffect(() => {
    onSave.current = props.onSave;
    onMonaco.current = props.onMonaco;
  });

  useEffect(() => {
    let alive = true;
    loadMonaco().then(
      (m) => alive && setMod(m),
      (e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, []);

  // Create the editor once Monaco is in; dispose it (not the models) on unmount.
  useEffect(() => {
    if (!mod || !host.current) return;
    const monaco: MonacoApi = mod.monaco;
    buffers.attach(monaco);
    onMonaco.current(mod);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const editor = monaco.editor.create(host.current, {
      model: null,
      theme: mod.themeName(props.theme),
      automaticLayout: true,
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      rulers: [],
      scrollBeyondLastLine: false,
      // No horizontal scrollbar unless a line really is wider than the editor.
      scrollBeyondLastColumn: 0,
      padding: { top: 8, bottom: 8 },
      wordWrap: "off",
      detectIndentation: true,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      showFoldingControls: "mouseover",
      renderLineHighlight: "line",
      renderLineHighlightOnlyWhenFocus: true,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: false },
      guides: { indentation: true, bracketPairs: false },
      // Slim and quiet like the app's other scroll areas: a 6px thumb in a 10px track, faded in on
      // scroll or hover (styles.css widens and darkens it on hover/drag); none when content fits.
      scrollbar: {
        vertical: "auto",
        horizontal: "auto",
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        verticalSliderSize: 6,
        horizontalSliderSize: 6,
        useShadows: false,
        alwaysConsumeMouseWheel: false,
      },
      smoothScrolling: false,
      cursorBlinking: reduced ? "solid" : "blink",
      cursorSmoothCaretAnimation: "off",
      fixedOverflowWidgets: true,
      ariaLabel: "Code editor",
      tabFocusMode: false,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave.current());
    editorRef.current = editor;
    buffers.editors.add(editor);
    setEditor(editor);
    return () => {
      setEditor(null);
      if (shownKey.current) buffers.saveView(shownKey.current, editor.saveViewState());
      shownKey.current = null;
      buffers.editors.delete(editor);
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
    };
    // Theme changes are applied below without recreating the editor.
  }, [mod, buffers]);

  useEffect(() => {
    if (mod) mod.monaco.editor.setTheme(mod.themeName(props.theme));
  }, [mod, props.theme]);

  // Show the active file's model, saving the previous tab's view state.
  useEffect(() => {
    const editor = editorRef.current;
    if (!mod || !editor || file.status !== "ready") return;
    if (shownKey.current === file.key && editor.getModel()) return;
    if (shownKey.current && shownKey.current !== file.key) buffers.saveView(shownKey.current, editor.saveViewState());
    const model = buffers.ensure(file.key, file.folder, file.path, file.content);
    editor.setModel(model);
    const view = buffers.view(file.key);
    if (view) editor.restoreViewState(view);
    shownKey.current = file.key;
    reveal(editor, buffers.takeReveal(file.key));
  }, [mod, buffers, file.key, file.folder, file.path, file.content, file.status]);

  // A link, a comment or a definition asked for a position in this file.
  useEffect(
    () =>
      buffers.onReveal((key) => {
        const editor = editorRef.current;
        if (key === file.key && editor && shownKey.current === key && editor.getModel()) reveal(editor, buffers.takeReveal(key));
      }),
    [buffers, file.key],
  );

  if (failed) {
    return (
      <p role="alert" className="px-3 pt-3 text-sm text-fg-2">
        The editor couldn't load ({failed}). Reload the window to try again.
      </p>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {loadingShown && (
        <div className="absolute inset-0 z-10 flex items-start gap-2 bg-panel px-3 pt-3 text-sm text-fg-3">
          <Spinner />
          Loading editor…
        </div>
      )}
      <div ref={host} className="h-full min-h-0" data-testid="code-editor" />
      {mod && editor && <mod.EditorComments editor={editor} monaco={mod.monaco} buffers={buffers} folder={file.folder} path={file.path} />}
    </div>
  );
}
