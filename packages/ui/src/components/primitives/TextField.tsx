import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, FIELD, type ControlSize } from "../../lib/controls";

/** Borderless editor look: no frame, no surface; the focus indicator is the caller's frame (composer, comment box). */
const BARE = "bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none touch:text-input-touch";

type Variant = "default" | "bare";

/**
 * Single-line text entry (decision 90). One look (`FIELD` in `lib/controls.ts`): 8px radius, `input-border`, `panel`
 * surface, 13px text (16px on touch); ONE focus indicator shared by every field primitive: the border turns `fg`, the
 * global shadow ring is off. `aria-invalid` turns the border `err`.
 *
 * - `size`: xs 24, sm 28, md 32 (default), lg 40; at touch widths every size is 40px tall.
 * - `variant`: `default` (framed) or `bare` (no frame: for an input that sits inside another frame).
 *
 * Not for: search (`SearchField`), a choice from a list (`Select`), several lines (`TextArea`), a label (`Field`).
 */
export const TextField = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: ControlSize; variant?: Variant }>(
  function TextField({ size = "md", variant = "default", className, ...rest }, ref) {
    return <input ref={ref} className={cn("w-full", variant === "bare" ? BARE : cn(FIELD, "px-3 touch:h-ctl-lg"), CONTROL[size].h, className)} {...rest} />;
  },
);

/**
 * Multi-line text entry: the same look and focus rule as `TextField`; grows by the user's drag (`resize-y`).
 * `variant="bare"` is the editor look of the composer and comment boxes. Not for: one line (`TextField`).
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { variant?: Variant }>(function TextArea(
  { variant = "default", className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn("w-full", variant === "bare" ? cn(BARE, "resize-none") : cn(FIELD, "resize-y px-3 py-1.5 leading-5"), className)}
      {...rest}
    />
  );
});
