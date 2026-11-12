import { Search, X } from "lucide-react";
import type { InputHTMLAttributes, KeyboardEvent, ReactNode, Ref } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, FIELD_FRAME, type ControlSize } from "../../lib/controls";
import { Glyph } from "./Glyph";
import { IconButton } from "./IconButton";

type Variant = "bordered" | "header" | "bare";

const FRAME: Record<Variant, string> = {
  // A framed field in a page or toolbar: the shared field look and focus rule.
  bordered: cn(FIELD_FRAME, "px-3"),
  // The header row of a picker, palette or popover: a 40px row with a hairline under it, no frame.
  header: "h-ctl-lg border-b border-line px-3",
  // Only the glyph and the input, on the surface of whatever holds it (a side-question input).
  bare: "px-0",
};

/**
 * The one search input (decision 90): a 14px search glyph, the text, a clear button while there is text, and a `shortcut`
 * slot (a `KeyHint`) while it is empty. Esc clears the text first (`clearOnEscape`); with nothing to clear it passes the
 * key on, so a surrounding popover or palette still closes. 16px text on touch.
 *
 * - `variant`: `bordered` (default, framed, `size` 24-40), `header` (40px row of an overlay), `bare` (no frame).
 * - `value`/`onChange(text)`; `label` is the accessible name and the default placeholder.
 *
 * Not for: a labelled form value (`Field` + `TextField`), a combobox that owns the listbox (`Picker` builds on this look).
 */
export function SearchField({
  ref,
  ...props
}: {
  value: string;
  onChange(value: string): void;
  label: string;
  placeholder?: string;
  variant?: Variant;
  size?: ControlSize;
  shortcut?: ReactNode;
  clearOnEscape?: boolean;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  /** The input element's ref (focus it from a shortcut). */
  ref?: Ref<HTMLInputElement>;
  /** Extra attributes for a combobox (`role`, `aria-controls`, `aria-activedescendant`). */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "className" | "ref">;
  className?: string;
}) {
  const variant = props.variant ?? "bordered";
  const clearOnEscape = props.clearOnEscape ?? true;
  return (
    <div
      role="search"
      className={cn(
        "flex min-w-0 items-center gap-2",
        variant === "bordered" && cn(CONTROL[props.size ?? "md"].h, "touch:h-ctl-lg"),
        FRAME[variant],
        props.className,
      )}
    >
      <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
      <input
        ref={ref}
        type="search"
        aria-label={props.label}
        placeholder={props.placeholder ?? props.label}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          props.onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (e.key === "Escape" && clearOnEscape && props.value !== "") {
            e.preventDefault();
            e.stopPropagation();
            props.onChange("");
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none touch:text-input-touch [&::-webkit-search-cancel-button]:hidden"
        {...props.inputProps}
      />
      {props.value !== "" ? (
        <IconButton icon={X} label="Clear search" size="xs" tabIndex={-1} onClick={() => props.onChange("")} className="-mr-1.5" />
      ) : (
        props.shortcut
      )}
    </div>
  );
}
