import { Search, X } from "lucide-react";
import { useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref } from "react";
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

// `align="rows"`: the frame's edge is an overlay (`after`) that takes no room, so the field's own 8px padding is the rows' 8: the
// glyph box is on x+8 and the text on x+32, the rows' label edge. The edge is a real border, so forced-colors keeps it.
const ROWS_FRAME =
  "relative rounded-md bg-panel px-2 text-sm text-fg after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:border after:border-field-edge after:transition-[border-color] after:duration-fast focus-within:after:border-fg touch:text-input-touch";

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
  /**
   * `rows`: a bordered field over a column of `ListRow`s (the settings navigation): 8px inset and the glyph in a 16px box, so
   * the glyph is centred on the rows' glyph column and the text starts on their label edge.
   */
  align?: "rows";
  clearOnEscape?: boolean;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  /** The input element's ref (focus it from a shortcut). */
  ref?: Ref<HTMLInputElement>;
  /** Extra attributes for a combobox (`role`, `aria-controls`, `aria-activedescendant`). */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "className" | "ref">;
  className?: string;
}) {
  const variant = props.variant ?? "bordered";
  const own = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  const clearOnEscape = props.clearOnEscape ?? true;
  return (
    <div
      role="search"
      className={cn(
        "flex min-w-0 items-center gap-2",
        variant === "bordered" && cn(CONTROL[props.size ?? "md"].h, "touch:h-ctl-lg"),
        props.align === "rows" && variant === "bordered" ? ROWS_FRAME : FRAME[variant],
        props.className,
      )}
    >
      {props.align === "rows" || variant === "header" ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          <Glyph icon={Search} size={14} className="text-fg-3" />
        </span>
      ) : (
        <Glyph icon={Search} size={14} className="shrink-0 text-fg-3" />
      )}
      <input
        ref={setRef}
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
        <IconButton
          icon={X}
          label="Clear search"
          size="xs"
          tabIndex={-1}
          onClick={() => {
            props.onChange("");
            // The button unmounts with the text; focus would fall to the page.
            own.current?.focus();
          }}
          className={cn(variant === "bare" ? "" : props.align === "rows" ? "-mr-1" : "-mr-2", variant === "bordered" && props.size === "xs" && "size-5")}
        />
      ) : (
        props.shortcut
      )}
    </div>
  );
}
