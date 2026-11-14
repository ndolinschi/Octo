import type * as Monaco from "monaco-editor";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FilePosition } from "../../lib/files";
import type { OpenFile } from "../../state/code";
import { useLatest } from "../../lib/hooks";
import { EditorContextMenu } from "../shared/EditorContextMenu";
import { EditorSkeleton } from "./EditorSkeleton";
import type { EditorBuffers, MonacoApi } from "../../lib/buffers";
import { errorMessage } from "../../lib/format";
import { type FileKey } from "../../lib/files";

type MonacoModule = typeof import("./monaco");
const InlineCompletion = lazy(() => import("./editor/completion/InlineCompletion"));

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
    editor.setSelection(
      at.endLine === undefined
        ? { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }
        : { startLineNumber: line, startColumn: 1, endLineNumber: end, endColumn: model.getLineMaxColumn(end) },
    );
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
 * Thin Monaco wrapper: one editor instance per file view (it outlives every file the view shows; decision 85), swapping
 * the file's model in (kept in `buffers` so edits outlive this component); view state is saved on a swap and on unmount and restored.
 */
export function CodeEditor(props: {
  file: OpenFile | null;
  buffers: EditorBuffers;
  theme: "dark" | "light";
  /** Room below the last line (8, or the floating composer's height + 16 so the last line stays reachable). */
  bottomPadding?: number;
  onSave(): void;
  /** Monaco is in: start the editor services that need it (the language-server client). */
  onMonaco(mod: MonacoModule): void;
}) {
  const { file, buffers } = props;
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<MonacoModule | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownKey = useRef<FileKey | null>(null);
  const onSave = useLatest(props.onSave);
  const onMonaco = useLatest(props.onMonaco);
  const bottomPadding = useLatest(props.bottomPadding ?? 8);

  useEffect(() => {
    let alive = true;
    loadMonaco().then(
      (m) => alive && setMod(m),
      (e: unknown) => alive && setFailed(errorMessage(e)),
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
    // Hover, suggest and peek widgets live in a layer on <body> above the app (fixed positions), so the
    // tree column, the breadcrumb row and the panel's clipping can never cut them or slide over them.
    const overflow = document.createElement("div");
    overflow.className = "monaco-editor octo-monaco-overflow";
    document.body.appendChild(overflow);
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
      padding: { top: 8, bottom: bottomPadding.current },
      wordWrap: "off",
      detectIndentation: true,
      // Gutter (polish step 4, E4): the comment lane (glyph margin, 20), numbers at least 3 digits wide, then a fixed 22px
      // to the code: 6 for the comment rail and the 16 Monaco adds for the fold chevrons (shown on hover). Steady for any
      // file up to 999 lines (was 26: Monaco's default 10 + 16).
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 6,
      // The comment "+" has its own lane left of the line numbers, so it never covers code (any indent).
      glyphMargin: true,
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
      // Slim and quiet like the app's other scroll areas: a 4px thumb in an 8px track (styles.css widens it to 6 and
      // darkens it on hover/drag); none when content fits.
      scrollbar: {
        vertical: "auto",
        // Always shown when a line is wider than the editor (a cut line needs a visible way to it).
        horizontal: "visible",
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        verticalSliderSize: 4,
        horizontalSliderSize: 4,
        useShadows: false,
        alwaysConsumeMouseWheel: false,
      },
      smoothScrolling: false,
      cursorBlinking: reduced ? "solid" : "blink",
      cursorSmoothCaretAnimation: "off",
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflow,
      ariaLabel: "Code editor",
      tabFocusMode: false,
      // The right-click menu is the app's own (EditorContextMenu): Monaco's has no surface in its shadow root.
      contextmenu: false,
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
      overflow.remove();
      editorRef.current = null;
    };
    // Theme changes are applied below without recreating the editor.
  }, [mod, buffers, bottomPadding, onMonaco, onSave]);

  useEffect(() => {
    if (mod) mod.monaco.editor.setTheme(mod.themeName(props.theme));
  }, [mod, props.theme]);

  // Room for the floating composer. Monaco's reveal (arrows, Ctrl/Cmd+End, typing) ignores the bottom
  // padding, so a caret moved under the composer is scrolled back above it.
  useEffect(() => {
    if (!editor) return;
    const bottom = props.bottomPadding ?? 8;
    editor.updateOptions({ padding: { top: 8, bottom } });
    if (bottom <= 8) return;
    const sub = editor.onDidChangeCursorPosition((e) => {
      const lineBottom = editor.getBottomForLineNumber(e.position.lineNumber) - editor.getScrollTop();
      const limit = editor.getLayoutInfo().height - bottom;
      if (lineBottom > limit) editor.setScrollTop(editor.getScrollTop() + lineBottom - limit);
    });
    return () => sub.dispose();
  }, [editor, props.bottomPadding]);

  // Show the active file's model, saving the previous file's view state. A layout effect: the swap lands in the same frame
  // as the commit that removes the cover, so the old file's text is never painted for the new one (decision 85).
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!mod || !editor || file?.status !== "ready") return;
    if (shownKey.current === file.key && editor.getModel()) return;
    if (shownKey.current && shownKey.current !== file.key) buffers.saveView(shownKey.current, editor.saveViewState());
    const model = buffers.ensure(file.key, file.folder, file.path, file.content);
    editor.setModel(model);
    const view = buffers.view(file.key);
    if (view) editor.restoreViewState(view);
    shownKey.current = file.key;
    reveal(editor, buffers.takeReveal(file.key));
  }, [mod, buffers, file, editor]);

  // A link, a comment or a definition asked for a position in this file.
  useEffect(
    () =>
      buffers.onReveal((key) => {
        const editor = editorRef.current;
        if (key === file?.key && editor && shownKey.current === key && editor.getModel()) reveal(editor, buffers.takeReveal(key));
      }),
    [buffers, file],
  );

  if (failed) {
    return (
      <p role="alert" className="px-3 pt-3 text-sm text-fg-2">
        The editor couldn't load ({failed}). Reload the window to try again.
      </p>
    );
  }

  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-clip">
      {/* Decision 60: grey lines in the editor's own box until Monaco is in, shown at once (no empty frame, no late spinner). */}
      {!editor && !failed && <EditorSkeleton />}
      <div ref={host} className="h-full min-h-0 min-w-0" data-testid="code-editor" />
      {editor && file && <EditorContextMenu editor={editor} path={file.path} />}
      {mod && editor && file && <mod.EditorComments editor={editor} monaco={mod.monaco} buffers={buffers} folder={file.folder} path={file.path} />}
      {mod && editor && file && (
        <Suspense fallback={null}>
          <InlineCompletion editor={editor} monaco={mod.monaco} fileKey={file.key} folder={file.folder} path={file.path} />
        </Suspense>
      )}
    </div>
  );
}
