import { forwardRef, useCallback, useRef, type KeyboardEvent } from "react";
import { cn } from "../../lib/cn";
import { listKeyTarget } from "../../lib/focus";

export type ChoiceOption = { id: string; label: string };

/**
 * Stacked exclusive choice buttons (`role="radiogroup"`) for 2–4 options whose labels are too descriptive for an inline
 * `Segmented` track (e.g. schema form questions). Neutral borders only (decision 81), full label wrapping without truncation,
 * roving arrow / Home / End focus, and 44px touch targets on phones.
 */
export const ChoiceGroup = forwardRef<
  HTMLDivElement,
  {
    id?: string | undefined;
    label: string;
    labelledBy?: string | undefined;
    describedBy?: string | undefined;
    options: readonly ChoiceOption[];
    value: string;
    onChange(value: string): void;
    disabled?: boolean | undefined;
    invalid?: boolean | undefined;
    required?: boolean | undefined;
    className?: string | undefined;
  }
>(function ChoiceGroup({ id, label, labelledBy, describedBy, options, value, onChange, disabled = false, invalid = false, required = false, className }, ref) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const chosenIndex = options.findIndex((o) => o.id === value);
  const chosen = chosenIndex >= 0;
  const at = chosen ? chosenIndex : 0;
  const tabbable = chosen ? value : options[0]?.id;

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      localRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    const key = e.key === "ArrowRight" ? "ArrowDown" : e.key === "ArrowLeft" ? "ArrowUp" : e.key;
    const to = listKeyTarget(key, at, options.length);
    const next = to === null ? undefined : options[to];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    localRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to ?? 0]?.focus();
  };

  return (
    <div
      ref={setRef}
      id={id}
      role="radiogroup"
      tabIndex={-1}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-required={required || undefined}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={cn("flex flex-col gap-2", disabled && "pointer-events-none opacity-60", className)}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            data-invalid={invalid || undefined}
            disabled={disabled}
            tabIndex={!disabled && o.id === tabbable ? 0 : -1}
            onClick={() => !disabled && onChange(o.id)}
            className={cn(
              "touch-hit flex min-h-ctl-md w-full items-center gap-2 rounded-md border px-3 py-1.5 text-left text-sm press-row focus-inset transition-[background-color,border-color,color] duration-fast phone:min-h-ctl-lg phone:text-input-touch",
              on
                ? cn(
                    invalid ? "border-err" : "border-input-border",
                    "bg-active font-medium text-fg forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:forced-color-adjust-none",
                  )
                : invalid
                  ? "border-err bg-panel text-fg-2 hover:bg-hover hover:text-fg"
                  : "border-field-edge bg-panel text-fg-2 hover:bg-hover hover:text-fg",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border transition-[border-color] duration-fast",
                on ? "border-fg" : "border-input-border",
              )}
            >
              {on && <span className="size-2 rounded-full bg-fg forced-colors:bg-[HighlightText]" />}
            </span>
            <span className="min-w-0 flex-1 wrap-anywhere">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
});
