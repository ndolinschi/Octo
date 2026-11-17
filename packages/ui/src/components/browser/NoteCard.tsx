import { SlidersHorizontal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { elementSummary, type CssEdit, type PickedElement, type Rect, type TextEdit } from "../../lib/browser/designNotes";
import { MOD } from "../../state/workspace/WorkspaceProvider";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { TextArea } from "../primitives/TextField";
import { CssInspector } from "./CssInspector";

export type NoteDraft = {
  id: string;
  anchor: Rect;
  elements: PickedElement[];
  area?: Rect | undefined;
  cssEdits: CssEdit[];
  textEdit?: TextEdit | undefined;
  text: string;
  existingPin?: number | undefined;
};

/**
 * Floating visual comment popover anchored to the picked element, dragged area, or clicked pin.
 * Neutral border (`border-line`) per Decision 81; `Enter` submits, `Shift+Enter` inserts newline,
 * `Mod+L` stages the note directly into the Chat composer.
 */
export function NoteCard(props: {
  draft: NoteDraft;
  batchEdits: boolean;
  busy: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  onTextChange(text: string): void;
  onCssChange(selector: string, property: string, before: string, after: string | null): void;
  onStageToChat(): void;
  onSubmit(): void;
  onCancel(): void;
}) {
  const { draft } = props;
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [cssOpen, setCssOpen] = useState(draft.cssEdits.length > 0);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 12, top: 12 });

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [draft.id]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const box = props.containerRef.current;
    if (!card || !box) return;
    const place = () => {
      const cw = box.clientWidth;
      const ch = box.clientHeight;
      const w = card.offsetWidth || 320;
      const h = card.offsetHeight || 180;
      const pad = 8;
      const a = draft.anchor;
      let top = a.y + a.height + 8;
      if (top + h + pad > ch && a.y - h - 8 >= pad) {
        top = a.y - h - 8;
      }
      top = Math.max(pad, Math.min(top, Math.max(pad, ch - h - pad)));
      const left = Math.max(pad, Math.min(a.x, Math.max(pad, cw - w - pad)));
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(card);
    ro.observe(box);
    return () => ro.disconnect();
  }, [draft.anchor, props.containerRef, cssOpen]);

  const singleEl = draft.elements.length === 1 ? draft.elements[0] : undefined;
  const canSubmit = Boolean(draft.text.trim() || draft.cssEdits.length > 0 || draft.textEdit);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      e.stopPropagation();
      if (canSubmit || draft.elements.length > 0 || draft.area) props.onStageToChat();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit && !props.busy) props.onSubmit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
    }
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Design note"
      data-design-note-card
      style={{ left: pos.left, top: pos.top }}
      className="absolute z-20 flex max-h-[calc(100%-16px)] w-[min(360px,calc(100%-16px))] flex-col gap-2 overflow-y-auto overscroll-contain rounded-xl border border-line bg-overlay p-3 text-sm shadow-pop"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {draft.elements.map((el) => (
            <span
              key={el.selector}
              title={el.component?.file ? `${el.selector} (${el.component.file})` : el.selector}
              className="max-w-full truncate rounded-sm bg-raised px-1.5 py-0.5 font-mono text-xs text-fg"
            >
              {elementSummary(el)}
            </span>
          ))}
          {draft.elements.length === 0 && draft.area && (
            <span className="rounded-sm bg-raised px-1.5 py-0.5 font-mono text-xs text-fg">{`Area ${draft.area.width}×${draft.area.height}`}</span>
          )}
          {singleEl?.component?.file && <span className="max-w-full truncate font-mono text-xs text-fg-3">{singleEl.component.file}</span>}
        </div>
        <IconButton icon={X} label="Close note" size="xs" onClick={props.onCancel} />
      </div>

      {draft.textEdit && (
        <p className="truncate rounded-sm bg-raised px-2 py-1 text-xs text-fg-2">{`Text: "${draft.textEdit.before}" → "${draft.textEdit.after}"`}</p>
      )}

      <TextArea
        ref={inputRef}
        rows={2}
        value={draft.text}
        onChange={(e) => props.onTextChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the change… (Enter to send)"
        aria-label="Design note"
      />

      {singleEl && cssOpen && (
        <CssInspector
          element={singleEl}
          edits={draft.cssEdits}
          onChangeProp={(prop, before, after) => props.onCssChange(singleEl.selector, prop, before, after)}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <div className="flex items-center gap-1">
          {singleEl && (
            <Button variant="quiet" size="xs" icon={SlidersHorizontal} pressed={cssOpen} onClick={() => setCssOpen((v) => !v)}>
              {draft.cssEdits.length > 0 ? `CSS (${draft.cssEdits.length})` : "Edit CSS"}
            </Button>
          )}
          <Button variant="quiet" size="xs" title={`Stage note into the session composer (${MOD}L)`} disabled={props.busy} onClick={props.onStageToChat}>
            Add to chat
          </Button>
        </div>

        <Button variant="primary" size="xs" loading={props.busy} disabled={!canSubmit} onClick={props.onSubmit}>
          {props.batchEdits ? (draft.existingPin ? "Update pin" : "Add pin") : "Send"}
        </Button>
      </div>
    </div>
  );
}
