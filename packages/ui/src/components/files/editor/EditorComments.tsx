import { Plus } from "lucide-react";
import { Glyph } from "../../primitives/Glyph";
import type * as Monaco from "monaco-editor";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useComments } from "../../../state/comments";
import { linesLabel } from "../../../lib/comments";
import type { EditorBuffers, MonacoApi } from "../../../lib/buffers";
import { CommentZone, type ZoneProps } from "./CommentBox";
import { useLatest } from "../../../lib/hooks";

type Draft = { start: number; end: number; editing: string | null };

/**
 * A comment box under a line: a view zone makes the room, an overlay widget (above the text layer, so
 * it gets the pointer, and fixed to the viewport, so horizontal scrolling never clips it) shows the box
 * at the zone's position. One React root each, since both live inside Monaco's DOM.
 */
type Zone = { id: string; spec: Monaco.editor.IViewZone; root: Root; dispose(): void };

/** Events that must not reach Monaco from inside a box (it would move the caret or run keybindings). */
const CONTAINED = ["mousedown", "pointerdown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup", "keypress"] as const;

/** The "+" is an 18px square centred in the glyph-margin lane (left of the line numbers) and on the line: it
 *  never covers code at any indentation, nor the line numbers or the fold controls. */
const PLUS = 18;

let widgetSeq = 0;

function lineRange(monaco: MonacoApi, model: Monaco.editor.ITextModel, start: number, end: number): Monaco.IRange {
  const last = Math.min(Math.max(end, start), model.getLineCount());
  const first = Math.min(start, last);
  return new monaco.Range(first, 1, last, model.getLineMaxColumn(last));
}

/** Whole lines of the selection (a selection ending at column 1 of a later line stops before it). */
function selectedLines(editor: Monaco.editor.IStandaloneCodeEditor): { start: number; end: number } | null {
  const sel = editor.getSelection();
  if (!sel) return null;
  const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
  return { start: sel.startLineNumber, end };
}

/**
 * Code comments in one editor (spec §5). Hovering a line shows a "+" in the glyph gutter;
 * that, `Ctrl/Cmd+Alt+C` or the context menu opens an inline composer under the line
 * (or the selected lines). Commented lines carry a rail and a faint tint; pending comments show as
 * cards under their last line and follow edits (tracked decorations).
 */
