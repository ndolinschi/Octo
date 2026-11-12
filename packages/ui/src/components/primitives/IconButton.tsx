import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { CONTROL, type ControlSize } from "../../lib/controls";
import { Glyph } from "./Glyph";

type Variant = "quiet" | "primary" | "round";

const VARIANT: Record<Variant, string> = {
  quiet: "text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-40",
  primary: "bg-primary text-primary-fg hover:opacity-90 disabled:bg-active disabled:text-fg-3 disabled:opacity-100",
  // The floating circle (jump to latest): overlay surface, hairline, elevation; its focus ring composes with the shadow.
  round: "rounded-full border border-line bg-overlay text-fg-2 shadow-float octo-ring-float hover:text-fg disabled:opacity-40",
};

/**
 * Icon-only button (decision 90). The accessible name is the required `label`; it is also the tooltip (`title`, shown by
 * the app's tooltip layer; `shortcut` adds the key hint).
 *
 * - `size`: xs 24, sm 28 (default), md 32, lg 40 (`lib/controls.ts`); one radius rule per size (6px, 8px at lg).
 * - `variant`: `quiet` (default), `primary` (the filled send/submit button, one per surface), `round` (floating circle).
 * - `round`: make any variant a circle (the send button is `primary` + `round`).
 * - `pressed`: a toggle (`aria-pressed`, the `active` fill).
 * - Touch: a 40px hit area grows around it without changing its size.
 *
 * Not for: a button with a visible label (`Button`), a chip with a value (`Chip`), a row action inside a `ListRow` that
 * must not widen it (put it in the row's `trailing` slot, which is also an `IconButton`).
 */
export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: ControlSize;
  variant?: Variant;
  round?: boolean;
  pressed?: boolean;
  shortcut?: string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = "sm", variant = "quiet", round = false, pressed, shortcut, className, type = "button", ...rest },
  ref,
) {
  const spec = CONTROL[size];
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...(shortcut ? { "data-shortcut": shortcut } : {})}
      className={cn(
        "touch-hit inline-flex shrink-0 press items-center justify-center disabled:pointer-events-none",
        spec.square,
        variant === "round" || round ? "rounded-full" : spec.radius,
        VARIANT[variant],
        pressed && variant === "quiet" && "bg-active text-fg",
        className,
      )}
      {...rest}
    >
      <Glyph icon={icon} size={spec.iconGlyph} />
    </button>
  );
});
