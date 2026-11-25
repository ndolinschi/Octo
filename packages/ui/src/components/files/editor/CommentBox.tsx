import { MessageSquare } from "lucide-react";
import { Glyph } from "../../primitives/Glyph";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "../../../lib/cn";
import { linesLabel } from "../../../lib/comments";
import { Button } from "../../primitives/Button";
import { TextArea } from "../../primitives/TextField";

/**
 * What an editor view zone shows under a line: the inline composer, or a pending comment card.
 * Both sit on the editor surface as a `raised` box (radius 8) in the UI font, so they read as part of the editor rather than
 * a form dropped into it. Polish step 4, E6: a card is a tone with no outline (step 1's rule); the composer is a field, so it
 * keeps the fields' edge (`field-edge`, `fg` on focus). Rendered in their own React root (view
 * zones live inside Monaco's DOM), so everything comes in as props.
 */
export type ZoneProps =
  | { kind: "composer"; start: number; end: number; initial: string; editing: boolean; onSubmit(text: string): void; onCancel(): void }
  | { kind: "card"; start: number; end: number; text: string; onEdit(): void; onRemove(): void };

const BOX = "w-full rounded-md bg-raised font-sans text-sm text-fg";

export function CommentZone({ onLayout, ...props }: ZoneProps & { onLayout?: () => void }) {
  // Tells the editor once the box is in the DOM and measurable (it then makes room for it).
  const layout = useRef(onLayout);
  useLayoutEffect(() => {
    layout.current?.();
  }, []);
  // Aligned to the code column (the box's left is the code's left), 12px clear of the right edge, 4px above and below.
  return <div className="py-1 pr-3">{props.kind === "composer" ? <Composer {...props} /> : <Card {...props} />}</div>;
}

function Composer(props: Extract<ZoneProps, { kind: "composer" }>) {
  const [text, setText] = useState(props.initial);
  const area = useRef<HTMLTextAreaElement>(null);
  const label = `Comment on ${linesLabel(props.start, props.end)}`;

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // Focus once the editor has placed the box (it is laid out a frame after it mounts).
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const focus = () => {
      const el = area.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      if (document.activeElement === el) el.setSelectionRange(el.value.length, el.value.length);
      else if (tries++ < 10) frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = () => {
    if (text.trim()) props.onSubmit(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    }
  };

  return (
    <form
      className={cn(BOX, "border border-field-edge transition-[border-color] duration-fast focus-within:border-fg")}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <TextArea
        variant="bare"
        ref={area}
        rows={1}
        value={text}
        aria-label={label}
        placeholder={props.editing ? "Edit comment" : `Comment on ${linesLabel(props.start, props.end)}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="block max-h-[200px] min-h-9 overscroll-contain px-3 pt-2 pb-1 leading-5 wrap-anywhere"
      />
      <div className="flex items-center justify-end gap-1.5 pt-0.5 pr-1.5 pb-1.5 pl-3">
        <p className="mr-auto min-w-0 truncate text-xs text-fg-3 @max-[360px]/zone:hidden">Enter to add, Shift+Enter for a new line</p>
        <Button size="sm" variant="quiet" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>
          {props.editing ? "Save" : "Comment"}
        </Button>
      </div>
    </form>
  );
}

function Card(props: Extract<ZoneProps, { kind: "card" }>) {
  const label = linesLabel(props.start, props.end);
  return (
    <article aria-label={`Pending comment on ${label}`} className={cn(BOX, "group/card px-3 pt-1.5 pb-2")}>
      <header className="flex h-ctl-xs items-center gap-1.5 text-xs text-fg-3">
        <Glyph icon={MessageSquare} size={14} className="shrink-0" />
        <span className="min-w-0 truncate tabular-nums">{label.replace(/^l/, "L")}</span>
        <span className="pointer-events-none ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100 touch:pointer-events-auto touch:opacity-100">
          <Button variant="quiet" size="xs" onClick={props.onEdit}>
            Edit
          </Button>
          <Button variant="quiet" size="xs" onClick={props.onRemove}>
            Remove
          </Button>
        </span>
      </header>
      <p className="text-sm wrap-anywhere whitespace-pre-wrap text-fg">{props.text}</p>
    </article>
  );
}
