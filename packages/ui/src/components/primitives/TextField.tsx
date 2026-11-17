import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, FIELD, FIELD_BASE, type ControlSize } from "../../lib/controls";

/** Borderless editor look: no frame, no surface; the focus indicator is the caller's frame (composer, comment box). */
const BARE = "bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none focus-visible:shadow-none touch:text-input-touch";

const TOUCH_H: Record<ControlSize, string> = {
  xs: "touch:h-ctl-xs",
  sm: "touch:h-ctl-sm",
  md: "touch:h-ctl-md",
  lg: "touch:h-ctl-lg",
};

type Variant = "default" | "bare";

/**
 * Single-line text entry (decision 90). One look (`FIELD` in `lib/controls.ts`): 8px radius, `input-border`, `panel`
 * surface, 13px text (16px on touch by default; `touchSize` lets compact toolbars stay `sm`/`md` inside `h-bar`); ONE focus
 * indicator shared by every field primitive: the border turns `fg`, the global shadow ring is off. `aria-invalid` turns
 * the border `err`.
 *
 * - `size`: xs 24, sm 28, md 32 (default), lg 40; at touch widths defaults to `touchSize="lg"` (40px / 44px on phone).
 * - `touchSize`: height on touch screens (`lg` by default; `sm` or `md` keeps toolbar inputs proportionate while the caller wraps a `touch-hit` label).
 * - `variant`: `default` (framed) or `bare` (no frame: for an input that sits inside another frame).
 * - `leading`: a short fixed adornment inside the frame, before the text (a currency sign: "$"); decorative, so the label
 *   and placeholder must say what it means. `className` then styles the wrapper, which carries the width.
 *
 * Not for: search (`SearchField`), a choice from a list (`Select`), several lines (`TextArea`), a label (`Field`).
 */
export const TextField = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: ControlSize; touchSize?: ControlSize; variant?: Variant; leading?: ReactNode }
>(function TextField({ size = "md", touchSize = "lg", variant = "default", leading, className, ...rest }, ref) {
  const fieldLook = touchSize === "lg" ? cn(FIELD, "px-3") : cn(FIELD_BASE, touchSize === "md" ? "px-3" : "px-2");
  const look = cn("w-full", variant === "bare" ? BARE : cn(fieldLook, TOUCH_H[touchSize]), CONTROL[size].h);
  if (leading === undefined) return <input ref={ref} className={cn(look, className)} {...rest} />;
  return (
    <span className={cn("relative block w-full", className)}>
      <span
        aria-hidden
        className={cn("pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-fg-3", touchSize === "lg" && "touch:text-input-touch")}
      >
        {leading}
      </span>
      <input ref={ref} className={cn(look, "pl-6 touch:pl-8")} {...rest} />
    </span>
  );
});

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
