import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import type { MonacoApi } from "../../lib/buffers";
import { errorMessage } from "../../lib/format";
import { useLatest } from "../../lib/hooks";
import { useDelayedLoading } from "../../lib/hooksMore";
import { DIFF_FLASH_MS, type DiffLayout } from "../../lib/v7/changes";
import { EditorContextMenu } from "../shared/EditorContextMenu";
import { Spinner } from "../primitives/Status";
import { DiffComments, type LineComment } from "./DiffComments";

/** What the diff needs from the editor chunk; the host passes the files feature's loader (Monaco loads only there). */
export type DiffMonaco = { monaco: MonacoApi; themeName(mode: "dark" | "light"): string };

let uriSeq = 0;

/**
 * Monaco's diff editor for one change (v7 §1): read-only, unchanged regions folded, split or one column, whitespace
 * toggle. Changed lines flash their tone once per `flashKey` (decision 46). The modified side takes line comments.
 */
export function DiffEditor(props: {
  loadMonaco(): Promise<DiffMonaco>;
  theme: "dark" | "light";
  path: string;
  before: string;
  after: string;
  layout: DiffLayout;
  ignoreWhitespace: boolean;
  /** Changing it flashes the changed lines (a newly shown diff, a revert). */
  flashKey: number;
  /** Lines that already carry a pending comment (a rail and a tint). */
  commented: readonly { start: number; end: number }[];
  onAddComment?(comment: LineComment): void;
  /** The first changed line of the modified side (null: none, or not computed yet), reported as the diff updates. */
  onFirstLine?(line: number | null): void;
  /** A click on a line number of the modified side. */
  onGoToLine?(line: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<DiffMonaco | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const loading = useDelayedLoading(!mod && !failed);
  const shownTexts = useRef<{ before: string; after: string } | null>(null);
  const { loadMonaco } = props;
  const firstLine = useLatest(props.onFirstLine);
  const goToLine = useLatest(props.onGoToLine);

  useEffect(() => {
    let alive = true;
    loadMonaco().then(
      (m) => alive && setMod(m),
      (e: unknown) => alive && setFailed(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [loadMonaco]);

  useEffect(() => {
    if (!mod || !host.current) return;
    const ed = mod.monaco.editor.createDiffEditor(host.current, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      overviewRulerLanes: 0,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
      glyphMargin: true,
      lineNumbersMinChars: 3,
      folding: false,
      renderLineHighlight: "none",
      stickyScroll: { enabled: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false, alwaysConsumeMouseWheel: false },
      diffWordWrap: "off",
      renderMarginRevertIcon: false,
      ariaLabel: "Diff",
      contextmenu: false,
    });
    setEditor(ed);
    return () => {
      setEditor(null);
      const model = ed.getModel();
      ed.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, [mod]);

  useEffect(() => {
    if (mod) mod.monaco.editor.setTheme(mod.themeName(props.theme));
  }, [mod, props.theme]);

  useEffect(() => {
    editor?.updateOptions({ renderSideBySide: props.layout === "split", ignoreTrimWhitespace: props.ignoreWhitespace });
  }, [editor, props.layout, props.ignoreWhitespace]);

  // Models per shown text; URIs carry the path so Monaco picks the language from the extension.
  useEffect(() => {
    if (!mod || !editor) return;
    const n = ++uriSeq;
    const uri = (side: string) => mod.monaco.Uri.from({ scheme: "octo-diff", path: `/${n}/${side}/${props.path}` });
    const original = mod.monaco.editor.createModel(props.before, undefined, uri("before"));
    const modified = mod.monaco.editor.createModel(props.after, undefined, uri("after"));
    const old = editor.getModel();
    firstLine.current?.(null);
    editor.setModel({ original, modified });
    old?.original.dispose();
    old?.modified.dispose();
  }, [mod, editor, props.path, props.before, props.after, firstLine]);

  useEffect(() => {
    if (!mod || !editor) return;
    const report = () => {
      const changes = editor.getLineChanges();
      const first = changes?.[0];
      if (changes) firstLine.current?.(first ? Math.max(1, first.modifiedStartLineNumber) : null);
    };
    const sub = editor.onDidUpdateDiff(report);
    report();
    const down = editor.getModifiedEditor().onMouseDown((e) => {
      const line = e.target.position?.lineNumber;
      if (e.target.type === mod.monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && line) goToLine.current?.(line);
    });
    return () => {
      sub.dispose();
      down.dispose();
    };
  }, [mod, editor, firstLine, goToLine]);

  // Decision 46: once the diff is computed for a new flash key, its changed lines flash their tone.
  useEffect(() => {
    if (!editor) return;
    let done = false;
    let timer = 0;
    const flash = () => {
      const changes = editor.getLineChanges();
      if (done || !changes) return;
      done = true;
      const range = (a: number, b: number) => ({ startLineNumber: a, startColumn: 1, endLineNumber: Math.max(a, b), endColumn: 1 });
      const added = changes
        .filter((c) => c.modifiedEndLineNumber > 0)
        .map((c) => ({ range: range(c.modifiedStartLineNumber, c.modifiedEndLineNumber), options: { isWholeLine: true, className: "octo-v7-flash-add" } }));
      const removed = changes
        .filter((c) => c.originalEndLineNumber > 0)
        .map((c) => ({ range: range(c.originalStartLineNumber, c.originalEndLineNumber), options: { isWholeLine: true, className: "octo-v7-flash-del" } }));
      const a = editor.getModifiedEditor().createDecorationsCollection(added);
      const r = editor.getOriginalEditor().createDecorationsCollection(removed);
      timer = window.setTimeout(() => {
        a.clear();
        r.clear();
      }, DIFF_FLASH_MS + 100);
    };
    const sub = editor.onDidUpdateDiff(flash);
    // Same texts (a revert, a re-flash): the computed diff is current, flash now. New texts: wait for the new diff.
    const last = shownTexts.current;
    if (last?.before === props.before && last.after === props.after) flash();
    shownTexts.current = { before: props.before, after: props.after };
    return () => {
      sub.dispose();
      window.clearTimeout(timer);
    };
  }, [editor, props.flashKey, props.before, props.after]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0" />
      {editor && <EditorContextMenu editor={editor.getModifiedEditor()} path={props.path} />}
      {editor && <EditorContextMenu editor={editor.getOriginalEditor()} path={props.path} />}
      {mod && editor && props.onAddComment && (
        <DiffComments monaco={mod.monaco} editor={editor} path={props.path} commented={props.commented} onAdd={props.onAddComment} />
      )}
      {failed && (
        <p role="alert" className="absolute inset-x-0 top-6 px-6 text-center text-sm text-err">
          The diff viewer did not load: {failed}. Reload the window to try again.
        </p>
      )}
      {loading && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
    </div>
  );
}
