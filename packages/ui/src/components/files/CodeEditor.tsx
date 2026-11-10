import type * as Monaco from "monaco-editor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OpenFile } from "../../state/code";
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

/** Same stack as the `--font-mono` token. */
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * Thin Monaco wrapper: one editor instance, one model per open file (kept in `buffers`
 * so edits outlive this component), view state saved and restored per tab.
 */
export function CodeEditor(props: {
  file: OpenFile;
  buffers: EditorBuffers;
  theme: "dark" | "light";
  onSave(): void;
}) {
  const { file, buffers } = props;
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<MonacoModule | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownKey = useRef<string | null>(null);
  const onSave = useRef(props.onSave);
  useLayoutEffect(() => {
    onSave.current = props.onSave;
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
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      smoothScrolling: false,
      cursorBlinking: reduced ? "solid" : "blink",
      cursorSmoothCaretAnimation: "off",
      fixedOverflowWidgets: true,
      ariaLabel: "Code editor",
      tabFocusMode: false,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave.current());
    editorRef.current = editor;
    buffers.editor = editor;
    return () => {
      if (shownKey.current) buffers.saveView(shownKey.current, editor.saveViewState());
      shownKey.current = null;
      if (buffers.editor === editor) buffers.editor = null;
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
  }, [mod, buffers, file.key, file.folder, file.path, file.content, file.status]);

  if (failed) {
    return (
      <p role="alert" className="px-3 pt-3 text-sm text-fg-2">
        The editor couldn't load ({failed}). Reload the window to try again.
      </p>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {!mod && (
        <div className="absolute inset-0 flex items-start gap-2 px-3 pt-3 text-sm text-fg-3">
          <Spinner />
          Loading editor…
        </div>
      )}
      <div ref={host} className="h-full min-h-0" data-testid="code-editor" />
    </div>
  );
}
