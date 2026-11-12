import type * as Monaco from "monaco-editor";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { MonacoApi } from "../../lib/buffers";
import { errorMessage } from "../../lib/format";
import { useDelayedLoading, useLatest } from "../../lib/hooks";
import type { ChangeBlock } from "../../lib/review/changes";
import { commentableRuns, type Anchor, type LineRun, type Side } from "../../lib/review/position";
import { DIFF_FLASH_MS } from "../../lib/v7/changes";
import { Spinner } from "../primitives/Status";

/** What the diff needs from the editor chunk; the dock passes the files feature's loader (Monaco is a value only there). */
export type ReviewMonaco = { monaco: MonacoApi; themeName(mode: "dark" | "light"): string };

export type Marked = { side: Side; start: number; end: number };
export type RevealRequest = { block: ChangeBlock; n: number };
/** A block of the review drawn inside the diff after a line (an existing thread): `render(key)` is its content. */
export type DiffZone = { key: string; side: Side; line: number };

let uriSeq = 0;

/**
 * Monaco's diff editor for one file of a review: read-only, unchanged regions folded (or all shown), split or one
 * column. Hovering a commentable line shows a "+" in the gutter; the selection is reported so `c` and `s` know where to
 * comment. Lines that carry a pending comment get a rail, lines a finding points at a tint.
 */
