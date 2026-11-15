import type * as Monaco from "monaco-editor";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import type { MonacoApi } from "../../lib/buffers";
import { Button } from "../primitives/Button";
import { Textarea } from "../primitives/Field";
import { focusOnMount } from "./parts";

/** A line comment from the changes view: lines of the file as changed (the diff's modified side). */
export type LineComment = { path: string; start: number; end: number; text: string };

type Draft = { start: number; end: number; top: number; left: number; width: number };

/**
 * Decision 47: in the changes view, hovering a line of the changed side shows a "+" in the glyph lane; it (or
 * `Ctrl/Cmd+Alt+C` on the selected lines) opens a small box under the line, and the comment goes to the composer's
 * pending comments, sent with the next request.
 */
export function DiffComments(props: {
  monaco: MonacoApi;
  editor: Monaco.editor.IStandaloneDiffEditor;
  path: string;
  commented: readonly { start: number; end: number }[];
  onAdd(comment: LineComment): void;
}) {
  const { monaco, editor, onAdd } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");

  const place = useCallback(
    (start: number, end: number): Draft | null => {
      const side = editor.getModifiedEditor();
      const node = side.getDomNode();
      const outer = editor.getContainerDomNode();
      if (!node) return null;
      const a = node.getBoundingClientRect();
      const b = outer.getBoundingClientRect();
      const info = side.getLayoutInfo();
      const top = side.getTopForLineNumber(end + 1) - side.getScrollTop();
      const left = a.left - b.left + info.contentLeft;
      return { start, end, top: Math.max(0, Math.min(top, b.height - 120)), left, width: Math.max(220, Math.min(480, a.width - info.contentLeft - 16)) };
    },
    [editor],
  );

  const open = useCallback(
    (start: number, end: number) => {
      setText("");
      setDraft(place(start, end));
    },
    [place],
  );

  // The "+" on the hovered line and the commented lines' rail live in one decorations collection per kind.
  useEffect(() => {
    const side = editor.getModifiedEditor();
    const hover = side.createDecorationsCollection([]);
    const showPlus = (line: number | null) =>
      hover.set(
        line === null
          ? []
          : [
              {
                range: new monaco.Range(line, 1, line, 1),
                options: { glyphMarginClassName: "octo-v7-plus", glyphMarginHoverMessage: { value: "Comment on this line" } },
              },
            ],
      );
    const move = side.onMouseMove((e) => showPlus(e.target.position?.lineNumber ?? null));
    const leave = side.onMouseLeave(() => showPlus(null));
    const down = side.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position.lineNumber;
      if (line) open(line, line);
    });
    const action = side.addAction({
      id: "octo.v7.comment",
      label: "Comment on these lines",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyC],
      contextMenuGroupId: "navigation",
      run: () => {
        const sel = side.getSelection();
        if (!sel) return;
        const end = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
        open(sel.startLineNumber, end);
      },
    });
    return () => {
      move.dispose();
      leave.dispose();
      down.dispose();
      action.dispose();
      hover.clear();
    };
  }, [editor, monaco, open]);

  useEffect(() => {
    const side = editor.getModifiedEditor();
    const rails = side.createDecorationsCollection(
      props.commented.map((c) => ({
        range: new monaco.Range(c.start, 1, c.end, 1),
        options: { isWholeLine: true, className: "octo-v7-commented", linesDecorationsClassName: "octo-v7-rail" },
      })),
    );
    return () => rails.clear();
  }, [editor, monaco, props.commented]);

  // The box follows its line while the diff scrolls.
  const isOpen = draft !== null;
  useEffect(() => {
    if (!isOpen) return;
    const side = editor.getModifiedEditor();
    const sub = side.onDidScrollChange(() => setDraft((d) => (d ? place(d.start, d.end) : d)));
    return () => sub.dispose();
  }, [editor, place, isOpen]);

  const close = () => {
    setDraft(null);
    editor.getModifiedEditor().focus();
  };
  const add = () => {
    if (!draft || !text.trim()) return;
    onAdd({ path: props.path, start: draft.start, end: draft.end, text: text.trim() });
    close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      add();
    }
  };

  if (!draft) return null;
  const lines = draft.end > draft.start ? `lines ${draft.start}–${draft.end}` : `line ${draft.start}`;
  return (
    <div
      role="dialog"
      aria-label={`Comment on ${lines}`}
      className="absolute z-10 flex flex-col gap-2 rounded-md border border-transparent bg-overlay p-2 shadow-pop forced-colors:border-[CanvasText]"
      style={{ top: draft.top, left: draft.left, width: draft.width }}
    >
      <Textarea
        aria-label={`Comment on ${lines}`}
        placeholder={`Comment on ${lines}, sent with your next message`}
        rows={2}
        ref={focusOnMount}
        onKeyDown={onKeyDown}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!text.trim()} onClick={add} data-shortcut="⌘↵">
          Add comment
        </Button>
      </div>
    </div>
  );
}
