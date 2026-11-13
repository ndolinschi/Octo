import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type Segment<T extends string | number> = { id: T; label: string; title?: string };

/**
 * A segmented control (decision 33): 24px, text only, no track or border; the chosen segment is marked by the
 * `hover` fill (never an accent or a solid fill). Segments are as wide as their labels and never truncate — a
 * panel holds at most one of these, and a control that does not fit folds into a menu instead. One tab stop;
 * ←/→ / Home / End move and choose (a radio group).
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
  const tabbable = props.options.some((o) => o.id === props.value) ? props.value : props.options[0]?.id;
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
      className={cn("flex h-chip shrink-0 gap-0.5", props.className)}
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
              "touch-hit shrink-0 rounded-sm px-2 text-sm whitespace-nowrap press-row focus-inset",
              on ? "bg-hover text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
