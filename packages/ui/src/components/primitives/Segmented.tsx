import { useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type Segment<T extends string | number> = { id: T; label: string; title?: string };

export type SegmentedSize = "xs" | "sm";

const TRACK_SIZE: Record<SegmentedSize, string> = {
  xs: "h-ctl-xs rounded-sm",
  sm: "h-ctl-sm rounded-md",
};

const ITEM_SIZE: Record<SegmentedSize, string> = {
  xs: "rounded-xs px-2 text-xs",
  sm: "rounded-sm px-2 text-sm",
};

/**
 * A segmented control (decision 33, revised by polish step 3 C4 and audit B5): `sm` (default) puts 24px segments inside a
 * 28px track with 2px padding; `xs` puts 20px segments inside a 24px track (`rounded-sm` / `rounded-xs` concentric). Text only,
 * on a tinted track (`seg-track`, a tint, no outline) so the unchosen state reads as a choice at rest; the chosen segment is
 * one step up (`seg-on`, plus a whisper of shadow in light), never an accent or a solid fill. Segments are as wide as their
 * labels and never truncate — a panel holds at most one of these, and a control that does not fit folds into a menu instead.
 * One tab stop; ←/→ / Home / End move and choose (a radio group).
 */
export function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onChange(value: T): void;
  size?: SegmentedSize;
  disabled?: boolean;
  className?: string;
}) {
  const size = props.size ?? "sm";
  const disabled = props.disabled === true;
  const box = useRef<HTMLDivElement>(null);
  const chosenIndex = props.options.findIndex((o) => o.id === props.value);
  const chosen = chosenIndex >= 0;
  const at = chosen ? chosenIndex : 0;
  const tabbable = chosen ? props.value : props.options[0]?.id;
  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
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
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      // On the phone every segmented option is a 44px touch target without relying on pseudo-element overlap. 6e: with nothing chosen yet
      // each segment is its own outlined tile, 2px apart, so the row reads as options to pick, not as three words on a plate.
      className={cn(
        "flex w-fit shrink-0 bg-seg-track p-0.5 phone:h-auto",
        TRACK_SIZE[size],
        !chosen && "gap-0.5",
        disabled && "pointer-events-none opacity-60",
        props.className,
      )}
    >
      {props.options.map((o) => {
        const on = o.id === props.value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            tabIndex={!disabled && o.id === tabbable ? 0 : -1}
            title={o.title}
            onClick={() => !disabled && props.onChange(o.id)}
            className={cn(
              "touch-hit inline-flex shrink-0 flex-col items-center justify-center whitespace-nowrap press-row focus-inset after:invisible after:h-0 after:font-medium after:whitespace-nowrap after:content-[attr(data-label)] phone:h-ctl-lg phone:min-w-ctl-lg",
              ITEM_SIZE[size],
              on
                ? // 6d: forced colours flatten the tones; the chosen segment is the system's highlight there.
                  "bg-seg-on font-medium text-fg shadow-seg forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none"
                : "text-fg-2 hover:text-fg",
              !chosen && "shadow-[inset_0_0_0_1px_var(--octo-line-strong)]",
            )}
            data-label={o.label}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