export function ReviewDiff(props: {
  loadMonaco(): Promise<ReviewMonaco>;
  theme: "dark" | "light";
  path: string;
  before: string;
  after: string;
  split: boolean;
  ignoreWhitespace: boolean;
  /** Show every line instead of folding the unchanged ones ("Expand context"). */
  expanded: boolean;
  runs: { new: readonly LineRun[]; old: readonly LineRun[] };
  commented: readonly Marked[];
  flagged: readonly Marked[];
  reveal: RevealRequest | null;
  zones: readonly DiffZone[];
  renderZone(key: string): ReactNode;
  onAnchor(anchor: Anchor): void;
  onSelection(anchor: Anchor | null): void;
  /** Called once the diff is computed and shown. */
  onReady?(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<ReviewMonaco | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const loading = useDelayedLoading(!mod && !failed);
  const { loadMonaco } = props;
  const latest = useLatest(props);

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
      // Decision 79: long lines wrap in a review, so the diff never needs sideways scrolling and cannot open scrolled to the right.
      wordWrap: "on",
      diffWordWrap: "inherit",
      renderMarginRevertIcon: false,
      enableSplitViewResizing: false,
      useInlineViewWhenSpaceIsLimited: false,
      ariaLabel: "Diff",
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
    editor?.updateOptions({
      renderSideBySide: props.split,
      ignoreTrimWhitespace: props.ignoreWhitespace,
      hideUnchangedRegions: { enabled: !props.expanded, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
    });
  }, [editor, props.split, props.ignoreWhitespace, props.expanded]);

  // Models per shown text; URIs carry the path so Monaco picks the language from the extension.
  useEffect(() => {
    if (!mod || !editor) return;
    const n = ++uriSeq;
    const uri = (side: string) => mod.monaco.Uri.from({ scheme: "octo-review", path: `/${n}/${side}/${props.path}` });
    const original = mod.monaco.editor.createModel(props.before, undefined, uri("before"));
    const modified = mod.monaco.editor.createModel(props.after, undefined, uri("after"));
    const old = editor.getModel();
    editor.setModel({ original, modified });
    editor.getModifiedEditor().setScrollLeft(0);
    editor.getOriginalEditor().setScrollLeft(0);
    old?.original.dispose();
    old?.modified.dispose();
  }, [mod, editor, props.path, props.before, props.after]);

  // The "+" in the gutter and the selection, one set of listeners per side.
  useEffect(() => {
    if (!mod || !editor) return;
    const { monaco } = mod;
    const subs: Monaco.IDisposable[] = [];
    const attach = (side: Side, ed: Monaco.editor.ICodeEditor) => {
      const hover = ed.createDecorationsCollection([]);
      const runs = () => latest.current.runs[side];
      const ok = (line: number) => runs().some((r) => line >= r.start && line <= r.end);
      subs.push(
        ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber;
          hover.set(
            line && ok(line)
              ? [
                  {
                    range: new monaco.Range(line, 1, line, 1),
                    options: { glyphMarginClassName: "octo-v7-plus", glyphMarginHoverMessage: { value: "Comment on this line (c)" } },
                  },
                ]
              : [],
          );
        }),
        ed.onMouseLeave(() => hover.set([])),
        ed.onMouseDown((e) => {
          if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
          const line = e.target.position.lineNumber;
          if (line && ok(line)) latest.current.onAnchor({ side, start: line, end: line });
        }),
        ed.onDidChangeCursorSelection((e) => {
          const s = e.selection;
          const end = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;
          latest.current.onSelection({ side, start: s.startLineNumber, end });
        }),
      );
      subs.push({ dispose: () => hover.clear() });
    };
    attach("new", editor.getModifiedEditor());
    attach("old", editor.getOriginalEditor());
    return () => subs.forEach((s) => s.dispose());
  }, [mod, editor, latest]);

  // Rails for pending comments, tint for findings.
  useEffect(() => {
    if (!mod || !editor) return;
    const { monaco } = mod;
    const make = (ed: Monaco.editor.ICodeEditor, side: Side) =>
      ed.createDecorationsCollection([
        ...props.commented
          .filter((c) => c.side === side)
          .map((c) => ({
            range: new monaco.Range(c.start, 1, c.end, 1),
            options: { isWholeLine: true, className: "octo-v7-commented", linesDecorationsClassName: "octo-v7-rail" },
          })),
        ...props.flagged
          .filter((c) => c.side === side)
          .map((c) => ({
            range: new monaco.Range(c.start, 1, c.end, 1),
            options: { isWholeLine: true, className: "octo-review-finding", linesDecorationsClassName: "octo-review-finding-rail" },
          })),
      ]);
    const a = make(editor.getModifiedEditor(), "new");
    const b = make(editor.getOriginalEditor(), "old");
    return () => {
      a.clear();
      b.clear();
    };
  }, [mod, editor, props.commented, props.flagged, props.path, props.before, props.after]);

  // j / k: bring a change into view and select it, so a comment or suggestion starts from it.
  const { reveal } = props;
  useEffect(() => {
    if (!mod || !editor || !reveal) return;
    const { block } = reveal;
    const go = () => {
      const side = block.side === "old" && props.split ? editor.getOriginalEditor() : editor.getModifiedEditor();
      const line = side === editor.getOriginalEditor() ? block.line : block.side === "new" ? block.line : block.at;
      const end = side === editor.getOriginalEditor() ? block.end : block.side === "new" ? block.end : block.at;
      const model = side.getModel();
      if (!model) return;
      const last = Math.min(end, model.getLineCount());
      // Ending at column 1 of the next line (not the end of a long line) keeps the cursor from pulling the view sideways.
      const more = last < model.getLineCount();
      side.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: more ? last + 1 : last, endColumn: more ? 1 : model.getLineMaxColumn(last) });
      side.revealLineInCenterIfOutsideViewport(line);
      side.setScrollLeft(0);
      if (block.side === "old" && !props.split) latest.current.onSelection({ side: "old", start: block.line, end: block.end });
      const flash = side.createDecorationsCollection([
        {
          range: new mod.monaco.Range(line, 1, last, 1),
          options: { isWholeLine: true, className: block.side === "new" ? "octo-v7-flash-add" : "octo-v7-flash-del" },
        },
      ]);
      window.setTimeout(() => flash.clear(), DIFF_FLASH_MS + 100);
    };
    go();
  }, [mod, editor, reveal, props.split, latest]);

  // Thread zones: a DOM node per zone inside Monaco's view-zone layer; React renders into it through a portal, and the
  // zone is as tall as its content (a ResizeObserver keeps it in step when a thread folds, unfolds or gets a reply box).
  const zoneNodes = useMemo(
    () =>
      props.zones.map((z) => {
        const dom = document.createElement("div");
        dom.className = "octo-thread-zone";
        const inner = document.createElement("div");
        dom.appendChild(inner);
        return { z, dom, inner };
      }),
    [props.zones],
  );
  useEffect(() => {
    if (!editor) return;
    const made: { ed: Monaco.editor.ICodeEditor; id: string; ro: ResizeObserver }[] = [];
    for (const { z, dom, inner } of zoneNodes) {
      const ed = z.side === "old" && latest.current.split ? editor.getOriginalEditor() : editor.getModifiedEditor();
      const model = ed.getModel();
      if (!model || z.line < 1 || z.line > model.getLineCount()) continue;
      let id = "";
      const zone: Monaco.editor.IViewZone = { afterLineNumber: z.line, heightInPx: 96, domNode: dom };
      ed.changeViewZones((a) => {
        id = a.addZone(zone);
      });
      const ro = new ResizeObserver(() => {
        const h = Math.ceil(inner.getBoundingClientRect().height);
        if (h > 0 && h !== zone.heightInPx)
          ed.changeViewZones((a) => {
            zone.heightInPx = h;
            a.layoutZone(id);
          });
      });
      ro.observe(inner);
      made.push({ ed, id, ro });
    }
    return () => {
      for (const m of made) {
        m.ro.disconnect();
        m.ed.changeViewZones((a) => a.removeZone(m.id));
      }
    };
  }, [editor, zoneNodes, props.split, props.before, props.after, latest]);

  const { onReady } = props;
  useEffect(() => {
    if (!editor) return;
    const sub = editor.onDidUpdateDiff(() => onReady?.());
    return () => sub.dispose();
  }, [editor, onReady]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0" />
      {failed && (
        <p role="alert" className="absolute inset-x-0 top-6 px-6 text-center text-sm text-err">
          The diff viewer did not load: {failed}. Reload the window to try again.
        </p>
      )}
      {zoneNodes.map(({ z, inner }) => createPortal(props.renderZone(z.key), inner, z.key))}
      {loading && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
    </div>
  );
}

/** The commentable runs of both sides of a diff, for the gutter's "+". */
export function runsOf(hunks: Parameters<typeof commentableRuns>[0]) {
  return { new: commentableRuns(hunks, "new"), old: commentableRuns(hunks, "old") };
}
