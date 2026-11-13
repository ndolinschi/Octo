import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type Filter<T extends string> = { id: T; label: string; /** Dim number after the label. */ count?: number; title?: string };

/**
 * Decision 82 (b): a list's filters (All, Open, Done, Dropped). Small, quiet text with dim counts, no fill, no
 * underline: the chosen filter is full-strength text, the others `fg-3`. It lives inside the list column under the view
 * switcher's hairline with the list's inset, never across the detail pane, and never as a second pill row. A radio
 * group: one tab stop, ←/→ / Home / End move and choose. Chips are 24px high with 8px of side padding, so their text starts on
 * the rows' text edge (decision 95f); `bare` drops the row's own height and inset for `PanelFilters`.
 */
export function FilterTabs<T extends string>(props: {
  label: string;
  options: readonly Filter<T>[];
  value: T;
  onChange(value: T): void;
  className?: string;
  bare?: boolean;
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
      className={cn("flex shrink-0 items-center gap-1 overflow-x-auto text-xs", props.bare ? "min-w-0" : "h-row px-pane", props.className)}
    >
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => props.onChange(o.id)}
            className={cn(
              "touch-hit flex h-ctl-xs shrink-0 items-center gap-1 rounded-sm px-2 whitespace-nowrap press-row focus-inset",
              on ? "text-fg" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="text-fg-3 tabular-nums">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
