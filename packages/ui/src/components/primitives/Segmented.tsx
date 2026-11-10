import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type Segment<T extends string | number> = { id: T; label: string; title?: string };

/**
 * A segmented control: one hairline track (radius 8, 2px inset) holding equal segments (radius 6), the chosen
 * one filled with `active` (the selected-row fill). `size` 28 (the Usage tab's Tokens | Cost | Limits) or 24 (range, scope). One tab stop;
 * ←/→ / Home / End move and choose (a radio group).
 */
export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange(value: T): void;
  size?: 24 | 28;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const at = Math.max(
    0,
    props.options.findIndex((o) => o.id === props.value),
  );
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
      className={cn("flex shrink-0 rounded-md border border-line p-0.5", props.size === 24 ? "h-chip" : "h-row", props.className)}
    >
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => props.onChange(o.id)}
            className={cn(
              "min-w-0 flex-1 truncate rounded-sm px-2 press-row focus-inset",
              props.size === 24 ? "text-xs" : "text-sm",
              on ? "bg-active text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
