import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type Segment<T extends string | number> = { id: T; label: string; title?: string };

/**
 * A segmented control (decision 33, revised by polish step 3 C4 and audit B5): segments 24px inside a 28px track
 * with 2px padding (the owner's audit, item 5: a form row that holds one is 54px, not 50), text only, on a tinted track
 * (`seg-track`, a tint, no outline) so the unchosen state reads as a choice at rest; the chosen segment is one step up (`seg-on`, plus a whisper of
 * shadow in light), never an accent or a solid fill. Segments are as wide as their labels and never truncate — a panel holds
 * at most one of these, and a control that does not fit folds into a menu instead. One tab stop; ←/→ / Home / End move and
 * choose (a radio group).
 */
export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const at = Math.max(
    0,
    props.options.findIndex((o) => o.id === props.value),
  );
  const chosen = props.options.some((o) => o.id === props.value);
  const tabbable = chosen ? props.value : props.options[0]?.id;
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key;
    const to = listKeyTarget(key, at, props.options.length);
    const next = to === null ? undefined : props.options[to];
    if (!next) return;
    e.preventDefault();
    props.onChange(next.id);
    box.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to ?? 0]?.focus();
  };
  return (
    <div
      ref={box}
      role="radiogroup"
      tabIndex={-1}
      aria-label={props.label}
      onKeyDown={onKeyDown}
      // A9.11: on the phone the segments are 32 (a 36 track), their touch zone 44 (`touch-hit`). 6e: with nothing chosen yet
      // each segment is its own outlined tile, 2px apart, so the row reads as options to pick, not as three words on a plate.
      className={cn("flex h-ctl-sm w-fit shrink-0 rounded-md bg-seg-track p-0.5 phone:h-9", !chosen && "gap-0.5", props.className)}
    >
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.id === tabbable ? 0 : -1}
            title={o.title}
            onClick={() => props.onChange(o.id)}
            className={cn(
              "touch-hit shrink-0 rounded-sm px-2 text-sm leading-5 whitespace-nowrap press-row focus-inset",
              on
                ? // 6d: forced colours flatten the tones; the chosen segment is the system's highlight there.
                  "bg-seg-on text-fg shadow-seg forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none"
                : "text-fg-2 hover:bg-hover hover:text-fg",
              !chosen && "shadow-[inset_0_0_0_1px_var(--octo-line-strong)]",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
