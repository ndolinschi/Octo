import { Check, Minus } from "lucide-react";
import { forwardRef, useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Glyph } from "./Glyph";

/**
 * A checkbox with its label (decision 90): a 16px box (`input-border`, filled `primary` when on), the label and an optional
 * dim description beside it; the whole line is the click target and grows a 40px hit area on touch. The native input is
 * kept (visually hidden) so keyboard, forms and screen readers behave as the platform's.
 *
 * - `checked`, `onChange(next)`; `indeterminate` shows a dash (a parent of partly chosen children).
 * - `label` is required; `hideLabel` keeps it as the accessible name only (a checkbox in a table row).
 * - `description`: one dim line under the label.
 * - `data-*` attributes go on the input (`data-autofocus`: a dialog opens on this box).
 *
 * Not for: an on/off setting that applies at once (`Switch`), one of several exclusive choices (`Segmented`).
 */
type CheckboxProps = Record<`data-${string}`, string | boolean | undefined> & {
  checked: boolean;
  onChange(next: boolean): void;
  label: ReactNode;
  /** Accessible name when `label` is not a plain string or is hidden. */
  ariaLabel?: string;
  hideLabel?: boolean;
  description?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  /** The choice is missing or wrong: a `err` box border and `aria-invalid`. */
  invalid?: boolean;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(props, outer) {
  const input = useRef<HTMLInputElement>(null);
  const mixed = props.indeterminate === true && !props.checked;
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  const on = props.checked || mixed;
  const data = Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith("data-")));
  return (
    <label className={cn("group touch-hit relative inline-flex min-w-0 items-start gap-2 text-sm text-fg", props.disabled && "opacity-50", props.className)}>
      <input
        {...data}
        ref={(el) => {
          input.current = el;
          if (typeof outer === "function") outer(el);
          else if (outer) outer.current = el;
        }}
        aria-invalid={props.invalid || undefined}
        type="checkbox"
        id={props.id}
        name={props.name}
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.ariaLabel ?? (props.hideLabel && typeof props.label === "string" ? props.label : undefined)}
        onChange={(e) => props.onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-xs border transition-[background-color,border-color] duration-fast peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-focus",
          !props.hideLabel && "mt-0.5",
          on ? "border-primary bg-primary text-primary-fg" : props.invalid ? "border-err bg-panel" : "border-input-border bg-panel group-hover:border-fg-3",
        )}
      >
        {on && <Glyph icon={mixed ? Minus : Check} size={12} />}
      </span>
      {!props.hideLabel && (
        <span className="flex min-w-0 flex-col">
          <span className="min-w-0 break-words">{props.label}</span>
          {props.description && <span className="text-xs text-fg-3">{props.description}</span>}
        </span>
      )}
    </label>
  );
});