export const EditorComments = memo(function EditorComments(props: {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: MonacoApi;
  buffers: EditorBuffers;
  folder: string;
  path: string;
}) {
  const { editor, monaco, buffers, folder, path } = props;
  const store = useComments();
  const comments = useMemo(() => store.forFile(folder, path), [store, folder, path]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverLine, setHoverLine] = useState<number | null>(null);
  const hoverLineRef = useLatest(hoverLine);
  const plusRef = useRef<HTMLButtonElement>(null);
  const zones = useRef(new Map<string, Zone>());
  const ranges = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const rangeIds = useRef<string[]>([]);
  const commentsRef = useLatest(comments);
  const storeRef = useLatest(store);
  const draftRef = useLatest(draft);

  const open = useCallback((start: number, end: number, editing: string | null = null) => setDraft({ start, end, editing }), []);

  /* ---------- keyboard + context menu ---------- */

  useEffect(() => {
    const action = editor.addAction({
      id: "octo.addComment",
      label: "Add comment",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      run: () => {
        const lines = selectedLines(editor);
        if (lines) open(lines.start, lines.end);
      },
    });
    return () => action.dispose();
  }, [editor, monaco, open]);

  /* ---------- hover: the gutter "+" ---------- */

  const syncPlus = useCallback(
    (line: number | null) => {
      const btn = plusRef.current;
      if (!btn || !line) return;
      const pos = editor.getScrolledVisiblePosition({ lineNumber: line, column: 1 });
      if (!pos) {
        btn.style.visibility = "hidden";
        return;
      }
      const info = editor.getLayoutInfo();
      const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
      // First visual row of the line (wrapped lines keep the button on their first row).
      const top = pos.top + (lineHeight - PLUS) / 2;
      const left = info.glyphMarginLeft + Math.max(0, (info.glyphMarginWidth - PLUS) / 2);
      btn.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      btn.style.visibility = "visible";
    },
    [editor, monaco],
  );

  useEffect(() => {
    const T = monaco.editor.MouseTargetType;
    const LINE_TARGETS = new Set([T.CONTENT_TEXT, T.CONTENT_EMPTY, T.GUTTER_LINE_NUMBERS, T.GUTTER_LINE_DECORATIONS, T.GUTTER_GLYPH_MARGIN]);
    const subs = [
      editor.onMouseMove((e) => {
        // Over Monaco's own popups (hover, suggest) the line stays the target.
        if (e.target.type === T.CONTENT_WIDGET) return;
        const line = e.target.position?.lineNumber;
        if (!line || !LINE_TARGETS.has(e.target.type)) {
          if (hoverLineRef.current !== null) setHoverLine(null);
          return;
        }
        if (line !== hoverLineRef.current) setHoverLine(line);
      }),
      editor.onMouseLeave((e) => {
        // Travelling from the line onto the button keeps it.
        const to = e.event.browserEvent.relatedTarget as Element | null;
        if (!to?.closest?.("[data-comment-plus]") && hoverLineRef.current !== null) setHoverLine(null);
      }),
      editor.onDidScrollChange((e) => {
        if ((e.scrollTopChanged || e.scrollLeftChanged) && hoverLineRef.current) syncPlus(hoverLineRef.current);
      }),
      editor.onDidLayoutChange(() => {
        if (hoverLineRef.current) syncPlus(hoverLineRef.current);
      }),
    ];
    return () => subs.forEach((s) => s.dispose());
  }, [editor, monaco, hoverLineRef, syncPlus]);

  /* ---------- commented ranges: rail + tint, tracking edits ---------- */

  const rangeKey = comments.map((c) => `${c.id}:${c.start}-${c.end}`).join(",");
  const draftKey = draft && !draft.editing ? `${draft.start}-${draft.end}` : "";
  const applyRanges = useCallback(() => {
    const model = editor.getModel();
    if (!model) return;
    const mark = {
      isWholeLine: true,
      className: "octo-comment-line",
      linesDecorationsClassName: "octo-comment-rail",
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    };
    const list = commentsRef.current;
    const d = draftRef.current;
    const next: Monaco.editor.IModelDeltaDecoration[] = list.map((c) => ({ range: lineRange(monaco, model, c.start, c.end), options: mark }));
    if (d && !d.editing) next.push({ range: lineRange(monaco, model, d.start, d.end), options: mark });
    ranges.current ??= editor.createDecorationsCollection();
    rangeIds.current = ranges.current.set(next);
  }, [editor, monaco, commentsRef, draftRef]);
  useEffect(applyRanges, [applyRanges, rangeKey, draftKey]);

  useEffect(() => {
    const model = editor.getModel();
    if (!model) return;
    let frame = 0;
    const sub = model.onDidChangeContent(() => {
      // Disk content replaced the buffer: comments keep their line numbers.
      if (buffers.replacing) {
        frame = requestAnimationFrame(applyRanges);
        return;
      }
      const list = commentsRef.current;
      const s = storeRef.current;
      const d = draftRef.current;
      list.forEach((c, i) => {
        const r = model.getDecorationRange(rangeIds.current[i] ?? "");
        if (r && (r.startLineNumber !== c.start || r.endLineNumber !== c.end)) s.move(c.id, r.startLineNumber, Math.max(r.startLineNumber, r.endLineNumber));
      });
      const dr = d && !d.editing ? model.getDecorationRange(rangeIds.current[list.length] ?? "") : null;
      if (d && dr && (dr.startLineNumber !== d.start || dr.endLineNumber !== d.end)) setDraft({ ...d, start: dr.startLineNumber, end: dr.endLineNumber });
    });
    return () => {
      cancelAnimationFrame(frame);
      sub.dispose();
    };
  }, [editor, buffers, applyRanges, commentsRef, storeRef, draftRef]);

  useEffect(
    () => () => {
      ranges.current?.clear();
      ranges.current = null;
    },
    [],
  );

  /* ---------- zones ---------- */

  const submit = useCallback(
    (d: Draft, text: string) => {
      if (d.editing) store.edit(d.editing, text);
      else store.add({ folder, path, start: d.start, end: d.end, text });
      setDraft(null);
      editor.focus();
    },
    [store, folder, path, editor],
  );
  const cancel = useCallback(() => {
    setDraft(null);
    editor.focus();
  }, [editor]);

  /** Shows `props` under `line`; a new zone is measured before it is inserted, so the code below moves once, by exactly its height. */
  const show = useCallback(
    (key: string, line: number, props: ZoneProps) => {
      const existing = zones.current.get(key);
      if (existing) {
        existing.root.render(<CommentZone {...props} />);
        if (existing.id && existing.spec.afterLineNumber !== line) {
          existing.spec.afterLineNumber = line;
          editor.changeViewZones((acc) => acc.layoutZone(existing.id));
        }
        return;
      }
      const spacer = document.createElement("div");
      const box = document.createElement("div");
      box.className = "octo-comment-box @container/zone";
      for (const type of CONTAINED) box.addEventListener(type, (e) => e.stopPropagation());
      const place = () => {
        const info = editor.getLayoutInfo();
        box.style.left = `${info.contentLeft}px`;
        box.style.width = `${Math.max(0, info.contentWidth - info.verticalScrollbarWidth)}px`;
      };
      place();
      box.style.top = "0px";
      box.style.visibility = "hidden";
      const widgetId = `octo.comment.${++widgetSeq}`;
      const widget: Monaco.editor.IOverlayWidget = { getId: () => widgetId, getDomNode: () => box, getPosition: () => null };
      editor.addOverlayWidget(widget);
      const spec: Monaco.editor.IViewZone = {
        afterLineNumber: line,
        heightInPx: 0,
        domNode: spacer,
        onDomNodeTop: (top) => {
          box.style.top = `${top}px`;
          box.style.visibility = "visible";
        },
      };
      // Monaco keeps `spec`: the box follows its zone (hidden while the zone is scrolled out), and the
      // zone follows the box's height (a growing composer, a wrapped card).
      const mo = new MutationObserver(() => {
        box.style.display = spacer.style.display === "none" ? "none" : "";
      });
      mo.observe(spacer, { attributes: true, attributeFilter: ["style"] });
      const ro = new ResizeObserver(() => {
        const h = Math.ceil(box.getBoundingClientRect().height);
        if (!zone.id || !h || h === spec.heightInPx) return;
        spec.heightInPx = h;
        editor.changeViewZones((acc) => acc.layoutZone(zone.id));
      });
      const layout = editor.onDidLayoutChange(place);
      let disposed = false;
      const zone: Zone = {
        id: "",
        spec,
        root: createRoot(box),
        dispose: () => {
          disposed = true;
          mo.disconnect();
          ro.disconnect();
          layout.dispose();
          editor.removeOverlayWidget(widget);
          if (zone.id) editor.changeViewZones((acc) => acc.removeZone(zone.id));
          // A root can't unmount while React is rendering.
          queueMicrotask(() => zone.root.unmount());
        },
      };
      // The room is made once the box has rendered and been measured, so the code below moves once,
      // by exactly the box's height.
      const insert = () => {
        if (disposed || zone.id) return;
        spec.heightInPx = Math.ceil(box.getBoundingClientRect().height);
        editor.changeViewZones((acc) => {
          zone.id = acc.addZone(spec);
        });
        ro.observe(box);
      };
      zone.root.render(<CommentZone {...props} onLayout={insert} />);
      zones.current.set(key, zone);
    },
    [editor],
  );

  useEffect(() => {
    const model = editor.getModel();
    if (!model) return;
    const lines = model.getLineCount();
    const wanted = new Map<string, { line: number; props: ZoneProps }>();
    for (const c of comments) {
      const editing = draft?.editing === c.id;
      wanted.set(c.id, {
        line: Math.min(c.end, lines),
        props: editing
          ? { kind: "composer", start: c.start, end: c.end, initial: c.text, editing: true, onSubmit: (t) => submit(draft, t), onCancel: cancel }
          : {
              kind: "card",
              start: c.start,
              end: c.end,
              text: c.text,
              onEdit: () => open(c.start, c.end, c.id),
              onRemove: () => {
                store.remove(c.id);
                // The card (and its focused button) goes away with the comment: the caret returns to the code.
                editor.focus();
              },
            },
      });
    }
    if (draft && !draft.editing) {
      wanted.set("draft", {
        line: Math.min(draft.end, lines),
        props: { kind: "composer", start: draft.start, end: draft.end, initial: "", editing: false, onSubmit: (t) => submit(draft, t), onCancel: cancel },
      });
    }
    for (const [key, zone] of zones.current) {
      if (wanted.has(key)) continue;
      zone.dispose();
      zones.current.delete(key);
    }
    for (const [key, w] of wanted) show(key, w.line, w.props);
  }, [editor, comments, draft, submit, cancel, open, store, show]);

  // Bring a freshly opened composer into view.
  useEffect(() => {
    if (draft) editor.revealLinesInCenterIfOutsideViewport(draft.start, draft.end + 3);
  }, [editor, draft]);

  useEffect(
    () => () => {
      const all = [...zones.current.values()];
      zones.current.clear();
      all.forEach((z) => z.dispose());
    },
    [editor],
  );

  /* ---------- the "+" ---------- */

  const covered = hoverLine !== null && draft && !draft.editing && hoverLine >= draft.start && hoverLine <= draft.end;
  const activeHoverLine = hoverLine !== null && !covered ? hoverLine : null;

  useLayoutEffect(() => {
    if (activeHoverLine) syncPlus(activeHoverLine);
  }, [activeHoverLine, syncPlus]);

  if (!activeHoverLine) return null;
  // With several lines selected and the pointer on one of them, the comment is on the selection (and the label says so).
  const sel = selectedLines(editor);
  const range =
    sel && sel.end > sel.start && activeHoverLine >= sel.start && activeHoverLine <= sel.end ? sel : { start: activeHoverLine, end: activeHoverLine };
  const onPlus = () => open(range.start, range.end);
  return (
    // eslint-disable-next-line octo/no-native-controls -- an 18px gutter mark placed over Monaco's line by measured transform; the smallest IconButton is 24px
    <button
      ref={plusRef}
      type="button"
      data-comment-plus
      aria-label={`Add comment on ${linesLabel(range.start, range.end)}`}
      title={`Add comment on ${linesLabel(range.start, range.end)}`}
      data-tip-side="left"
      data-shortcut={`${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⌥" : "Ctrl+Alt+"}C`}
      style={{ left: 0, top: 0, width: PLUS, height: PLUS, visibility: "hidden" }}
      onMouseLeave={(e) => {
        if (!(e.relatedTarget as Element | null)?.closest?.(".monaco-editor")) setHoverLine(null);
      }}
      onClick={onPlus}
      className="octo-ring-panel absolute z-[5] grid press place-items-center rounded-xs bg-overlay text-fg shadow-panel before:absolute before:-inset-1 before:content-[''] hover:bg-active"
    >
      <Glyph icon={Plus} size={14} />
    </button>
  );
});
